/**
 * Fetch the CLI's JSONL transcript out of the sandbox as text.
 *
 * Any failure to reach it (the sandbox is gone, the file lives in another container) is the case
 * the contract reserves `HarnessHistoryUnavailableError` for, so the cause is kept and nothing
 * else is thrown from here.
 */
import type { SandboxProvider } from '@amond-ai/sandbox'
import { HarnessHistoryUnavailableError } from '@ai-sdk/harness'

export async function readTranscript(input: {
  sandboxes: SandboxProvider
  sandboxId: string
  harnessId: string
  sessionId: string
  path: string
}): Promise<string> {
  try {
    const file = await input.sandboxes.session(input.sandboxId).readFile(input.path, { encoding: 'utf-8' })
    return file.encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(file.content), char => char.charCodeAt(0))) : file.content
  }
  catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new HarnessHistoryUnavailableError({
      harnessId: input.harnessId,
      message: `claude-code history for session ${input.sessionId} is not readable from here: ${reason}`,
      cause,
    })
  }
}
