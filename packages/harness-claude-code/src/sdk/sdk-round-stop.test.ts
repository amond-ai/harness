/**
 * The stop a round owes across its dials: what a redial may hold back, and how long it may dial.
 *
 * Driven over the same scripted socket, session and fake timers as `sdk-round.test.ts`.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'
import { runAttachRound } from './sdk-round'
import { RESUME_ACK_TIMEOUT_MS } from './sdk-round-settle'
import { createFakeSession, createFakeTurnHost, fakeConfig, finishFrame, HANDLE, interruptsSent, runningClock } from './sdk-round.fixtures'

const BUDGET_MS = 6 * 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a round entered with the turn\'s budget already spent', () => {
  it('kills after the stop\'s grace even when a slow redial would arm a fresh resume settle', async () => {
    // The stop goes unanswered and the socket drops; the redial that finally lands is past the
    // grace, on a host that promises a `bridge-resumed` it never sends.
    const host = createFakeTurnHost({
      helloState: 'running',
      helloLastSeq: 4,
      helloCapabilities: { resumeAck: true },
      onSend: (message, connection) => {
        if (message.type === 'interrupt') {
          connection.drop()
        }
      },
    })
    const enteredAt = Date.now()
    const interruptAt = RESUME_ACK_TIMEOUT_MS
    const connect = async (): Promise<WsLike> => {
      if (host.connections.length === 0) {
        return await host.connect()
      }
      if (Date.now() - enteredAt < interruptAt + INTERRUPT_SETTLE_TIMEOUT_MS - 4_000) {
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
    await vi.advanceTimersByTimeAsync(interruptAt + INTERRUPT_SETTLE_TIMEOUT_MS + 15_000)
    const state = await round

    expect(host.connections).toHaveLength(2)
    expect(state.outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'budget' })
    expect(kill).toHaveBeenCalled()
    expect(interruptsSent(host)).toHaveLength(1)
  })

  it('does not let a status probe started inside the replay hold send the stop past queued frames', async () => {
    // The replay's tail — the turn's own run error — arrives while a probe that began just inside
    // the hold is still out, and the probe returns after the hold has expired.
    const enteredAt = Date.now()
    const host = createFakeTurnHost({
      helloState: 'running',
      helloLastSeq: 5,
      onSend: (message, connection) => {
        if (message.type === 'resume') {
          setTimeout(() => connection.emit({ type: 'error', seq: 5, phase: 'run', error: 'boom' }), 4_900)
        }
      },
    })
    let slowed = false
    const { session, kill } = createFakeSession([{
      id: HANDLE.processId,
      onStatus: async () => {
        if (!slowed && Date.now() - enteredAt >= 4_800) {
          slowed = true
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      },
    }])

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
    await vi.advanceTimersByTimeAsync(6_000)
    const state = await round

    expect(interruptsSent(host)).toHaveLength(0)
    expect(state.outcome).toMatchObject({ outcome: 'failed' })
    expect(kill).not.toHaveBeenCalled()
  })
  it('sends the stop as the replay hold ends on a host whose lastSeq no replay reaches', async () => {
    // A host older than `resumeAck` whose greeting counts live-only frames: nothing replayed ever
    // reaches its `lastSeq`, so only the hold's bound lets the budget's stop out.
    const host = createFakeTurnHost({
      helloState: 'running',
      helloLastSeq: 9,
      onSend: (message, connection) => {
        if (message.type === 'interrupt') {
          connection.emit(finishFrame({ seq: 10, stopped: 'interrupted' }))
        }
      },
    })
    const { session } = createFakeSession()

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: host.connect,
      // A production-sized sample interval: a slice of it would hold the stop for 30 s.
      config: fakeConfig({ livenessSampleIntervalMs: 30_000 }),
      mirror: undefined,
      budgetMs: 1,
      previous: { since: 4, lastActivityAt: HANDLE.startedAtMs! },
      now: runningClock(10),
    })
    await vi.advanceTimersByTimeAsync(RESUME_ACK_TIMEOUT_MS - 1)
    expect(interruptsSent(host)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)

    expect(interruptsSent(host)).toEqual([{ type: 'interrupt', reason: 'budget' }])
    expect((await round).outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'budget' })
  })
})

describe('a round that inherits an outstanding interrupt', () => {
  it('bounds each redial by what is left of the stop\'s settle deadline, not by the entry remainder', async () => {
    const enteredAt = HANDLE.startedAtMs! + 60_000
    const startedAt = Date.now()
    let dials = 0
    const connect = async (): Promise<WsLike> => {
      dials += 1
      if (dials === 1) {
        // Fails late, still inside the stop's grace.
        await new Promise(resolve => setTimeout(resolve, INTERRUPT_SETTLE_TIMEOUT_MS - 2_000))
        throw new Error('connection refused')
      }
      return await new Promise<WsLike>(() => {})
    }
    const { session, kill } = createFakeSession()
    let settled = false

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect,
      config: fakeConfig({ livenessSampleIntervalMs: 30_000 }),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: {
        since: 4,
        lastActivityAt: enteredAt,
        interruptedBy: 'watchdog',
        interruptedAt: enteredAt - 1_000,
      },
      now: runningClock(60_000),
    }).finally(() => {
      settled = true
    })
    // The stop's settle deadline, plus the backoff between the two dials.
    const settleDeadline = INTERRUPT_SETTLE_TIMEOUT_MS + KILL_SETTLE_TIMEOUT_MS - 1_000
    await vi.advanceTimersByTimeAsync(settleDeadline + 1_000)

    expect(dials).toBe(2)
    expect(settled).toBe(true)
    expect(Date.now() - startedAt).toBeLessThanOrEqual(settleDeadline + 1_000)
    expect((await round).outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'watchdog' })
    expect(kill).toHaveBeenCalled()
  })

  it('measures the grace of a stop carried without its time from the round\'s entry', async () => {
    const enteredAt = HANDLE.startedAtMs! + 60_000
    const { session, kill } = createFakeSession()
    let settled = false

    const round = runAttachRound({
      session,
      handle: HANDLE,
      connect: async () => await Promise.reject(new Error('connection refused')),
      config: fakeConfig(),
      mirror: undefined,
      budgetMs: BUDGET_MS,
      previous: { since: 4, lastActivityAt: enteredAt, interruptedBy: 'watchdog' },
      now: runningClock(60_000),
    }).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(INTERRUPT_SETTLE_TIMEOUT_MS - 1_000)
    // Inside the grace: the round redials for the host's answer rather than killing it.
    expect(settled).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(settled).toBe(true)
    expect((await round).outcome).toMatchObject({ outcome: 'timed-out', timedOutBy: 'watchdog' })
    expect(kill).toHaveBeenCalled()
  })
})
