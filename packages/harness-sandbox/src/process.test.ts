import type { ProcessLogEvent } from '@pleaseai/sandbox-contract'
import { describe, expect, it } from 'bun:test'
import { createProcessSurface, splitProcessStreams } from './process'
import {
  exitedEvent,
  fakeSandboxProvider,
  FIXTURE_CWD,
  processSurface,
  stderrEvent,
  stdoutEvent,
  truncatedEvent,
} from './sandbox.fixtures'

function eventStream(events: readonly ProcessLogEvent[]): ReadableStream<ProcessLogEvent> {
  let index = 0
  return new ReadableStream<ProcessLogEvent>({
    pull(controller) {
      if (index >= events.length) {
        controller.close()
        return
      }
      controller.enqueue(events[index++])
    },
  })
}

function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

describe('splitProcessStreams', () => {
  it('routes each event to the stream it is tagged for', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream([
      stdoutEvent('out-1'),
      stderrEvent('err-1'),
      stdoutEvent('out-2'),
      stderrEvent('err-2'),
    ]))

    expect(await Promise.all([text(stdout), text(stderr)])).toEqual(['out-1out-2', 'err-1err-2'])
  })

  /**
   * The harness's `stdout`/`stderr` are byte streams and have no representation for an exit
   * or a truncation notice. A split that forwarded them would inject their payload — or,
   * with no `data` field, a `TypeError` — into the agent's own output.
   */
  it('drops terminal and truncation events rather than forwarding them as bytes', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream([
      stdoutEvent('out'),
      truncatedEvent(),
      exitedEvent(3),
    ]))

    expect(await Promise.all([text(stdout), text(stderr)])).toEqual(['out', ''])
  })

  /**
   * Ordering matters more than it looks: both output streams pull once as soon as they are
   * constructed, in construction order, so a source whose events arrive stdout-first hands
   * each pull the event it was already waiting for. A misrouting split passes that by
   * coincidence. Leading with stderr is what makes the first pull — stdout's — see an event
   * that is not its own (measured: this ordering catches three mutations the stdout-first
   * ordering does not).
   */
  it('routes correctly when the first event belongs to the second stream', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream([
      stderrEvent('err-1'),
      stderrEvent('err-2'),
      stdoutEvent('out-1'),
    ]))

    expect(await Promise.all([text(stdout), text(stderr)])).toEqual(['out-1', 'err-1err-2'])
  })

  it('closes the stream that never sees a byte', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream([stdoutEvent('only-stdout')]))

    expect(await text(stderr)).toBe('')
    expect(await text(stdout)).toBe('only-stdout')
  })

  /**
   * One source, two consumers: a reader that only drained the stream being pulled would
   * stall the other forever once the source ran out of events for it. Reading `stderr` to
   * completion *before* touching `stdout` is the ordering that catches that.
   */
  it('serves a consumer that reads the second stream first', async () => {
    const { stdout, stderr } = splitProcessStreams(eventStream([
      stdoutEvent('out'),
      stderrEvent('err'),
    ]))

    expect(await text(stderr)).toBe('err')
    expect(await text(stdout)).toBe('out')
  })

  it('errors both streams when the source fails', async () => {
    const source = new ReadableStream<ProcessLogEvent>({
      pull(controller) {
        controller.error(new Error('transport gone'))
      },
    })
    const { stdout, stderr } = splitProcessStreams(source)

    await expect(text(stdout)).rejects.toThrow('transport gone')
    await expect(text(stderr)).rejects.toThrow('transport gone')
  })
})

describe('spawn', () => {
  /**
   * `SandboxProcessOptions.command` is a shell string and `SandboxCommand` is argv, so the
   * shell has to be named explicitly. A backend that quotes argv into a shell word list
   * (`packages/sandbox-e2b/src/shell-quote.ts`) re-quotes these three words and `sh` reads
   * the command back as one literal argument, so the wrapping survives that round trip.
   */
  it('wraps the shell string as argv for the shell itself', async () => {
    const { surface: s, state } = processSurface()
    await s.spawn({ command: 'echo hi && false' })

    expect(state.execs[0].command).toEqual(['sh', '-c', 'echo hi && false'])
  })

  it('runs in the sandbox default working directory when the caller names none', async () => {
    const { surface: s, state } = processSurface()
    await s.spawn({ command: 'pwd' })

    expect(state.execs[0].options?.cwd).toBe(FIXTURE_CWD)
  })

  it('runs where the caller asked', async () => {
    const { surface: s, state } = processSurface()
    await s.spawn({ command: 'pwd', workingDirectory: '/elsewhere' })

    expect(state.execs[0].options?.cwd).toBe('/elsewhere')
  })

  it('forwards per-command environment', async () => {
    const { surface: s, state } = processSurface()
    await s.spawn({ command: 'env', env: { TOKEN: 'k' } })

    expect(state.execs[0].options?.env).toEqual({ TOKEN: 'k' })
  })

  it('streams the process log as separate stdout and stderr byte streams', async () => {
    const { surface: s } = processSurface(() => ({ events: [stdoutEvent('o'), stderrEvent('e')] }))
    const process = await s.spawn({ command: 'noise' })

    expect(await Promise.all([text(process.stdout), text(process.stderr)])).toEqual(['o', 'e'])
  })

  /**
   * `follow` alone is a live tail. The contract's own word for the flag that reads the
   * retained log from the beginning is `replay`, and the backend the harness runs against
   * agrees: `@cloudflare/sandbox`'s internal readers — `consumeLogs`, which is what
   * `waitForExit` and `output` are built on, and `waitForPortSubscriptions` — all open
   * `openLogs({ replay: true, follow: true })`. A subscription attached after `exec` has
   * returned is therefore already behind whatever the command wrote in the meantime: a fast
   * `echo`, or the bridge's startup banner, is written and retained before this call is made
   * (codex review, PR #268).
   */
  it('reads the retained log from the beginning, not from the live tail', async () => {
    const { surface: s, state } = processSurface(() => ({ events: [stdoutEvent('written before the subscription')] }))
    const process = await s.spawn({ command: 'echo hi' })

    expect(await text(process.stdout)).toBe('written before the subscription')
    expect(state.logReads).toEqual([{ follow: true, replay: true }])
  })

  it('reports the exit code the contract resolved', async () => {
    const { surface: s } = processSurface(() => ({ exit: { code: 7, timedOut: false } }))
    const process = await s.spawn({ command: 'fail' })

    expect(await process.wait()).toEqual({ exitCode: 7 })
  })

  it('kills the process when the caller aborts', async () => {
    const controller = new AbortController()
    const { surface: s, state } = processSurface()
    await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    controller.abort()
    await Promise.resolve()

    expect(state.kills).toBe(1)
  })

  /**
   * The harness states the rejection value for an aborted `spawn`: `wait()` rejects with the
   * abort reason. The contract leaves what an aborted `waitForExit` rejects with to the
   * backend, so the reason has to be restored here or the caller cannot recognise its own abort.
   */
  it('rejects wait with the abort reason, not the backend error', async () => {
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    // A backend wait that settles only when its *own* signal fires. A script that rejected
    // unconditionally would reject whether or not the signal was forwarded, so the reason
    // assertion below would pass over a surface that dropped it — and dropping it means the
    // sandbox is never told to stop waiting.
    const { surface: s, state } = processSurface(() => ({ waitsForAbort: true }))
    const process = await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    const waited = process.wait()

    // Asserted before the abort, not after: a surface that dropped the signal leaves the
    // backend wait pending forever, so a rejection assertion would hang instead of failing.
    expect(state.waits).toHaveLength(1)
    expect(state.waits[0]?.signal).toBe(controller.signal)

    controller.abort(reason)
    await expect(waited).rejects.toThrow('caller gave up')
  })

  /**
   * The abort can land between `spawn` and `wait`, and `abort` is one-shot — a listener added
   * to a signal that has already fired never runs (measured under Bun 1.3.14; the same DOM
   * behaviour `spawn`'s pre-check exists for, now on the wait side). A backend wait that only
   * registers a listener therefore never settles, and the caller hangs forever on a process it
   * has already cancelled rather than being told its own abort reason.
   */
  it('rejects wait with the abort reason when the abort landed before wait was called', async () => {
    const controller = new AbortController()
    const { surface: s } = processSurface(() => ({ waitsForAbort: true }))
    const process = await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    controller.abort(new Error('cancelled before wait'))

    await expect(process.wait()).rejects.toThrow('cancelled before wait')
  })

  /**
   * And that the backend is never asked at all, which the reason assertion above cannot say.
   *
   * That test drives the fixture's own pre-abort branch, so it passes whether or not `wait()`
   * refuses first — the reason is restored either way, by the guard or by the `catch` behind
   * it (cubic review, PR #268). The refusal is the part worth pinning: the contract does not
   * make a backend reject a wait handed an already-aborted signal, and a backend that only
   * registers an `abort` listener never settles for a caller who aborted between `spawn` and
   * `wait` — `abort` is one-shot. That is the same bug class `spawn`'s own `throwIfAborted()`
   * closes, one call later, and a hang is what it costs.
   */
  it('refuses a wait for a caller that aborted first, without reaching the backend', async () => {
    const controller = new AbortController()
    const { surface: s, state } = processSurface(() => ({ waitsForAbort: true }))
    const process = await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    controller.abort(new Error('cancelled before wait'))

    await expect(process.wait()).rejects.toThrow('cancelled before wait')
    expect(state.waits).toEqual([])
  })

  it('surfaces a wait failure unchanged when nothing was aborted', async () => {
    const { surface: s } = processSurface(() => ({ waitRejects: new Error('backend-specific wait failure') }))
    const process = await s.spawn({ command: 'sleep 100' })

    await expect(process.wait()).rejects.toThrow('backend-specific wait failure')
  })

  /**
   * A listener added to an already-aborted signal never fires — the DOM spec fires `abort`
   * exactly once (measured under Bun 1.3.14: a listener attached after `abort()` does not
   * run). So attaching one and returning would start a process in the sandbox for a caller
   * that has already cancelled, with nothing left holding a handle to kill it.
   *
   * Refusing rather than starting-then-killing follows the platform: `fetch` rejects on a
   * pre-aborted signal, `AbortSignal.throwIfAborted()` exists for exactly this, and
   * provider-utils' own `connectToWebSocket` documents that it leaves the socket `undefined`
   * "when the constructor threw or the signal was already aborted". A kill is also async and
   * can fail, so start-then-kill can still leak; refusing cannot.
   */
  it('refuses to start a process for a caller that has already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before spawn'))
    const { surface: s, state } = processSurface()

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal }))
      .rejects
      .toThrow('cancelled before spawn')
    expect(state.execs).toEqual([])
  })

  /**
   * The window between the two guards, and the second instance of one bug class here.
   *
   * `throwIfAborted()` covers a signal aborted *before* `spawn` is entered, and the `abort`
   * listener covers one that fires *after* it is attached. `exec` sits between them and is a
   * remote call, so the gap is wide in wall-clock terms: an abort landing there is past the
   * pre-check and ahead of the listener, and `abort` is one-shot — a listener attached
   * afterwards never fires (same DOM behaviour the pre-check is written for). The process is
   * then running in the sandbox with no kill ever issued, while `wait()` still rejects with
   * the reason, so the caller is told it cancelled something that is in fact still running.
   *
   * Aborting from inside the fake's `exec` is the only way to land in that window
   * deliberately: it is the one point the production code is suspended at.
   */
  it('kills and refuses when the abort lands while exec is in flight', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-exec')
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: (command, execOptions) => {
          controller.abort(reason)
          return session.exec(command, execOptions)
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal }))
      .rejects
      .toThrow('cancelled mid-exec')
    expect(state.kills).toBe(1)
  })

  /**
   * The fifth window, and the first one where the two abort guards above are *both* live and
   * still leave something open: the log subscription itself.
   *
   * `throwIfAborted()` covers a pre-aborted caller and the listener covers everything after
   * `exec`, so an abort landing here does kill the command — the leak the other guards exist
   * for cannot happen. What neither of them touches is the call `spawn` is suspended in.
   * `logs()` takes a `signal` (`ProcessLogsOptions`), and a subscription opened without one
   * has nothing to cancel it: the listener kills the process, and this promise is still
   * pending, so `spawn()` never settles for a caller that has already cancelled.
   *
   * Asserted before the abort, exactly as the wait test does: a surface that dropped the
   * signal leaves the subscription open forever, so the rejection assertion below would hang
   * the suite instead of naming the defect.
   */
  it('hands the log subscription the caller signal, and rejects with the abort reason', async () => {
    const controller = new AbortController()
    const { surface: s, state } = processSurface(() => ({ logsWaitsForAbort: true }))
    const spawned = s.spawn({ command: 'sleep 100', abortSignal: controller.signal })
    // A macrotask, not a microtask: `exec` resolves through the microtask queue, so this is
    // the first point at which `logs()` has certainly been reached.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(state.logReads[0]?.signal).toBe(controller.signal)

    controller.abort(new Error('cancelled while the log opened'))
    // The fixture rejects with its own message, so this also pins the reason being restored:
    // a caller that cannot recognise its own abort reports a transport failure instead.
    await expect(spawned).rejects.toThrow('cancelled while the log opened')
  })

  /**
   * The same window, for a backend that opens the subscription anyway.
   *
   * Nothing obliges a backend to honour `ProcessLogsOptions.signal`, and even one that does
   * can win the race: the abort lands after `logs()` resolved and before `spawn` returns.
   * Without a recheck the caller is handed a process whose command the listener has already
   * killed — a corpse with two streams and a `wait()` that only rejects once asked — instead
   * of the rejection the two earlier windows give it for an abort one millisecond earlier.
   *
   * Aborting from inside the fake's `logs` is the only way to land there deliberately: it is
   * the one point the production code is suspended at.
   */
  it('cancels the subscription and refuses when the abort lands while the log opens', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-logs')
    const { provider, state } = fakeSandboxProvider({ script: () => ({ events: [stdoutEvent('banner')] }) })
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            logs: (logOptions) => {
              controller.abort(reason)
              return handle.logs(logOptions)
            },
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal }))
      .rejects
      .toThrow('cancelled mid-logs')
    // One kill, not two: the listener attached before this window opens fires for it, so what
    // this guard owes the caller is the rejection and the subscription nobody will ever read —
    // a second kill would be a fifth copy of a guard that already ran.
    expect(state.kills).toBe(1)
    expect(state.logCancels).toBe(1)
  })

  it('kills through the contract handle', async () => {
    const { surface: s, state } = processSurface()
    const process = await s.spawn({ command: 'sleep 100' })
    await process.kill()

    expect(state.kills).toBe(1)
  })
})

describe('run', () => {
  it('collects both streams and the exit code', async () => {
    const { surface: s } = processSurface(() => ({
      events: [stdoutEvent('out-a'), stderrEvent('err'), stdoutEvent('out-b'), exitedEvent(2)],
      exit: { code: 2, timedOut: false },
    }))

    expect(await s.run({ command: 'work' })).toEqual({
      exitCode: 2,
      stdout: 'out-aout-b',
      stderr: 'err',
    })
  })

  it('refuses an already-aborted caller before reaching the sandbox', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled before run'))
    const { surface: s, state } = processSurface()

    await expect(s.run({ command: 'work', abortSignal: controller.signal }))
      .rejects
      .toThrow('cancelled before run')
    expect(state.execs).toEqual([])
  })

  it('wraps the shell string the same way spawn does', async () => {
    const { surface: s, state } = processSurface()
    await s.run({ command: 'ls -la' })

    expect(state.execs[0].command).toEqual(['sh', '-c', 'ls -la'])
  })
})
