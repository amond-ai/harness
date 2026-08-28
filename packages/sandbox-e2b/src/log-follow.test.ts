/**
 * `logs({ follow: true })` — the live read.
 *
 * Its own file because it is a different question from the replay suite next door: replay
 * asks what a finished turn looks like, this asks whether a stream stays open across a gap
 * in a *running* process's output. The distinction is not academic — the backend answered
 * both with one snapshot read until 2026-08-27, and the AI SDK harness, which reads the
 * bridge's stdout as a liveness channel, took the resulting end-of-stream as
 * `bridge exited before becoming ready` (`scripts/spike-e2b-follow.ts`: the stream closed at
 * 1489ms against a process that ran to 16680ms).
 */
import { describe, expect, it } from 'bun:test'
import { decode, encode, endProcess, fakeSandbox, ROOT, session, streamOf } from './e2b-session.fixtures'

/** Read one event, so a test can write into the journal *while* the stream is open. */
async function next(reader: ReadableStreamDefaultReader<{
  type: string
  state?: string
  data?: Uint8Array
  error?: { code: string, message: string }
}>) {
  const { done, value } = await reader.read()
  return done ? undefined : value
}

describe('createE2bSession', () => {
  describe('logs({ follow: true })', () => {
    it('stays open across a gap and serves what the process writes next', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('first\n'))

      const reader = (await handle.logs({ replay: true, follow: true })).getReader()
      try {
        const first = await next(reader)
        expect(first?.type).toBe('stdout')
        expect(first?.data && decode(first.data)).toBe('first\n')

        // The gap the snapshot read used to end in: nothing new for a while, then more.
        fake.files.set(`${ROOT}/run-1.out`, encode('first\nsecond\n'))

        const second = await next(reader)
        expect(second?.type).toBe('stdout')
        expect(second?.data && decode(second.data)).toBe('second\n')
      }
      finally {
        await reader.cancel().catch(() => {})
      }
    })

    it('closes with a terminal event once the process has exited', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1, followLivenessIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('working\n'))

      const stream = await handle.logs({ replay: true, follow: true })
      const reader = stream.getReader()
      const seen: { type: string, data?: Uint8Array }[] = []
      const first = await next(reader)
      if (first) {
        seen.push(first)
      }

      // Written after the stream opened, and the exit record last — the order the wrapper
      // writes them in. A follower that reads the exit code before draining would stop here
      // with `done\n` still in the file.
      fake.files.set(`${ROOT}/run-1.out`, encode('working\ndone\n'))
      endProcess(fake, 'run-1', '0')

      for (;;) {
        const event = await next(reader)
        if (!event) {
          break
        }
        seen.push(event)
      }

      expect(seen.map(event => event.type)).toEqual(['stdout', 'stdout', 'terminal'])
      expect(decode(seen[1].data!)).toBe('done\n')
    })

    it('ends when the caller aborts, rather than polling a sandbox nobody is reading', async () => {
      // `harness-sandbox` passes its `abortSignal` here, and a follow that ignored it would
      // outlive the caller: the snapshot read ended on its own, a tail does not.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('first\n'))
      const control = new AbortController()

      const stream = await handle.logs({ replay: true, follow: true, signal: control.signal })
      const reader = stream.getReader()
      expect((await next(reader))?.type).toBe('stdout')

      // Asserted before the abort as well, because "the read ended" is what a *snapshot* does
      // too: without this the test passes against the very implementation it exists to reject.
      // Nothing new is written and the process never exits, so a follower must still be waiting.
      const pending = next(reader)
      const settled = new Promise<'waiting'>(resolve => setTimeout(resolve, 25, 'waiting'))
      expect(await Promise.race([pending, settled])).toBe('waiting')

      control.abort()
      expect(await pending).toBeUndefined()
    })

    it('ends the stream when the wrapper died without journalling an exit', async () => {
      // The escape `waitForExit` already has and the tail did not (code review, PR #280). The
      // wrapper writes `printf '%s' "$?"` *after* the command, so a killed or OOM-reaped
      // wrapper never writes one — and a tail whose only stopping rule is that file follows a
      // process that no longer exists for as long as the caller lives. That is worse here than
      // in a wait: `@ai-sdk/harness` reads end-of-stream as "the bridge died", so this is the
      // very signal the follow read exists to make meaningful.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1, followLivenessIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('starting\n'))

      const reader = (await handle.logs({ replay: true, follow: true })).getReader()
      expect((await next(reader))?.type).toBe('stdout')

      // Killed, the way `kill()` kills: the whole session goes, so no `$?` is ever recorded.
      fake.live.delete(2054)

      const terminal = await next(reader)
      expect(terminal?.type).toBe('terminal')
      expect(terminal?.state).toBe('error')
      expect(terminal?.error?.code).toBe('no_exit_record')
      expect(await next(reader)).toBeUndefined()
    })

    it('does not end on an exit record the process could have forged', async () => {
      // `statusOf` refuses to call the exit file terminal until e2b's process table agrees,
      // because "a prompt-injected or merely buggy turn can journal an exit for itself while
      // it is still running" — the table is the part the turn cannot forge. A tail that
      // trusted the file alone would close a live stream and truncate the transcript, which
      // the harness reads as the bridge dying (code review, PR #280).
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1, followLivenessIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('still working\n'))
      const reader = (await handle.logs({ replay: true, follow: true })).getReader()
      expect((await next(reader))?.type).toBe('stdout')

      // The forgery: an exit record while the pid is still in the table.
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))

      const pending = next(reader)
      const waiting = new Promise<'waiting'>(resolve => setTimeout(resolve, 25, 'waiting'))
      expect(await Promise.race([pending, waiting])).toBe('waiting')

      // Now it really ends, and only now is the record worth believing.
      fake.live.delete(2054)
      expect((await pending)?.type).toBe('terminal')
      await reader.cancel().catch(() => {})
    })

    it('ends without waiting out the interval when the abort lands mid-poll', async () => {
      // The window the loop's own `aborted` check cannot cover: the caller aborts *while* a
      // poll is in flight, so the tail reaches `sleep` with a signal that has already fired.
      // An `abort` listener registered then is never called, and the follow sits out a whole
      // interval — a second by default — after its reader has gone (gemini review, PR #280).
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 3_000 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('first\n'))
      const control = new AbortController()

      // Aborting from inside the read is the only way to land in that window deliberately:
      // the stream pulls again the moment a chunk is taken, so a test that aborts between
      // reads finds the tail already asleep, where the listener does fire.
      const inner = fake.sandbox.files.read.bind(fake.sandbox.files)
      fake.sandbox.files.read = ((path: string, opts: { format: 'stream' }) => {
        if (path.endsWith('.out')) {
          control.abort()
        }
        return inner(path, opts)
      }) as typeof fake.sandbox.files.read

      const stream = await handle.logs({ replay: true, follow: true, signal: control.signal })
      const reader = stream.getReader()
      expect((await next(reader))?.type).toBe('stdout')

      const ended = next(reader)
      const stalled = new Promise<'stalled'>(resolve => setTimeout(resolve, 50, 'stalled'))
      expect(await Promise.race([ended, stalled])).toBeUndefined()
    })

    it('reads the journal at most once per interval while output keeps arriving', async () => {
      // The tail used to skip the wait whenever a poll served bytes, for first-byte latency.
      // e2b has no byte-range read, so each poll re-transfers the whole file: a command that
      // writes continuously — `pnpm install`, on the harness's own bootstrap path — turned
      // that into a back-to-back full-file download loop inside a 128MB isolate (code review,
      // PR #280). Latency is bounded by the interval instead, against a readiness budget of
      // two minutes.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 40 }).exec(['claude'])

      // A process that is *always* mid-write: the file has grown again by the time any read
      // observes it. Anything less cannot tell the two loops apart — a fake that writes on a
      // timer leaves gaps, and the old loop slept in those gaps too.
      const inner = fake.sandbox.files.read.bind(fake.sandbox.files)
      let grown = 0
      fake.sandbox.files.read = ((path: string, opts: { format: 'stream' }) => {
        if (path.endsWith('.out')) {
          grown += 1
          fake.files.set(path, encode('chunk\n'.repeat(grown)))
        }
        return inner(path, opts)
      }) as typeof fake.sandbox.files.read

      const reader = (await handle.logs({ replay: true, follow: true })).getReader()
      expect((await next(reader))?.type).toBe('stdout')

      // Read as fast as the stream will serve, which is what the harness does. Without a
      // consumer the question cannot even be asked: a `ReadableStream` stops pulling once its
      // queue is full, so an idle test measures back-pressure rather than the loop.
      const until = Date.now() + 200
      while (Date.now() < until) {
        await next(reader)
      }
      await reader.cancel().catch(() => {})

      // 200ms at a 40ms interval is a handful of polls. The bound that matters is that the
      // count scales with elapsed time rather than with how fast the process writes.
      expect(grown).toBeLessThan(15)
    })

    it('starts at the tail when the caller followed without asking for replay', async () => {
      // `replay` is the contract's word for "read the retained log from the beginning rather
      // than from the live tail", and `harness-sandbox` passes it explicitly for that reason.
      // A follow that replayed regardless served a subscriber every byte the process had
      // already written, so a consumer attaching to a long-running turn double-counts its
      // whole transcript and diverges from the Cloudflare backend (codex review, PR #280).
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('retained\n'))

      const reader = (await handle.logs({ follow: true })).getReader()
      // The first read is what establishes the tail, so the new bytes must land after it —
      // written any earlier, they would be part of the retained log this test is about.
      const pending = next(reader)
      await new Promise(resolve => setTimeout(resolve, 20))
      fake.files.set(`${ROOT}/run-1.out`, encode('retained\nfresh\n'))

      const first = await pending
      expect(first?.data && decode(first.data)).toBe('fresh\n')
      await reader.cancel().catch(() => {})
    })

    it('refuses to position a tail on a read that failed, rather than starting from zero', async () => {
      // `streamFile` treats a file it cannot open as silence, which is right for a stream the
      // wrapper has not written to yet and wrong for positioning: a transient `files.read`
      // failure would put the tail at byte 0, and the next successful poll would replay the
      // whole retained transcript — the very double-count this start rule exists to prevent
      // (codex review, PR #280).
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1 }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('retained\n'))

      const inner = fake.sandbox.files.read.bind(fake.sandbox.files)
      let failed = false
      fake.sandbox.files.read = ((path: string, opts: { format: 'stream' }) => {
        if (path.endsWith('.out') && !failed) {
          failed = true
          return Promise.reject(new Error('e2b unreachable'))
        }
        return inner(path, opts)
      }) as typeof fake.sandbox.files.read

      const reader = (await handle.logs({ follow: true })).getReader()
      // The file is there; only the read failed. Serving `retained\n` here would be the bug.
      await expect(next(reader)).rejects.toThrow('e2b unreachable')
    })

    it('positions a tail at zero for a stream the wrapper has not written to yet', async () => {
      // The other half of the same rule: an *absent* file really is empty, and a turn that
      // wrote no stderr must not fail its own subscription.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { followIntervalMs: 1 }).exec(['claude'])

      const reader = (await handle.logs({ follow: true })).getReader()
      const pending = next(reader)
      await new Promise(resolve => setTimeout(resolve, 20))
      fake.files.set(`${ROOT}/run-1.err`, encode('warning\n'))

      const first = await pending
      expect(first?.type).toBe('stderr')
      expect(first?.data && decode(first.data)).toBe('warning\n')
      await reader.cancel().catch(() => {})
    })

    it('leaves the snapshot read alone', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('only\n'))

      // No exit record and no `follow`: this must still end at the journal's current EOF,
      // which is what `replayTurn` reads a finished turn with.
      const events = []
      for await (const event of streamOf(await handle.logs({ replay: true, follow: false }))) {
        events.push(event)
      }
      expect(events.map(event => event.type)).toEqual(['stdout'])
    })
  })
})
