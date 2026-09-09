import type { SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
/**
 * The `cli` driver's reading of the turn's own `result` (#376) — the part of `awaitTurn` that is
 * about evidence rather than about the watchdog race, which `run-workflow.watchdog.test.ts` owns.
 *
 * Driven against a process whose log is scripted per cursor read, because that is where the
 * result really is: the entry read sees a turn that has only just started, and the line arrives on
 * the closing drain after the process has exited.
 */
import type { LiveMirror } from './mirror'
import type { ProcessLogEvent } from './process-ndjson'
import { describe, expect, it } from 'vitest'
import { awaitTurn } from './cli-turn-watch'

const encoder = new TextEncoder()

/** Only the thresholds `awaitTurn` reads; the sampling never fires, the exit comes first. */
const CONFIG = {
  livenessSampleIntervalMs: 60_000,
  watchdogTimeoutMs: 600_000,
  livenessWindowMs: 600_000,
  turnWallClockBudgetMs: 6 * 60 * 60 * 1000,
} as Parameters<typeof awaitTurn>[2]

function resultLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'opened the pull request',
    ...overrides,
  })}\n`
}

/** A process that exits with `code`, answering one scripted log batch per `logs()` call. */
function scriptedProcess(batches: string[][], code: number): SandboxProcessHandle {
  const queue = [...batches]
  return {
    id: 'p1',
    status: async () => ({ state: 'running', id: 'p1', pid: 1, command: ['claude'], startedAt: new Date().toISOString() }),
    logs: async () => {
      const batch = queue.shift() ?? []
      return new ReadableStream<ProcessLogEvent>({
        start(controller) {
          batch.forEach((text, index) => {
            controller.enqueue({
              type: 'stdout',
              cursor: String(index),
              timestamp: '2026-09-09T00:00:00.000Z',
              data: encoder.encode(text),
            })
          })
          controller.close()
        },
      })
    },
    waitForExit: async () => ({ code, timedOut: false }),
  } as unknown as SandboxProcessHandle
}

function sessionOver(process: SandboxProcessHandle): SandboxSession {
  return { getProcess: async () => process } as unknown as SandboxSession
}

/** A mirror that stores nothing and only answers what a resumed one would have brought back. */
function seededMirror(resumedFrom: string | undefined, cursor?: string): LiveMirror {
  return {
    append: () => {},
    noteGap: () => {},
    flush: async () => {},
    bytes: 0,
    cursor,
    resumedFrom,
  }
}

describe('a cli turn\'s verdict', () => {
  it('reads the result off the drain that follows the exit, with no mirror configured', async () => {
    const process = scriptedProcess([[], [resultLine({ is_error: true })]], 0)

    const result = await awaitTurn(sessionOver(process), 'p1', CONFIG, { mirror: undefined })

    expect(result).toMatchObject({
      outcome: 'succeeded',
      exitCode: 0,
      verdict: { subtype: 'success', isError: true },
    })
  })

  /**
   * A restarted `await-exit` starts its first read at the mirror's cursor, so a turn that ended
   * before the restart has its `result` only in the record the mirror resumed from. Read from
   * anywhere else it is a turn with no verdict at all.
   */
  it('reads the result out of the record a restarted step resumed from', async () => {
    const process = scriptedProcess([[], []], 1)
    const stored = `${JSON.stringify({ type: 'assistant' })}\n${resultLine()}`

    const result = await awaitTurn(sessionOver(process), 'p1', CONFIG, {
      mirror: seededMirror(stored, '40'),
    })

    expect(result).toMatchObject({
      outcome: 'failed',
      exitCode: 1,
      verdict: { subtype: 'success', isError: false },
    })
  })

  it('leaves the reading absent when the turn printed no result at all', async () => {
    const process = scriptedProcess([[], [`${JSON.stringify({ type: 'assistant' })}\n`]], 1)

    const result = await awaitTurn(sessionOver(process), 'p1', CONFIG, { mirror: seededMirror(undefined) })

    expect(result).toEqual({ outcome: 'failed', exitCode: 1 })
  })
})
