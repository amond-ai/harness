import type { SandboxProcessHandle } from '@amond-ai/sandbox'
import type { LiveMirror } from './mirror'
import type { ProcessLogEvent } from './process-ndjson'
import { describe, expect, it, vi } from 'vitest'
import { LOG_READ_TIMEOUT_MS, readLogSample } from './log-sample'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What the mirror was handed, so an abandoned read's silence is asserted rather than assumed. */
interface RecordedAppend {
  text: string
  cursor: string
}

/** The recorded appends and gaps, and the {@link LiveMirror} that writes into them. */
interface RecordingMirror {
  mirror: LiveMirror
  appends: RecordedAppend[]
  readonly gaps: number
}

function recordingMirror(): RecordingMirror {
  const appends: RecordedAppend[] = []
  const state = { gaps: 0 }
  const mirror: LiveMirror = {
    append: (data, cursor) => {
      appends.push({ text: decoder.decode(data), cursor })
    },
    noteGap: () => {
      state.gaps += 1
    },
    flush: async () => {},
    bytes: 0,
    cursor: undefined,
  }
  return {
    mirror,
    appends,
    get gaps() {
      return state.gaps
    },
  }
}

function stdout(text: string, cursor: string): ProcessLogEvent {
  return { type: 'stdout', cursor, timestamp: '2026-09-05T00:00:00.000Z', data: encoder.encode(text) }
}

/** A process whose `logs()` answers one caller-driven stream, so a test can stall it deliberately. */
function processWith(stream: ReadableStream<ProcessLogEvent>): SandboxProcessHandle {
  return { id: 'p1', logs: async () => stream } as unknown as SandboxProcessHandle
}

describe('readLogSample', () => {
  /**
   * The finding this bound exists for: `watchTurn` judges the wall-clock deadline only after a
   * read returns, so a stalled log backend must not be able to hold the turn there. The read
   * answers with the progress it reached, at the cursor of the last event it actually appended.
   */
  it('abandons a stream that never closes, keeping what it already read', async () => {
    const { mirror, appends } = recordingMirror()
    let controller!: ReadableStreamDefaultController<ProcessLogEvent>
    const stream = new ReadableStream<ProcessLogEvent>({
      start(source) {
        controller = source
        source.enqueue(stdout('{"a":1}\n', 'c1'))
        source.enqueue(stdout('{"b":2}\n', 'c2'))
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sample = await readLogSample(processWith(stream), { bytes: 0 }, mirror, 20)

    expect(sample).toEqual({ cursor: 'c2', bytes: 16 })
    expect(appends.map(append => append.cursor)).toEqual(['c1', 'c2'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('watchdog log read abandoned'))

    // Whatever the backend delivers after the read was abandoned belongs to the *next* read,
    // which resumes at `c2`. Appending it here would put it into a snapshot already published.
    controller.enqueue(stdout('{"c":3}\n', 'c3'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(appends.map(append => append.cursor)).toEqual(['c1', 'c2'])

    warn.mockRestore()
  })

  /**
   * A stream with no next event at all — the case the per-event check cannot reach. The deadline
   * aborts the read through the contract's `signal`, so a backend that honours it ends the stream
   * and the drain settles rather than staying pending behind every later tick.
   */
  it('aborts a read that never delivers anything, and records no gap for it', async () => {
    const recorded = recordingMirror()
    let seen: AbortSignal | undefined
    let errored = false
    const stream = new ReadableStream<ProcessLogEvent>({ start() {} })
    const process = {
      id: 'p1',
      logs: async (options: { signal?: AbortSignal }) => {
        seen = options.signal
        // What a backend that honours the signal does: end the stream it handed out.
        options.signal?.addEventListener('abort', () => {
          errored = true
        }, { once: true })
        return stream
      },
    } as unknown as SandboxProcessHandle
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sample = await readLogSample(process, { bytes: 0, cursor: 'c0' }, recorded.mirror, 20)

    expect(sample).toEqual({ cursor: 'c0', bytes: 0 })
    expect(seen?.aborted).toBe(true)
    expect(errored).toBe(true)
    expect(recorded.gaps).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('watchdog log read abandoned'))

    warn.mockRestore()
  })

  /** The ordinary case: a finite batch returns whole, well inside the bound. */
  it('returns the whole batch when the stream closes first', async () => {
    const { mirror, appends } = recordingMirror()
    const stream = new ReadableStream<ProcessLogEvent>({
      start(source) {
        source.enqueue(stdout('{"a":1}\n', 'c1'))
        source.enqueue({ type: 'stderr', cursor: 'c2', timestamp: 't', data: encoder.encode('oh no') })
        source.close()
      },
    })

    const sample = await readLogSample(processWith(stream), { bytes: 0, cursor: 'c0' }, mirror, 20)

    // stderr is counted for liveness but never mirrored — the settle path stores stdout alone.
    expect(sample).toEqual({ cursor: 'c2', bytes: 13 })
    expect(appends.map(append => append.cursor)).toEqual(['c1'])
  })

  /**
   * A read that threw part-way through moved the cursor past output this record will never see,
   * which is a gap — unlike an abandoned read, whose bytes are merely not fetched yet.
   */
  it('reports the bytes a failed batch delivered and records the gap once', async () => {
    const recorded = recordingMirror()
    // Errored from `pull` rather than from `start`: `controller.error()` clears whatever is still
    // queued, so erroring beside the enqueue would test a batch that delivered nothing at all.
    let pulls = 0
    const stream = new ReadableStream<ProcessLogEvent>({
      pull(source) {
        pulls += 1
        if (pulls === 1) {
          source.enqueue(stdout('{"a":1}\n', 'c1'))
          return
        }
        source.error(new Error('transport died'))
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sample = await readLogSample(processWith(stream), { bytes: 0 }, recorded.mirror, 200)

    expect(sample).toEqual({ cursor: 'c1', bytes: 8 })
    expect(recorded.gaps).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('watchdog log read failed'))

    warn.mockRestore()
  })

  /**
   * A `logs()` that rejected before delivering anything skipped nothing: the cursor is exactly
   * where it started, so the next read asks for the same batch again. Stamping the record
   * truncated for that would admit a loss that did not happen.
   */
  it('records no gap when the read failed before it moved', async () => {
    const recorded = recordingMirror()
    const process = { id: 'p1', logs: async () => await Promise.reject(new Error('backend unreachable')) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sample = await readLogSample(process as unknown as SandboxProcessHandle, { bytes: 0, cursor: 'c0' }, recorded.mirror, 200)

    expect(sample).toEqual({ cursor: 'c0', bytes: 0 })
    expect(recorded.gaps).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('watchdog log read failed'))

    warn.mockRestore()
  })

  /** A minute is far past anything a positioned read of a finite batch takes. */
  it('defaults to a bound nothing healthy approaches', () => {
    expect(LOG_READ_TIMEOUT_MS).toBe(60_000)
  })
})
