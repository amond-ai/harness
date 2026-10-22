/**
 * The transcript read is a bounded stream, so these tests hand it streams: one split inside a
 * multi-byte character, one past the bound that must be cancelled, and one that breaks mid-read.
 */
import type { SandboxProvider } from '@amond-ai/sandbox'
import { HarnessHistoryUnavailableError } from '@ai-sdk/harness'
import { describe, expect, it } from 'vitest'
import { readTranscript } from './read-transcript'

function providerOver(content: ReadableStream<Uint8Array>): SandboxProvider {
  return { session: () => ({ readFile: async () => ({ content }) }) } as unknown as SandboxProvider
}

function target(sandboxes: SandboxProvider): Parameters<typeof readTranscript>[0] {
  return { sandboxes, sandboxId: 'sbx-1', harnessId: 'claude-code', sessionId: 's1', path: '/t.jsonl' }
}

describe('readTranscript', () => {
  it('reads several chunks back exactly, even when one splits a multi-byte character', async () => {
    const bytes = new TextEncoder().encode('{"a":"한"}\n{"b":2}\n')
    const cut = bytes.indexOf(0xED) + 1
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut))
        controller.enqueue(bytes.slice(cut, cut + 1))
        controller.enqueue(bytes.slice(cut + 1))
        controller.close()
      },
    })

    expect(await readTranscript(target(providerOver(stream)))).toBe('{"a":"한"}\n{"b":2}\n')
  })

  it('reports a transcript past the bound as unavailable and cancels the stream', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4))
      },
      cancel() {
        cancelled = true
      },
    })

    const error = await readTranscript(target(providerOver(stream)), 10).catch((caught: unknown) => caught)

    expect(HarnessHistoryUnavailableError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ message: expect.stringContaining('larger than 10 bytes') })
    expect(cancelled).toBe(true)
  })

  it('reports a stream that breaks mid-read as unavailable, keeping the cause', async () => {
    const boom = new Error('connection reset')
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(boom)
      },
    })

    const error = await readTranscript(target(providerOver(stream))).catch((caught: unknown) => caught)

    expect(HarnessHistoryUnavailableError.isInstance(error)).toBe(true)
    expect(error).toMatchObject({ cause: boom, message: expect.stringContaining('connection reset') })
  })
})
