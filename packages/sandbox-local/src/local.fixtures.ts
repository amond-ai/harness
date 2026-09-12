/**
 * The fake host the session and registry suites are written against.
 *
 * In its own module because those suites are split by responsibility — process lifecycle,
 * waiting, log reads, discovery — and every one of them needs the same machine. Keeping one
 * copy is what makes the split safe: a fake that drifted per file would let one suite pass
 * against a host the others no longer model. Not a `*.test.ts` file, so the runner does not
 * pick it up as a suite of its own.
 *
 * What it models, and why each part is here rather than stubbed:
 *
 * - **a process table with start times**, because the whole of `registry.ts` turns on telling a
 *   pid that is ours from a pid that was reissued, and that is unreproducible against a real
 *   machine without waiting for the kernel to wrap its pid counter;
 * - **process groups**, because "the wrapper exited but something it detached is still
 *   running" is the state the session's liveness verdict exists for;
 * - **files as bytes**, because the journal is read at byte offsets and a string-keyed stub
 *   would hide every cursor bug there is.
 */
import type { SandboxSession } from '@amond-ai/sandbox'
import type { LocalSessionOptions } from './local-session'
import type { LocalHost, LocalProcessRow, LocalSlice, LocalSpawnSpec } from './local-surface'
import { createLocalSession } from './local-session'

export const ROOT = '/sandboxes'
export const SANDBOX_ID = 'run-42'
export const WORK = `${ROOT}/${SANDBOX_ID}`
export const STATE = `${ROOT}/.state/${SANDBOX_ID}`
export const AT = '2026-09-12T13:00:00.000Z'

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

interface FakeProcess {
  pid: number
  /** The process group this process belongs to; the wrapper's own pid, for a wrapper. */
  group: number
  startedAt: string
  command: string
}

export interface FakeHost {
  host: LocalHost
  files: Map<string, Uint8Array>
  dirs: Set<string>
  /** Every script handed to `spawn`, in order. */
  spawned: LocalSpawnSpec[]
  /** Every signal delivered, including the `0` probes, in order. */
  signals: { pid: number, signal: number }[]
  table: Map<number, FakeProcess>
  /** Call counts, so a test can pin how often a loop reaches for the process table. */
  calls: { processes: number, identify: number }
  /** Put a process in the table by hand — a stranger, or a child the wrapper detached. */
  place: (process: Partial<FakeProcess> & { pid: number }) => void
  /** Remove a process, the way exiting does. */
  end: (pid: number) => void
  /** Write a file the way the wrapper's shell would. */
  put: (path: string, content: string) => void
  /** Whether `ps` answers at all; `false` models a host that will not run it. */
  psWorks: boolean
}

export function fakeHost(options: { nextPid?: number } = {}): FakeHost {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>([ROOT])
  const spawned: LocalSpawnSpec[] = []
  const signals: { pid: number, signal: number }[] = []
  const table = new Map<number, FakeProcess>()
  const calls = { processes: 0, identify: 0 }
  let nextPid = options.nextPid ?? 1000

  const fake: FakeHost = {
    files,
    dirs,
    spawned,
    signals,
    table,
    calls,
    psWorks: true,
    place: (process) => {
      table.set(process.pid, {
        pid: process.pid,
        group: process.group ?? process.pid,
        startedAt: process.startedAt ?? `start-${String(process.pid)}`,
        command: process.command ?? 'something-else',
      })
    },
    end: (pid) => {
      table.delete(pid)
    },
    put: (path, content) => {
      files.set(path, encode(content))
      dirs.add(path.slice(0, path.lastIndexOf('/')))
    },
    host: {
      env: { PATH: '/usr/bin', HOME: '/home/tester' },
      size: async (path: string) => files.get(path)?.length ?? (dirs.has(path) ? 0 : undefined),
      exists: async (path: string) => files.has(path) || dirs.has(path),
      readSlice: async (path: string, offset: number, length?: number): Promise<LocalSlice> => {
        const data = files.get(path)
        if (!data) {
          return { data: new Uint8Array(), total: 0 }
        }
        const end = length === undefined ? data.length : Math.min(data.length, offset + length)
        return { data: data.slice(Math.min(offset, data.length), Math.max(offset, end)), total: data.length }
      },
      writeFile: async (path: string, data: Uint8Array) => {
        files.set(path, data)
      },
      mkdir: async (path: string) => {
        dirs.add(path)
      },
      readdir: async (path: string) => {
        const prefix = `${path}/`
        return [...files.keys()]
          .filter(name => name.startsWith(prefix))
          .map(name => name.slice(prefix.length))
          .filter(name => !name.includes('/'))
      },
      remove: async (path: string) => {
        dirs.delete(path)
        for (const name of [...files.keys()]) {
          if (name === path || name.startsWith(`${path}/`)) {
            files.delete(name)
          }
        }
        for (const name of [...dirs]) {
          if (name.startsWith(`${path}/`)) {
            dirs.delete(name)
          }
        }
      },
      spawn: async (spec: LocalSpawnSpec) => {
        spawned.push(spec)
        const pid = nextPid++
        table.set(pid, {
          pid,
          group: pid,
          startedAt: `start-${String(pid)}`,
          command: `/bin/sh -c ${spec.script}`,
        })
        return { pid }
      },
      signal: (pid: number, signal: number) => {
        signals.push({ pid, signal })
        if (pid < 0) {
          const group = -pid
          const members = [...table.values()].filter(process => process.group === group)
          if (signal !== 0) {
            for (const member of members) {
              table.delete(member.pid)
            }
          }
          return members.length > 0
        }
        const found = table.has(pid)
        if (found && signal !== 0) {
          table.delete(pid)
        }
        return found
      },
      identify: async (pid: number) => {
        calls.identify++
        const found = table.get(pid)
        return fake.psWorks && found
          ? { pid: found.pid, startedAt: found.startedAt, command: found.command }
          : undefined
      },
      processes: async (): Promise<LocalProcessRow[]> => {
        calls.processes++
        return fake.psWorks
          ? [...table.values()].map(({ pid, startedAt, command }) => ({ pid, startedAt, command }))
          : []
      },
    },
  }
  return fake
}

/** A session over the fake, addressing the sandbox {@link SANDBOX_ID} names. */
export function sessionOver(fake: FakeHost, overrides: Partial<LocalSessionOptions> = {}): SandboxSession {
  return createLocalSession({
    host: fake.host,
    paths: { work: WORK, state: STATE, owned: true },
    env: { PATH: '/usr/bin' },
    newProcessId: () => 'p1',
    now: () => AT,
    pollIntervalMs: 0,
    followIntervalMs: 0,
    ...overrides,
  })
}
