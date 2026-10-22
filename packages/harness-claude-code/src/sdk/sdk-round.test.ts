/**
 * The attach round, driven directly over a scripted socket and session.
 *
 * Its clock is injected and its timers are fake, so the window, the settle bounds and the
 * watchdog's thresholds are decided by the test rather than waited for.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS } from '../turn-kill'
import { runAttachRound } from './sdk-round'
import { SPENT_BUDGET_CONNECT_TIMEOUT_MS } from './sdk-round-dial'
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

describe('a round whose dial does not complete', () => {
  it('ends on a suspend that lands while the connect is still pending, and closes the late socket', async () => {
    const controller = new AbortController()
    const host = createFakeTurnHost()
    let arrive: (() => void) | undefined
    const connect = async (): Promise<WsLike> => {
      await new Promise<void>((resolve) => {
        arrive = resolve
      })
      return await host.connect()
    }
    const { session, kill } = createFakeSession()
    let settled = false

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect,
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: undefined,
      signal: controller.signal,
      now: runningClock(0),
    }).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    await vi.advanceTimersByTimeAsync(100)

    expect(settled).toBe(true)
    expect((await round).outcome).toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
    arrive?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.connections[0]?.closed).toBe(true)
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

  it('reports an inherited watchdog stop as the budget when the budget is spent and the host is unreachable', async () => {
    const enteredAt = HANDLE.startedAtMs! + 60_000
    const { session, kill } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: async () => await Promise.reject(new Error('connection refused')),
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: 1_000,
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

    expect(state.outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'budget' })
    expect(kill).toHaveBeenCalled()
  })

  it('dials a host whose stop is already due with no more than the short bound, not a full connect', async () => {
    const enteredAt = HANDLE.startedAtMs! + 60_000
    const { session, kill } = createFakeSession()
    let settled = false

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: async () => await new Promise<WsLike>(() => {}),
      // A production-sized sample interval: the round's deadline is floored by it, the stop's is not.
      config: fakeConfig({ livenessSampleIntervalMs: 30_000 }),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: {
        since: 4,
        lastActivityAt: enteredAt,
        interruptedBy: 'watchdog',
        interruptedAt: enteredAt - INTERRUPT_SETTLE_TIMEOUT_MS - KILL_SETTLE_TIMEOUT_MS,
      },
      now: runningClock(60_000),
    }).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(SPENT_BUDGET_CONNECT_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(settled).toBe(true)
    expect((await round).outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'watchdog' })
    expect(kill).toHaveBeenCalled()
  })
  it('gives a connect and its greeting one handshake bound between them, not one each', async () => {
    // The socket arrives just inside the bound, and the bridge behind it never greets.
    const host = createFakeTurnHost({ greet: false })
    const enteredAt = HANDLE.startedAtMs! + 60_000
    const { session, kill } = createFakeSession()
    let settled = false

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: async () => {
        await new Promise(resolve => setTimeout(resolve, SPENT_BUDGET_CONNECT_TIMEOUT_MS - 100))
        return await host.connect()
      },
      config: fakeConfig({ livenessSampleIntervalMs: 30_000 }),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: {
        since: 4,
        lastActivityAt: enteredAt,
        interruptedBy: 'watchdog',
        interruptedAt: enteredAt - INTERRUPT_SETTLE_TIMEOUT_MS - KILL_SETTLE_TIMEOUT_MS,
      },
      now: runningClock(60_000),
    }).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(SPENT_BUDGET_CONNECT_TIMEOUT_MS)

    expect(host.connections).toHaveLength(1)
    expect(settled).toBe(true)
    expect((await round).outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'watchdog' })
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

  /**
   * What a consumer's dedupe rests on (#26): a failed step's reports above the mirror's cursor
   * come round again, but each under the `seq` it carried the first time.
   */
  it('reports again what a failed step reported past the mirror\'s cursor, under the same seq', async () => {
    const journal = [
      { type: 'raw', seq: 2, rawValue: { type: 'assistant' } },
      { type: 'sandbox-log', seq: 3, source: 'bridge', stream: 'stdout', line: 'logged' },
      { type: 'raw', seq: 4, rawValue: { type: 'user' } },
      finishFrame({ seq: 5 }),
    ]
    const host = createFakeTurnHost({
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          journal.filter(frame => Number(frame.seq) > Number(message.lastSeenEventId)).forEach(connection.emit)
        }
      },
    })
    const { session } = createFakeSession()
    // Both steps start from the same committed state: a step that fails commits nothing.
    const step = async (stored: string, failAt?: number): Promise<{ seq: number | undefined, frame: unknown }[]> => {
      const reported: { seq: number | undefined, frame: unknown }[] = []
      await runAttachRound({
        session,
        handle: HANDLE,
        connect: host.connect,
        config: fakeConfig(),
        mirror: fakeMirror([], stored),
        budgetMs: BUDGET_MS,
        previous: { since: 1, lastActivityAt: HANDLE.startedAtMs! },
        onFrame: (frame, seq) => {
          reported.push({ seq, frame })
          if (seq === failAt) {
            throw new Error('step died')
          }
        },
        now: runningClock(0),
      }).catch(() => undefined)
      return reported
    }

    // The first step dies once it has reported seq 4. Its mirror's last put had reached seq 2,
    // and that is all the retry has to go on.
    const failed = await step('1', 4)
    const retried = await step('2')

    expect(failed.map(report => report.seq)).toEqual([2, 3, 4])
    expect(retried.map(report => report.seq)).toEqual([3, 4, 5])
    expect(retried.slice(0, 2)).toEqual(failed.slice(1))
  })
})

describe('a round over a turn waiting on background work', () => {
  it('judges silence again once a woken turn starts streaming, though it stalls before a complete block', async () => {
    const host = createFakeTurnHost({
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          // A main-thread stream part: the CLI woke a turn, which then stalls mid-stream.
          connection.emit({ type: 'text-start', id: 'text-1', seq: 5 })
        }
        if (message.type === 'interrupt') {
          connection.emit(finishFrame({ seq: 6, stopped: 'interrupted' }))
        }
      },
    })
    const { session } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: host.connect,
      config: fakeConfig({ watchdogTimeoutMs: 10_000 }),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: { since: 4, lastActivityAt: HANDLE.startedAtMs!, awaitingBackground: true },
      now: runningClock(0),
    })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(interruptsSent(host)).toEqual([{ type: 'interrupt', reason: 'watchdog' }])
    const state = await round
    expect(state.awaitingBackground).toBeUndefined()
    expect(state.outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'watchdog' })
  })

  it('keeps the wait over the structured output a JSON-format result is rendered as', async () => {
    const controller = new AbortController()
    const host = createFakeTurnHost({
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          // What the host emits for a `result` under `responseFormat: json` that leaves work
          // running: the result, its structured output as one text block, the step's end.
          connection.emit({
            type: 'raw',
            seq: 5,
            rawValue: { type: 'result', subtype: 'success', terminal_reason: 'completed', structured_output: { ok: true } },
          })
          connection.emit({ type: 'text-start', id: 'json-1', seq: 6 })
          connection.emit({ type: 'text-delta', id: 'json-1', delta: '{"ok":true}', seq: 7 })
          connection.emit({ type: 'text-end', id: 'json-1', seq: 8 })
          connection.emit({
            type: 'finish-step',
            seq: 9,
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: {}, outputTokens: {} },
          })
        }
      },
    })
    const { session } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: host.connect,
      config: fakeConfig({ watchdogTimeoutMs: 10_000 }),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: { since: 4, lastActivityAt: HANDLE.startedAtMs!, backgroundTasks: 1 },
      signal: controller.signal,
      now: runningClock(0),
    })
    await vi.advanceTimersByTimeAsync(15_000)

    expect(interruptsSent(host)).toEqual([])
    controller.abort()
    const state = await round
    expect(state).toMatchObject({ since: 9, awaitingBackground: true })
    expect(state.outcome).toBeUndefined()
  })
})
