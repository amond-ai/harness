import type { ProcessRecord } from './journal'
import type { FakeHost } from './local.fixtures'
import { describe, expect, it } from 'vitest'
import { journalledScript, journalPaths, serializeProcessRecord } from './journal'
import { AT, fakeHost, STATE } from './local.fixtures'
import { createProcessRegistry } from './registry'

function registryOver(fake: FakeHost, elapsed: { ms: number } = { ms: 0 }) {
  return createProcessRegistry({
    host: fake.host,
    stateDir: STATE,
    now: () => AT,
    elapsedMs: () => elapsed.ms,
  })
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

/** A wrapper in the table, exactly as the host would render one it started. */
function placeWrapper(fake: FakeHost, pid: number, id: string, argv: string[] = ['claude', '-p']): void {
  fake.place({
    pid,
    command: `/bin/sh -c ${journalledScript(argv, journalPaths(STATE, id))}`,
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

  it('is unknown, never gone, when nothing can be compared', async () => {
    // Both mistakes are not equal: a live turn called dead frees its checkout for a retry.
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    await expect(registryOver(fake).liveness(recordFor(4711, { kernelStartedAt: undefined })))
      .resolves
      .toBe('unknown')

    fake.psWorks = false
    await expect(registryOver(fake).liveness(recordFor(4711))).resolves.toBe('unknown')
  })

  it('reuses one identity answer, and re-asks once it is stale', async () => {
    const fake = fakeHost()
    fake.place({ pid: 4711 })
    const elapsed = { ms: 0 }
    const registry = registryOver(fake, elapsed)

    await registry.liveness(recordFor(4711))
    await registry.liveness(recordFor(4711))
    expect(fake.calls.startedAt).toBe(1)

    elapsed.ms = 6_000
    await registry.liveness(recordFor(4711))
    expect(fake.calls.startedAt).toBe(2)
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
})

describe('ensure', () => {
  it('fails loudly when the state directory cannot be created', async () => {
    // Silently, the wrapper's redirection dies and the command never runs — and the caller
    // learns only much later, from a transcript that is empty.
    const fake = fakeHost()
    fake.host.mkdir = async () => {}
    await expect(registryOver(fake).ensure()).rejects.toThrow(/could not be created/)
  })
})
