import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import { journalPaths } from './journal'
import { AT, encode, fakeSandbox, ROOT } from './vercel-sandbox.fake'
import { createVercelSession } from './vercel-session'
import { endProcess, forgeExit, killWrapperOnly, leapingClock, startProcess } from './vercel-session.fixtures'

/**
 * A session whose clock leaps a second per reading.
 *
 * The polls themselves are real `setTimeout(0)`s; only the *deadline* is simulated, so a wait
 * that must run out its budget does so in a handful of ticks rather than in wall-clock time.
 */
function session(fake: ReturnType<typeof fakeSandbox>, stepMs = 1_000) {
  return createVercelSession(fake.sandbox, {
    journalRoot: ROOT,
    newProcessId: () => 'p1',
    now: () => AT,
    pollIntervalMs: 0,
    monotonicNowMs: leapingClock(stepMs),
  })
}

async function started(fake: ReturnType<typeof fakeSandbox>) {
  const handle = await session(fake).exec(['claude', '-p'])
  startProcess(fake, handle.id)
  return handle
}

describe('waitForExit', () => {
  it('resolves from a journalled exit once the group is gone', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    endProcess(fake, handle.id, 0)

    expect(await handle.waitForExit()).toEqual({ code: 0, timedOut: false })
  })

  it('carries the wrapper watchdog’s timeout marker into the exit', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    fake.files.set(journalPaths(ROOT, handle.id).timeout, encode('t'))
    endProcess(fake, handle.id, 143)

    expect(await handle.waitForExit()).toEqual({ code: 143, timedOut: true })
  })

  it('resolves from an exit code Vercel recorded without asking the group', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    // Still live in the fake's table: the API's own account of the command it started needs no
    // corroboration, because it is the corroboration.
    endProcess(fake, handle.id, 3, true)
    startProcess(fake, handle.id)

    expect(await handle.waitForExit()).toEqual({ code: 3, timedOut: false })
  })

  it('never resolves on an exit record forged while the group is alive', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    forgeExit(fake, handle.id, 0)

    // The duplicate-turn hazard in one assertion: resolving here reports the attempt finished,
    // frees the checkout for a retry, and lets a second `claude` start beside the first.
    await expect(handle.waitForExit({ timeout: 5_000 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('rejects with no_exit_record when the wrapper died before recording $?', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    killWrapperOnly(fake, handle.id)

    // Distinguishable on purpose: a timeout says "wait longer or kill it", this says "it is
    // already gone, retrying the wait buys nothing".
    await expect(handle.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })

  it('keeps waiting while the probe cannot decide', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    fake.failing.add('/proc/')

    await expect(handle.waitForExit({ timeout: 5_000 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('never times out without a timeout, however long the process runs', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    // A clock jumping a full day per reading. `awaitTurn` races an unbounded `waitForExit()`
    // inside a step that already allows a live turn six hours and documents that such a wait
    // never rejects, so any cap invented here would fail a run whose turn was merely long.
    const unbounded = createVercelSession(fake.sandbox, {
      journalRoot: ROOT,
      now: () => AT,
      pollIntervalMs: 0,
      monotonicNowMs: leapingClock(86_400_000),
    })
    const waiting = (await unbounded.getProcess(handle.id))?.waitForExit()
    await new Promise(resolve => setTimeout(resolve, 20))
    endProcess(fake, handle.id, 0)

    expect(await waiting).toEqual({ code: 0, timedOut: false })
  })

  it('rejects as a timeout when the caller aborts', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const stop = new AbortController()
    stop.abort()

    await expect(handle.waitForExit({ signal: stop.signal })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('renews the sandbox lifetime from the wait loop', async () => {
    const fake = fakeSandbox()
    const live = createVercelSession(fake.sandbox, {
      journalRoot: ROOT,
      newProcessId: () => 'p1',
      now: () => AT,
      pollIntervalMs: 0,
      sandboxTimeoutMs: 60_000,
      monotonicNowMs: leapingClock(20_000),
    })
    const handle = await live.exec(['claude'])
    startProcess(fake, handle.id)

    await expect(handle.waitForExit({ timeout: 120_000 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
    // Additive, not re-applied: `extendTimeout` adds to Vercel's deadline, so a renewal is only
    // spent once the remaining lifetime has fallen past half.
    expect(fake.extended.length).toBeGreaterThan(0)
    expect(fake.extended.every(ms => ms === 60_000)).toBe(true)
  })
})
