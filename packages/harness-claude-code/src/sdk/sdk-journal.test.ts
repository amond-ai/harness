import { describe, expect, it } from 'vitest'
import { journalTailArgv, journalTerminal, MAX_JOURNAL_BYTES, sdkJournalTranscript } from './sdk-journal'

function RAW(message: unknown, seq: number): string {
  return JSON.stringify({ type: 'raw', seq, rawValue: message })
}

describe('sdkJournalTranscript', () => {
  it('turns the journal\'s raw frames back into the NDJSON the window decodes', () => {
    const journal = [
      JSON.stringify({ type: 'bridge-hello', seq: 1, state: 'waiting', lastSeq: 0 }),
      RAW({ type: 'system' }, 2),
      JSON.stringify({ type: 'sandbox-log', seq: 3, source: 'claude-code', stream: 'stderr', line: 'x' }),
      RAW({ type: 'result', result: 'READY' }, 4),
      JSON.stringify({ type: 'finish', seq: 5, finishReason: { unified: 'stop', raw: 'stop' }, totalUsage: {} }),
    ].join('\n')

    expect(sdkJournalTranscript(`${journal}\n`, false)).toBe(
      `${JSON.stringify({ type: 'system' })}\n${JSON.stringify({ type: 'result', result: 'READY' })}\n`,
    )
  })

  /*
   * `tail -c` starts at a byte, not at a line, so the first line of a cut read is usually half a
   * frame — indistinguishable from a corrupt one, and dropping it is what keeps a capped turn
   * from warning on every settle.
   */
  it('discards the first line of a cut read, and only of a cut read', () => {
    const journal = `${RAW({ type: 'system' }, 8)}\n${RAW({ type: 'result' }, 9)}\n`
    const result = `${JSON.stringify({ type: 'result' })}\n`

    // Dropped even though this one happens to be whole: a `tail -c` cut cannot be told from an
    // intact line, and half a JSON object is indistinguishable from a corrupt one.
    expect(sdkJournalTranscript(journal, true)).toBe(result)
    expect(sdkJournalTranscript(journal, false)).toBe(`${JSON.stringify({ type: 'system' })}\n${result}`)
    // And a genuinely severed line is skipped rather than thrown on.
    expect(sdkJournalTranscript(`pe":"raw","rawValue":{}}\n${RAW({ type: 'result' }, 9)}\n`, false)).toBe(result)
  })

  it('reads a journal with nothing in it as an empty transcript', () => {
    expect(sdkJournalTranscript('', false)).toBe('')
    expect(sdkJournalTranscript('\n\n', false)).toBe('')
  })
})

describe('journalTailArgv', () => {
  it('bounds the read at the byte level rather than reading the whole journal', () => {
    expect(journalTailArgv('/workspace/.turn-host/run-1/1/event-log.ndjson')).toEqual([
      'tail',
      '-c',
      String(MAX_JOURNAL_BYTES),
      '/workspace/.turn-host/run-1/1/event-log.ndjson',
    ])
  })
})

describe('journalTerminal', () => {
  it('reads the last terminal frame the host wrote before it went', () => {
    const journal = [
      RAW({ type: 'result' }, 1),
      JSON.stringify({
        type: 'finish',
        seq: 2,
        stopped: 'completed',
        finishReason: { unified: 'stop', raw: 'stop' },
        totalUsage: { inputTokens: {}, outputTokens: {} },
      }),
    ].join('\n')

    expect(journalTerminal(`${journal}\n`, false))
      .toMatchObject({ type: 'finish', stopped: 'completed' })
  })

  it('answers nothing for a journal that holds no ending', () => {
    expect(journalTerminal(`${RAW({ type: 'system' }, 1)}\n`, false)).toBeUndefined()
    expect(journalTerminal('', false)).toBeUndefined()
  })

  it('drops the partial first line of a cut read rather than reading half a frame', () => {
    const cutOff = `pe":"finish","seq":1,"stopped":"completed"}\n${RAW({ type: 'system' }, 2)}\n`

    expect(journalTerminal(cutOff, true)).toBeUndefined()
  })
})
