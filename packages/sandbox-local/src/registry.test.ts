import type { ProcessRecord } from './journal'
import type { FakeHost } from './local.fixtures'
import { describe, expect, it } from 'vitest'
import { journalledScript, journalPaths, noncePath, serializeProcessRecord } from './journal'
import { AT, decode, fakeHost, STATE } from './local.fixtures'
import { createProcessRegistry } from './registry'

/** This sandbox's wrapper nonce, fixed so a wrapper's command line can be written by hand. */
const NONCE = 'sandbox-nonce'

function registryOver(fake: FakeHost, elapsed: { ms: number } = { ms: 0 }) {
  return createProcessRegistry({
    host: fake.host,
    stateDir: STATE,
    now: () => AT,
    elapsedMs: () => elapsed.ms,
    newNonce: () => NONCE,
  })
}

/** The nonce file every sandbox that has ever spawned a wrapper has on disk. */
function placeNonce(fake: FakeHost, value = NONCE): void {
  fake.put(noncePath(STATE), value)
}

function recordFor(pid: number, overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'p1',
    pid,
    command: ['claude', '-p'],
    startedAt: AT,
    kernelStartedAt: `start-${String(pid)}`,
    ...overrides,
  }
}

/**
 * A wrapper in the table, exactly as the host would render one it started.
 *
 * The nonce file comes with it, because on a real machine it always does: it is written by the
 * `ensure()` that precedes the first spawn, and a wrapper in the table without one is a state
 * directory somebody has taken a file out of.
 */
function placeWrapper(fake: FakeHost, pid: number, id: string, argv: string[] = ['claude', '-p']): void {
  placeNonce(fake)
  fake.place({
    pid,
    command: `/bin/sh -c ${journalledScript(argv, journalPaths(STATE, id), NONCE)}`,
  })
}

describe('liveness', () => {
  it('is live only when the pid is running and is the one the record was written for', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('live')
  })

  it('is gone when the pid is free', async () => {
    const fake = fakeHost()
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('gone')
  })

  it('is gone when the pid was reissued to something that started later', async () => {
    // The failure this whole file exists for: after a reboot, pid 4711 is somebody's Dock, and
    // a registry that answered from the number alone would report a turn that is not there.
    const fake = fakeHost()
    fake.place({ pid: 4711, startedAt: 'a different day' })
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('gone')
  })

  it('is unknown, never gone, when the host says nothing at all', async () => {
    // Both mistakes are not equal: a live turn called dead frees its checkout for a retry.
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    fake.psWorks = false
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('unknown')
  })

  it('is unknown when the command line is unreadable and no start time was recorded', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711, command: '' })
    const state = await registryOver(fake).liveness(recordFor(4711, { kernelStartedAt: undefined }))
    expect(state).toBe('unknown')
  })

  it('recognises its own wrapper by its marker, whatever the clock says', async () => {
    // `ps -o lstart` resolves to one second, so a pid recycled inside that second reports an
    // identical start time. The marker is what does not collide.
    const fake = fakeHost()
    placeWrapper(fake, 4711, 'p1')
    const state = await registryOver(fake).liveness(recordFor(4711, { kernelStartedAt: 'a stale time' }))
    expect(state).toBe('live')
  })

  it('reads a stranger holding the pid as gone, even when their start times agree', async () => {
    // The same-second pid-reuse case: the times are equal and the command lines are not.
    const fake = fakeHost()
    placeWrapper(fake, 4711, 'a-different-process')
    const reused = await registryOver(fake).liveness(recordFor(4711, { kernelStartedAt: 'start-4711' }))
    expect(reused).toBe('gone')

    const unrelated = fakeHost()
    unrelated.place({ pid: 4711, command: '/usr/libexec/secretd -x' })
    const stranger = await registryOver(unrelated).liveness(recordFor(4711, { kernelStartedAt: undefined }))
    expect(stranger).toBe('gone')
  })

  it('falls back to the start time when the command line is unreadable', async () => {
    // A row whose argv the host truncated is not evidence of a stranger, and answering 'gone'
    // for one would declare a live turn dead.
    const fake = fakeHost()
    fake.place({ pid: 4711, command: '' })
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('live')
    const moved = await registryOver(fake).liveness(recordFor(4711, { kernelStartedAt: 'another day' }))
    expect(moved).toBe('gone')
  })

  it('re-reads the process table for every live answer, and never caches one', async () => {
    // The cache cannot hold a positive. `signal(pid, 0)` keeps answering yes after our process
    // exits and the kernel reissues the number, so a remembered 'live' is indistinguishable
    // from a stranger — and `kill` would deliver to it.
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    const registry = registryOver(fake)

    await registry.liveness(recordFor(4711))
    await registry.liveness(recordFor(4711))
    expect(fake.calls.identify).toBe(2)
  })

  it('sees a pid reissued inside the identity window as gone', async () => {
    // The failure the positive cache produced: our wrapper ends, the pid is handed to somebody
    // else within the TTL, and the pid is still allocated throughout — so nothing but the
    // process table can tell the two apart.
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    const elapsed = { ms: 0 }
    const registry = registryOver(fake, elapsed)
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('live')

    fake.end(4711)
    fake.place({ pid: 4711, startedAt: 'a different day' })
    elapsed.ms = 1_000
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('gone')
  })

  it('reuses one not-ours answer, and re-asks once it is stale', async () => {
    // The negative is the half that keeps: while the pid stays allocated it cannot turn back
    // into ours, because a record does not get its lost pid returned to it.
    const fake = fakeHost()
    fake.place({ pid: 4711, startedAt: 'a different day' })
    const elapsed = { ms: 0 }
    const registry = registryOver(fake, elapsed)

    await expect(registry.liveness(recordFor(4711))).resolves.toBe('gone')
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('gone')
    expect(fake.calls.identify).toBe(1)

    elapsed.ms = 6_000
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('gone')
    expect(fake.calls.identify).toBe(2)
  })

  it('drops the cached identity the moment the pid goes free', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    const registry = registryOver(fake)
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('live')

    fake.end(4711)
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('gone')

    // Re-verified rather than answered from the cache: this is a different process now.
    fake.place({ pid: 4711, startedAt: 'much later' })
    await expect(registry.liveness(recordFor(4711))).resolves.toBe('gone')
  })
})

describe('survivors', () => {
  it('counts a child the wrapper detached and left behind', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4712, group: 4711 })
    // The wrapper itself is gone; something it started is not, and it is still writing to the
    // checkout. Reporting the process finished here is what starts a second claude beside it.
    await expect(registryOver(fake).survivors(recordFor(4711))).resolves.toBe('some')
  })

  it('is none when the group emptied out', async () => {
    await expect(registryOver(fakeHost()).survivors(recordFor(4711))).resolves.toBe('none')
  })

  it('refuses to read a stranger\'s group as ours after the leader pid was reissued', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711, startedAt: 'a different day' })
    fake.place({ pid: 4713, group: 4711 })
    await expect(registryOver(fake).survivors(recordFor(4711))).resolves.toBe('none')
  })
})

describe('signalGroup', () => {
  it('delivers to the group while the leader is ours', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    fake.place({ pid: 4712, group: 4711 })
    await expect(registryOver(fake).signalGroup(recordFor(4711), 9)).resolves.toBe(true)
    expect(fake.table.size).toBe(0)
  })

  it('refuses a group id whose leader pid now belongs to someone else', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711, startedAt: 'a different day' })
    await expect(registryOver(fake).signalGroup(recordFor(4711), 9)).resolves.toBe(false)
    expect(fake.signals.filter(sent => sent.signal === 9)).toEqual([])
  })

  it('refuses a leader whose identity the host could not confirm', async () => {
    // A group id *is* a leader's pid, so an unverified leader makes `-pid` a guess — and this
    // call is the one that ends processes.
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    fake.psWorks = false
    await expect(registryOver(fake).signalGroup(recordFor(4711), 9)).resolves.toBe(false)
    expect(fake.signals.filter(sent => sent.signal === 9)).toEqual([])
  })

  it('refuses the placeholder pid, which POSIX would read as our own process group', async () => {
    const fake = fakeHost()
    await expect(registryOver(fake).signalGroup(recordFor(0), 9)).resolves.toBe(false)
    expect(fake.signals).toEqual([])
  })
})

describe('discovery', () => {
  it('recovers a live wrapper whose record was never written', async () => {
    const fake = fakeHost()
    placeWrapper(fake, 4711, 'p1', ['claude', '-p', 'fix it'])
    const recovered = await registryOver(fake).recovered()
    expect(recovered.get('p1')).toMatchObject({
      id: 'p1',
      pid: 4711,
      command: ['claude', '-p', 'fix it'],
      kernelStartedAt: 'start-4711',
    })
  })

  it('unions what has run with what is running, and skips a foreign filename', async () => {
    const fake = fakeHost()
    fake.put(journalPaths(STATE, 'exited').meta, serializeProcessRecord(recordFor(4000, { id: 'exited' })))
    fake.put(`${STATE}/2026-09-12.log`, 'not a record')
    placeWrapper(fake, 4711, 'live')

    const listed = await registryOver(fake).list()
    expect(listed.map(record => record.id).sort()).toEqual(['exited', 'live'])
  })

  it('reads a record whose id disagrees with its filename as absent', async () => {
    const fake = fakeHost()
    fake.put(journalPaths(STATE, 'p1').meta, serializeProcessRecord(recordFor(4000, { id: 'somebody-else' })))
    await expect(registryOver(fake).read('p1')).resolves.toBeUndefined()
  })

  it('leaves that record out of the listing too, not only out of a single read', async () => {
    // `destroy()` signals every group the listing names, so a record trusted here would let one
    // writable journal file aim that kill at a process it does not own.
    const fake = fakeHost()
    fake.put(journalPaths(STATE, 'p1').meta, serializeProcessRecord(recordFor(4000, { id: 'somebody-else' })))
    await expect(registryOver(fake).list()).resolves.toEqual([])
  })
})

describe('ensure', () => {
  it('fails loudly when the state directory cannot be created', async () => {
    // Silently, the wrapper's redirection dies and the command never runs — and the caller
    // learns only much later, from a transcript that is empty.
    const fake = fakeHost()
    fake.host.mkdir = async () => {}
    await expect(registryOver(fake).ensure()).rejects.toThrow(/could not be created/)
  })

  it('mints the sandbox nonce once and hands the same one back afterwards', async () => {
    const fake = fakeHost()
    const registry = registryOver(fake)
    await expect(registry.ensure()).resolves.toBe(NONCE)
    await expect(registry.ensure()).resolves.toBe(NONCE)
    expect(decode(fake.files.get(noncePath(STATE))!)).toBe(NONCE)
  })

  it('adopts the nonce a second orchestrator already minted, rather than replacing it', async () => {
    // Two orchestrators open the same sandbox and both reach this call. A read-then-write would
    // let the second overwrite a value the first has already spawned wrappers carrying, and
    // every one of those processes would become unrecoverable — silently, and only after a
    // crash. The loser of the race takes the winner's value instead.
    const fake = fakeHost()
    placeNonce(fake, 'minted-first')
    const second = createProcessRegistry({
      host: fake.host,
      stateDir: STATE,
      now: () => AT,
      newNonce: () => 'minted-second',
    })
    await expect(second.ensure()).resolves.toBe('minted-first')
    expect(decode(fake.files.get(noncePath(STATE))!)).toBe('minted-first')
  })

  it('refuses to start a command it could never recover', async () => {
    // Something is already at the nonce's path and it is not a nonce, so the exclusive create
    // refuses and there is nothing to read. Proceeding would spawn a wrapper carrying a value
    // no later orchestrator can check, which is exactly the orphan this file exists to prevent.
    const fake = fakeHost()
    placeNonce(fake, 'not a nonce')
    await expect(registryOver(fake).ensure()).rejects.toThrow(/could not be read/)
  })

  it('refuses a minted nonce that would not survive the wrapper it goes into', async () => {
    const fake = fakeHost()
    const registry = createProcessRegistry({
      host: fake.host,
      stateDir: STATE,
      now: () => AT,
      newNonce: () => `x' ; rm -rf / ; : '`,
    })
    await expect(registry.ensure()).rejects.toThrow(/not usable/)
  })
})

describe('the wrapper nonce', () => {
  it('refuses a process-table row that reproduces the marker without it', async () => {
    // The issue this defence is for (#4). Everything else in a wrapper's command line — the
    // shell, the opener, the process id, the state directory — is public, so a row carrying all
    // of them is something any process on the machine can be running. `destroy()` signals the
    // group of whatever recovery returns, so a match here is a bystander killed.
    const fake = fakeHost()
    placeNonce(fake)
    fake.place({
      pid: 4711,
      command: `/bin/sh -c ${journalledScript(['claude', '-p'], journalPaths(STATE, 'p1'), 'someone-elses-nonce')}`,
    })
    await expect(registryOver(fake).recovered()).resolves.toEqual(new Map())
    await expect(registryOver(fake).list()).resolves.toEqual([])
  })

  it('recovers nothing at all once the nonce file is gone', async () => {
    // Recovery is the path with no record to check a row against, so the sandbox's own nonce is
    // the last thing separating a wrapper of ours from a command line shaped like one. Without
    // it we lose an orphan we could once have ended — and do not kill whatever reproduced it.
    const fake = fakeHost()
    placeWrapper(fake, 4711, 'p1')
    fake.files.delete(noncePath(STATE))
    await expect(registryOver(fake).recovered()).resolves.toEqual(new Map())
  })

  it('leaves liveness on the start time when the nonce file is gone', async () => {
    // A record still names the pid, so the weaker half of the identity check is still there.
    // It is weaker — `ps -o lstart` resolves to one second — and it is not nothing.
    const fake = fakeHost()
    placeWrapper(fake, 4711, 'p1')
    fake.files.delete(noncePath(STATE))
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('live')
    const moved = await registryOver(fake).liveness(recordFor(4711, { kernelStartedAt: 'another day' }))
    expect(moved).toBe('gone')
  })

  it('reads a nonce file larger than any it minted as none', async () => {
    // The file lives where the sandbox's own commands can write, and this read happens on every
    // liveness probe — so the cap is what keeps a command from making it arbitrarily expensive.
    const fake = fakeHost()
    placeWrapper(fake, 4711, 'p1')
    placeNonce(fake, 'n'.repeat(65))
    await expect(registryOver(fake).recovered()).resolves.toEqual(new Map())
  })
})
