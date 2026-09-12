import type { FakeHost } from './local.fixtures'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import { journalPaths, serializeProcessRecord } from './journal'
import { AT, fakeHost, sessionOver, STATE } from './local.fixtures'

const PATHS = journalPaths(STATE, 'p1')

/** A sandbox holding one running process, recorded the way `exec` records one. */
function running(fake: FakeHost, pid = 4711): void {
  fake.place({ pid })
  fake.put(PATHS.pid, String(pid + 1))
  fake.place({ pid: pid + 1, group: pid, command: 'claude -p' })
  fake.put(PATHS.meta, serializeProcessRecord({
    id: 'p1',
    pid,
    command: ['claude', '-p'],
    startedAt: AT,
    kernelStartedAt: `start-${String(pid)}`,
  }))
}

/** A monotonic clock that advances a fixed step per read. */
function ticking(stepMs: number): () => number {
  let at = -stepMs
  return () => (at += stepMs)
}

describe('waitForExit', () => {
  it('resolves on a journalled exit once nothing of the tree is left', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({ id: 'p1', pid: 4711, command: ['claude'], startedAt: AT }))
    fake.put(PATHS.exit, '3')
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.waitForExit()).resolves.toEqual({ code: 3, timedOut: false })
  })

  it('reports a command its own watchdog killed as timed out', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({ id: 'p1', pid: 4711, command: ['claude'], startedAt: AT }))
    fake.put(PATHS.exit, '143')
    fake.put(PATHS.timeout, 't')
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.waitForExit()).resolves.toEqual({ code: 143, timedOut: true })
  })

  it('rejects rather than resolving when the wait ends before the process does', async () => {
    // The caller's `catch` is the timeout path: a synthetic exit here would be read as a
    // confirmed death, and the caller would proceed over a process that is still running.
    const fake = fakeHost()
    running(fake)
    const handle = await sessionOver(fake, { monotonicNowMs: ticking(10) }).getProcess('p1')
    await expect(handle?.waitForExit({ timeout: 5 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('rejects an aborted wait the same way, without inventing an exit', async () => {
    const fake = fakeHost()
    running(fake)
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.waitForExit({ signal: AbortSignal.abort() }))
      .rejects
      .toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('reports a wrapper that died before recording anything, rather than waiting forever', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({ id: 'p1', pid: 4711, command: ['claude'], startedAt: AT }))
    const handle = await sessionOver(fake).getProcess('p1')
    // Unbounded: what ends this wait is an observation — the group is empty — and not a cap
    // the backend invented, which would fail a run whose turn was merely long.
    await expect(handle?.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })

  it('keeps waiting while a child the wrapper detached is still running', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({ id: 'p1', pid: 4711, command: ['claude'], startedAt: AT }))
    fake.put(PATHS.exit, '0')
    // The wrapper is gone and claims success, but something it started is still writing to the
    // checkout. Resolving here is what frees that checkout for a second claude.
    fake.place({ pid: 4712, group: 4711 })
    const handle = await sessionOver(fake, { monotonicNowMs: ticking(10) }).getProcess('p1')
    await expect(handle?.waitForExit({ timeout: 5 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })
})

describe('status', () => {
  it('reports a process whose pid was reissued as gone, not as running', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({
      id: 'p1',
      pid: 4711,
      command: ['claude'],
      startedAt: AT,
      kernelStartedAt: 'start-4711',
    }))
    fake.put(PATHS.exit, '0')
    fake.place({ pid: 4711, startedAt: 'after a reboot' })

    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.status()).resolves.toMatchObject({ state: 'exited' })
  })

  it('reports an unreadable process table as running', async () => {
    const fake = fakeHost()
    running(fake)
    fake.psWorks = false
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.status()).resolves.toMatchObject({ state: 'running' })
  })

  it('reports a wrapper that recorded nothing as an error, not as an exit', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({ id: 'p1', pid: 4711, command: ['claude'], startedAt: AT }))
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.status()).resolves.toMatchObject({
      state: 'error',
      error: { code: 'no_exit_record' },
    })
  })
})

describe('kill', () => {
  it('aims the signal at the command, so the wrapper survives to record the exit', async () => {
    // A group-wide SIGINT would take the wrapper shell with it, and the `printf` that records
    // `$?` would never run — an interrupt sent to collect a result destroying the record of one.
    const fake = fakeHost()
    running(fake)
    const handle = await sessionOver(fake).getProcess('p1')
    await handle?.kill(2)
    expect(fake.signals.filter(sent => sent.signal === 2)).toEqual([{ pid: 4712, signal: 2 }])
    expect(fake.table.has(4711)).toBe(true)
  })

  it('terminates by default, matching the incumbent backend', async () => {
    const fake = fakeHost()
    running(fake)
    const handle = await sessionOver(fake).getProcess('p1')
    await handle?.kill()
    expect(fake.signals.filter(sent => sent.signal === 15)).toEqual([{ pid: 4712, signal: 15 }])
  })

  it('falls back to the group when only orphans are left to signal', async () => {
    const fake = fakeHost()
    fake.put(PATHS.meta, serializeProcessRecord({
      id: 'p1',
      pid: 4711,
      command: ['claude'],
      startedAt: AT,
      kernelStartedAt: 'start-4711',
    }))
    fake.place({ pid: 4712, group: 4711 })
    const handle = await sessionOver(fake).getProcess('p1')
    await handle?.kill(9)
    expect(fake.signals.filter(sent => sent.signal === 9)).toEqual([{ pid: -4711, signal: 9 }])
    expect(fake.table.has(4712)).toBe(false)
  })
})
