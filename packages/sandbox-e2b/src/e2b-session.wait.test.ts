/**
 * Everything `createE2bSession` decides by *observing* a process rather than starting one:
 * whether a wait may settle, what state a process is in, the per-command budget e2b would
 * otherwise impose, and keeping the sandbox alive underneath a long turn. These judgements
 * share one rule — the journal is writable by the turn, so nothing in it is believed on its
 * own — which is why they are one file. The fake sandbox is `e2b-session.fixtures.ts`.
 */
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@pleaseai/sandbox-contract'
import { describe, expect, it } from 'vitest'
import { decode, encode, endProcess, fakeSandbox, leapingClock, ROOT, session } from './e2b-session.fixtures'

describe('createE2bSession', () => {
  describe('waitForExit()', () => {
    it('resolves from the journalled exit code once the process has ended', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['false'])
      fake.files.set(`${ROOT}/run-1.exit`, encode('3'))
      fake.live.clear()

      expect(await handle.waitForExit()).toEqual({ code: 3, timedOut: false })
    })

    it('keeps waiting on an exit record the process forged while still running', async () => {
      // Same untrusted journal as `status()`: resolving here would report the attempt
      // finished, and `run-workflow` would act on an exit the turn wrote about itself.
      const fake = fakeSandbox()
      // The clock leaps a whole liveness cadence on every read, so the wait probes on each
      // poll and "still waiting" costs milliseconds instead of a real 5s probe interval.
      const handle = await session(fake, ['run-1'], {
        pollIntervalMs: 1,
        monotonicNowMs: leapingClock(5_000),
      }).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))

      const wait = handle.waitForExit()
      expect(await Promise.race([
        wait.then(() => 'settled', () => 'rejected'),
        new Promise(resolve => setTimeout(resolve, 40, 'still waiting')),
      ])).toBe('still waiting')

      // and settles on the same record the moment e2b confirms the pid is gone.
      fake.live.delete(2054)
      expect(await wait).toEqual({ code: 0, timedOut: false })
    })

    it('keeps waiting on a forged exit whose session still has survivors', async () => {
      // The path that matters: `awaitTurn` settles a turn through `waitForExit`, not through
      // `status()`, so #266's forgery — detach a child, kill the wrapper, write `<id>.exit` —
      // resolves the workflow's own wait unless it is gated here too. The wrapper is gone from
      // e2b's table and the exit record is there; the session is the only thing left that says
      // the turn's work is still running.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], {
        pollIntervalMs: 1,
        monotonicNowMs: leapingClock(5_000),
      }).exec(['claude'])
      endProcess(fake, 'run-1', '0')
      fake.sessions.add(2054)

      const wait = handle.waitForExit()
      expect(await Promise.race([
        wait.then(() => 'settled', () => 'rejected'),
        new Promise(resolve => setTimeout(resolve, 40, 'still waiting')),
      ])).toBe('still waiting')

      // and settles on that same record once the session is empty: a survivor delays the
      // verdict, it does not replace it.
      fake.sessions.delete(2054)
      expect(await wait).toEqual({ code: 0, timedOut: false })
    })

    it('ends a bounded wait as a timeout, not as an exit, while the session is alive', async () => {
      // `SandboxWaitTimeoutError` is the honest ending for a survivor: "still running, wait
      // longer or kill it". Resolving the forged code instead would report the attempt
      // finished and free the checkout for the next one.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { pollIntervalMs: 1 }).exec(['claude'])
      endProcess(fake, 'run-1', '0')
      fake.sessions.add(2054)

      await expect(handle.waitForExit({ timeout: 30 }))
        .rejects
        .toBeInstanceOf(SandboxWaitTimeoutError)
    })

    it('does not report no_exit_record while that session still has survivors', async () => {
      // The kill path. `killTurn` waits after signalling and reads `SandboxNoExitRecordError`
      // as "it is already gone" — but a fallback kill SIGKILLs the wrapper alone, so no `$?`
      // is ever recorded while the reparented child keeps running (codex, PR #260 round 16).
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { pollIntervalMs: 1 }).exec(['claude'])
      fake.live.clear()
      fake.sessions.add(2054)

      const rejection = await handle.waitForExit({ timeout: 30 }).catch((error: unknown) => error)

      expect(rejection).toBeInstanceOf(SandboxWaitTimeoutError)
      expect(rejection).not.toBeInstanceOf(SandboxNoExitRecordError)
    })

    it('asks the session at most once per liveness probe, not once per poll', async () => {
      // The gate sits in a loop that re-reads every `pollIntervalMs`, and a survivor keeps it
      // there for the rest of the wait. One command per poll would be hundreds of remote round
      // trips a second against a sandbox whose turn is already in trouble.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { pollIntervalMs: 1 }).exec(['claude'])
      endProcess(fake, 'run-1', '0')
      fake.sessions.add(2054)

      await expect(handle.waitForExit({ timeout: 200 }))
        .rejects
        .toBeInstanceOf(SandboxWaitTimeoutError)
      expect(fake.calls.read).toBeGreaterThan(20)
      expect(fake.ran.filter(command => command.cmd.startsWith('pgrep -s'))).toHaveLength(1)
    })

    it('rejects rather than resolving when the wait ends before the process does', async () => {
      // A resolved ProcessExit means the process exited. Callers use `catch` as their
      // timeout path, so resolving here would report a live turn as a confirmed kill.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['sleep'])
      const rejection = await handle.waitForExit({ timeout: 20 }).catch((error: unknown) => error)

      expect(rejection).toBeInstanceOf(SandboxWaitTimeoutError)
      expect(rejection).toMatchObject({ processId: 'run-1', elapsedMs: 20 })
    })

    it('rejects on an already-aborted signal instead of waiting out the budget', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['sleep'])
      await expect(handle.waitForExit({ signal: AbortSignal.abort(), timeout: 60_000 }))
        .rejects
        .toBeInstanceOf(SandboxWaitTimeoutError)
    })

    it('fails fast, and distinguishably, when the process vanished without an exit record', async () => {
      // A crashed wrapper never writes the exit file, so polling to the deadline would burn
      // the whole budget and then report a timeout the caller cannot act on differently.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.live.clear()

      const rejection = await handle.waitForExit({ timeout: 60_000 }).catch((error: unknown) => error)
      // Asserted by type, not by message text: the point of the two error classes is that a
      // caller branches on them, and `run-workflow.ts` does. A substring assertion would keep
      // passing if the classes were collapsed back into one.
      expect(rejection).toBeInstanceOf(SandboxNoExitRecordError)
      expect(rejection).not.toBeInstanceOf(SandboxWaitTimeoutError)
    })

    it('takes an exit file that lands during the liveness probe over the vanished verdict', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.sandbox.commands.list = async () => {
        fake.files.set(`${ROOT}/run-1.exit`, encode('7'))
        return []
      }

      expect(await handle.waitForExit({ timeout: 60_000 })).toEqual({ code: 7, timedOut: false })
    })

    it('never expires when no timeout was given, however long the turn runs', async () => {
      // `awaitTurn` races an unbounded waitForExit() inside a never-retried step that allows
      // a live turn six hours; any cap here would fail an ordinary long turn instead. The
      // clock leaps an hour per read, so this pins hours of waiting in milliseconds.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], {
        pollIntervalMs: 1,
        monotonicNowMs: leapingClock(60 * 60 * 1000),
      }).exec(['claude'])

      const wait = handle.waitForExit()
      const outcome = await Promise.race([
        wait.then(() => 'settled', () => 'rejected'),
        new Promise(resolve => setTimeout(resolve, 50, 'still waiting')),
      ])
      expect(outcome).toBe('still waiting')

      endProcess(fake, 'run-1', '0')
      expect(await wait).toEqual({ code: 0, timedOut: false })
    })

    it('still fails fast on a vanished process when the wait is unbounded', async () => {
      // The `'gone'` observation — not a deadline — is what stops a lost process hanging the
      // step, so removing the cap must not remove that.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.live.clear()

      await expect(handle.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
    })

    it('probes liveness on a coarse cadence, not once per poll', async () => {
      // Polling reads one file; liveness lists the whole process table. At 250ms that is
      // four listings a second for the whole turn, now that a wait can run for hours.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { pollIntervalMs: 1 }).exec(['claude'])

      await expect(handle.waitForExit({ timeout: 200 }))
        .rejects
        .toBeInstanceOf(SandboxWaitTimeoutError)
      expect(fake.calls.read).toBeGreaterThan(20)
      expect(fake.calls.list).toBe(1)
    })

    it('treats a malformed exit file as not-yet-exited rather than a bogus code', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.exit`, encode('nope'))

      await expect(handle.waitForExit({ timeout: 20 }))
        .rejects
        .toBeInstanceOf(SandboxWaitTimeoutError)
    })
  })

  describe('status()', () => {
    it('reports a process e2b still lists as running', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['sleep'])
      const status = await handle.status()
      expect(status.state).toBe('running')
      expect(status.command).toEqual(['sleep'])
    })

    it('reports no_exit_record for a pid that is gone with no exit file ever written', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.live.clear()

      const status = await handle.status()
      expect(status.state).toBe('error')
      expect(status.state === 'error' && status.error.code).toBe('no_exit_record')
    })

    it('stays running when the liveness call itself fails, rather than reporting error', async () => {
      // `run-workflow.ts` reads only `running` as alive, so an `error` here would make
      // `liveTurnProcess` decline the turn and exec a second `claude` on the same repo. One
      // transient commands.list() failure must not buy that.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.sandbox.commands.list = async () => {
        throw new Error('transient rpc failure')
      }

      expect((await handle.status()).state).toBe('running')
    })

    it('reports exited when the exit file lands between the first read and the liveness check', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.sandbox.commands.list = async () => {
        fake.files.set(`${ROOT}/run-1.exit`, encode('0'))
        return []
      }

      const status = await handle.status()
      expect(status.state).toBe('exited')
      expect(status.state === 'exited' && status.exit.code).toBe(0)
    })

    it('treats a truncated exit file as still running rather than exited on a bogus code', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.exit`, encode(''))
      expect((await handle.status()).state).toBe('running')
    })

    it('ignores a pid the journal rewrote, since the meta file is writable too', async () => {
      // The liveness proof is worth nothing if the thing it looks up comes from the same
      // writable journal: point `pid` at something that is not running, write an exit file,
      // and the forged exit is accepted again. e2b's own listing is matched on the wrapper
      // command instead, which the turn cannot rewrite.
      const fake = fakeSandbox()
      const session_ = session(fake)
      const started = await session_.exec(['claude'])
      const meta = JSON.parse(decode(fake.files.get(`${ROOT}/run-1.meta.json`)!))
      fake.files.set(`${ROOT}/run-1.meta.json`, encode(JSON.stringify({ ...meta, pid: 999_999 })))
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))

      const handle = await session_.getProcess(started.id)
      expect((await handle!.status()).state).toBe('running')
    })

    it('does not take its paths from a meta file that claims to be a different process', async () => {
      // `handleFor` takes its paths from the meta's own id, so a renamed meta would point a
      // caller's wait at another process's transcript and exit record. The renamed meta is
      // discarded and the process is described from e2b's listing instead.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude', '-p', 'go'])
      const meta = JSON.parse(decode(fake.files.get(`${ROOT}/run-1.meta.json`)!))
      fake.files.set(`${ROOT}/run-1.meta.json`, encode(JSON.stringify({ ...meta, id: 'run-2' })))

      const handle = await active.getProcess('run-1')

      expect(handle!.id).toBe('run-1')
      expect((await handle!.status()).command).toEqual(['claude', '-p', 'go'])
    })

    it('returns null only when e2b is running nothing for the id either', async () => {
      // `killTurn` reads a null lookup as a *confirmed death* and starts the next attempt, so
      // a deleted meta must not be enough to be declared dead.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      const started = await active.exec(['claude'])
      fake.files.delete(`${ROOT}/run-1.meta.json`)

      expect(await active.getProcess(started.id)).not.toBeNull()

      fake.live.clear()
      expect(await active.getProcess(started.id)).toBeNull()
    })

    it('refuses to call a turn exited while its own session still has survivors', async () => {
      // The forgery this closes (#266): detach a child, kill the wrapper, write an exit file.
      // e2b lists only what it started, so the wrapper is gone from the one table this
      // backend trusts and the exit record is there — which read as `exited` while the
      // detached child kept working in the checkout. The wrapper leads a session of its own,
      // and `pgrep -s <sid>` sees the child that outlived it (`scripts/spike-e2b-session.ts`).
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      endProcess(fake, 'run-1', '0')
      fake.sessions.add(2054)

      expect((await handle.status()).state).toBe('running')

      // and settles once that session is empty, so a survivor delays the verdict, not ends it.
      fake.sessions.delete(2054)
      expect((await handle.status()).state).toBe('exited')
    })

    it('refuses no_exit_record for the same session, which is how a kill is confirmed', async () => {
      // `confirmDead` in `run-workflow.ts` judges a kill by `status()`, and `'error'` is not
      // `'running'` — so a wrapper SIGKILLed by the fallback path reported a confirmed kill
      // while its reparented child ran on (codex review, PR #260, round 16). The survivor
      // check therefore gates the whole terminal verdict, not only `exited`.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.live.clear()
      fake.sessions.add(2054)

      expect((await handle.status()).state).toBe('running')
    })

    it('stays running when the session probe itself fails, rather than settling on silence', async () => {
      // Same asymmetry as a failed `commands.list()`: a probe that could not run has not
      // observed an empty session, and treating it as one is what ends an attempt early.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      endProcess(fake, 'run-1', '0')
      fake.sandbox.commands.run = async () => {
        throw new Error('transient rpc failure')
      }

      expect((await handle.status()).state).toBe('running')
    })

    it('never asks about the session of a process that never recorded a pid', async () => {
      // `pgrep -s 0` means *the caller's own session*, so asking it about a process known
      // only by its journal files would report a survivor for every one of them, forever.
      const fake = fakeSandbox()
      const active = session(fake, ['run-1'])
      await active.exec(['claude'])
      endProcess(fake, 'run-1', '0')
      fake.files.delete(`${ROOT}/run-1.meta.json`)
      const before = fake.ran.length

      expect((await (await active.getProcess('run-1'))!.status()).state).toBe('exited')
      expect(fake.ran).toHaveLength(before)
    })

    it('keeps a still-live process running even when it journalled an exit for itself', async () => {
      // The journal is inside the sandbox the turn writes to, and this repository treats
      // what a turn acts on as untrusted. Believing the file would free the checkout for a
      // retry while the first `claude` is still running in it.
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      fake.files.set(`${ROOT}/run-1.exit`, encode('0'))

      expect((await handle.status()).state).toBe('running')
    })
  })

  describe('per-command timeout', () => {
    /**
     * e2b's default is 60s and it applies to background commands too — measured with
     * `scripts/spike-e2b-command-timeout.ts`. Under the default a 95s background wrapper
     * left only its first marker; under `0` it completed. A `claude` turn is routinely
     * longer than a minute, and the kill lands before the wrapper records `$?`, so it would
     * arrive as a missing exit record rather than as a timeout.
     */
    it('disables it by default, so the orchestrator owns every bound on a turn', async () => {
      const fake = fakeSandbox()

      await session(fake).exec(['claude'])

      expect(fake.ran[0].opts.timeoutMs).toBe(0)
    })

    it('passes a configured budget through instead', async () => {
      const fake = fakeSandbox()

      await session(fake, ['run-1'], { commandTimeoutMs: 30_000 }).exec(['claude'])

      expect(fake.ran[0].opts.timeoutMs).toBe(30_000)
    })
  })

  describe('sandbox lifetime', () => {
    it('renews the sandbox while a wait is in progress', async () => {
      // e2b stops a sandbox at its configured lifetime whatever is running inside it, and
      // the workflow tolerates a turn far longer than the lifetime the provider sets.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], { sandboxTimeoutMs: 3_600_000 })
        .exec(['claude'])

      const wait = handle.waitForExit()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(fake.calls.renewed).toEqual([3_600_000])

      endProcess(fake, 'run-1', '0')
      await wait
    })

    it('renews on the lifetime\'s own scale, not once per liveness probe', async () => {
      // `waitForExit` asks on every probe. Honouring each one renews an hourly lifetime
      // ~4,300 times over a six-hour turn, every call a remote round trip and all but a
      // handful redundant.
      const fake = fakeSandbox()
      const handle = await session(fake, ['run-1'], {
        pollIntervalMs: 1,
        sandboxTimeoutMs: 3_600_000,
        // Two reads per iteration, so each poll advances the clock a full probe interval
        // and every one of them reaches the renewal call.
        monotonicNowMs: leapingClock(5_000),
      }).exec(['claude'])

      await expect(handle.waitForExit({ timeout: 3_600_000 }))
        .rejects
        .toBeInstanceOf(SandboxWaitTimeoutError)

      // An hour of wait at a 15-minute interval: the first renewal plus three more.
      expect(fake.calls.renewed).toEqual([3_600_000, 3_600_000, 3_600_000, 3_600_000])
    })

    it('leaves the sandbox alone when no lifetime was configured', async () => {
      const fake = fakeSandbox()
      const handle = await session(fake).exec(['claude'])
      const wait = handle.waitForExit({ timeout: 30 }).catch(() => undefined)
      await wait
      expect(fake.calls.renewed).toEqual([])
    })

    it('survives a renewal that fails, since the process is still healthy', async () => {
      const fake = fakeSandbox()
      fake.sandbox.setTimeout = async () => {
        throw new Error('e2b unreachable')
      }
      const handle = await session(fake, ['run-1'], { sandboxTimeoutMs: 3_600_000 })
        .exec(['claude'])

      // Set after the wait is under way, so the throwing renewal is genuinely reached first.
      const wait = handle.waitForExit()
      await new Promise(resolve => setTimeout(resolve, 20))
      endProcess(fake, 'run-1', '0')

      expect(await wait).toEqual({ code: 0, timedOut: false })
    })
  })
})
