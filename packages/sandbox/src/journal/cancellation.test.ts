import type { LogReadSources } from './index'
import { describe, expect, it, vi } from 'vitest'
import { createProcessLogs, followJournal } from './index'

const bytes = (text: string) => new TextEncoder().encode(text)
function hang<T>(signal?: AbortSignal) {
  return new Promise<T>((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function sources(overrides: Partial<LogReadSources> = {}): LogReadSources {
  return {
    paths: { stdout: '/j/p.out', stderr: '/j/p.err', exit: '/j/p.exit', meta: '/j/p.meta.json' },
    readExitCode: async () => undefined,
    readSliceFrom: async (_path, offset) => ({ data: new Uint8Array(0), total: offset }),
    readEndOffset: async () => 0,
    async* streamFile() {},
    isGone: async () => true,
    now: () => 't',
    elapsedMs: () => 0,
    followIntervalMs: 1,
    livenessIntervalMs: 1,
    ...overrides,
  } as LogReadSources
}

async function collect(stream: ReadableStream<{ type: string }>) {
  const types: string[] = []
  for await (const event of stream) {
    types.push(event.type)
  }
  return types
}

describe('journal read cancellation', () => {
  it('cancels both pending reads of a positioned read when the caller aborts', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const logs = createProcessLogs(sources({
      readSliceFrom: (_path, _offset, options) => {
        seen.push(options?.signal)
        return hang(options?.signal)
      },
    }))
    const controller = new AbortController()

    const pending = logs({ since: '0:0', signal: controller.signal })
    controller.abort(new Error('watchdog'))

    await expect(pending).rejects.toThrow('watchdog')
    expect(seen).toHaveLength(2)
    expect(seen.every(signal => signal === controller.signal)).toBe(true)
  })

  it('does not read the journal for a follower aborted before it started', async () => {
    const readEndOffset = vi.fn(async () => 0)
    const controller = new AbortController()
    controller.abort()

    const logs = createProcessLogs(sources({ readEndOffset }))
    const types = await collect(await logs({ follow: true, signal: controller.signal }))

    expect(types).toEqual([])
    expect(readEndOffset).not.toHaveBeenCalled()
  })

  it('returns promptly when the caller aborts while a read hangs', async () => {
    const controller = new AbortController()
    const logs = createProcessLogs(sources({
      readSliceFrom: (_path, _offset, options) => hang(options?.signal),
    }))

    const stream = await logs({ follow: true, replay: true, signal: controller.signal })
    const finished = collect(stream)
    controller.abort()

    await expect(finished).resolves.toEqual([])
  })

  it('does not sit out the interval when the abort lands after the poll\'s reads', async () => {
    // The window the reads' own signals cannot cover: every read of the poll has already
    // settled, so nothing rejects, and the tail reaches `sleep` with a signal that has fired. An
    // `abort` listener registered then is never called (gemini review, PR #280). The clock is the
    // last thing the poll asks before sleeping, so aborting from it lands exactly there (cubic
    // review, PR #30).
    const controller = new AbortController()
    let polled = false
    const tail = {
      ...sources(),
      paths: { stdout: '/j/p.out', stderr: '/j/p.err' },
      readExitCode: async () => {
        polled = true
        return undefined
      },
      elapsedMs: () => {
        if (polled) {
          controller.abort()
        }
        return 0
      },
      isGone: async () => false,
      intervalMs: 3_000,
    }

    const ended = (async () => {
      for await (const _ of followJournal(tail, { from: { stdout: 0, stderr: 0 }, terminal: true, signal: controller.signal })) {
        // Nothing is written, so there is nothing to see.
      }
      return 'ended'
    })()
    const stalled = new Promise<'stalled'>(resolve => setTimeout(resolve, 50, 'stalled'))

    expect(await Promise.race([ended, stalled])).toBe('ended')
  })

  it('surfaces a failed final drain instead of emitting a terminal', async () => {
    const tail = {
      ...sources(),
      paths: { stdout: '/j/p.out', stderr: '/j/p.err' },
      // The polling read answers silence; only a read told to fail can tell the drain it lost bytes.
      readSliceFrom: async (_path: string, offset: number, options?: { partial?: string }) => {
        if (options?.partial === 'fail') {
          throw new Error('journal unavailable')
        }
        return { data: bytes(''), total: offset }
      },
      intervalMs: 1,
    }
    const seen: string[] = []

    const drained = (async () => {
      for await (const event of followJournal(tail, { from: { stdout: 0, stderr: 0 }, terminal: true })) {
        seen.push(event.type)
      }
    })()

    await expect(drained).rejects.toThrow('journal unavailable')
    expect(seen).not.toContain('terminal')
  })

  it('reads the exit record with a failing read, so a blip is not a no_exit_record', async () => {
    const tail = {
      ...sources(),
      paths: { stdout: '/j/p.out', stderr: '/j/p.err' },
      readExitCode: async (options?: { partial?: string }) => {
        if (options?.partial === 'fail') {
          throw new Error('exit read failed')
        }
        return undefined
      },
      intervalMs: 1,
    }
    const seen: string[] = []

    const drained = (async () => {
      for await (const event of followJournal(tail, { from: { stdout: 0, stderr: 0 }, terminal: true })) {
        seen.push(event.type)
      }
    })()

    await expect(drained).rejects.toThrow('exit read failed')
    expect(seen).toEqual([])
  })
})
