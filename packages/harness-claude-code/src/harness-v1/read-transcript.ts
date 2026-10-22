/**
 * Fetch the CLI's JSONL transcript out of the sandbox as text, streamed and bounded.
 *
 * Any failure to reach it (the sandbox is gone, the file lives in another container, the stream
 * breaks) is the case the contract reserves `HarnessHistoryUnavailableError` for, so the cause is
 * kept and nothing else is thrown from here. So is a transcript past {@link MAX_TRANSCRIPT_BYTES}.
 */
import type { SandboxProvider } from '@amond-ai/sandbox'
import { HarnessHistoryUnavailableError } from '@ai-sdk/harness'
import { LIVE_MIRROR_MAX_BYTES } from '../mirror'

/**
 * How much transcript is read into the Worker.
 *
 * The same bound the live mirror and the journal tail use ({@link LIVE_MIRROR_MAX_BYTES}), because
 * it is the same isolate holding the same kind of string. The transcript spans the whole session
 * and grows every turn, and the line-count cursor, its fingerprint and the tool-name lookup all
 * need the file from its head, so there is no tail read to fall back on. Past the bound the read
 * is reported as unavailable rather than truncated: a partial transcript would give a wrong cursor.
 */
export const MAX_TRANSCRIPT_BYTES = LIVE_MIRROR_MAX_BYTES

export async function readTranscript(input: {
  sandboxes: SandboxProvider
  sandboxId: string
  harnessId: string
  sessionId: string
  path: string
}, maxBytes: number = MAX_TRANSCRIPT_BYTES): Promise<string> {
  try {
    const file = await input.sandboxes.session(input.sandboxId).readFile(input.path, { encoding: 'none' })
    const reader = file.content.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new HarnessHistoryUnavailableError({
          harnessId: input.harnessId,
          message: `claude-code history for session ${input.sessionId} is not readable from here: the transcript is larger than ${maxBytes} bytes`,
        })
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  }
  catch (cause) {
    if (HarnessHistoryUnavailableError.isInstance(cause)) {
      throw cause
    }
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new HarnessHistoryUnavailableError({
      harnessId: input.harnessId,
      message: `claude-code history for session ${input.sessionId} is not readable from here: ${reason}`,
      cause,
    })
  }
}
