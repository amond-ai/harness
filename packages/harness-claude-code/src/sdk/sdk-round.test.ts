/**
 * The attach round, driven directly over a scripted socket and session.
 *
 * Its clock is injected and its timers are fake, so the window, the settle bounds and the
 * watchdog's thresholds are decided by the test rather than waited for.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTERRUPT_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'
import { runAttachRound } from './sdk-round'
import { RESUME_ACK_TIMEOUT_MS, RESUME_SETTLE_MS } from './sdk-round-settle'
import {
  createFakeSession,
  createFakeTurnHost,
  fakeConfig,
  fakeMirror,
  finishFrame,
  HANDLE,
  interruptsSent,
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

describe('a round that inherits an outstanding interrupt', () => {
  it('kills an unreachable host once the stop\'s grace is over, whatever its silence clock says', async () => {
    // The stop went out a whole settle budget ago; entering refreshed the silence clock, and the
    // budget still has room, so only the outstanding stop says the host is overdue.
    const enteredAt = HANDLE.startedAtMs! + 60_000
    const { session, kill } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: async () => await Promise.reject(new Error('connection refused')),
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: {
        since: 4,
        lastActivityAt: enteredAt,
        interruptedBy: 'watchdog',
        interruptedAt: enteredAt - INTERRUPT_SETTLE_TIMEOUT_MS - 1_000,
      },
      now: runningClock(60_000),
    })
    await vi.advanceTimersByTimeAsync(5_000)
    const state = await round

    expect(state.outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'watchdog' })
    expect(kill).toHaveBeenCalled()
  })
})

describe('a round entered with the turn\'s budget already spent', () => {
  it('kills after the no-turn grace even when a slow redial arms a fresh resume settle', async () => {
    // The stop finds no turn and the socket drops; the redial that finally lands is past the
    // grace, on a host that promises a `bridge-resumed` it never sends.
    const host = createFakeTurnHost({
      helloState: 'running',
      helloLastSeq: 4,
      helloCapabilities: { resumeAck: true },
      onSend: (message, connection) => {
        if (message.type === 'interrupt') {
          connection.emit({ type: 'error', phase: 'run', error: 'no running turn to interrupt' })
          connection.drop()
        }
      },
    })
    const enteredAt = Date.now()
    const replyAt = RESUME_ACK_TIMEOUT_MS
    const connect = async (): Promise<WsLike> => {
      const elapsed = Date.now() - enteredAt
      if (host.connections.length === 0) {
        return await host.connect()
      }
      if (elapsed < replyAt + INTERRUPT_SETTLE_TIMEOUT_MS - 4_000) {
        throw new Error('connection refused')
      }
      await new Promise(resolve => setTimeout(resolve, 4_500))
      return await host.connect()
    }
    const { session, kill } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect,
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: 1,
      previous: { since: 4, lastActivityAt: HANDLE.startedAtMs! },
      now: runningClock(10),
    })
    await vi.advanceTimersByTimeAsync(replyAt + INTERRUPT_SETTLE_TIMEOUT_MS + 15_000)
    const state = await round

    expect(host.connections).toHaveLength(2)
    expect(state.outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'budget' })
    expect(kill).toHaveBeenCalled()
    expect(interruptsSent(host)).toHaveLength(1)
  })

  it('sends no stop on a sample before the replay reaches the greeting\'s last seq', async () => {
    // A replay later than the settle, whose tail is the turn's own run error; the interrupt
    // goes unanswered, as it does on a host already unwinding its turn.
    const host = createFakeTurnHost({
      helloState: 'running',
      helloLastSeq: 5,
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          setTimeout(() => connection.emit({ type: 'error', seq: 5, phase: 'run', error: 'boom' }), RESUME_SETTLE_MS + 500)
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
      budgetMs: 1,
      previous: { since: 4, lastActivityAt: HANDLE.startedAtMs! },
      now: runningClock(10),
    })
    await vi.advanceTimersByTimeAsync(RESUME_SETTLE_MS + 600)
    const state = await round

    expect(interruptsSent(host)).toHaveLength(0)
    expect(state.outcome).toMatchObject({ outcome: 'failed' })
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('a round retried from a cursor behind what its mirror published', () => {
  it('repeats no outward effect of a frame at or below the mirror\'s cursor, and folds it all the same', async () => {
    const appended: string[] = []
    const reported: (number | undefined)[] = []
    const host = createFakeTurnHost({
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          connection.emit({ type: 'raw', seq: 2, rawValue: { type: 'assistant' } })
          connection.emit({ type: 'sandbox-log', seq: 3, source: 'bridge', stream: 'stdout', line: 'replayed' })
          connection.emit({ type: 'raw', seq: 4, rawValue: { type: 'user' } })
          connection.emit(finishFrame({ seq: 5 }))
        }
      },
    })
    const { session } = createFakeSession()

    const state = await runAttachRound({
      session,
      handle: HANDLE,
      connect: host.connect,
      config: fakeConfig(),
      mirror: fakeMirror(appended, '3'),
      budgetMs: BUDGET_MS,
      previous: { since: 1, lastActivityAt: HANDLE.startedAtMs! },
      onFrame: (_frame, seq) => reported.push(seq),
      now: runningClock(0),
    })

    expect(reported).toEqual([4, 5])
    expect(appended).toEqual([`${JSON.stringify({ type: 'user' })}\n`])
    expect(vi.mocked(console.warn).mock.calls.flat()).not.toContainEqual(expect.stringContaining('replayed'))
    expect(state).toMatchObject({ since: 5, outcome: { outcome: 'succeeded' } })
  })
})
