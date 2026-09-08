import type { ProcessLogEvent } from './process-ndjson'
import { describe, expect, it } from 'vitest'
import { demuxProcessEvents, iterateStream, STDERR_RETENTION } from './process-ndjson'

const encoder = new TextEncoder()
let cursor = 0

/** Build an async iterable over the given Sandbox 1.0 process log events. */
async function* eventsOf(events: ProcessLogEvent[]): AsyncIterable<ProcessLogEvent> {
  for (const event of events) {
    yield event
  }
}

/**
 * The NDJSON reader the Worker composes this adapter with, restated here.
 *
 * Restated rather than imported: the real one lives in `@pleaseai/sandbox-bridge`, which is
 * outside this package's closed dependency set, and what these cases assert is the *adapter* —
 * that a line split across transport chunks arrives whole, and that stderr never reaches this
 * side. The decoder is scaffolding for that, and this is the same line-reassembling,
 * skip-unparseable loop it performs.
 */
async function* decodeNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of iterateStream(stream)) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      yield* parsedLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  yield* parsedLine(buffer)
}

/** One line, parsed — or nothing at all, which is how the real decoder skips a stray banner. */
function* parsedLine(line: string): Generator<unknown> {
  const trimmed = line.trim()
  if (trimmed === '') {
    return
  }
  try {
    yield JSON.parse(trimmed)
  }
  catch {
    // Not JSON: a warning or an ANSI banner, skipped rather than aborting the turn.
  }
}

/** Run the full composition the Worker uses: events → adapter → decodeNdjson. */
async function decode(events: ProcessLogEvent[]) {
  const { stdout, sideChannel } = demuxProcessEvents(eventsOf(events))
  const messages: unknown[] = []
  for await (const message of decodeNdjson(stdout)) {
    messages.push(message)
  }
  return { messages, sideChannel }
}

function stdout(data: string): ProcessLogEvent {
  return logEvent('stdout', encoder.encode(data))
}

function logEvent(type: 'stdout' | 'stderr', data: Uint8Array): ProcessLogEvent {
  cursor += 1
  return { type, cursor: String(cursor), timestamp: '2026-08-07T00:00:00.000Z', data }
}

function exited(code: number): ProcessLogEvent {
  cursor += 1
  return {
    type: 'terminal',
    state: 'exited',
    cursor: String(cursor),
    timestamp: 't',
    exit: { code, timedOut: false },
  }
}

describe('iterateStream', () => {
  it('iterates every value from a Web ReadableStream', async () => {
    const stream = new ReadableStream<number>({
      start(controller) {
        controller.enqueue(1)
        controller.enqueue(2)
        controller.close()
      },
    })
    const values: number[] = []
    for await (const value of iterateStream(stream)) {
      values.push(value)
    }
    expect(values).toEqual([1, 2])
  })

  it('preserves a read error when cancel also rejects', async () => {
    const pullError = new Error('distinctive pull failure')
    const cancelError = new Error('distinctive cancel failure')
    const stream = new ReadableStream<number>({
      pull() {
        throw pullError
      },
      cancel() {
        return Promise.reject(cancelError)
      },
    })

    let thrown: unknown
    try {
      for await (const _value of iterateStream(stream)) {
        // The stream errors before yielding a value.
      }
    }
    catch (cause) {
      thrown = cause
    }

    expect(thrown).toBe(pullError)
  })
})

describe('demuxProcessEvents', () => {
  it('decodes two complete NDJSON lines carried by a single stdout event', async () => {
    const { messages } = await decode([
      stdout('{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n'),
    ])
    expect(messages).toEqual([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success' },
    ])
  })

  it('reassembles one JSON object split across two stdout events mid-token', async () => {
    const { messages } = await decode([
      stdout('{"type":"assis'),
      stdout('tant","session_id":"s1"}\n'),
    ])
    expect(messages).toEqual([{ type: 'assistant', session_id: 's1' }])
  })

  it('flushes a final line that never received its trailing newline', async () => {
    const { messages } = await decode([stdout('{"type":"result","subtype":"success"}')])
    expect(messages).toEqual([{ type: 'result', subtype: 'success' }])
  })

  it('skips a non-JSON banner line between valid lines', async () => {
    const { messages } = await decode([
      stdout('[1mClaude Code[0m starting up\n'),
      stdout('{"type":"result","subtype":"success"}\n'),
    ])
    expect(messages).toEqual([{ type: 'result', subtype: 'success' }])
  })

  it('routes split UTF-8 stderr to the side channel and captures the exit code', async () => {
    const stderr = encoder.encode('warning: 한글\n')
    const split = stderr.indexOf(0xED) + 1
    const { messages, sideChannel } = await decode([
      logEvent('stderr', stderr.slice(0, split)),
      stdout('{"type":"result","subtype":"success"}\n'),
      logEvent('stderr', stderr.slice(split)),
      exited(3),
    ])
    expect(messages).toEqual([{ type: 'result', subtype: 'success' }])
    expect(sideChannel.stderr).toBe('warning: 한글\n')
    expect(sideChannel.stderrDropped).toBe(0)
    expect(sideChannel.exitCode).toBe(3)
  })

  it('keeps the tail of stderr once the retention bound is exceeded', async () => {
    const overflow = 100
    const { sideChannel } = await decode([
      logEvent('stderr', encoder.encode('o'.repeat(STDERR_RETENTION))),
      logEvent('stderr', encoder.encode('t'.repeat(overflow))),
      exited(1),
    ])
    expect(sideChannel.stderr.length).toBe(STDERR_RETENTION)
    expect(sideChannel.stderrDropped).toBe(overflow)
    expect(sideChannel.stderr.endsWith('t'.repeat(overflow))).toBe(true)
    expect(sideChannel.stderr.startsWith('o')).toBe(true)
  })

  it('does not leave an orphaned surrogate at the front of the retained tail', async () => {
    // 'o' + 😀 (2 code units) + 8191 't' is 8194 units, so the cut lands on the low surrogate.
    const tail = 't'.repeat(STDERR_RETENTION - 1)
    const { sideChannel } = await decode([
      logEvent('stderr', encoder.encode(`o😀${tail}`)),
      exited(1),
    ])
    expect(sideChannel.stderr).toBe(tail)
    expect(sideChannel.stderrDropped).toBe(3)
    const first = sideChannel.stderr.charCodeAt(0)
    expect(first >= 0xDC00 && first <= 0xDFFF).toBe(false)
  })

  it('closes the source iterator when pull throws after a successful next()', async () => {
    let sourceClosed = false
    // `data` is not a BufferSource, so `route`'s decode throws inside `pull` — after
    // `next()` already resolved, which is the case the stream never cancels for us.
    async function* source(): AsyncIterable<ProcessLogEvent> {
      try {
        yield { type: 'stderr', cursor: '1', timestamp: 't', data: 'not-a-buffer' as unknown as Uint8Array }
      }
      finally {
        sourceClosed = true
      }
    }

    const { stdout } = demuxProcessEvents(source())
    const reader = stdout.getReader()
    await expect(reader.read()).rejects.toThrow()
    expect(sourceClosed).toBe(true)
  })

  it('records a terminal error event instead of dropping it', async () => {
    const { sideChannel } = await decode([{
      type: 'terminal',
      state: 'error',
      cursor: 'error',
      timestamp: 't',
      error: { code: 'container_error', message: 'container died' },
    }])
    expect(sideChannel.error).toBe('container died')
  })

  it('records truncation without treating it as an error', async () => {
    const { sideChannel } = await decode([
      { type: 'truncated', cursor: '1', timestamp: 't' },
      stdout('{"type":"result","subtype":"success"}\n'),
      exited(0),
    ])
    expect(sideChannel.truncated).toBe(true)
    expect(sideChannel.error).toBeUndefined()
    expect(sideChannel.exitCode).toBe(0)
  })

  it('leaves exitCode undefined when the stream ends without a terminal event', async () => {
    const { sideChannel } = await decode([stdout('{"a":1}\n')])
    expect(sideChannel.exitCode).toBeUndefined()
  })
})
