import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import {
  AT,
  endProcess,
  fakeSandbox,
  forgetSession,
  leapingClock,
  session,
} from './daytona-session.fixtures'

describe('status', () => {
  /**
   * One read settles liveness and exit together, which is the whole reason this backend is thin:
   * `exitCode` is written by Daytona's toolbox daemon, not by the turn, so there is no forged
   * exit to cross-check against a process table.
   */
  it('reads running, then exited, from the command the daemon holds', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])

    expect(await handle.status()).toMatchObject({ id: 'run-1', state: 'running', startedAt: AT })
    endProcess(fake, 'run-1', 3)
    expect(await handle.status()).toMatchObject({
      state: 'exited',
      exit: { code: 3, timedOut: false },
      endedAt: AT,
    })
  })

  /** A zero exit is an exit, not an absent one — the trap `exitCode === undefined` avoids. */
  it('treats a zero exit code as an exit', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    endProcess(fake, 'run-1', 0)

    expect(await handle.status()).toMatchObject({ state: 'exited', exit: { code: 0 } })
  })

  it('reports a session Daytona no longer holds as no_exit_record', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    forgetSession(fake, 'run-1')

    expect(await handle.status()).toMatchObject({ state: 'error', error: { code: 'no_exit_record' } })
  })

  /**
   * Both reads that can say "gone" have to tell an absence from a failure, because only one of
   * them means the process is really over. Exercised on each: the warm handle asks
   * `getSessionCommand` directly, while a cold session — a retried step on another instance — has
   * to resolve the command id through `getSession` first.
   */
  it('propagates a transport failure rather than reporting the process gone', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    fake.failing.add('run-1')

    await expect(handle.status()).rejects.toThrow(/connection reset/)
    await expect(session(fake).getProcess('run-1')).rejects.toThrow(/connection reset/)
  })
})

describe('waitForExit', () => {
  it('resolves only from an exit the daemon recorded', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    endProcess(fake, 'run-1', 7)

    expect(await handle.waitForExit()).toEqual({ code: 7, timedOut: false })
  })

  /**
   * The caller's `catch` is the timeout path (`WaitForExitOptions`), so a wait that ends before
   * the process does must reject rather than resolve a synthetic exit — a resolved one would
   * report a live turn as dead and free its checkout for a second `claude`.
   */
  it('rejects a wait that outlives its budget instead of inventing an exit', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake, ['run-1'], { monotonicNowMs: leapingClock(1_000) })
      .exec(['claude'])

    await expect(handle.waitForExit({ timeout: 1_500 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('rejects an aborted wait the same way, since the process is still running', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])

    await expect(handle.waitForExit({ signal: AbortSignal.abort() }))
      .rejects
      .toBeInstanceOf(SandboxWaitTimeoutError)
  })

  /**
   * The opposite verdict, and it asks the caller for the opposite thing: waiting again buys
   * nothing once Daytona has forgotten the session.
   */
  it('rejects with no_exit_record when the session is gone', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    forgetSession(fake, 'run-1')

    await expect(handle.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })

  /**
   * `awaitTurn` races an unbounded `waitForExit()` inside a step that already allows a live turn
   * six hours and is never retried, so a private cap here would fail a run whose turn was merely
   * long. The clock leaps an hour per poll to prove no such cap exists.
   */
  it('never expires a wait the caller put no bound on', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake, ['run-1'], { monotonicNowMs: leapingClock(3_600_000) })
      .exec(['claude'])

    let settled = false
    const wait = handle.waitForExit().finally(() => {
      settled = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    endProcess(fake, 'run-1', 0)
    expect(await wait).toEqual({ code: 0, timedOut: false })
  })
})
