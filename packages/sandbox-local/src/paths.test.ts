import { describe, expect, it } from 'vitest'
import { isSandboxId, resolveWithin, sandboxPaths, STATE_DIRECTORY_NAME } from './paths'

describe('sandboxPaths', () => {
  it('owns the directory it named itself', () => {
    expect(sandboxPaths({ root: '/sandboxes' }, 'run-42')).toEqual({
      work: '/sandboxes/run-42',
      state: '/sandboxes/.state/run-42',
      owned: true,
    })
  })

  it('gives up ownership of a directory the caller named', () => {
    const paths = sandboxPaths({ root: '/sandboxes', resolveRoot: () => '/Users/me/project/' }, 'run-42')
    expect(paths).toEqual({
      work: '/Users/me/project',
      // Still the provider's, wherever the working directory went: it is the only place a
      // reattach can look, and the one thing destroy may always remove.
      state: '/sandboxes/.state/run-42',
      owned: false,
    })
  })

  it('keeps the state root out of the sandboxes, and off a root with a trailing slash', () => {
    expect(sandboxPaths({ root: '/sandboxes//', stateRoot: '/var/state/' }, 'run-42')).toEqual({
      work: '/sandboxes/run-42',
      state: '/var/state/run-42',
      owned: true,
    })
  })

  it('refuses an id that would resolve somewhere else', () => {
    for (const id of ['../escape', 'a/b', '', '.state', 'has space']) {
      expect(() => sandboxPaths({ root: '/sandboxes' }, id)).toThrow(/invalid sandbox id/)
    }
  })

  it('reserves the default state directory name against every legal id', () => {
    // The two share a parent, so `destroy()` on a sandbox called `.state` would take every
    // other sandbox's bookkeeping with it. The id grammar is what makes that unreachable.
    expect(isSandboxId(STATE_DIRECTORY_NAME)).toBe(false)
  })
})

describe('resolveWithin', () => {
  it('reads a caller\'s absolute path as the sandbox\'s own root', () => {
    expect(resolveWithin('/sandboxes/run-42', '/home/user/repo')).toBe('/sandboxes/run-42/home/user/repo')
  })

  it('normalises without leaving the root', () => {
    expect(resolveWithin('/sandboxes/run-42', './a//b/../c')).toBe('/sandboxes/run-42/a/c')
    expect(resolveWithin('/sandboxes/run-42/', '')).toBe('/sandboxes/run-42')
    expect(resolveWithin('/sandboxes/run-42', '.')).toBe('/sandboxes/run-42')
  })

  it('throws rather than clamping a path that climbs out', () => {
    // Clamping would answer a different path than the one asked for, silently.
    expect(() => resolveWithin('/sandboxes/run-42', '../run-43/secret')).toThrow(/outside the sandbox root/)
    expect(() => resolveWithin('/sandboxes/run-42', '/a/../../etc/passwd')).toThrow(/outside the sandbox root/)
  })
})
