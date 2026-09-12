import { describe, expect, it } from 'vitest'
import { fakeHost, ROOT } from './local.fixtures'
import { createLocalProvider } from './provider'

describe('createLocalProvider', () => {
  it('names itself, and hands back one session per sandbox id', async () => {
    // Not to save a round trip — resolving a path costs nothing — but so the registry's
    // identity cache survives: the orchestrator asks for a session once per workflow step.
    const fake = fakeHost()
    const provider = createLocalProvider({ root: ROOT, host: fake.host })
    expect(provider.backend).toBe('local')
    expect(provider.session('run-42')).toBe(provider.session('run-42'))
    expect(provider.session('run-42')).not.toBe(provider.session('run-43'))
  })

  it('destroys the directory it created', async () => {
    const fake = fakeHost()
    fake.put(`${ROOT}/run-42/file.txt`, 'work')
    await createLocalProvider({ root: ROOT, host: fake.host }).session('run-42').destroy()
    expect(fake.files.has(`${ROOT}/run-42/file.txt`)).toBe(false)
  })

  it('never destroys a directory the consumer named', async () => {
    // The reason ownership is decided at resolution rather than argued about at deletion.
    const fake = fakeHost()
    fake.put('/Users/me/project/file.txt', 'the user\'s own work')
    const provider = createLocalProvider({
      root: ROOT,
      host: fake.host,
      resolveRoot: id => `/Users/me/${id === 'run-42' ? 'project' : 'other'}`,
    })
    await provider.session('run-42').destroy()
    expect(fake.files.get('/Users/me/project/file.txt')).toBeDefined()
  })

  it('leaves the root and the state root alone, whatever a sandbox does', async () => {
    const fake = fakeHost()
    fake.put(`${ROOT}/.state/run-43/p9.meta.json`, '{}')
    fake.put(`${ROOT}/shared-bootstrap/node`, 'a cache beside the sandboxes')
    await createLocalProvider({ root: ROOT, host: fake.host }).session('run-42').destroy()
    // The hazard that is invisible until the second concurrent session: a `destroy()` written
    // as "remove the working directory" takes the neighbours' state with it.
    expect(fake.files.has(`${ROOT}/.state/run-43/p9.meta.json`)).toBe(true)
    expect(fake.files.has(`${ROOT}/shared-bootstrap/node`)).toBe(true)
  })

  it('answers a port with the loopback address, in the scheme it was asked for', async () => {
    // The opposite of the e2b backend's default, for the same reason: there is no TLS edge in
    // front of a loopback port, so upgrading the request could only produce a dead URL.
    const provider = createLocalProvider({ root: ROOT, host: fakeHost().host })
    await expect(provider.portEndpoint('run-42', 3000)).resolves.toEqual({ url: 'http://127.0.0.1:3000/' })
    await expect(provider.portEndpoint('run-42', 3000, { protocol: 'ws' })).resolves.toEqual({ url: 'ws://127.0.0.1:3000/' })
  })

  it('refuses an id it would refuse anywhere else', async () => {
    const provider = createLocalProvider({ root: ROOT, host: fakeHost().host })
    await expect(provider.portEndpoint('../escape', 3000)).rejects.toThrow(/invalid sandbox id/)
    expect(() => provider.session('../escape')).toThrow(/invalid sandbox id/)
  })
})
