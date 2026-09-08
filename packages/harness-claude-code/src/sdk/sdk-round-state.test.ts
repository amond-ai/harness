import { describe, expect, it } from 'vitest'
import { applyFrame, interruptedResult, observedResult, roundEnded, terminalResult } from './sdk-round-state'

describe('applyFrame', () => {
  const state = { since: 4, lastActivityAt: 1_000 }

  it('advances the cursor and resets the silence clock on any frame that carries a seq', () => {
    expect(applyFrame(state, { kind: 'liveness', seq: 9 }, 2_000))
      .toEqual({ since: 9, lastActivityAt: 2_000 })
  })

  it('never moves the cursor backwards', () => {
    // `resume` replays from the journal, so a round can legitimately see a seq it already has.
    expect(applyFrame(state, { kind: 'transcript', seq: 2, line: 'x\n' }, 2_000))
      .toEqual({ since: 4, lastActivityAt: 2_000 })
  })

  it('leaves the handshake out of both — it is the connection, not the turn', () => {
    expect(applyFrame(state, { kind: 'hello', state: 'waiting', lastSeq: 40 }, 2_000)).toEqual(state)
  })

  it('counts an unreadable frame as liveness without advancing a cursor it could not read', () => {
    expect(applyFrame(state, { kind: 'unreadable', reason: 'bad' }, 2_000))
      .toEqual({ since: 4, lastActivityAt: 2_000 })
  })
})

describe('terminalResult', () => {
  it('maps every ending the host can report', () => {
    expect(terminalResult({ type: 'finish', stopped: 'completed' })).toEqual({ outcome: 'succeeded' })
    // The good ending of a stop: the agent produced a real result, so nothing is left running.
    expect(terminalResult({ type: 'finish', stopped: 'interrupted' }))
      .toEqual({ outcome: 'timed-out', killConfirmed: true })
    // D6 layer 3 with nothing to defer *about*: a host older than `deferredToolUse`, or one
    // that dropped it. Read as a failure rather than as a pause nobody can answer.
    expect(terminalResult({ type: 'finish', stopped: 'deferred' })).toEqual({ outcome: 'failed' })
    for (const phase of ['start', 'init', 'run'] as const) {
      expect(terminalResult({ type: 'error', phase, error: 'boom' })).toEqual({ outcome: 'failed' })
    }
  })
})

describe('a finish that stopped on a deferred call (D6 layer 3)', () => {
  const deferred = { id: 'req-1', name: 'Bash', input: { command: 'ls' } }

  it('names the call the run has to get an answer for', () => {
    expect(terminalResult({ type: 'finish', stopped: 'deferred', deferredToolUse: deferred }))
      .toEqual({ outcome: 'deferred', deferredToolUse: deferred })
  })

  it('carries the session, so the attempt that replays the answer can resume the same turn', () => {
    expect(terminalResult({
      type: 'finish',
      stopped: 'deferred',
      deferredToolUse: deferred,
      sessionArtifacts: {
        sessionId: 'sess-1',
        sessionTranscriptPath: '/root/.claude/projects/-workspace-repo/sess-1.jsonl',
        journalPath: '/workspace/.turn-host/run-1/1/event-log.ndjson',
      },
    })).toEqual({
      outcome: 'deferred',
      deferredToolUse: deferred,
      session: {
        sessionId: 'sess-1',
        transcriptPath: '/root/.claude/projects/-workspace-repo/sess-1.jsonl',
        journalPath: '/workspace/.turn-host/run-1/1/event-log.ndjson',
      },
    })
  })
})

describe('the session a terminal frame reports (D8)', () => {
  const artifacts = {
    sessionId: 'sess-1',
    sessionTranscriptPath: '/root/.claude/projects/-workspace-repo/sess-1.jsonl',
    journalPath: '/state/event-log.ndjson',
  }

  it('carries the host\'s two paths and the id onto the attempt result', () => {
    expect(terminalResult({ type: 'finish', stopped: 'completed', sessionArtifacts: artifacts })).toEqual({
      outcome: 'succeeded',
      session: {
        sessionId: 'sess-1',
        transcriptPath: '/root/.claude/projects/-workspace-repo/sess-1.jsonl',
        journalPath: '/state/event-log.ndjson',
      },
    })
  })

  /**
   * The *good* ending of a stop: the agent answered `query.interrupt()` with a real result, and
   * the session it leaves is exactly the one the next attempt should resume — arguably more so,
   * since an interrupted turn left work unfinished.
   */
  it('carries it on an interrupted finish, whether or not this side asked for the stop', () => {
    expect(terminalResult({ type: 'finish', stopped: 'interrupted', sessionArtifacts: artifacts }))
      .toMatchObject({ outcome: 'timed-out', session: { sessionId: 'sess-1' } })
    expect(observedResult({ type: 'finish', stopped: 'interrupted', sessionArtifacts: artifacts }, 'watchdog'))
      .toEqual({
        outcome: 'timed-out',
        killConfirmed: true,
        timedOutBy: 'watchdog',
        session: {
          sessionId: 'sess-1',
          transcriptPath: '/root/.claude/projects/-workspace-repo/sess-1.jsonl',
          journalPath: '/state/event-log.ndjson',
        },
      })
  })

  /**
   * The case the loop actually retries: a run-phase `error` is how a turn ordinarily fails, and
   * `system`/`init` named a session long before it — so the failed attempt is precisely the one
   * whose session the next attempt wants.
   */
  it('carries it off a run-phase error, which is the ordinary retry trigger', () => {
    expect(terminalResult({ type: 'error', phase: 'run', error: 'boom', sessionArtifacts: artifacts }))
      .toEqual({
        outcome: 'failed',
        session: {
          sessionId: 'sess-1',
          transcriptPath: '/root/.claude/projects/-workspace-repo/sess-1.jsonl',
          journalPath: '/state/event-log.ndjson',
        },
      })
    // The host escalating a stop this side asked for: still a timeout, and still the session.
    expect(observedResult({ type: 'error', phase: 'run', error: 'boom', sessionArtifacts: artifacts }, 'budget'))
      .toMatchObject({ outcome: 'timed-out', timedOutBy: 'budget', session: { sessionId: 'sess-1' } })
  })

  /**
   * A `start`- or `init`-phase error happened before there was a session, and a host older than
   * the field names none either — the key is then absent rather than `undefined`, because this
   * is a Workflow step result read back through JSON.
   */
  it('omits the key entirely when the frame named no artifacts', () => {
    expect(terminalResult({ type: 'error', phase: 'init', error: 'boom' })).not.toHaveProperty('session')
    expect(terminalResult({ type: 'finish', stopped: 'completed' })).not.toHaveProperty('session')
    expect(observedResult({ type: 'error', phase: 'run', error: 'boom' }, 'budget'))
      .not
      .toHaveProperty('session')
  })
})

/**
 * The host's echo of the stop it was asked for (#388).
 *
 * The Worker's memory of the reason it sent dies with a Workflow step that never commits, so a
 * re-entered round has nothing of its own to read — which is why the echo outranks it, and why
 * an `error` it names is the escalation rather than a turn that failed on its own.
 */
describe('an ending the host named the interrupt on', () => {
  const artifacts = { sessionId: 'sess-1', journalPath: '/state/event-log.ndjson' }

  it('names a finish with no memory of the stop after the timer the host reports', () => {
    expect(observedResult({ type: 'finish', stopped: 'interrupted', interruptedBy: 'budget' }, undefined))
      .toEqual({ outcome: 'timed-out', killConfirmed: true, timedOutBy: 'budget' })
  })

  it('reads a run-phase error the host named as the escalation it is, session and all', () => {
    expect(observedResult(
      { type: 'error', phase: 'run', error: 'no result within 30000ms of interrupt (budget)', interruptedBy: 'budget', sessionArtifacts: artifacts },
      undefined,
    )).toEqual({
      outcome: 'timed-out',
      killConfirmed: true,
      timedOutBy: 'budget',
      session: { sessionId: 'sess-1', transcriptPath: undefined, journalPath: '/state/event-log.ndjson' },
    })
  })

  it('outranks a memory that disagrees — the host is the source of truth for what it was asked', () => {
    expect(observedResult({ type: 'finish', stopped: 'interrupted', interruptedBy: 'budget' }, 'watchdog'))
      .toMatchObject({ outcome: 'timed-out', timedOutBy: 'budget' })
  })

  /*
   * A present echo is the whole answer, `operator` included. The host acts on the first
   * `interrupt` only, so an `operator` echo beside a remembered timer says the timer's stop was
   * the no-op — falling back to that memory would report a human's stop as the timeout it was
   * not, and `shouldStopAttemptLoop` reads `timedOutBy` to decide whether to run another turn.
   */
  it('does not fall back to a remembered timer when the host names an operator stop', () => {
    expect(observedResult({ type: 'finish', stopped: 'interrupted', interruptedBy: 'operator' }, 'budget'))
      .toEqual({ outcome: 'timed-out', killConfirmed: true })
    expect(observedResult({ type: 'finish', stopped: 'interrupted', interruptedBy: 'operator' }, 'budget'))
      .not
      .toHaveProperty('timedOutBy')
  })

  it('leaves an operator-named run-phase error a failed turn rather than the remembered timeout', () => {
    expect(observedResult({ type: 'error', phase: 'run', error: 'boom', interruptedBy: 'operator' }, 'watchdog'))
      .toEqual({ outcome: 'failed' })
  })

  /*
   * A memory of a stop cannot widen a `finish` the host did not call interrupted.
   *
   * `interrupt` reaches the host's runtime only while a turn is running: one sent as the turn
   * settled is answered on the socket and never lands, and the ending then says what actually
   * happened. Reading the memory over it would record a turn that succeeded as a timeout — and
   * on a deferral it would drop the request the run is waiting on and park the loop for good.
   */
  it('leaves a completed finish the success it is, whatever stop this side remembers', () => {
    const completed = observedResult({ type: 'finish', stopped: 'completed' }, 'budget')
    expect(completed).toEqual({ outcome: 'succeeded' })
    expect(completed).not.toHaveProperty('timedOutBy')
  })

  it('keeps a deferred finish a deferral, with the request it stopped on', () => {
    const deferredToolUse = { id: 'req-1', name: 'Bash', input: { command: 'ls' } }
    expect(observedResult({ type: 'finish', stopped: 'deferred', deferredToolUse }, 'watchdog'))
      .toEqual({ outcome: 'deferred', deferredToolUse })
  })

  it('leaves an unnamed run-phase error the failed turn it looks like', () => {
    expect(observedResult({ type: 'error', phase: 'run', error: 'boom' }, undefined))
      .toEqual({ outcome: 'failed' })
  })
})

describe('interruptedResult and roundEnded', () => {
  it('names the timer that fired and whether the kill was confirmed', () => {
    expect(interruptedResult('budget', false))
      .toEqual({ outcome: 'timed-out', killConfirmed: false, timedOutBy: 'budget' })
  })

  it('calls the record complete for every ending the host itself reported', () => {
    expect(roundEnded(undefined)).toBe(false)
    expect(roundEnded({ outcome: 'succeeded' })).toBe(true)
    expect(roundEnded({ outcome: 'failed' })).toBe(true)
    expect(roundEnded({ outcome: 'timed-out', killConfirmed: true })).toBe(true)
    // The one unproven case: the process may still be writing more than the snapshot holds.
    expect(roundEnded({ outcome: 'timed-out', killConfirmed: false })).toBe(false)
  })
})
