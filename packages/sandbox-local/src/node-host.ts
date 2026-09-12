/**
 * The default {@link LocalHost}: the host primitives, over the Node builtins.
 *
 * The one file in the package that names a runtime, and the reason every other one can be
 * tested without a machine. It is written against `node:` specifiers rather than any single
 * engine's API, so it runs unchanged on Node, on Bun, and on Deno — which is the runtime the
 * backend was asked for, and which resolves `node:child_process` and `node:fs/promises`
 * through its compatibility layer.
 *
 * POSIX only. Process groups, signal numbers and `ps` all mean something specific here, and
 * Windows has no equivalent for any of the three; the package README says so rather than this
 * file pretending otherwise.
 */
import type { LocalHost, LocalProcessRow, LocalSlice, LocalSpawned, LocalSpawnSpec } from './local-surface'
import { Buffer } from 'node:buffer'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { promisify } from 'node:util'
import { WRAPPER_SHELL } from './journal'
import { parsePsRow, parsePsTable } from './ps-table'

const execFile = promisify(execFileCallback)

const EMPTY = new Uint8Array()

/** The whole machine's process table can be large; the default 1MB would truncate it. */
const PS_MAX_BUFFER = 16 * 1024 * 1024

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  }
  catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

async function readSlice(path: string, offset: number, length?: number): Promise<LocalSlice> {
  let handle
  try {
    handle = await open(path, 'r')
  }
  catch (error) {
    if (isMissing(error)) {
      // A journal file is created by the wrapper's first write, so "no output yet" and "no such
      // process" arrive here identically. Reported as empty, and told apart by the caller.
      return { data: EMPTY, total: 0 }
    }
    throw error
  }
  try {
    const total = (await handle.stat()).size
    const available = Math.max(0, total - offset)
    const want = length === undefined ? available : Math.min(length, available)
    if (want === 0) {
      return { data: EMPTY, total }
    }
    // `Buffer.alloc`, never `allocUnsafe`: the latter hands back a slice of a shared pool, and
    // the `Uint8Array` view built over it below would then alias whatever the pool is reused
    // for next — a transcript chunk that changes after it was handed to the caller.
    const buffer = Buffer.alloc(want)
    // Read until the buffer is full or the file ends. `read()` is permitted to return fewer
    // bytes than asked for, and a short read here is not a short *answer*: the caller pairs the
    // bytes with the file's full length, and a follower's next cursor comes from that length —
    // so the bytes the short read left behind would be skipped rather than served late, and
    // that part of the transcript would be lost for good.
    let bytesRead = 0
    while (bytesRead < want) {
      const read = await handle.read(buffer, bytesRead, want - bytesRead, offset + bytesRead)
      if (read.bytesRead === 0) {
        break
      }
      bytesRead += read.bytesRead
    }
    return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead), total }
  }
  finally {
    await handle.close()
  }
}

/**
 * Deliver a signal, and read "no such process" as an answer rather than as a failure.
 *
 * `EPERM` is the case worth naming: it means the process exists and belongs to someone else,
 * which is a *live* answer to a liveness probe. Reading it as absence would report a pid that
 * had been reused by another user's process as free, and the record keyed to it as dead.
 */
function signal(pid: number, sent: number): boolean {
  try {
    process.kill(pid, sent)
    return true
  }
  catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ESRCH') {
      return false
    }
    if (code === 'EPERM') {
      return true
    }
    throw error
  }
}

async function processes(): Promise<LocalProcessRow[]> {
  try {
    // `-ww` so a long wrapper script is not truncated to the terminal width: the command line
    // is what recovery reads a lost process's identity out of, and a cut one reads as foreign.
    const { stdout } = await execFile('ps', ['-A', '-ww', '-o', 'pid=,lstart=,args='], {
      maxBuffer: PS_MAX_BUFFER,
    })
    return parsePsTable(stdout)
  }
  catch {
    // Recovery is a best-effort second opinion, asked for only when a record is already
    // missing. A `ps` that will not run leaves the caller exactly where it was.
    return []
  }
}

async function identify(pid: number): Promise<LocalProcessRow | undefined> {
  try {
    // The same three columns the whole-table read asks for, so one parser serves both — and
    // `-ww` for the same reason: the wrapper's marker is near the front of a long script, but a
    // truncated line is one the registry cannot recognise as ours.
    const { stdout } = await execFile('ps', ['-p', String(pid), '-ww', '-o', 'pid=,lstart=,args='])
    return parsePsRow(stdout.split('\n')[0] ?? '')
  }
  catch {
    // `ps` exits non-zero when the pid is gone, which is indistinguishable here from `ps` being
    // unavailable. Both are reported as "cannot say", and the registry treats that as
    // unverifiable rather than as a death — a pid it cannot check is not a pid it saw end.
    return undefined
  }
}

async function spawnDetached(spec: LocalSpawnSpec): Promise<LocalSpawned> {
  return new Promise<LocalSpawned>((resolve, reject) => {
    const child = spawn(WRAPPER_SHELL, ['-c', spec.script], {
      cwd: spec.cwd,
      env: spec.env,
      // `detached` is the whole point: it puts the wrapper in a session and process group of
      // its own, which is what lets it outlive the orchestrator and what makes `-pid` name the
      // command's tree rather than the orchestrator's.
      detached: true,
      // Nothing is read through the pipes — the journal is the transcript — and an inherited
      // stdout would put the command's output in the desktop app's own console.
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      const { pid } = child
      if (pid === undefined) {
        reject(new Error('the host reported no pid for a process it started'))
        return
      }
      // Released from the parent's event loop: the orchestrator must be able to exit while the
      // turn keeps running, which is the case this whole backend is written for.
      child.unref()
      resolve({ pid })
    })
  })
}

export function nodeLocalHost(): LocalHost {
  return {
    env: process.env,
    size: sizeOf,
    exists: async (path: string) => await sizeOf(path) !== undefined,
    readSlice,
    writeFile: async (path: string, data: Uint8Array) => writeFile(path, data),
    mkdir: async (path: string) => {
      await mkdir(path, { recursive: true })
    },
    readdir: async (path: string) => {
      try {
        return await readdir(path)
      }
      catch (error) {
        if (isMissing(error)) {
          return []
        }
        throw error
      }
    },
    remove: async (path: string) => rm(path, { recursive: true, force: true }),
    spawn: spawnDetached,
    signal,
    identify,
    processes,
  }
}
