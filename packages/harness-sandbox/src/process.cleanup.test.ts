/**
 * The cleanup guards: every failure path that must not leave a live process behind.
 *
 * Split out of `process.test.ts`, which carries the behaviour of `spawn` and `run` themselves.
 * These two suites are about one thing instead: a sandbox that fails *after* the command is
 * already running, where the surface holds the only handle and the caller is about to be told
 * the call failed. Each of them pins a kill, the original cause surviving that kill, and the
 * kill being best-effort in both of the shapes a failure can take.
 */
import { describe, expect, it } from 'bun:test'
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
