/**
 * The fake e2b sandbox the `e2b-session.*.test.ts` suites are written against.
 *
 * It lives in its own module because those suites are split by responsibility — process
 * lifecycle, waiting and status, log replay — and every one of them needs the same fake.
 * Keeping one copy is what makes the split safe: a fake that drifted per file would let a
 * suite pass against a sandbox the others no longer model. Not a `*.test.ts` file, so the
 * runner does not pick it up as a suite of its own.
 */
import type { E2bSandboxLike, E2bSessionOptions } from './e2b-session'
import { createE2bSession } from './e2b-session'

export const ROOT = '/home/user/.agent-runs'
export const AT = '2026-08-24T13:00:00.000Z'
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

export interface Fake {
  sandbox: E2bSandboxLike
  files: Map<string, Uint8Array>
  dirs: Set<string>
  ran: { cmd: string, opts: Record<string, unknown> }[]
  live: Set<number>
  killed: { sandbox: boolean, pids: number[] }
  /** Call counts, so a test can pin *how often* the loop reaches the network. */
  calls: {
    list: number
    read: number
    renewed: number[]
    readFormats: string[]
    cancelled: string[]
    /** How many chunks readers have pulled, across every stream this fake handed out. */
    pulled: number
  }
  /** Bytes per chunk when a file is read as a stream; pins cursor handling at boundaries. */
  chunkSize: number
  /**
   * Hold every background command's `wait()` until the returned release is called.
   *
   * Lets a test tell "the caller awaited the walk" from "the caller merely started it": a
   * fire-and-forget `wait()` still reaps a microtask later, and an assertion made after the
   * call would not notice (cubic review, PR #260).
   */
  holdCommandWaits: () => () => void
  /** What a background command's `wait()` reports; non-zero means it did not finish. */
  commandExitCode: number
}

/**
 * Everything the fake's two surfaces share. Held in one object so `fakeCommands` and
 * `fakeFiles` can each stay a readable size while still observing each other's writes —
 * the process table and the journal are one sandbox, not two.
 */
interface FakeState {
  files: Map<string, Uint8Array>
  dirs: Set<string>
  ran: Fake['ran']
  live: Set<number>
  /** What each pid was started as, so `list()` can report it the way e2b does. */
  wrappers: Map<number, string>
  killed: Fake['killed']
  calls: Fake['calls']
  stream: { chunkSize: number }
  waits: { held: boolean, queue: (() => void)[], exitCode: number }
  nextPid: number
}

function fakeCommands(state: FakeState): E2bSandboxLike['commands'] {
  return {
    run: async (cmd, opts) => {
      state.ran.push({ cmd, opts: opts as Record<string, unknown> })
      // The kill walk really reaps, the way it was measured to
      // (`scripts/spike-e2b-kill-tree.ts`) — otherwise a test could assert the command was
      // issued while the process it names stays live in the fake's own table.
      //
      // A background command's effects have *not* landed when e2b's `run` resolves — it
      // returns as soon as the command starts. Modelled by holding the reap until the handle
      // is waited on, which is what makes a caller that awaits only the start observable.
      const reaped = /^reap\(\) \{.* reap (\d+)$/.exec(cmd)
      const reap = (): void => {
        if (reaped) {
          state.live.delete(Number(reaped[1]))
        }
      }
      if (opts?.background !== true) {
        reap()
      }
      const assigned = state.nextPid++
      state.live.add(assigned)
      state.wrappers.set(assigned, cmd)
      return {
        pid: assigned,
        wait: async () => {
          if (state.waits.held) {
            await new Promise<void>(resolve => state.waits.queue.push(resolve))
          }
          reap()
          state.live.delete(assigned)
          return { exitCode: state.waits.exitCode }
        },
      }
    },
    list: async () => {
      state.calls.list++
      // Shaped the way e2b reports it: the shell is `cmd` and the command it was given
      // is one of `args`, so a backend reading only `cmd` would see none of the argv.
      return [...state.live].map(value => ({
        pid: value,
        cmd: '/bin/bash',
        args: ['-l', '-c', state.wrappers.get(value) ?? ''],
      }))
    },
    kill: async (target) => {
      state.killed.pids.push(target)
      return state.live.delete(target)
    },
  }
}

function fakeFiles(state: FakeState): E2bSandboxLike['files'] {
  return {
    read: ((path: string, opts: { format: 'bytes' | 'stream' }) => {
      state.calls.read++
      state.calls.readFormats.push(opts.format)
      const found = state.files.get(path)
      if (!found) {
        return Promise.reject(new Error(`not found: ${path}`))
      }
      if (opts.format !== 'stream') {
        return Promise.resolve(found)
      }
      // One chunk per pull rather than the whole file enqueued up front, so a test can see
      // *how much* a reader actually took: a bounded read and a read-it-all-then-discard both
      // end in the same state, and only the pull count tells them apart (cubic review,
      // PR #260).
      let at = 0
      return Promise.resolve(new ReadableStream<Uint8Array>({
        pull(controller) {
          state.calls.pulled++
          if (at >= found.length) {
            controller.close()
            return
          }
          controller.enqueue(found.subarray(at, at + state.stream.chunkSize))
          at += state.stream.chunkSize
        },
        // Stands in for e2b's response body: a reader that only unlocks leaves this
        // unrecorded, which is exactly the leak the cancel assertions in the logs suite pin.
        cancel() {
          state.calls.cancelled.push(path)
        },
      }))
    }) as E2bSandboxLike['files']['read'],
    write: async (path, data) => {
      state.files.set(path, typeof data === 'string' ? encode(data) : data)
    },
    exists: async path => state.files.has(path) || state.dirs.has(path),
    // Scoped to the directory asked for, the way e2b's own `files.list` is: an unscoped
    // listing would hand `listProcesses` meta files from journals it never asked about, and
    // a test written against two roots would pass on the wrong input (cubic review, PR #260).
    list: async (path) => {
      const prefix = `${path.replace(/\/+$/, '')}/`
      return [...state.files.keys()]
        .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
        .map(file => ({ name: file.slice(prefix.length) }))
    },
    makeDir: async (path) => {
      state.dirs.add(path)
      return true
    },
  }
}

export function fakeSandbox(nextPid = 2054): Fake {
  const state: FakeState = {
    files: new Map<string, Uint8Array>(),
    dirs: new Set<string>(),
    ran: [],
    live: new Set<number>(),
    wrappers: new Map<number, string>(),
    killed: { sandbox: false, pids: [] },
    calls: { list: 0, read: 0, renewed: [], readFormats: [], cancelled: [], pulled: 0 },
    stream: { chunkSize: Number.MAX_SAFE_INTEGER },
    waits: { held: false, queue: [], exitCode: 0 },
    nextPid,
  }

  const sandbox: E2bSandboxLike = {
    sandboxId: 'sbx-1',
    commands: fakeCommands(state),
    files: fakeFiles(state),
    setTimeout: async (timeoutMs) => {
      state.calls.renewed.push(timeoutMs)
    },
    kill: async () => {
      state.killed.sandbox = true
      return true
    },
  }
  return {
    sandbox,
    files: state.files,
    dirs: state.dirs,
    ran: state.ran,
    live: state.live,
    killed: state.killed,
    calls: state.calls,
    get chunkSize() {
      return state.stream.chunkSize
    },
    set chunkSize(value: number) {
      state.stream.chunkSize = value
    },
    holdCommandWaits: () => {
      state.waits.held = true
      return () => {
        state.waits.held = false
        for (const resume of state.waits.queue.splice(0)) {
          resume()
        }
      }
    },
    get commandExitCode() {
      return state.waits.exitCode
    },
    set commandExitCode(value: number) {
      state.waits.exitCode = value
    },
  }
}

export function session(fake: Fake, ids: string[] = ['run-1'], extra: Partial<E2bSessionOptions> = {}) {
  const queue = [...ids]
  return createE2bSession(fake.sandbox, {
    journalRoot: ROOT,
    newProcessId: () => queue.shift() ?? 'exhausted',
    now: () => AT,
    ...extra,
  })
}

/**
 * End a process the way a sandbox really does: the exit record appears *and* the pid leaves
 * the process table. Writing the record alone is what a turn scribbling in its own journal
 * can do, and both `status()` and `waitForExit()` deliberately refuse to call that an exit.
 */
export function endProcess(fake: Fake, processId: string, code: string, pid = 2054): void {
  fake.files.set(`${ROOT}/${processId}.exit`, encode(code))
  fake.live.delete(pid)
}

/** A clock that leaps forward on every read, so hours of waiting cost no wall-clock time. */
export function leapingClock(stepMs: number): () => number {
  let at = 0
  return () => (at += stepMs)
}

/**
 * Drain a stream, cancelling it on the way out.
 *
 * Cancelled rather than merely unlocked, because this stands in for a real consumer: a test
 * that stops reading early would otherwise leave the underlying file stream open and still
 * pass, which is the exact leak the cancel assertions in the logs suite exist to catch
 * (cubic review, PR #260). Cancelling a stream that already ran to completion is a no-op.
 */
export async function* streamOf<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      yield value
    }
  }
  finally {
    // Cancelled *and* released: cancelling closes the stream but leaves the reader holding
    // its lock, so a helper that only cancelled would hand back a permanently locked stream
    // (cubic review, PR #260).
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
