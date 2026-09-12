import type { ProcessLogEvent } from '@amond-ai/sandbox'
import type { FakeHost } from './local.fixtures'
import { describe, expect, it } from 'vitest'
import { journalPaths, serializeProcessRecord } from './journal'
import { AT, decode, fakeHost, sessionOver, STATE } from './local.fixtures'

const PATHS = journalPaths(STATE, 'p1')

function recorded(fake: FakeHost, pid = 4711): void {
  fake.put(PATHS.meta, serializeProcessRecord({
    id: 'p1',
    pid,
    command: ['claude', '-p'],
    startedAt: AT,
    kernelStartedAt: `start-${String(pid)}`,
  }))
}

async function collect(stream: ReadableStream<ProcessLogEvent>): Promise<ProcessLogEvent[]> {
  const events: ProcessLogEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

/** `[type, text or exit code, cursor]`, which is all these tests are about. */
function shape(events: ProcessLogEvent[]): unknown[] {
  return events.map(event => event.type === 'terminal'
    ? [event.type, event.state === 'exited' ? event.exit.code : event.error.code, event.cursor]
    : event.type === 'truncated' ? [event.type] : [event.type, decode(event.data), event.cursor])
}

describe('logs', () => {
  it('replays the whole transcript and how the process ended', async () => {
    const fake = fakeHost()
    recorded(fake)
    fake.put(PATHS.stdout, 'out')
    fake.put(PATHS.stderr, 'err!')
    fake.put(PATHS.exit, '0')

    const handle = await sessionOver(fake).getProcess('p1')
    expect(shape(await collect(await handle!.logs()))).toEqual([
      ['stdout', 'out', '3:0'],
      ['stderr', 'err!', '3:4'],
      ['terminal', 0, '3:4'],
    ])
  })

  it('serves a positioned read only what arrived since, and no terminal event', async () => {
    // The watchdog samples this every few seconds for the length of a turn: it counts bytes and
    // ignores terminal events, so re-serving one per tick is noise at best.
    const fake = fakeHost()
    recorded(fake)
    fake.put(PATHS.stdout, 'first-second')
    fake.put(PATHS.exit, '0')

    const handle = await sessionOver(fake).getProcess('p1')
    expect(shape(await collect(await handle!.logs({ since: '5:0' })))).toEqual([
      ['stdout', '-second', '12:0'],
    ])
  })

  it('reads an unusable cursor as the beginning rather than as the end', async () => {
    const fake = fakeHost()
    recorded(fake)
    fake.put(PATHS.stdout, 'out')
    const handle = await sessionOver(fake).getProcess('p1')
    expect(shape(await collect(await handle!.logs({ since: '99999999999999999999:0' })))).toEqual([
      ['stdout', 'out', '3:0'],
    ])
  })

  it('follows until the process is gone, then closes on the terminal event', async () => {
    const fake = fakeHost()
    recorded(fake)
    fake.put(PATHS.stdout, 'done')
    fake.put(PATHS.exit, '0')

    const handle = await sessionOver(fake).getProcess('p1')
    expect(shape(await collect(await handle!.logs({ follow: true, replay: true })))).toEqual([
      ['stdout', 'done', '4:0'],
      ['terminal', 0, '4:0'],
    ])
  })

  it('starts a follower at the live tail when it was not asked to replay', async () => {
    const fake = fakeHost()
    recorded(fake)
    fake.put(PATHS.stdout, 'already written')
    fake.put(PATHS.exit, '0')

    const handle = await sessionOver(fake).getProcess('p1')
    expect(shape(await collect(await handle!.logs({ follow: true })))).toEqual([['terminal', 0, '15:0']])
  })

  it('delivers what was written between the last read and the death verdict', async () => {
    // The verdict and the final line race, and those are the bytes a caller cares most about —
    // the ones that say how the turn finished. One read always follows the verdict.
    const fake = fakeHost()
    recorded(fake)
    fake.put(PATHS.exit, '0')
    const readSlice = fake.host.readSlice.bind(fake.host)
    let reads = 0
    fake.host.readSlice = async (path, offset, length) => {
      if (path === PATHS.stdout && ++reads === 1) {
        // Written after this read has already decided there was nothing.
        fake.put(PATHS.stdout, 'the last line')
      }
      return readSlice(path, offset, length)
    }

    const handle = await sessionOver(fake).getProcess('p1')
    expect(shape(await collect(await handle!.logs({ follow: true, replay: true })))).toEqual([
      ['stdout', 'the last line', '13:0'],
      ['terminal', 0, '13:0'],
    ])
  })

  it('lets a caller cancel a follow of a process that never ends', async () => {
    // Cancelling cannot simply return the generator: the stream keeps one pull in flight, and
    // the return would queue behind a poll that is waiting on a live process.
    const fake = fakeHost()
    recorded(fake)
    fake.place({ pid: 4711 })
    fake.put(PATHS.stdout, 'running')

    const handle = await sessionOver(fake, { followIntervalMs: 50 }).getProcess('p1')
    const stream = await handle!.logs({ follow: true, replay: true })
    const reader = stream.getReader()
    const first = await reader.read()
    expect(first.value?.type).toBe('stdout')
    // The follower is now inside its poll, waiting on a process that is still running.
    await expect(reader.cancel()).resolves.toBeUndefined()
  })
})
