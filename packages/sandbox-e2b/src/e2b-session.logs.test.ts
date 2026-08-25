/**
 * How a turn is read back out of the journal: `logs()` replay, positioned reads, and the
 * process listing that finds a turn to read in the first place. Grouped together because
 * they all turn journal bytes into something a caller can act on, and split off from the
 * process and waiting suites to keep each file readable. The fake sandbox they are written
 * against is `e2b-session.fixtures.ts`.
 */
import type { E2bSandboxLike } from './e2b-session'
import type { Fake } from './e2b-session.fixtures'
import { describe, expect, it } from 'bun:test'
import { decode, encode, fakeSandbox, ROOT, session, streamOf } from './e2b-session.fixtures'
import { decodeCursor } from './log-replay'

describe('createE2bSession', () => {
  describe('logs()', () => {
    it('replays the whole transcript after the process has exited', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('{"a":1}\n'))
      fake.files.set(`${ROOT}/run-1.err`, encode('warn\n'))
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))

      const events = []
      for await (const event of streamOf(await handle.logs({ replay: true, follow: false }))) {
        events.push(event)
      }
      expect(events.map(event => event.type)).toEqual(['stdout', 'stderr', 'terminal'])
      const [stdout] = events
      expect(stdout.type === 'stdout' && decode(stdout.data)).toBe('{"a":1}\n')
    })

    it('serves only what follows the cursor on a positioned read', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('firstsecond'))

      const first = []
      for await (const event of streamOf(await handle.logs({ replay: true }))) {
        first.push(event)
      }
      const resumed = []
      for await (const event of streamOf(await handle.logs({ since: first.at(-1)?.cursor, replay: true }))) {
        resumed.push(event)
      }
      expect(resumed).toHaveLength(0)
    })

    it.each(['out', 'err'])(
      'fails a whole-transcript replay whose .%s read dies mid-file',
      async (suffix) => {
        // `replayTurn` judges the turn from this transcript. A read that died after the first
        // chunk and was served as though it were the whole thing records a successful turn as
        // a failed one whenever the result line sat past the break — and a transcript with a
        // hole in it as complete whenever it did not (codex review, PR #260). Both streams,
        // because the Agent reads stdout for the result and stderr for why there was none.
        const fake = fakeSandbox()
        const handle = await session(fake).exec(['claude'])
        fake.files.set(`${ROOT}/run-1.out`, encode('{"a":1}\n'))
        fake.files.set(`${ROOT}/run-1.err`, encode('warn\n'))
        const failing = `${ROOT}/run-1.${suffix}`
        const inner = fake.sandbox.files.read
        fake.sandbox.files.read = ((path: string, opts: { format: 'bytes' | 'stream' }) =>
          path === failing && opts.format === 'stream'
            ? Promise.resolve(new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(encode('partial'))
                  controller.error(new Error('e2b stream reset'))
                },
              }))
            : inner(path, opts as { format: 'bytes' })) as E2bSandboxLike['files']['read']

        const drain = async (): Promise<void> => {
          for await (const event of streamOf(await handle.logs({ replay: true }))) {
            expect(event.type).toBeDefined()
          }
        }

        await expect(drain()).rejects.toThrow('e2b stream reset')
      },
    )

    it('never moves a cursor backwards when a positioned read dies early', async () => {
      // The cursor is where the next sample starts reading. A stream that failed before
      // reaching it would otherwise encode a lower total, and the next sample would re-read
      // output it has already counted — reporting a wedged turn as alive on its own old
      // bytes, and replaying a large stale segment every time (codex review, PR #260).
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('0123456789'))

      const first = []
      for await (const event of streamOf(await handle.logs({ replay: true }))) {
        first.push(event)
      }
      fake.files.set(`${ROOT}/run-1.err`, encode('late stderr'))
      const stdout = `${ROOT}/run-1.out`
      const inner = fake.sandbox.files.read
      fake.sandbox.files.read = ((path: string, opts: { format: 'bytes' | 'stream' }) =>
        path === stdout && opts.format === 'stream'
          ? Promise.resolve(new ReadableStream<Uint8Array>({
              start: controller => controller.error(new Error('e2b stream reset')),
            }))
          : inner(path, opts as { format: 'bytes' })) as E2bSandboxLike['files']['read']

      const resumed = []
      for await (const event of streamOf(await handle.logs({ since: first.at(-1)?.cursor, replay: true }))) {
        resumed.push(event)
      }

      expect(decodeCursor(resumed.at(-1)?.cursor ?? '')).toEqual({ stdout: 10, stderr: 11 })
    })

    it('reports an empty journal as no output rather than failing', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      const events = []
      for await (const event of streamOf(await handle.logs({ replay: true }))) {
        events.push(event)
      }
      expect(events).toEqual([])
    })
  })

  /**
   * Coverage carried over from `log-replay.test.ts`'s `replayEvents` suite, which this
   * streaming path replaced. The projection is no longer a pure function over two buffers —
   * interleaving the read with the emission is the whole point — so the same properties are
   * now asserted through `logs()`.
   */
  describe('logs() whole-transcript replay', () => {
    async function drain(fake: Fake, since?: string) {
      const handle = await session(fake).exec(['claude'])
      const events = []
      const reader = (await handle.logs({ since, replay: true, follow: false })).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        events.push(value)
      }
      return events
    }

    it('emits one event per non-empty stream, tagged by stream, stdout first', async () => {
      const fake = fakeSandbox()
      fake.files.set(`${ROOT}/run-1.out`, encode('{"a":1}\n'))
      fake.files.set(`${ROOT}/run-1.err`, encode('warn\n'))

      const events = await drain(fake)

      expect(events.map(event => event.type)).toEqual(['stdout', 'stderr'])
      const [out, err] = events
      expect(out.type === 'stdout' && decode(out.data)).toBe('{"a":1}\n')
      expect(err.type === 'stderr' && decode(err.data)).toBe('warn\n')
    })

    it('omits a stream that has produced nothing', async () => {
      const fake = fakeSandbox()
      fake.files.set(`${ROOT}/run-1.out`, encode('x'))

      expect((await drain(fake)).map(event => event.type)).toEqual(['stdout'])
    })

    it('closes with a terminal event once the exit code has been journalled', async () => {
      const fake = fakeSandbox()
      fake.files.set(`${ROOT}/run-1.out`, encode('x'))
      fake.files.set(`${ROOT}/run-1.exit`, encode('3'))

      const last = (await drain(fake)).at(-1)

      expect(last?.type).toBe('terminal')
      expect(last?.type === 'terminal' && last.state === 'exited' && last.exit)
        .toEqual({ code: 3, timedOut: false })
    })

    it('emits no terminal event while the process is still running', async () => {
      const fake = fakeSandbox()
      fake.files.set(`${ROOT}/run-1.out`, encode('x'))

      expect((await drain(fake)).some(event => event.type === 'terminal')).toBe(false)
    })

    it('carries a cursor that accounts for both streams', async () => {
      const fake = fakeSandbox()
      fake.files.set(`${ROOT}/run-1.out`, encode('abc'))
      fake.files.set(`${ROOT}/run-1.err`, encode('de'))

      expect((await drain(fake)).at(-1)?.cursor).toBe('3:2')
    })

    it('advances the cursor past a terminal event so a later since is not re-served', async () => {
      const fake = fakeSandbox()
      fake.files.set(`${ROOT}/run-1.out`, encode('abc'))
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))

      const first = await drain(fake)

      expect(await drain(fake, first.at(-1)?.cursor)).toEqual([])
    })

    it('splits a large transcript across events rather than handing over one buffer', async () => {
      // `replayTurn` folds into a bounded window "so the full transcript never exists in
      // memory (AC-016)" and `processStderr` drains stdout to keep stderr's bounded tail.
      // One event per stream defeats both, whatever the consumer does afterwards.
      const fake = fakeSandbox()
      fake.chunkSize = 4
      fake.files.set(`${ROOT}/run-1.out`, encode('abcdefghijkl'))

      const events = await drain(fake)

      expect(events).toHaveLength(3)
      expect(events.map(event => event.type === 'stdout' && decode(event.data)))
        .toEqual(['abcd', 'efgh', 'ijkl'])
      // Each event carries the position reached so far, so the last one is the file's end.
      expect(events.map(event => event.cursor)).toEqual(['4:0', '8:0', '12:0'])
    })

    it('cancels the underlying file stream when the consumer stops reading early', async () => {
      // Abandoning the read leaves e2b's response body open unless the reader is cancelled
      // rather than merely unlocked, and the watchdog abandons log reads routinely.
      const fake = fakeSandbox()
      fake.chunkSize = 4
      fake.files.set(`${ROOT}/run-1.out`, encode('abcdefghijkl'))
      const handle = await session(fake).exec(['claude'])

      const stream = await handle.logs({ replay: true, follow: false })
      const reader = stream.getReader()
      await reader.read()
      await reader.cancel()

      expect(fake.calls.cancelled).toEqual([`${ROOT}/run-1.out`])
    })
  })

  describe('logs() positioning', () => {
    /**
     * The watchdog samples every few seconds for the whole length of a turn, so a positioned
     * read that takes the file whole to slice its tail off costs O(total transcript) in a
     * 128MB isolate on every tick. Which form of read is used is the fix, so it is what is
     * asserted; the behaviour either form produces is identical by construction.
     */
    async function readAt(fake: Fake, since?: string): Promise<{ text: string, cursor?: string }> {
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.out`, encode('first-half|second-half'))
      const events = []
      const reader = (await handle.logs({ since, replay: true, follow: false })).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        events.push(value)
      }
      const out = events.flatMap(event => event.type === 'stdout' ? [event] : [])
      return {
        text: out.map(event => decode(event.data)).join(''),
        cursor: out.at(-1)?.cursor,
      }
    }

    it('streams a positioned read so the bytes before the cursor are never held', async () => {
      const fake = fakeSandbox()
      fake.chunkSize = 4

      const { text, cursor } = await readAt(fake, '11:0')

      expect(text).toBe('second-half')
      // The cursor is a position in the journal, so it names the file's length — not how
      // many bytes this read happened to serve.
      expect(cursor).toBe('22:0')
      expect(fake.calls.readFormats).toContain('stream')
      expect(fake.calls.readFormats).not.toContain('bytes')
    })

    it('streams the transcript on an unpositioned read too, exit record included', async () => {
      // `replayTurn` needs all of it and the terminal event, but "all of it" is what it
      // folds — not what it should have to hold. The exit record is streamed as well, and
      // abandoned past its cap: it is the turn's file too, and it is re-read on every
      // liveness probe (codex review, PR #260).
      const fake = fakeSandbox()
      fake.chunkSize = 6

      const { text } = await readAt(fake)

      expect(text).toBe('first-half|second-half')
      expect(fake.calls.readFormats.filter(format => format === 'stream')).toHaveLength(3)
      expect(fake.calls.readFormats).not.toContain('bytes')
    })

    it('reads no exit code from a file too large to be one, and stops reading it', async () => {
      // The wrapper writes at most three digits, but the file is the turn's to write and is
      // re-read on every liveness probe. Buffering it whole first would let a turn make the
      // Worker hold an arbitrarily large file, repeatedly (codex review, PR #260) — so the
      // *state* is only half the assertion; a read-it-all-then-discard would reach the same
      // one. The pull count is what says the read was bounded (cubic review, PR #260).
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      const handle = await active.exec(['claude'])
      fake.chunkSize = 8
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'.repeat(4096)))
      fake.live.delete(2054)
      const before = fake.calls.pulled

      expect((await handle.status()).state).toBe('error')
      // 512 chunks of 8 bytes are there to be taken. The cap is 32, so the read stops on the
      // fifth chunk; a `ReadableStream` pulls one ahead, and `status()` reads the exit file
      // twice — sixteen leaves room for all of that and is still two orders off the whole
      // file, which is the difference this asserts.
      expect(fake.calls.pulled - before).toBeLessThanOrEqual(16)
    })

    it('reads no exit code from a record whose read died mid-file', async () => {
      // Half of `137` is `1` — a perfectly plausible failure the turn never had. A partial
      // exit record must read as no exit record (cubic review, PR #260).
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      const handle = await active.exec(['claude'])
      fake.live.delete(2054)
      const exit = `${ROOT}/run-1.exit`
      const inner = fake.sandbox.files.read
      let served = false
      fake.sandbox.files.read = ((path: string, opts: { format: 'bytes' | 'stream' }) =>
        path === exit && opts.format === 'stream'
          ? Promise.resolve(new ReadableStream<Uint8Array>({
              // Enqueued and errored on separate pulls: `error()` discards whatever is still
              // queued, so a stream that does both at once delivers nothing and never
              // exercises a *partial* read at all.
              pull(controller) {
                if (served) {
                  controller.error(new Error('e2b stream reset'))
                  return
                }
                served = true
                controller.enqueue(encode('1'))
              },
            }))
          : inner(path, opts as { format: 'bytes' })) as E2bSandboxLike['files']['read']

      expect((await handle.status()).state).toBe('error')
    })

    it('positions inside a chunk rather than only at its boundary', async () => {
      const fake = fakeSandbox()
      fake.chunkSize = 5

      // 11 is not a multiple of 5, so the cursor lands mid-chunk.
      expect((await readAt(fake, '11:0')).text).toBe('second-half')
    })

    it('serves nothing for a cursor past the end of a truncated journal', async () => {
      const fake = fakeSandbox()
      fake.chunkSize = 3

      expect((await readAt(fake, '9999:0')).text).toBe('')
    })
  })

  describe('listProcesses()', () => {
    it('reports both live and exited processes, unlike e2b commands.list()', async () => {
      const fake = fakeSandbox()
      const active = session(fake, ['run-1', 'run-2'])
      await active.exec(['first'])
      await active.exec(['second'])
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))
      fake.live.delete(2054)

      const listed = await active.listProcesses()
      expect(listed.map(process => [process.id, process.state]).sort()).toEqual([
        ['run-1', 'exited'],
        ['run-2', 'running'],
      ])
    })

    /**
     * `liveTurnProcess` reads this listing to find a turn a replayed `start-turn` step
     * already launched. That step is not idempotent, so "the API blipped" must not arrive
     * as "no processes are running" — the reuse guard would miss the live turn and start a
     * second `claude` in the same checkout.
     */
    it('fails rather than reporting an empty table when the listing itself fails', async () => {
      const fake = fakeSandbox()
      fake.dirs.add(ROOT)
      fake.sandbox.files.list = async () => {
        throw new Error('e2b api unavailable')
      }

      await expect(session(fake, []).listProcesses()).rejects.toThrow('e2b api unavailable')
    })

    it('fails rather than dropping a process whose journalled meta will not read', async () => {
      // One level down from the listing guard above: the directory just named this file, so
      // a read that fails is a failed read — and a dropped entry is a live turn the
      // duplicate-turn guard cannot see.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude'])
      fake.sandbox.files.read = async () => {
        throw new Error('e2b api unavailable')
      }

      await expect(active.listProcesses()).rejects.toThrow('e2b api unavailable')
    })

    it('drops an entry whose meta really is gone between the listing and the read', async () => {
      // The other half of the same judgement: absence records no process, so it is dropped;
      // anything else knows nothing and must not be read as absence.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1', 'run-2'])
      await active.exec(['first'])
      await active.exec(['second'])
      // Gone from e2b as well, so the recovery below has nothing to find and this really is
      // the drop case rather than a process still running under an erased meta.
      fake.live.delete(2054)
      const gone = `${ROOT}/run-1.meta.json`
      const inner = fake.sandbox.files.read
      fake.sandbox.files.read = ((path: string, opts: { format: 'bytes' | 'stream' }) =>
        path === gone
          ? Promise.reject(new Error('not found'))
          : inner(path, opts as { format: 'bytes' })) as E2bSandboxLike['files']['read']
      fake.files.delete(gone)

      expect((await active.listProcesses()).map(entry => entry.id)).toEqual(['run-2'])
    })

    it('recovers the id from the redirection, not from a path the prompt names', async () => {
      // The argv is tracker-authored text. A prompt naming a journal path would otherwise
      // file the live wrapper under that id: the real one then looks absent, `killTurn`
      // reads that as a confirmed death, and the next attempt starts beside a running turn.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude', '-p', `write to ${ROOT}/fake.out please`])
      fake.files.delete(`${ROOT}/run-1.meta.json`)

      const listed = await active.listProcesses()

      expect(listed.map(entry => entry.id)).toEqual(['run-1'])
      expect(await active.getProcess('fake')).toBeNull()
    })

    it('still lists a running process whose meta the turn deleted', async () => {
      // `liveTurnProcess` reads this listing as its duplicate-turn guard, so a turn that
      // erases its own meta would otherwise arrive as "nothing is running in this checkout"
      // and have a second `claude` started beside it. e2b's listing is the record the turn
      // cannot erase; the argv is read back out of the wrapper so the guard can still match
      // it against the command it is about to start.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude', '-p', `it's a turn`])
      fake.files.delete(`${ROOT}/run-1.meta.json`)

      const listed = await active.listProcesses()

      expect(listed.map(entry => [entry.id, entry.state])).toEqual([['run-1', 'running']])
      expect(listed[0]!.command).toEqual(['claude', '-p', `it's a turn`])
    })

    it('reports the argv e2b lists, not the one a live turn rewrote into its own meta', async () => {
      // `liveTurnProcess` matches a discovered process by its argv, and the meta file lives
      // in the sandbox the turn writes to. Believing `command` from there lets a running turn
      // make itself unrecognisable to the duplicate-turn guard and have a second `claude`
      // started beside it in the same checkout (codex review, PR #260).
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude', '-p', 'the real turn'])
      const path = `${ROOT}/run-1.meta.json`
      const journalled = JSON.parse(decode(fake.files.get(path) ?? encode('{}'))) as Record<string, unknown>
      fake.files.set(path, encode(JSON.stringify({ ...journalled, command: ['innocent'] })))

      const listed = await active.listProcesses()

      expect(listed[0]!.command).toEqual(['claude', '-p', 'the real turn'])
      expect((await (await active.getProcess('run-1'))?.status())?.command)
        .toEqual(['claude', '-p', 'the real turn'])
    })

    it('recovers a process under a journal root whose name contains a quote', async () => {
      // `quoteArg` splits `it's` into `'it'\''s'`, so reading the redirection up to the first
      // closing quote truncates the path. The wrapper then matches no journal at all, a
      // running turn reads as gone, and the next attempt starts beside it (cubic review,
      // PR #260).
      const root = `/home/user/it's-runs`
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'], { journalRoot: root })
      await active.exec(['claude'])
      fake.files.delete(`${root}/run-1.meta.json`)

      const listed = await active.listProcesses()

      expect(listed.map(entry => [entry.id, entry.state])).toEqual([['run-1', 'running']])
    })

    it('reports an empty table when the journal root is simply not there yet', async () => {
      // The ordinary state before the first turn: nothing has been journalled, so `list`
      // throws for a reason that genuinely means "no processes".
      const fake = fakeSandbox()
      fake.sandbox.files.list = async () => {
        throw new Error('no such file or directory')
      }

      expect(await session(fake, []).listProcesses()).toEqual([])
    })

    it('skips a foreign filename without losing the valid entries beside it', async () => {
      // Not merely adversarial: a dot or a space in a neighbouring file is enough, and the
      // rejection took the whole listing — and with it the duplicate-turn guard — down.
      const fake = fakeSandbox()
      await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/2026-08-24.log.meta.json`, encode('{}'))
      fake.files.set(`${ROOT}/a b.meta.json`, encode('{}'))

      const listed = await session(fake, []).listProcesses()
      expect(listed.map(process => process.id)).toEqual(['run-1'])
    })
  })
})
