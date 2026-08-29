/**
 * The half of `createE2bSession` that starts and owns a process: launching it through the
 * journal wrapper, reattaching to one by id, and reaping it. Split from the waiting and log
 * suites so each file stays readable; they share `e2b-session.fixtures.ts` so all three are
 * written against one fake sandbox.
 */
import { describe, expect, it } from 'vitest'
import { decode, encode, fakeSandbox, ROOT, session } from './e2b-session.fixtures'
import { journalledScriptIn, journalPaths, SESSION_OPEN } from './journal'
import { quoteArg, quoteArgv } from './shell-quote'

describe('createE2bSession', () => {
  describe('exec()', () => {
    it('runs the argv through the journal wrapper in the background', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude', '-p', 'do it'], { cwd: '/workspace' })

      expect(handle.id).toBe('run-1')
      expect(fake.ran).toHaveLength(1)
      // Read through the peel: `exec` now hands e2b the script as one quoted word under the
      // session prefix, and what matters here is still what the wrapper runs.
      const script = journalledScriptIn(fake.ran[0].cmd)
      expect(script).toContain(`'claude' '-p' 'do it'`)
      expect(script).toContain(`> '${ROOT}/run-1.out'`)
      expect(script).toContain(`2> '${ROOT}/run-1.err'`)
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

    it('recovers an argv containing a quote element for element, not merely approximately', async () => {
      // `liveTurnProcess` matches a recovered process against the argv it is about to start,
      // so this round trip *is* the duplicate-turn guard. The argv now passes through
      // `quoteArg` twice — once per element, once for the whole script — and one backslash
      // out of place makes a live turn unrecognisable and starts a second `claude` beside it.
      // Asserted as equality: `toContain` would pass on a prefix of the truth.
      const payload = `x'; rm -rf / #`
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude', '-p', payload])
      // Deleted so the answer can only come from e2b's listing, which is the record the turn
      // cannot rewrite and the only one recovery has.
      fake.files.delete(`${ROOT}/run-1.meta.json`)

      const handle = await active.getProcess('run-1')

      expect((await handle!.status()).command).toEqual(['claude', '-p', payload])
    })

    it('still sees a legacy wrapper whose own prompt quotes the session prefix', async () => {
      // The consequence, asserted where it lands rather than only at the peel: this is the
      // duplicate-turn guard's own input. A wrapper started before #276 carries no prefix of
      // ours, so a prompt quoting `setsid --wait sh -c '…'` — an issue body about this
      // feature — used to be peeled at the *prompt's* occurrence, leaving a line with neither
      // the journal redirection nor the argv in it. `recoveredProcesses` then reported no such
      // process, `getProcess` answered null, `killTurn` reads null as a confirmed death, and a
      // second `claude` starts in the checkout the first is still working in.
      const argv = ['claude', '-p', `run ${SESSION_OPEN}'{ echo hi ; }' to detach`] as const
      const paths = journalPaths(ROOT, 'abc123')
      const legacy = `{ ${quoteArgv(argv)} ; } > ${quoteArg(paths.stdout)} 2> ${quoteArg(paths.stderr)}`
        + ` ; printf '%s' "$?" > ${quoteArg(paths.exit)}`
      const fake = fakeSandbox()
      fake.sandbox.commands.list = async () => [{ pid: 4242, cmd: '/bin/bash', args: ['-l', '-c', legacy] }]

      const handle = await session(fake, []).getProcess('abc123')

      expect(handle).not.toBeNull()
      const status = await handle!.status()
      expect(status.state).toBe('running')
      expect(status.command).toEqual(argv)
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
    it('reports a meta-write failure it could not reap as one that may still be running', async () => {
      // The remedy for a plain write failure is a retry, and a retry clones into the same
      // checkout. `commands.kill` leaves the wrapped command reparented and running, so a
      // caller told only "disk full" would start that clone beside a live process.
      const fake = fakeSandbox()
      fake.sandbox.files.write = async () => {
        throw new Error('disk full')
      }
      fake.commandExitCode = 137

      const failure = await session(fake).exec(['claude']).catch((error: unknown) => error)

      expect(String(failure)).toContain('may still be running')
      expect(String(failure)).toContain('2054')
      expect((failure as { cause?: unknown }).cause).toBeInstanceOf(Error)
    })

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

    it('kill() reaps the session when the wrapper leads one, and walks the tree when it does not', async () => {
      // Measured (`scripts/spike-e2b-session.ts`): `pkill -KILL -s <sid>` against a `setsid`
      // wrapper emptied the session and the reaper survived, because the reaper is in envd's
      // session and the victim in its own. The condition is the point: wrappers started
      // before the session wrapping share session 511 *with envd*, so an unconditional
      // `pkill -s` would kill envd and destroy the sandbox. Only a process that is its own
      // session leader can pass `sid = pid`, and 511 is envd's own pid, never a wrapper's.
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])

      await handle.kill()

      const reap = fake.ran.at(-1)!.cmd
      expect(reap).toContain('ps -o sid= -p 7')
      expect(reap).toContain(`[ "$sid" = "7" ]`)
      expect(reap).toContain('pkill -KILL -s 7')
      // and the walk is still there for the wrapper that answers 511.
      expect(reap).toContain('else reap 7')
    })

    it('kill() reports an unconfirmed kill rather than resolving like a completed reap', async () => {
      // `killTurn` reads a resolved kill as a confirmed one and starts the next attempt. The
      // fallback SIGKILLs the wrapper alone, so its child is reparented and keeps writing to
      // the checkout — and the wrapper's session is where that child is still visible.
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])
      fake.sessions.add(7)
      // The walk is stopped at its budget rather than refused outright, which is the case
      // that matters: the session is still probeable, and it answers.
      fake.commandExitCode = 137

      await expect(handle.kill()).rejects.toThrow('run-1')
      expect(fake.killed.pids).toEqual([7])
    })

    it('kill() resolves when the fallback left nothing running in that session', async () => {
      // Only an *observed* survivor is a failed kill. A fallback whose session is empty did
      // reap the tree, and failing it would report every such kill as unconfirmed.
      const fake = fakeSandbox(7)
      const handle = await session(fake).exec(['sleep'])
      fake.commandExitCode = 137

      await expect(handle.kill()).resolves.toBeUndefined()
      expect(fake.killed.pids).toEqual([7])
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
