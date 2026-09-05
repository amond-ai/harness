/*
 * The kill path: which pid a stop is aimed by, which reap reaches it, and what a stop that
 * signalled nothing reports. Split out of `e2b-session.process.test.ts` alongside the module
 * these drive (`e2b-kill.ts`); that file keeps `exec`/`getProcess` and the journal bookkeeping.
 */
import { SandboxWaitTimeoutError } from '@pleaseai/sandbox-contract'
import { describe, expect, it, vi } from 'vitest'
import { decode, encode, endProcess, fakeSandbox, ROOT, session } from './e2b-session.fixtures'

describe('createE2bSession kill path', () => {
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

  it('kill(signal) walks the tree and the session with that signal instead of SIGKILL', async () => {
    // `killTurn` interrupts with SIGINT before it kills: the `claude` CLI ends the turn and
    // prints its `result` on SIGINT, and nothing on a kill. The reap keeps its shape — children
    // first, session where the wrapper leads one — and only the signal changes.
    const fake = fakeSandbox(7)
    const handle = await session(fake).exec(['sleep'])

    await handle.kill(2)

    const reap = fake.ran.at(-1)!.cmd
    expect(reap).toContain('kill -INT "$1"')
    expect(reap).toContain('pkill -INT -s 7')
    expect(reap).not.toContain('KILL')
    expect(fake.killed.pids).toEqual([])
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

  it('kill() signals nothing when the wrapper is gone and its session is empty', async () => {
    // The absence of a wrapper is not by itself a reason to kill: the session is asked, and
    // an empty one means there is nothing left to reach.
    const fake = fakeSandbox(7)
    const handle = await session(fake).exec(['sleep'])
    const before = fake.ran.length
    fake.live.clear()

    await handle.kill()

    expect(fake.ran.slice(before).map(run => run.cmd)).toEqual([
      expect.stringContaining('pgrep -s 7'),
    ])
    expect(fake.killed.pids).toEqual([])
  })

  /**
   * A session-wide SIGINT kills the untrapped `sh` wrapper and leaves `claude` reparented to
   * init in the same session — so the wrapper drops out of `commands.list()` while the turn
   * is still running. Returning early there is how `terminateTurn`'s SIGKILL came to reach
   * nothing at all.
   *
   * It has to be the *unconditional* session reap, not the tree walk: the walk's `pkill -s`
   * branch is gated on the target answering `ps -o sid=` with its own pid, and a dead leader
   * answers nothing — so the walk falls through to `pgrep -P <dead pid>`, signals nothing,
   * exits `0` and reports a reap. Asserting on the script text cannot tell those apart,
   * because the gated script contains the `pkill` string either way.
   */
  it('kill() reaps a session survivor after the wrapper has left e2b\'s table', async () => {
    const fake = fakeSandbox(7)
    const handle = await session(fake).exec(['sleep'])
    fake.live.clear()
    fake.sessions.add(7)

    await handle.kill()

    expect(fake.ran.map(run => run.cmd)).toContainEqual(
      expect.stringMatching(/^pkill -KILL -s 7\b/),
    )
    // And it reached: the fake empties a session only for a command that signals all of it.
    expect(fake.sessions.has(7)).toBe(false)
  })

  /**
   * The same state driven through the gated script instead: the leader is gone, so the walk
   * takes its `else` branch, finds no children of a dead pid, and leaves the session alone.
   * This is what `killTree` would have reported as `'reaped'`.
   */
  it('the gated tree walk cannot reach a session whose leader is already dead', async () => {
    const fake = fakeSandbox(7)
    await session(fake).exec(['sleep'])
    fake.live.clear()
    fake.sessions.add(7)

    const walk = await fake.sandbox.commands.run(
      `reap() { for c in $(pgrep -P "$1" 2>/dev/null); do reap "$c"; done; kill -KILL "$1" 2>/dev/null || true; }`
      + ` ; sid=$(ps -o sid= -p 7 2>/dev/null | tr -d ' ')`
      + ` ; if [ "$sid" = "7" ] ; then pkill -KILL -s 7 2>/dev/null || true ; else reap 7 ; fi`,
      { background: true },
    )
    await walk.wait()

    expect(fake.sessions.has(7)).toBe(true)
  })

  /**
   * `run-workflow.ts` never keeps the handle `exec` returned — `killTurn` and `terminateTurn`
   * both look the process up again with `getProcess` — so the exec-time pid has to survive
   * that lookup or the reap above never runs on the real path.
   */
  it('kill() reaches the survivor through a handle re-fetched with getProcess', async () => {
    const fake = fakeSandbox(7)
    const active = session(fake)
    const started = await active.exec(['sleep'])
    const refetched = (await active.getProcess(started.id))!
    fake.live.clear()
    fake.sessions.add(7)

    await refetched.kill()

    expect(fake.ran.map(run => run.cmd)).toContainEqual(
      expect.stringMatching(/^pkill -KILL -s 7\b/),
    )
  })

  /**
   * Pids are recycled, so an exec-time pid kept past its process's death is a `pkill -s`
   * aimed at whatever holds that number next — another turn's session on a busy sandbox.
   * Observing the journalled exit is the proof that clears it.
   */
  it('kill() stops aiming at the exec pid once the process is proven exited', async () => {
    const fake = fakeSandbox(7)
    const active = session(fake, ['run-1'])
    await active.exec(['sleep'])
    endProcess(fake, 'run-1', '0', 7)

    expect((await (await active.getProcess('run-1'))!.status()).state).toBe('exited')

    fake.sessions.add(7)
    const before = fake.ran.length
    await (await active.getProcess('run-1'))!.kill()

    expect(fake.ran).toHaveLength(before)
    expect(fake.killed.pids).toEqual([])
  })

  /**
   * The death proofs read a session id too, and `<id>.meta.json` is the turn's own file: a
   * turn that rewrites its pid to `0` — which `sessionSurvivors` short-circuits to `'none'`
   * — would otherwise certify its own death while its session is still working. The
   * exec-time pid is preferred wherever this isolate has it.
   */
  it('status() judges liveness by the exec pid, not the pid the meta claims', async () => {
    const fake = fakeSandbox(7)
    const active = session(fake, ['run-1'])
    await active.exec(['sleep'])
    const meta = JSON.parse(decode(fake.files.get(`${ROOT}/run-1.meta.json`)!))
    fake.files.set(`${ROOT}/run-1.meta.json`, encode(JSON.stringify({ ...meta, pid: 0 })))
    // Gone from e2b's table, no exit journalled, and its real session still inhabited.
    fake.live.clear()
    fake.sessions.add(7)

    expect((await (await active.getProcess('run-1'))!.status()).state).toBe('running')
    await expect(
      (await active.getProcess('run-1'))!.waitForExit({ timeout: 5 }),
    ).rejects.toThrow(SandboxWaitTimeoutError)
  })

  /**
   * The trust is this session's own memory of what it started, not anything on disk. A
   * session that never ran the process — a different isolate after a restart — reads its pid
   * from `<id>.meta.json`, which the turn can rewrite, so it gets no target at all.
   */
  it('kill() does not aim at a journal pid a session did not start', async () => {
    const fake = fakeSandbox(7)
    const started = await session(fake).exec(['sleep'])
    const meta = JSON.parse(decode(fake.files.get(`${ROOT}/${started.id}.meta.json`)!))
    fake.files.set(
      `${ROOT}/${started.id}.meta.json`,
      encode(JSON.stringify({ ...meta, pid: 999_999 })),
    )
    // A second session over the same sandbox: the provider hands one out per isolate, and
    // this is the one that has never seen an `exec` for this id.
    const restarted = session(fake)
    fake.live.clear()
    fake.sessions.add(999_999)
    const recovered = (await restarted.getProcess(started.id))!
    const before = fake.ran.length

    await recovered.kill()

    expect(fake.ran).toHaveLength(before)
    expect(fake.killed.pids).toEqual([])
  })

  /**
   * e2b's own kill is SIGKILL and nothing else, so it cannot stand in for the SIGINT stage:
   * substituting it cuts the turn with no `result`, which is what the interrupt exists to
   * avoid. The walk failing leaves the tree untouched and its liveness unknown, and the
   * caller's bounded wait escalates from there.
   */
  it('kill(signal) does not substitute e2b\'s SIGKILL when the walk fails', async () => {
    const fake = fakeSandbox(7)
    const handle = await session(fake).exec(['sleep'])
    fake.commandExitCode = 137
    const warnings: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message))
    })

    try {
      await expect(handle.kill(2)).resolves.toBeUndefined()
    }
    finally {
      warn.mockRestore()
    }

    expect(fake.killed.pids).toEqual([])
    // Said, not swallowed: the signal that was asked for is the fact that decides whether
    // e2b's kill may stand in, so it is what the log names.
    expect(warnings.join('\n')).toContain('the requested INT was not substituted')
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
