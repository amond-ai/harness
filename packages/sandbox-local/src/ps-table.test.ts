import { describe, expect, it } from 'vitest'
import { parsePsRow, parsePsTable, parseStartedAt } from './ps-table'

describe('parsePsRow', () => {
  it('reads the five-token start time apart from the command line', () => {
    expect(parsePsRow('  501 Fri Sep 12 21:33:01 2026 /bin/sh -c : \'a\' ; echo hi')).toEqual({
      pid: 501,
      startedAt: 'Fri Sep 12 21:33:01 2026',
      command: `/bin/sh -c : 'a' ; echo hi`,
    })
  })

  it('keeps a command line that is mostly whitespace-separated argv intact', () => {
    const row = parsePsRow('7 Mon Jan  1 00:00:00 2035 node --enable-source-maps  app.js')
    expect(row?.command).toBe('node --enable-source-maps  app.js')
    // The doubled space inside `Jan  1` is why the start time is normalised rather than sliced.
    expect(row?.startedAt).toBe('Mon Jan 1 00:00:00 2035')
  })

  it('drops a row it cannot read rather than failing the whole table', () => {
    expect(parsePsRow('')).toBeUndefined()
    expect(parsePsRow('not-a-pid Fri Sep 12 21:33:01 2026 sh')).toBeUndefined()
    expect(parsePsTable('bad\n 9 Fri Sep 12 21:33:01 2026 sh\n')).toEqual([
      { pid: 9, startedAt: 'Fri Sep 12 21:33:01 2026', command: 'sh' },
    ])
  })
})

describe('parseStartedAt', () => {
  it('normalises the one value a per-pid read returns', () => {
    expect(parseStartedAt('  Fri Sep 12 21:33:01 2026\n')).toBe('Fri Sep 12 21:33:01 2026')
  })

  it('reads an empty answer as no answer', () => {
    expect(parseStartedAt('  \n')).toBeUndefined()
  })
})
