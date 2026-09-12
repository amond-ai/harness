import { describe, expect, it } from 'vitest'
import { isSandboxId, resolveWithin, sandboxPaths, STATE_DIRECTORY_NAME, trimTrailingSlash, withoutTrailingSlashes } from './paths'

describe('trimming trailing separators', () => {
  it('takes every separator off the end, and only off the end', () => {
    expect(withoutTrailingSlashes('/sandboxes/run-42///')).toBe('/sandboxes/run-42')
    expect(withoutTrailingSlashes('//sandboxes//run-42')).toBe('//sandboxes//run-42')
    expect(withoutTrailingSlashes('')).toBe('')
  })

  it('answers a path of nothing but separators without scanning it twice', () => {
    // Not itself the pathological input, though it reads like it: `replace(/\/+$/, '')` matches
    // an all-separator path on the first attempt — greedy run, then `$` — and is linear on it.
    // The quadratic case is a run followed by a non-separator, where `$` fails and every start
    // index backtracks the whole run: measured on this regex at 2k/4k/8k/16k separators plus
    // 'x', 3.8ms → 15.3ms → 67.0ms → 279.2ms, four times the work for twice the length, while
    // the all-separator input stayed flat at 0.02ms. Both are covered below.
    // The two functions part company here — an empty base joins as a relative path, so the one
    // that prefixes a root keeps it.
    expect(withoutTrailingSlashes('/'.repeat(64))).toBe('')
    expect(trimTrailingSlash('/'.repeat(64))).toBe('/')
  })

  it('leaves the input CodeQL was actually about untouched', () => {
    // A separator run with something after it has no trailing separator to take, so the scan
    // returns the string as it stands — in one pass, which is the whole point.
    const pathological = `${'/'.repeat(64)}x`
    expect(withoutTrailingSlashes(pathological)).toBe(pathological)
    expect(trimTrailingSlash(pathological)).toBe(pathological)
  })
})

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

  it('refuses a working directory that is inside its own state directory', () => {
    // Marked unowned, so destroy() spares it as the working directory — and then removes it
    // anyway as bookkeeping, which it may always do. The consumer's own workspace, deleted by
    // the branch written to protect it.
    expect(() => sandboxPaths({
      root: '/sandboxes',
      resolveRoot: id => `/sandboxes/.state/${id}`,
    }, 'run-42')).toThrow(/destroy\(\) would remove the working directory/)

    expect(() => sandboxPaths({
      root: '/sandboxes',
      stateRoot: '/work',
      resolveRoot: () => '/work/run-42/repo',
    }, 'run-42')).toThrow(/destroy\(\) would remove the working directory/)
  })

  it('allows a state directory that lives inside the working tree', () => {
    // The other direction is safe: removing state removes only what the provider created.
    expect(sandboxPaths({
      root: '/sandboxes',
      stateRoot: '/work/run-42/.harness',
      resolveRoot: () => '/work/run-42',
    }, 'run-42')).toMatchObject({ work: '/work/run-42', owned: false })
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
