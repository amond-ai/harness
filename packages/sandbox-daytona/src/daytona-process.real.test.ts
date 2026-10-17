/**
 * The pid record and its identity check, run by a real shell against a real `/proc`.
 *
 * The kill suite stubs the check's exit code, so it says what a kill does with the answer and
 * nothing about whether the shell computes it: whether `printf` writes three fields, whether the
 * `sed | cut` lands on `/proc/<pid>/stat` field 22, whether a missing `/proc/<pid>` passes (cubic
 * review, PR #31). Those are checked here against `/bin/sh`.
 *
 * Linux only, and skipped elsewhere rather than pretended: the boot id and `/proc/<pid>/stat` are
 * what a Daytona sandbox has, and a host without them has nothing for the check to read.
 */
import type { ChildProcess } from 'node:child_process'
import type { PidIdentity } from './daytona-process'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { identityCheck, parsePidRecord, wrappedCommand } from './daytona-process'

const linux = existsSync('/proc/sys/kernel/random/boot_id')
  && existsSync('/proc/self/stat')
  && spawnSync('sh', ['-c', 'command -v setsid']).status === 0

/** The check's verdict, from the exit status of the shell that ran it. */
function passes(pid: number, identity: PidIdentity): boolean {
  return spawnSync('sh', ['-c', identityCheck(pid, identity)]).status === 0
}

describe.skipIf(!linux)('the pid record against a real /proc', () => {
  let root = ''
  let turn: ChildProcess | undefined
  let record: ReturnType<typeof parsePidRecord>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sandbox-daytona-'))
    const pidPath = join(root, 'run-1.pid')
    turn = spawn('sh', ['-c', wrappedCommand({ command: ['sleep', '30'], pidPath })], { stdio: 'ignore' })
    // Until the record is whole, not until the file exists: the redirection creates it before
    // `printf` has written anything.
    const until = Date.now() + 5_000
    do {
      await new Promise(resolve => setTimeout(resolve, 20))
      record = parsePidRecord(await readFile(pidPath, 'utf8').catch(() => ''))
    } while (record.identity === undefined && Date.now() < until)
  })

  afterAll(async () => {
    if (record?.pid > 1) {
      spawnSync('kill', ['-KILL', '--', `-${String(record.pid)}`])
    }
    turn?.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  })

  it('records the pid with the boot id and start time it can be checked against', async () => {
    expect(record.pid).toBeGreaterThan(1)
    expect(record.identity).toBeDefined()
    expect(passes(record.pid, record.identity!)).toBe(true)

    // Read independently of the shell, because the record and the check share one `sed | cut`:
    // a wrong field would agree with itself. Field 22 is the 20th after the parenthesised name.
    const stat = await readFile(`/proc/${String(record.pid)}/stat`, 'utf8')
    expect(record.identity!.startTime).toBe(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19])
    expect(record.identity!.bootId).toBe((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim())
  })

  it('fails a live pid whose start time is another process\'s', () => {
    const later = String(BigInt(record.identity!.startTime) + 1n)
    expect(passes(record.pid, { ...record.identity!, startTime: later })).toBe(false)
  })

  it('fails a pid recorded under another boot', () => {
    expect(passes(record.pid, { ...record.identity!, bootId: 'another-boot' })).toBe(false)
  })

  it('passes a pid whose /proc entry is gone, which has nothing left to be a stranger', () => {
    // Above the kernel's pid ceiling, so no process can hold it.
    expect(passes(2 ** 22 + 1, record.identity!)).toBe(true)
  })
})
