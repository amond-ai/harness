import { describe, expect, it } from 'vitest'
import { createTurnResultScanner, withVerdict } from './turn-result-scan'

/** One `result` line as `claude --output-format stream-json` writes it. */
function resultLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.1,
    duration_ms: 1_000,
    result: 'opened the pull request',
    ...overrides,
  })}\n`
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('createTurnResultScanner', () => {
  it('reads the verdict out of a line the transport split in half', () => {
    const scanner = createTurnResultScanner()
    const line = resultLine()
    const cut = Math.floor(line.length / 2)

    scanner.push(bytes(line.slice(0, cut)))
    expect(scanner.verdict()).toBeUndefined()
    scanner.push(bytes(line.slice(cut)))

    expect(scanner.verdict()).toEqual({ subtype: 'success', isError: false })
  })

  /**
   * The host appends its own output after the turn ended, and a `cli` turn's log ends in whatever
   * the container wrote last. A scan that only remembered the final line would answer for that one.
   */
  it('keeps the verdict when the stream carries more lines after the result', () => {
    const scanner = createTurnResultScanner()

    scanner.push(bytes(`${JSON.stringify({ type: 'assistant' })}\n`))
    scanner.push(bytes(resultLine({ subtype: 'error_max_turns', is_error: true })))
    scanner.push(bytes('not json at all\n'))

    expect(scanner.verdict()).toEqual({ subtype: 'error_max_turns', isError: true })
  })

  /** A resumed journal holds an earlier turn's result before this one's; the later one is the turn's. */
  it('takes the last readable result when the stream carries several', () => {
    const scanner = createTurnResultScanner()

    scanner.push(bytes(resultLine({ subtype: 'error_during_execution', is_error: true })))
    scanner.push(bytes(resultLine()))

    expect(scanner.verdict()).toEqual({ subtype: 'success', isError: false })
  })

  it('carries the terminal reason a deferral is recognised by, and nothing the agent wrote', () => {
    const scanner = createTurnResultScanner()

    scanner.push(bytes(resultLine({ terminal_reason: 'tool_deferred', result: 'may I run rm?' })))

    expect(scanner.verdict()).toEqual({
      subtype: 'success',
      isError: false,
      terminalReason: 'tool_deferred',
    })
  })

  /** Schema drift costs the verdict, never the scan: the reading before it still stands. */
  it('skips a result-shaped line this build cannot read', () => {
    const scanner = createTurnResultScanner()

    scanner.push(bytes(resultLine({ subtype: 'error_max_turns', is_error: true })))
    scanner.push(bytes(`${JSON.stringify({ type: 'result', subtype: 'success' })}\n`))

    expect(scanner.verdict()).toEqual({ subtype: 'error_max_turns', isError: true })
  })

  /**
   * `decodeNdjson` — the decoder the settle path reads these very bytes with — flushes its
   * trailing buffer and parses a final line that never got its newline. A `result` is the last
   * thing a turn writes, so the two must agree about it.
   */
  it('reads a final line the stream never terminated', () => {
    const scanner = createTurnResultScanner()

    scanner.push(bytes(resultLine().trimEnd()))

    expect(scanner.verdict()).toEqual({ subtype: 'success', isError: false })
  })

  /**
   * Where the transport cut is not a fact about the turn. A line long enough to cross any bound
   * has to read the same whether it arrived whole or in pieces — the decoder has no length rule,
   * so neither does this.
   */
  it('reads a long line the same whether it arrived whole or fragmented', () => {
    const long = resultLine({ result: 'y'.repeat(512 * 1024) })
    const whole = createTurnResultScanner()
    const split = createTurnResultScanner()

    whole.push(bytes(long))
    const cut = Math.floor(long.length / 3)
    split.push(bytes(long.slice(0, cut)))
    split.push(bytes(long.slice(cut, cut * 2)))
    split.push(bytes(long.slice(cut * 2)))

    expect(whole.verdict()).toEqual({ subtype: 'success', isError: false })
    expect(split.verdict()).toEqual(whole.verdict())
  })

  /** The `sdk` driver's frames arrive already reassembled — one `raw` is one line by construction. */
  it('reads text handed to it already assembled', () => {
    const scanner = createTurnResultScanner()

    scanner.text(resultLine({ subtype: 'error_during_execution', is_error: true }))

    expect(scanner.verdict()).toEqual({ subtype: 'error_during_execution', isError: true })
  })

  /** The record a restarted step resumes from: whole lines, several at a time. */
  it('reads a resumed record handed to it as one block of lines', () => {
    const scanner = createTurnResultScanner()

    scanner.text(`${JSON.stringify({ type: 'assistant' })}\n${resultLine()}`)

    expect(scanner.verdict()).toEqual({ subtype: 'success', isError: false })
  })

  /** A round seeds the next one: the `result` frame and the `finish` can land in different windows. */
  it('starts from the verdict an earlier round already read', () => {
    const seeded = createTurnResultScanner({ subtype: 'success', isError: false })

    expect(seeded.verdict()).toEqual({ subtype: 'success', isError: false })
  })
})

describe('withVerdict', () => {
  it('carries the reading onto an ending the turn itself described', () => {
    expect(withVerdict({ outcome: 'failed', exitCode: 1 }, { subtype: 'success', isError: false }))
      .toEqual({ outcome: 'failed', exitCode: 1, verdict: { subtype: 'success', isError: false } })
  })

  it('drops it on a timeout, which a timer on this side decided', () => {
    expect(withVerdict({ outcome: 'timed-out', killConfirmed: true }, { subtype: 'success', isError: false }))
      .toEqual({ outcome: 'timed-out', killConfirmed: true })
  })

  it('drops it on a deferral, which is a pending question rather than an ending', () => {
    const deferred = {
      outcome: 'deferred',
      deferredToolUse: { id: 'call-1', name: 'Bash', input: {} },
    } as const

    expect(withVerdict(deferred, { subtype: 'success', isError: false })).toEqual(deferred)
  })

  it('leaves a result untouched when nothing was read', () => {
    expect(withVerdict({ outcome: 'succeeded', exitCode: 0 }, undefined))
      .toEqual({ outcome: 'succeeded', exitCode: 0 })
  })
})
