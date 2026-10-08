import type { PumpContext } from './sdk-round'
import type { TurnRoundState } from './sdk-round-state'
import { describe, expect, it } from 'vitest'
import { foldBackgroundWait } from './sdk-background-wait'
import { timeoutCauseOf } from './sdk-round-verdict'

/** One transcript line, the way a `raw` frame becomes one (`sdk-frames.ts`). */
function line(message: Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`
}

const RESULT = { type: 'result', subtype: 'success', terminal_reason: 'completed', num_turns: 3 }

describe('foldBackgroundWait', () => {
  const state: TurnRoundState = { since: 4, lastActivityAt: 1_000 }

  it('counts the live non-ambient tasks of a background_tasks_changed, replacing the last count', () => {
    const one = foldBackgroundWait(state, line({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ id: 'gate' }, { id: 'watcher', ambient: true }],
    }))

    expect(one).toEqual({ since: 4, lastActivityAt: 1_000, backgroundTasks: 1 })
    // A level signal: an empty set clears the count rather than leaving it at one.
    expect(foldBackgroundWait(one, line({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })))
      .toEqual(state)
  })

  it('waits after a completed result that left work running, and not after one that did not', () => {
    expect(foldBackgroundWait({ ...state, backgroundTasks: 2 }, line(RESULT)))
      .toEqual({ ...state, backgroundTasks: 2, awaitingBackground: true })
    expect(foldBackgroundWait(state, line(RESULT))).toEqual(state)
    // An older CLI names no terminal reason; a completed result is still a completed result.
    expect(foldBackgroundWait({ ...state, backgroundTasks: 1 }, line({ type: 'result', subtype: 'success' })))
      .toMatchObject({ awaitingBackground: true })
  })

  it('never waits after a result that did not complete', () => {
    const running = { ...state, backgroundTasks: 1, awaitingBackground: true as const }

    expect(foldBackgroundWait(running, line({ ...RESULT, subtype: 'error_during_execution' })))
      .toEqual({ ...state, backgroundTasks: 1 })
    expect(foldBackgroundWait(running, line({ ...RESULT, terminal_reason: 'tool_deferred' })))
      .toEqual({ ...state, backgroundTasks: 1 })
  })

  it('reads a completed turn the way the host does: every terminal reason but the aborted and deferred ones', () => {
    const tasks = { ...state, backgroundTasks: 1 }

    expect(foldBackgroundWait(tasks, line({ ...RESULT, terminal_reason: 'stop_hook_prevented' })))
      .toMatchObject({ awaitingBackground: true })
    expect(foldBackgroundWait(tasks, line({ ...RESULT, terminal_reason: 'aborted_streaming' })))
      .toEqual(tasks)
    expect(foldBackgroundWait(tasks, line({ ...RESULT, terminal_reason: 'aborted_tools' }))).toEqual(tasks)
  })

  it('keeps waiting through an empty result of a batched wake, but does not start a wait on one', () => {
    const batched = line({ ...RESULT, origin: { kind: 'task-notification' }, num_turns: 0 })

    expect(foldBackgroundWait({ ...state, awaitingBackground: true }, batched))
      .toEqual({ ...state, awaitingBackground: true })
    expect(foldBackgroundWait(state, batched)).toEqual(state)
  })

  it('ends the wait when the main thread speaks, but not when a background subagent does', () => {
    const waiting = { ...state, backgroundTasks: 1, awaitingBackground: true as const }

    for (const type of ['assistant', 'user', 'stream_event']) {
      expect(foldBackgroundWait(waiting, line({ type, parent_tool_use_id: null })))
        .toEqual({ ...state, backgroundTasks: 1 })
    }
    expect(foldBackgroundWait(waiting, line({ type: 'assistant', parent_tool_use_id: 'toolu_1' })))
      .toEqual(waiting)
  })

  it('leaves the state alone on a line it cannot read or a message it does not track', () => {
    const waiting = { ...state, awaitingBackground: true as const }

    expect(foldBackgroundWait(waiting, 'not json\n')).toBe(waiting)
    expect(foldBackgroundWait(waiting, line({ type: 'system', subtype: 'init' }))).toBe(waiting)
  })
})

describe('timeoutCauseOf over a background wait', () => {
  const context = (state: TurnRoundState, interruptedBy?: 'watchdog') => ({
    input: { handle: { startedAtMs: 0 }, budgetMs: 10_000_000, config: { watchdogTimeoutMs: 1_000, livenessWindowMs: 100 } },
    state,
    ...(interruptedBy === undefined ? {} : { interruptedBy }),
  }) as unknown as PumpContext
  const waiting: TurnRoundState = { since: 1, lastActivityAt: 0, backgroundTasks: 1, awaitingBackground: true }

  it('exempts silence while nothing has asked the turn to stop', () => {
    expect(timeoutCauseOf(context(waiting), 5_000)).toBeUndefined()
  })

  it('judges silence again once a stop is outstanding, on the round or in the carried state', () => {
    expect(timeoutCauseOf(context(waiting, 'watchdog'), 5_000)).toBe('watchdog')
    expect(timeoutCauseOf(context({ ...waiting, interruptedBy: 'watchdog', interruptedAt: 1 }), 5_000)).toBe('watchdog')
  })
})
