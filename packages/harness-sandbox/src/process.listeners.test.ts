/**
 * Which listeners `createProcessSurface` leaves on the caller's signal, and which it takes off.
 *
 * Its own file rather than a third block in `process.cleanup.test.ts`, which is full: that
 * suite is at the 500-line ceiling, and this is a different question in any case. Every test
 * there asks what a guard *did* — a kill issued, a subscription released — and can read the
 * answer off the fixture's recorded calls. A listener left behind does nothing at all: on the
 * paths that leak it never fires, because `abort` is one-shot and has already fired. It is
 * only visible in what the signal is still holding, which is what {@link trackListeners}
 * watches — and watches through the runtime's own collection rather than around it, since a
 * signal that dropped a listener itself is not holding one either.
 */
import type { ProcessLogEvent } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import { createProcessSurface } from './process'
import { fakeSandboxProvider, FIXTURE_CWD } from './sandbox.fixtures'

/**
 * Which listeners a signal is left carrying, which is a leak nothing else here would notice.
 *
 * Wrapping the instance's own `addEventListener`/`removeEventListener` rather than counting
 * kills, because the two questions are different: a listener that is never removed still never
 * fires — `abort` is one-shot, and on the paths that leak it has already fired — so it costs
 * nothing observable per spawn and everything cumulatively.
 *
 * The wrapper around the callback is what makes `live` mean the runtime rather than this
 * helper's own bookkeeping. `{ once: true }` collection does *not* go through
 * `removeEventListener` — it is internal to the `EventTarget`, measured under Bun 1.3.14: a
 * wrapped `removeEventListener` records zero calls after a once-listener fires, and the
 * listener is genuinely gone (a second `dispatchEvent` does not re-run it). A set built from
 * add-minus-remove therefore keeps reporting a listener the signal no longer holds, which is a
 * green assertion resting on a fixture that mis-models the runtime — coverage that is not
 * there (cubic review, PR #274; its stated mechanism was that `once` calls
 * `removeEventListener`, which it does not, but the conclusion holds for this reason).
 *
 * So the map is keyed by the caller's own function and holds the wrapper actually attached:
 * firing under `once` drops the entry, exactly as the runtime drops the listener, and
 * `removeEventListener(original)` still finds the wrapper to take off. A removal aimed at some
 * *other* function still cannot pass as a removal of this one.
 */
function trackListeners(signal: AbortSignal): { added: () => number, live: () => number } {
  const attached = new Map<unknown, EventListener>()
  let added = 0
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type: string, listener: unknown, listenerOptions?: unknown) => {
    added++
    const once = (listenerOptions as AddEventListenerOptions | undefined)?.once === true
    const wrapper: EventListener = (event) => {
      if (once) {
        attached.delete(listener)
      }
      const callback = listener as EventListener
      callback(event)
    }
    attached.set(listener, wrapper)
    add(type, wrapper, listenerOptions as AddEventListenerOptions)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, listener: unknown, listenerOptions?: unknown) => {
    const wrapper = attached.get(listener)
    attached.delete(listener)
    remove(type, wrapper ?? (listener as EventListener), listenerOptions as EventListenerOptions)
  }) as typeof signal.removeEventListener
  return { added: () => added, live: () => attached.size }
}

/**
 * The listener `startProcess` attaches, and the one exit that has to take it off again.
 *
 * The attach is deliberately ahead of the pre-check — that ordering is what closes the window
 * around `exec` — so a refused spawn throws with a listener already on the signal, and
 * `{ once: true }` cannot collect it: `abort` has fired, so it will never fire again. One
 * signal serves a whole turn of spawns, and each dead listener holds the process handle and
 * the closure around it, so they accumulate for as long as the caller holds the signal
 * (gemini review, PR #274).
 */
describe('createProcessSurface abort listeners on the caller signal', () => {
  it('takes its listener back off the signal when it refuses the spawn', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-exec')
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider()
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

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    // Attached first and then removed, rather than never attached: the attach is what closes
    // the `exec` window, and a spawn that stopped attaching would pass a bare `live() === 0`.
    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(0)
  })

  /**
   * And the exit that must *not* remove it, which is the whole point of attaching one: the
   * caller holds a live process, and killing it on a later abort is the listener's only job.
   */
  it('leaves its listener attached for a spawn that succeeded', async () => {
    const controller = new AbortController()
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider()
    const s = createProcessSurface({
      sandbox: provider.session('sbx'),
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await s.spawn({ command: 'sleep 100', abortSignal: controller.signal })

    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(1)
  })
})

/**
 * The other exit that refuses a spawn: `openLogStream` throws, and `spawn` has no process to
 * hand back either.
 *
 * The pre-check's leak and this one are the same leak — gemini's finding is that a refused
 * spawn leaves its listener behind, and a spawn refused here is a refused spawn. Fixing the
 * one exit and not the other is the asymmetry that produced #273 in the first place.
 *
 * Both shapes are exercised because round 2 split them onto different branches: an abort
 * landing while `logs()` resolves reaches the recheck, and a `logs()` that rejects with no
 * abort in play reaches the `catch`'s awaited-kill branch. Only the second of them *pins* the
 * detach, and the first test below says why in its own comment — measured by deleting the
 * detach, not read off the code.
 */
describe('createProcessSurface abort listeners when the log stream refuses the spawn', () => {
  /**
   * This one does not pin the detach, and saying so is the point of the comment.
   *
   * The abort lands *after* the listener is attached, so the listener fires, and a listener
   * that fires under `{ once: true }` is collected by the runtime itself — `live()` reaches 0
   * whether or not `spawn` detaches. Measured, not assumed: deleting the detach leaves this
   * test green and fails only its sibling below (cubic review, PR #274).
   *
   * What it does establish is still worth having, and is what the assertions say: this exit
   * leaves the signal clean, by whichever route. That is the property the caller has — the
   * detach is one of the two ways of holding it, and a change that broke *both* (attaching
   * without `once`, say, and dropping the detach) fails here and nowhere else.
   */
  it('leaves the signal clean when the abort lands while the log opens', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled mid-logs')
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const s = createProcessSurface({
      sandbox: {
        ...session,
        exec: async (command, execOptions) => {
          const handle = await session.exec(command, execOptions)
          return {
            ...handle,
            logs: () => {
              controller.abort(reason)
              return Promise.resolve(new ReadableStream<ProcessLogEvent>())
            },
          }
        },
      },
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal })).rejects.toBe(reason)
    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(0)
  })

  /**
   * And the branch with no abort at all, where the listener is even more plainly dead: it was
   * attached for a process that no longer has a caller, and the signal it is on may serve the
   * whole rest of the turn.
   */
  it('takes its listener back off when the log open fails with no abort in play', async () => {
    const controller = new AbortController()
    const listeners = trackListeners(controller.signal)
    const { provider } = fakeSandboxProvider({
      script: () => ({ logsRejects: new Error('log stream unavailable') }),
    })
    const s = createProcessSurface({
      sandbox: provider.session('sbx'),
      defaultWorkingDirectory: FIXTURE_CWD,
    })

    await expect(s.spawn({ command: 'sleep 100', abortSignal: controller.signal }))
      .rejects
      .toThrow('log stream unavailable')
    // Attached as well as removed: the attach is what covers the `exec` window, and a spawn
    // that stopped attaching would pass a bare `live() === 0`.
    expect(listeners.added()).toBe(1)
    expect(listeners.live()).toBe(0)
  })
})
