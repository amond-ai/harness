/**
 * The attach round, driven directly over a scripted socket and session.
 *
 * Its clock is injected and its timers are fake, so the window, the settle bounds and the
 * watchdog's thresholds are decided by the test rather than waited for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAttachRound } from './sdk-round'
import {
  createFakeSession,
  createFakeTurnHost,
  fakeConfig,
  fakeMirror,
  finishFrame,
  HANDLE,
  runningClock,
} from './sdk-round.fixtures'

const BUDGET_MS = 6 * 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the scripted attach round', () => {
  it('resumes from the carried cursor, mirrors the record, and ends on finish', async () => {
    const appended: string[] = []
    const host = createFakeTurnHost({
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          connection.emit({ type: 'raw', seq: 2, rawValue: { type: 'assistant' } })
          connection.emit(finishFrame())
        }
      },
    })
    const { session, kill } = createFakeSession()

    const state = await runAttachRound({
      session,
      handle: HANDLE,
      connect: host.connect,
      config: fakeConfig(),
      mirror: fakeMirror(appended),
      budgetMs: BUDGET_MS,
      previous: { since: 1, lastActivityAt: HANDLE.startedAtMs! },
      now: runningClock(0),
    })

    expect(host.connections[0]?.sent[0]).toEqual({ type: 'resume', lastSeenEventId: 1 })
    expect(appended).toEqual([`${JSON.stringify({ type: 'assistant' })}\n`])
    expect(state).toMatchObject({ since: 3, outcome: { outcome: 'succeeded', exitCode: 0 } })
    expect(host.connections[0]?.sent.at(-1)).toEqual({ type: 'destroy' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('ends on an aborted signal as it would on its own window, with the cursor it consumed', async () => {
    const controller = new AbortController()
    const host = createFakeTurnHost({
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          connection.emit({ type: 'raw', seq: 5, rawValue: { type: 'assistant' } })
          setTimeout(() => controller.abort(), 50)
        }
      },
    })
    const { session, kill } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: host.connect,
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: undefined,
      signal: controller.signal,
      now: runningClock(0),
    })
    await vi.advanceTimersByTimeAsync(50)
    const state = await round

    expect(state.outcome).toBeUndefined()
    expect(state.since).toBe(5)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('a round that cannot reach its host', () => {
  it('returns the turn for the next round when a suspend lands while the host loss is being confirmed', async () => {
    const controller = new AbortController()
    // The budget is spent, so the unreachable verdict would kill; the probe is where the suspend lands.
    const { session, kill } = createFakeSession([{ id: HANDLE.processId, onStatus: () => controller.abort() }])

    const state = await runAttachRound({
      session,
      handle: HANDLE,
      connect: async () => await Promise.reject(new Error('connection refused')),
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: 1,
      previous: undefined,
      signal: controller.signal,
      now: runningClock(10),
      sleep: async () => {},
    })

    expect(controller.signal.aborted).toBe(true)
    expect(state.outcome).toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
  })
})
