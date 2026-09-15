import type { ProcessLogEvent } from '@amond-ai/sandbox'
import { describe, expect, it, vi } from 'vitest'
import { AT, decode, fakeSandbox, ROOT } from './vercel-sandbox.fake'
import { createVercelSession } from './vercel-session'
import { endProcess, killWrapperOnly, startProcess, streamOf, writeErr, writeOut } from './vercel-session.fixtures'

function session(fake: ReturnType<typeof fakeSandbox>) {
  return createVercelSession(fake.sandbox, {
    journalRoot: ROOT,
    newProcessId: () => 'p1',
    now: () => AT,
    pollIntervalMs: 0,
    followIntervalMs: 1,
  })
}

async function started(fake: ReturnType<typeof fakeSandbox>) {
  const handle = await session(fake).exec(['claude', '-p'])
  startProcess(fake, handle.id)
  return handle
}

function text(event: ProcessLogEvent): string {
  return event.type === 'stdout' || event.type === 'stderr' ? decode(event.data) : event.type
}

/** Read until a terminal event arrives, so a test cannot hang on a stream that never closes. */
async function readUntilTerminal(stream: ReadableStream<ProcessLogEvent>): Promise<ProcessLogEvent[]> {
  const events: ProcessLogEvent[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return events
    }
    events.push(value)
    if (value.type === 'terminal') {
      await reader.cancel()
      return events
    }
  }
}

describe('the whole-transcript read', () => {
  it('serves both streams and how the turn ended', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    writeOut(fake, handle.id, 'out')
    writeErr(fake, handle.id, 'err')
    endProcess(fake, handle.id, 0)

    const events = await streamOf(await handle.logs())

    expect(events.map(text)).toEqual(['out', 'err', 'terminal'])
    expect(events.at(-1)).toMatchObject({ state: 'exited', exit: { code: 0 } })
  })

  it('emits no terminal while the process is still running', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    writeOut(fake, handle.id, 'partial')

    expect((await streamOf(await handle.logs())).map(text)).toEqual(['partial'])
  })

  it('never emits a truncated event — nothing rotates or evicts this journal', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    writeOut(fake, handle.id, 'x'.repeat(200_000))
    endProcess(fake, handle.id, 0)

    const events = await streamOf(await handle.logs())

    expect(events.some(event => event.type === 'truncated')).toBe(false)
    // Cut into chunks all the same, because `replayTurn` folds into a bounded window and
    // `processStderr` keeps only stderr's bounded tail — both written against a stream.
    expect(events.filter(event => event.type === 'stdout')).toHaveLength(4)
  })
})

describe('the positioned read', () => {
  it('serves what arrived since the cursor, and nothing before it', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    writeOut(fake, handle.id, 'first')
    const [seen] = await streamOf(await handle.logs())
    writeOut(fake, handle.id, 'second')

    const events = await streamOf(await handle.logs({ since: seen?.cursor }))

    expect(events.map(text)).toEqual(['second'])
  })

  it('re-serves no terminal, because a sampler would double-count the exit', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    endProcess(fake, handle.id, 0)

    expect(await streamOf(await handle.logs({ since: '0:0' }))).toEqual([])
  })
})

describe('the following read', () => {
  it('starts at the live tail unless replay was asked for', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    writeOut(fake, handle.id, 'before the subscriber')
    const stream = await handle.logs({ follow: true })
    const reader = stream.getReader()
    writeOut(fake, handle.id, 'after')

    expect(text((await reader.read()).value as ProcessLogEvent)).toBe('after')
    await reader.cancel()
  })

  it('replays the retained journal from the beginning when asked', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    writeOut(fake, handle.id, 'before the subscriber')
    const stream = await handle.logs({ follow: true, replay: true })
    const reader = stream.getReader()

    expect(text((await reader.read()).value as ProcessLogEvent)).toBe('before the subscriber')
    await reader.cancel()
  })

  it('stays open while the group is live and closes once it is gone', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const stream = await handle.logs({ follow: true, replay: true })
    const reader = stream.getReader()
    writeOut(fake, handle.id, 'still working')

    expect(text((await reader.read()).value as ProcessLogEvent)).toBe('still working')
    writeOut(fake, handle.id, 'and done')
    endProcess(fake, handle.id, 0)

    // The final drain is what makes the last write reachable: bytes flushed between the loop's
    // last slice read and its verdict would otherwise be lost.
    expect(text((await reader.read()).value as ProcessLogEvent)).toBe('and done')
    expect((await reader.read()).value).toMatchObject({ type: 'terminal', exit: { code: 0 } })
  })

  it('does not close on an exit record forged while the group is alive', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const stream = await handle.logs({ follow: true, replay: true })
    const reader = stream.getReader()
    fake.files.set(`${ROOT}/p1.exit`, new TextEncoder().encode('0'))
    writeOut(fake, handle.id, 'still writing')

    // A tail that believed the file alone would close a live stream mid-transcript, and the
    // harness reads a closed stream as the bridge dying.
    expect(text((await reader.read()).value as ProcessLogEvent)).toBe('still writing')
    await reader.cancel()
  })

  it('ends a SIGKILLed wrapper as the no_exit_record terminal rather than as silence', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const stream = await handle.logs({ follow: true, replay: true })
    killWrapperOnly(fake, handle.id)

    const events = await readUntilTerminal(stream)

    expect(events.at(-1)).toMatchObject({
      type: 'terminal',
      state: 'error',
      error: { code: 'no_exit_record', message: 'process is not running and journalled no exit code' },
    })
  })

  it('transfers nothing at all while the journal is quiet', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const before = fake.calls.runCommand
    const stream = await handle.logs({ follow: true })
    const reader = stream.getReader()
    const reading = reader.read()
    await new Promise(resolve => setTimeout(resolve, 25))

    // The probe's length field is the gate: a poll that finds neither file past the cursor
    // reads no bytes at all, which is what makes polling a quiet bridge affordable.
    expect(fake.calls.read).toBe(0)
    // It did keep polling, though — the zero above is a gate, not a stalled loop. How many
    // polls fit in those 25ms is the runner's to decide, so the bound is the claim itself
    // (it polled more than once) rather than a count: `toBeGreaterThan(3)` failed in CI at
    // exactly 3, which says nothing about the gate this test is actually about.
    expect(fake.calls.runCommand - before).toBeGreaterThan(1)
    await reader.cancel()
    await reading
  })

  it('cancels without deadlocking on the poll in flight', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const stream = await handle.logs({ follow: true })
    const reader = stream.getReader()
    const reading = reader.read()
    await new Promise(resolve => setTimeout(resolve, 10))

    // A `ReadableStream` keeps one `pull` in flight, so at cancel time the tail is inside
    // `next()` and a bare `return()` would queue behind a loop that may never end.
    await expect(Promise.race([
      reader.cancel(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel deadlocked')), 1_000)),
    ])).resolves.toBeUndefined()
    await reading
  })

  it('drops the caller’s abort listener on a follow that ends by itself', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const caller = new AbortController()
    const dropped = vi.spyOn(caller.signal, 'removeEventListener')
    endProcess(fake, handle.id, 0)

    await streamOf(await handle.logs({ follow: true, signal: caller.signal }))

    // The signal `harness-sandbox` passes outlives the process it was spawned for, so a listener
    // left behind per `logs()` call accumulates on it for the session's lifetime.
    expect(dropped).toHaveBeenCalledWith('abort', expect.any(Function))
    dropped.mockRestore()
  })

  it('ends at once when the caller has already aborted', async () => {
    const fake = fakeSandbox()
    const handle = await started(fake)
    const caller = new AbortController()
    caller.abort()

    expect(await streamOf(await handle.logs({ follow: true, signal: caller.signal }))).toEqual([])
  })
})
