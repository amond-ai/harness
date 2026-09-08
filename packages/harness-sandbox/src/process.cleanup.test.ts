/**
 * The cleanup guards: every failure path that must not leave a live process behind.
 *
 * Split out of `process.test.ts`, which carries the behaviour of `spawn` and `run` themselves.
 * These two suites are about one thing instead: a sandbox that fails *after* the command is
 * already running, where the surface holds the only handle and the caller is about to be told
 * the call failed. Each of them pins a kill, the original cause surviving that kill, and the
 * kill being best-effort in both of the shapes a failure can take.
 */
import type { ProcessLogEvent } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import { createProcessSurface } from './process'
import { fakeSandboxProvider, FIXTURE_CWD, processSurface, stdoutEvent } from './sandbox.fixtures'

/**
 * The third window in `spawn` where a rejection could leave a live process behind.
 *
 * The two already closed are about the caller's abort signal; this one is about the sandbox.
 * `exec` has returned by the time `logs()` is called, so the command is running — and a
 * rejection from `logs()` propagates out of `spawn`, which returns no handle. The caller is
 * told the spawn failed and has nothing to kill with, while the process runs on in the
 * sandbox: the same "told it cancelled something that is in fact still running" the abort
 * comments name, reached from the other side.
 */
describe('createProcessSurface spawn when the log stream never opens', () => {
  it('kills the process it already started', async () => {
    const { surface: s, state } = processSurface(() => ({ logsRejects: new Error('log stream unavailable') }))

    await expect(s.spawn({ command: 'sleep 100' })).rejects.toThrow('log stream unavailable')
    expect(state.kills).toBe(1)
  })

  /**
   * The kill is best-effort and the original failure is what the caller has to see: a kill
   * that also failed would otherwise replace "the log stream never opened" with whatever the
   * kill said, and the caller would be debugging the wrong call.
   */
  it('rethrows the original failure even when the kill fails too', async () => {
    let killed = 0
    const { provider, state } = fakeSandboxProvider({
      script: () => ({ logsRejects: new Error('log stream unavailable') }),
    })
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          const kill = (): Promise<never> => {
            killed++
            return Promise.reject(new Error('kill failed too'))
          }
          return { ...handle, kill }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100' })).rejects.toThrow('log stream unavailable')
    expect(state.execs).toHaveLength(1)
    // The rethrow is only half of it: a guard that skipped the kill entirely would rethrow the
    // same cause and pass every assertion above, leaving the process running in the sandbox.
    // `state.kills` cannot say so here — the failing kill never reaches the fixture's counter.
    expect(killed).toBe(1)
  })

  /**
   * Best-effort covers a kill that throws synchronously as well as one that rejects.
   *
   * `handle.kill().catch(…)` evaluates the call before `.catch` exists to be attached to, so a
   * backend that throws instead of rejecting escapes the handler and replaces "the log stream
   * never opened" with its own error — the same substitution the rejecting case above is
   * written to prevent (cubic review, PR #268).
   */
  it('rethrows the original failure when the kill throws synchronously', async () => {
    const { surface: s, state } = processSurface(() => ({
      logsRejects: new Error('log stream unavailable'),
      killThrows: new Error('kill threw'),
    }))

    await expect(s.spawn({ command: 'sleep 100' })).rejects.toThrow('log stream unavailable')
    expect(state.kills).toBe(1)
  })

  /** `run` goes through `spawn`, so the same guard has to hold for it. */
  it('kills the process when run reaches the same failure', async () => {
    const { surface: s, state } = processSurface(() => ({ logsRejects: new Error('log stream unavailable') }))

    await expect(s.run({ command: 'sleep 100' })).rejects.toThrow('log stream unavailable')
    expect(state.kills).toBe(1)
  })
})

/**
 * The fourth window, and the one the guard above cannot reach.
 *
 * `run` spawns and then swallows the handle: it returns only the collected output, so a
 * rejection from the collection itself propagates out of `run` with nothing left for the
 * caller to kill the command with. `spawn`'s guard covers `logs()` failing *before* a stream
 * exists; a stream that errors while `Response(...).text()` is draining it — a mid-run
 * sandbox log-stream reset — is past that guard, and the command is running by definition,
 * since output had already started arriving (codex review, PR #268).
 */
describe('createProcessSurface run when output collection fails', () => {
  it('kills the process it can no longer hand back', async () => {
    const { surface: s, state } = processSurface(() => ({
      // Output first, then the reset: a stream that errored before emitting anything could be
      // mistaken for a log that never opened, which is the case `spawn` already covers.
      events: [stdoutEvent('partial')],
      eventsError: new Error('log stream reset'),
    }))

    await expect(s.run({ command: 'sleep 100' })).rejects.toThrow('log stream reset')
    expect(state.kills).toBe(1)
  })

  /**
   * The same synchronous throw, on `run`'s own guard — which holds the *harness* process
   * object, whose `kill()` the harness types as `PromiseLike<void>`. `Promise.resolve(x())`
   * evaluates `x()` first, so a throw from the call lands before any promise exists and
   * escapes the `.catch` that follows it (cubic review, PR #268).
   */
  it('rethrows the collection failure when the kill throws synchronously', async () => {
    const { surface: s, state } = processSurface(() => ({
      events: [stdoutEvent('partial')],
      eventsError: new Error('log stream reset'),
      killThrows: new Error('kill threw'),
    }))

    await expect(s.run({ command: 'sleep 100' })).rejects.toThrow('log stream reset')
    expect(state.kills).toBe(1)
  })

  /**
   * Best-effort, for the same reason `spawn`'s guard is: a kill that also failed would replace
   * "the log stream reset" with whatever the kill said and send the caller after the wrong call.
   */
  it('rethrows the collection failure even when the kill fails too', async () => {
    let killed = 0
    const { provider, state } = fakeSandboxProvider({
      script: () => ({ events: [stdoutEvent('partial')], eventsError: new Error('log stream reset') }),
    })
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          const kill = (): Promise<never> => {
            killed++
            return Promise.reject(new Error('kill failed too'))
          }
          return { ...handle, kill }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.run({ command: 'sleep 100' })).rejects.toThrow('log stream reset')
    expect(state.execs).toHaveLength(1)
    // As above: without this, a `run` that dropped the kill outright still rethrows the
    // collection failure and passes, which is the regression this test exists to catch.
    expect(killed).toBe(1)
  })
})

/** How long a stalled teardown holds before settling. Bounded — see {@link stallingTeardown}. */
const STALL_MS = 200

/**
 * A teardown that is slow rather than instant, which is what separates the two spellings.
 *
 * Every spelling of these guards *starts* the cleanup, so `started` alone cannot tell them
 * apart; only the awaited one waits for it to *settle*. A stall makes that gap observable —
 * the rejection either arrives while the teardown is still pending, or it does not.
 *
 * Bounded at `STALL_MS` for the reason `files.cancellation.test.ts` gives for its own stalls:
 * an unbounded teardown reverted against the awaited form hangs the suite instead of naming
 * the defect, and a test that hangs reports nothing.
 *
 * `starts` is a count rather than a flag because one of these tests reaches the same teardown
 * twice — the listener's kill and the guard's — and "at least one call happened" cannot tell
 * the guard's call from the listener's. A guard that dropped its cleanup outright would still
 * see the listener's call and pass, which is the leak the count exists to name.
 */
function stallingTeardown(): { starts: () => number, settled: () => boolean, run: () => Promise<void> } {
  let starts = 0
  let settles = 0
  return {
    starts: () => starts,
    settled: () => settles > 0,
    run: () => {
      starts++
      return new Promise<void>(resolve => setTimeout(() => {
        settles++
        resolve()
      }, STALL_MS))
    },
  }
}

/**
 * The other half of every guard above: the cleanup is *started* and never *waited on*.
 *
 * `kill()` and `cancel()` are RPCs into the sandbox, and each of these three guards runs one
 * on its way to throwing an abort reason at a caller that has already cancelled. Awaiting the
 * RPC hands a backend that is slow — or stuck — in its own teardown the power to hold that
 * rejection back for exactly as long as it hangs, which is the bug class the guards exist to
 * close, reintroduced by the lines that close it. Nothing reads the outcome either way, since
 * `bestEffort` discards it, so the wait bought only the delay (#273, after PR #272 fixed the
 * same shape in `files.ts`).
 *
 * Each test asserts both halves, because they fail in opposite directions: a guard that
 * skipped the cleanup outright would satisfy the timing assertion while leaking the process or
 * the subscription it was supposed to release.
 *
 * All three are abort paths, which is what they have in common: the caller has already
 * cancelled. The one branch that reaches a caller who has *not* is the opposite of this block
 * and is pinned below.
 */
describe('createProcessSurface cleanup that outlives the rejection it precedes', () => {
  /**
   * `startProcess`'s pre-check — the abort that landed while `exec` was in flight.
   *
   * Its listener is attached after the abort has already fired, so it never runs (`abort` is
   * one-shot) and the pre-check's kill is the only one issued: the counters below see that
   * call and no other.
   */
  it('refuses an abort that landed during exec without waiting for the kill it starts', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-exec')
    const kill = stallingTeardown()
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          controller.abort(reason)
          return { ...handle, kill: kill.run }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    // Started, because nobody else holds this process: skipping the kill leaks it into the
    // sandbox for a caller that has already cancelled. Exactly once, because the listener
    // attached to an already-aborted signal never fires.
    expect(kill.starts()).toBe(1)
    // Not settled, because the caller is already back — the kill outlives the rejection
    // rather than the other way round.
    expect(kill.settled()).toBe(false)
  })

  /**
   * `openLogStream`'s `catch`, on the branch where the caller had aborted.
   *
   * The listener is live by now and fires on the same abort, so it starts a kill of its own a
   * moment before this guard starts its second one — which is why the counters count calls
   * rather than latch a single one. The listener's kill is scheduled first and therefore
   * settles first, so under the awaited spelling `settled` is already true by the time the
   * guard's own await resolves.
   */
  it('restores the abort reason on a failed log open without waiting for the kill it starts', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled while the log opened')
    const kill = stallingTeardown()
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            kill: kill.run,
            logs: () => {
              controller.abort(reason)
              return Promise.reject(new Error('backend-specific log failure'))
            },
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    // The reason, not the backend message: a caller that cannot recognise its own abort
    // reports a transport failure instead.
    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    // Twice: the listener's kill and this guard's own. `> 0` would pass on a `catch` that
    // dropped its kill entirely, because the listener's call is already on the counter.
    expect(kill.starts()).toBe(2)
    expect(kill.settled()).toBe(false)
  })

  /**
   * `openLogStream`'s recheck — the abort that landed while `logs()` was resolving.
   *
   * The subscription opened anyway, so this guard releases it; the kill is the listener's, not
   * this one's, which is why the stall under test here is the stream's `cancel` rather than
   * `kill`.
   */
  it('refuses an abort that landed during the log open without waiting for the cancel it starts', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-logs')
    const cancel = stallingTeardown()
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const events = new ReadableStream<ProcessLogEvent>({
      cancel: () => cancel.run(),
    })
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            logs: () => {
              controller.abort(reason)
              return Promise.resolve(events)
            },
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    // Started, because nobody will ever read this subscription — dropping it leaves the
    // stream open against the sandbox. Once: the listener kills the process, not the stream.
    expect(cancel.starts()).toBe(1)
    expect(cancel.settled()).toBe(false)
  })
})

/**
 * The `catch`'s other branch, where nobody cancelled anything and the ordering flips.
 *
 * `logs()` can fail for its own reasons — a backend error, not an abort — and then the caller
 * is not being made to wait for a rejection it already asked for: it is still waiting for a
 * result, and it may retry or tear down the moment the failure arrives. Awaiting the kill
 * discards its outcome exactly as the abort branch does, but it still orders the kill *before*
 * the report, which is the guarantee `sandbox-e2b` pins one layer down in `kill() does not
 * resolve until the walk has actually reaped the process` — a retry that cloned into the same
 * checkout while the previous tree was still being killed is what the ordering prevents (codex
 * and cubic reviews, PR #260; codex review, PR #274).
 *
 * So this test is the inverse of the three above: same stall, opposite verdict on `settled`.
 */
describe('createProcessSurface cleanup that precedes the failure it reports', () => {
  it('awaits the kill before reporting a log open that failed with no abort in play', async () => {
    const kill = stallingTeardown()
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            kill: kill.run,
            logs: () => Promise.reject(new Error('log stream unavailable')),
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    // No signal at all, so the branch is chosen by the absence of one rather than by a signal
    // that happens not to have fired yet — the same shape the suite's other `logsRejects`
    // tests run in.
    await expect(s.spawn({ command: 'sleep 100' })).rejects.toThrow('log stream unavailable')
    // Once, by this guard: there is no listener here to issue a second.
    expect(kill.starts()).toBe(1)
    // Settled, which is the whole difference from the abort branch: the caller learns the
    // spawn failed only after the kill it was owed has actually been issued.
    expect(kill.settled()).toBe(true)
  })

  /**
   * And the window that await opens: the caller aborts *during* the kill this branch waits on.
   *
   * The branch was chosen for a caller that had not cancelled, and then it waits — on an RPC
   * into the sandbox, which is the only reason the wait is worth anything. A caller aborting
   * inside that wait is therefore not an exotic ordering; it is the case the wait exists for,
   * the slow kill. Before the branch was split it could not happen, because the value thrown
   * was decided after the await; splitting the decision to the front is what put it back
   * (codex review, PR #274), and re-asking `nowAborted` afterwards is what closes it again.
   *
   * The abort is fired from inside `kill` rather than from a timer, so it is ordered by the
   * call rather than by the clock: the wait has certainly begun, and has certainly not
   * finished, at the moment the signal fires.
   */
  it('reports the abort reason for a caller that aborted while the kill was in flight', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled while the kill ran')
    const kill = stallingTeardown()
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            kill: () => {
              controller.abort(reason)
              return kill.run()
            },
            logs: () => Promise.reject(new Error('backend-specific log failure')),
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    // The reason, not `log stream unavailable`: a caller handed the backend's error here
    // cannot tell its own cancellation from a sandbox that lost the log stream.
    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    // Twice, and the second one is the proof the abort actually landed: the listener only
    // fires because the signal fired inside the first kill.
    expect(kill.starts()).toBe(2)
    // Still awaited. A guard that answered this case by moving the check ahead of the await
    // would satisfy the assertion above and give back the delay the await is there to buy.
    expect(kill.settled()).toBe(true)
  })
})
