/**
 * Bridge Sandbox 1.0 process log events back into a byte stream that `decodeNdjson`
 * (from `@pleaseai/sandbox-bridge`) can consume.
 *
 * `process.logs()` returns a `ReadableStream<ProcessLogEvent>`. stdout payloads are already
 * bytes, but transport boundaries still do not align with NDJSON lines: one
 * `claude --output-format stream-json` line can arrive across several events, and one event
 * can carry several lines. This adapter forwards stdout bytes unchanged and leaves line
 * reassembly to `decodeNdjson`, which handles split lines, unterminated tails, and non-JSON
 * noise.
 *
 * stderr text, the exit code, transport errors, and truncation notices are diverted to a
 * side channel the caller reads after stdout is fully consumed. The adapter deliberately
 * has no sandbox import, so bun tests can exercise the complete composition:
 * `process.logs()` → `iterateStream()` → `demuxProcessEvents()` → `decodeNdjson()`.
 */

interface ProcessExit {
  code: number
  signal?: number
  timedOut: boolean
}

interface ProcessFailure {
  code: string
  message: string
}

/** The structural subset of the Sandbox 1.0 `ProcessLogEvent` union this adapter reads. */
export type ProcessLogEvent
  = | { type: 'stdout' | 'stderr', cursor: string, timestamp: string, data: Uint8Array }
    | { type: 'terminal', state: 'exited', cursor: string, timestamp: string, exit: ProcessExit }
    | { type: 'terminal', state: 'error', cursor: string, timestamp: string, error: ProcessFailure }
    | { type: 'truncated', cursor?: string, timestamp: string }

/**
 * How much stderr text the side channel retains, in UTF-16 code units.
 *
 * A replay covers the whole turn, so accumulating every `stderr` event would make this
 * adapter's memory grow with the container's own output — the unbounded-state problem
 * `message-window.ts` already solves for stdout (AC-016), and `replayTurn` claims to avoid.
 * The *tail* is kept because a failing turn's diagnosis is at the end of its stderr.
 */
export const STDERR_RETENTION = 8 * 1024

/** Everything from the process stream that is not stdout, available after the stream ends. */
export interface ProcessSideChannel {
  /**
   * The tail of the concatenated UTF-8 text of every `stderr` event, at most
   * {@link STDERR_RETENTION} characters.
   */
  stderr: string
  /** How many leading stderr characters were dropped to honour that bound. */
  stderrDropped: number
  /** Exit code reported by an exited terminal event. */
  exitCode?: number
  /** Message reported by an errored terminal event. */
  error?: string
  /** True when the process resource reports that earlier log output was discarded. */
  truncated: boolean
}

export interface DemuxedProcessStream {
  /** stdout payloads, unchanged, ready for `decodeNdjson`. */
  stdout: ReadableStream<Uint8Array>
  /** Mutated as events arrive; read it after `stdout` has been consumed to completion. */
  sideChannel: ProcessSideChannel
}

/**
 * Iterate a Web `ReadableStream` without relying on the runtime-specific async-iterator
 * extension. Early consumer return cancels the stream; normal completion drains it fully.
 */
export async function* iterateStream<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader()
  let completed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        return
      }
      yield value
    }
  }
  finally {
    if (!completed) {
      // A rejecting `cancel()` (the stream already errored) must not displace the original
      // error nor skip `releaseLock()`.
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }
}

export function demuxProcessEvents(
  events: AsyncIterable<ProcessLogEvent>,
): DemuxedProcessStream {
  const sideChannel: ProcessSideChannel = { stderr: '', stderrDropped: 0, truncated: false }
  const stderrDecoder = new TextDecoder()
  const iterator = events[Symbol.asyncIterator]()

  const stdout = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await iterator.next()
          if (done) {
            appendStderr(sideChannel, stderrDecoder.decode())
            controller.close()
            return
          }
          const chunk = route(value, sideChannel, stderrDecoder)
          if (chunk?.byteLength) {
            controller.enqueue(chunk)
            return
          }
        }
      }
      catch (cause) {
        // Web Streams do not call `cancel` when `pull` throws, so an iterator suspended at a
        // successful `next()` would never close — leaking the reader `iterateStream` holds.
        // Closing it must not displace `cause` (#88 review).
        await Promise.resolve(iterator.return?.()).catch(() => {})
        throw cause
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })

  return { stdout, sideChannel }
}

/** Return stdout bytes, or route the event to the side channel and return nothing. */
function route(
  event: ProcessLogEvent,
  sideChannel: ProcessSideChannel,
  stderrDecoder: TextDecoder,
): Uint8Array | undefined {
  if (event.type === 'stdout') {
    return event.data
  }
  if (event.type === 'stderr') {
    appendStderr(sideChannel, stderrDecoder.decode(event.data, { stream: true }))
  }
  else if (event.type === 'terminal' && event.state === 'exited') {
    sideChannel.exitCode = event.exit.code
  }
  else if (event.type === 'terminal' && event.state === 'error') {
    sideChannel.error = event.error.message
  }
  else if (event.type === 'truncated') {
    // Truncation alone is not failure: a retained terminal `result` can still prove success.
    sideChannel.truncated = true
  }
  return undefined
}

/** Append decoded stderr text, evicting from the front to honour {@link STDERR_RETENTION}. */
function appendStderr(sideChannel: ProcessSideChannel, text: string): void {
  if (text === '') {
    return
  }
  const appended = sideChannel.stderr + text
  const overflow = appended.length - STDERR_RETENTION
  if (overflow > 0) {
    // The bound counts UTF-16 code units, so it can land between a surrogate pair and leave
    // an orphaned low surrogate at the front of the tail. Drop that half too (#88 review).
    const cut = isLowSurrogate(appended.charCodeAt(overflow)) ? overflow + 1 : overflow
    sideChannel.stderr = appended.slice(cut)
    sideChannel.stderrDropped += cut
    return
  }
  sideChannel.stderr = appended
}

/** True for the trailing half of a UTF-16 surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}
