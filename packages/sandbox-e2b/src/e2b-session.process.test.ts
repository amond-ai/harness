/**
 * The half of `createE2bSession` that starts and owns a process: launching it through the
 * journal wrapper, reattaching to one by id, and reaping it. Split from the waiting and log
 * suites so each file stays readable; they share `e2b-session.fixtures.ts` so all three are
 * written against one fake sandbox.
 */
import { describe, expect, it } from 'bun:test'
import { decode, encode, fakeSandbox, ROOT, session } from './e2b-session.fixtures'

describe('createE2bSession', () => {
  describe('exec()', () => {
    it('runs the argv through the journal wrapper in the background', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude', '-p', 'do it'], { cwd: '/workspace' })

      expect(handle.id).toBe('run-1')
      expect(fake.ran).toHaveLength(1)
      expect(fake.ran[0].cmd).toContain(`'claude' '-p' 'do it'`)
      expect(fake.ran[0].cmd).toContain(`> '${ROOT}/run-1.out'`)
      expect(fake.ran[0].cmd).toContain(`2> '${ROOT}/run-1.err'`)
      expect(fake.ran[0].opts.background).toBe(true)
      expect(fake.ran[0].opts.cwd).toBe('/workspace')
    })

    it('records the pid so a later call can find, kill and judge the process', async () => {
      const fake = fakeSandbox(4242)
      await session(fake).exec(['echo', 'hi'])

      const meta = JSON.parse(decode(fake.files.get(`${ROOT}/run-1.meta.json`)!))
      expect(meta).toMatchObject({ id: 'run-1', pid: 4242, command: ['echo', 'hi'] })
    })
  })

  describe('getProcess()', () => {
    it('returns null for an id the journal has never seen', async () => {
      expect(await session(fakeSandbox()).getProcess('unknown-1')).toBeNull()
    })

    // e2b forgets an exited process, so after a turn ends neither record names it and a meta
    // that was deleted — or whose read failed — leaves only the journal files. `null` here
    // reaches `settleRun` as logs that could not be read, recording a turn that succeeded as
    // one that failed (codex review, PR #260). Each file is enough on its own, and they are
    // exercised separately because either one alone is the case that actually occurs.
    it.each([
      ['exit record', 'exit', '0', 'exited'],
      ['transcript', 'out', '{"a":1}\n', 'error'],
    ] as const)('reattaches through the %s alone when the meta is gone too', async (_what, suffix, contents, state) => {
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude'])
      fake.live.delete(2054)
      fake.files.set(`${ROOT}/run-1.${suffix}`, encode(contents))
      fake.files.delete(`${ROOT}/run-1.meta.json`)

      const handle = await active.getProcess('run-1')

      expect(handle).not.toBeNull()
      expect((await handle?.status())?.state).toBe(state)
    })

    it('fails rather than reporting no process when the journal probe itself fails', async () => {
      // `killTurn` reads a `null` lookup as a *confirmed death*, so an e2b blip swallowed
      // into "nothing here" would clear the way for a second `claude` in the same checkout
      // (cubic review, PR #260).
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude'])
      fake.live.delete(2054)
      fake.files.delete(`${ROOT}/run-1.meta.json`)
      fake.sandbox.files.exists = async () => {
        throw new Error('e2b api unavailable')
      }

      await expect(active.getProcess('run-1')).rejects.toThrow('e2b api unavailable')
    })

    it('reattaches to an exited process, which e2b itself cannot', async () => {
      const fake = fakeSandbox()
      const started = await session(fake).exec(['echo', 'hi'])
      fake.files.set(`${ROOT}/run-1.out`, encode('{"type":"result"}\n'))
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))
      fake.live.clear()

      const handle = await session(fake, []).getProcess(started.id)
      expect(handle).not.toBeNull()
      expect((await handle!.status()).state).toBe('exited')
    })
  })

  describe('exec() journal bookkeeping', () => {
    it('kills the process it just started when its meta cannot be written', async () => {
      // The pid is only knowable host-side, so a failed meta write leaves a turn that
      // nothing can name: no handle, no `getProcess`, no row in `listProcesses` — and so no
      // watchdog kill either. Better a turn that did not start than one nobody owns.
      const fake = fakeSandbox()
      fake.sandbox.files.write = async () => {
        throw new Error('disk full')
      }

      await expect(session(fake).exec(['claude'])).rejects.toThrow('disk full')
      // Reaped as a tree, not as the shell e2b tracks: `commands.kill` leaves the wrapped
      // command running, and materialization is retried, so the orphan would race the retry
      // in the same checkout.
      expect(fake.ran.at(-1)!.cmd).toContain('reap 2054')
      expect(fake.live.has(2054)).toBe(false)
    })
  })

  describe('journal root', () => {
    it('fails exec loudly when the journal root is not there to write into', async () => {
      // Silently, the wrapper's redirection dies and the wrapped command never runs at all —
      // which the caller would otherwise meet as an empty transcript, much later.
      const fake = fakeSandbox()
      fake.sandbox.files.makeDir = async () => false
      fake.sandbox.files.exists = async () => false

      await expect(session(fake).exec(['claude'])).rejects.toThrow(ROOT)
      expect(fake.ran).toEqual([])
    })
  })

  describe('delegation', () => {
    it('answers exists() from the sandbox filesystem', async () => {
      const fake = fakeSandbox()
      fake.files.set('/workspace', encode(''))
      expect(await session(fake).exists('/workspace')).toEqual({ exists: true })
      expect(await session(fake).exists('/nope')).toEqual({ exists: false })
    })

    it('destroy() kills the sandbox, not just the process', async () => {
      const fake = fakeSandbox()
      await session(fake).destroy()
      expect(fake.killed.sandbox).toBe(true)
    })

    it('kill() reaps the whole tree, children first, not just the shell e2b tracks', async () => {
      // Measured (`scripts/spike-e2b-kill-tree.ts`): `commands.kill` SIGKILLs the journal
      // wrapper, which cannot propagate it, so the `claude` child was reparented to init and
      // ran to completion with no exit file ever written. Children-first matters — a parent
      // killed first leaves its children reparented and out of reach.
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])

      await handle.kill()

      const reap = fake.ran.at(-1)!
      expect(reap.cmd).toContain('pgrep -P')
      expect(reap.cmd).toContain('reap 7')
      expect(reap.cmd.indexOf('pgrep -P')).toBeLessThan(reap.cmd.indexOf('kill -KILL'))
      expect(fake.killed.pids).toEqual([])
    })

    it('kill() does not resolve until the walk has actually reaped the process', async () => {
      // e2b returns from a background command as soon as it *starts*, and its effects land
      // afterwards (https://e2b.dev/docs/commands/background). Awaiting only the start lets
      // `materializationExit` and the meta-write failure path surface a retry — a clone into
      // the same checkout — while the previous process tree is still being killed (codex and
      // cubic reviews, PR #260). Held open rather than merely asserted afterwards, because a
      // `wait()` that was called but not awaited still reaps a microtask later.
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])
      const release = fake.holdCommandWaits()

      let settled = false
      const killed = handle.kill().then(() => {
        settled = true
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      expect(fake.live.has(7)).toBe(true)

      release()
      await killed

      expect(fake.live.has(7)).toBe(false)
    })

    it('kill() falls back to e2b\'s own kill when the walk runs out of time', async () => {
      // e2b stops a background command at its `timeoutMs`. If that arrives as a resolved
      // `wait()` rather than a throw, the walk looks finished and the fallback is skipped
      // while the child is still running (cubic review, PR #260).
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])
      fake.commandExitCode = 137

      await handle.kill()

      expect(fake.killed.pids).toEqual([7])
    })

    it('kill() aims at the pid e2b lists, not the one the journal claims', async () => {
      // A kill aimed by the writable journal is a kill the turn chooses the target of.
      const fake = fakeSandbox(7)
      const active = session(fake)
      const started = await active.exec(['sleep'])
      const meta = JSON.parse(decode(fake.files.get(`${ROOT}/run-1.meta.json`)!))
      fake.files.set(`${ROOT}/run-1.meta.json`, encode(JSON.stringify({ ...meta, pid: 999_999 })))

      await (await active.getProcess(started.id))!.kill()

      expect(fake.ran.at(-1)!.cmd).toContain('reap 7')
    })

    it('kill() does nothing when e2b is running no wrapper for the process', async () => {
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])
      const before = fake.ran.length
      fake.live.clear()

      await handle.kill()

      expect(fake.ran).toHaveLength(before)
      expect(fake.killed.pids).toEqual([])
    })

    it('kill() falls back to e2b\'s own kill when the walk cannot even start', async () => {
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])
      fake.sandbox.commands.run = async () => {
        throw new Error('no shell')
      }

      await handle.kill()

      expect(fake.killed.pids).toEqual([7])
    })
  })
})
