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
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { link, mkdir, open, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { promisify } from 'node:util'
import { WRAPPER_SHELL } from './journal'
import { parsePsRow, parsePsTable } from './ps-table'

const execFile = promisify(execFileCallback)

const EMPTY = new Uint8Array()

/**
 * The buffer both `ps` reads are given; the default 1MB would truncate either of them.
 *
 * The whole machine's process table is the obvious case. A single row is the less obvious one:
 * `-ww` renders a wrapper's command line in full, and this backend's argv carries prompts.
 */
const PS_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Extra reads given to a process-table row whose arguments `ps` could not read.
 *
 * Bounded because zombies render the same way and never become readable. Each attempt is one
 * `ps -p` for every such row at once, so the bound is on forks per listing, not per row. An
 * attempt that makes none of them readable ends the rereads early: macOS prints hardened and
 * other-user processes as `(comm)` for good, so those rows would otherwise cost every listing
 * the full bound.
 */
const UNREADABLE_REREADS = 2

/**
 * Whether a syscall failed because the path names nothing.
 *
 * `ENOTDIR` counts alongside `ENOENT`: a path that walks *through* a regular file — a caller
 * asking about `<file>/nested`, which a sandbox's own command can arrange by writing a file
 * where a directory was expected — fails with it rather than with `ENOENT`. Every caller here
 * is asking an existence question, and both answers to that question are "no".
 */
function isMissing(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
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

/**
 * Read a slice of a regular file.
 *
 * Anything else is refused: a directory with `EISDIR`, as a plain read of one fails, and any
 * other kind (a FIFO, a device) with `EINVAL`. A sandbox's own commands can write to the state
 * directory, so a journal or the nonce file can be replaced by a FIFO; a plain `open(path, 'r')`
 * on a FIFO with no writer blocks before any size limit or error handling applies, and every
 * caller of this read — listing, recovery, status, exec, destroy — would hang with it. The open
 * is therefore non-blocking (a no-op for regular files), and the kind is checked on the opened
 * descriptor rather than on the path, so a replacement between a check and the open cannot slip
 * through.
 */
async function readSlice(path: string, offset: number, length?: number): Promise<LocalSlice> {
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
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
    const info = await handle.stat()
    if (info.isDirectory()) {
      throw Object.assign(new Error(`'${path}' is a directory`), { code: 'EISDIR' })
    }
    if (!info.isFile()) {
      throw Object.assign(new Error(`'${path}' is not a regular file`), { code: 'EINVAL' })
    }
    const total = info.size
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

/** Only macOS `ps` prints `(<comm>)` for arguments it could not read; elsewhere it is a real argv. */
const PS_OPTIONS = { parenthesisedStandIn: process.platform === 'darwin' }

async function processes(): Promise<LocalProcessRow[]> {
  try {
    // `-ww` so a long wrapper script is not truncated to the terminal width: the command line
    // is what recovery reads a lost process's identity out of, and a cut one reads as foreign.
    const { stdout } = await execFile('ps', ['-A', '-ww', '-o', 'pid=,lstart=,args='], {
      maxBuffer: PS_MAX_BUFFER,
    })
    return await rereadUnreadable(parsePsTable(stdout, PS_OPTIONS))
  }
  catch {
    // Recovery is a best-effort second opinion, asked for only when a record is already
    // missing. A `ps` that will not run leaves the caller exactly where it was.
    return []
  }
}

/**
 * Ask again about the rows whose arguments `ps` could not read, up to
 * {@link UNREADABLE_REREADS} times, stopping as soon as an attempt reads none of them.
 *
 * Recovery has no other look at a process whose record is gone, so one missed read is a live
 * wrapper left out of the listing — and out of what `destroy()` ends. The miss is transient on
 * macOS (see `ps-table.ts`), so a second read usually has the arguments. A pid that has gone or
 * changed hands in between keeps the original row: its unreadable command line claims nothing.
 *
 * One `ps -p` per attempt for all of them together, not one per row: the misses come in bursts
 * under load, which is the worst moment to fork a `ps` for each.
 */
async function rereadUnreadable(rows: LocalProcessRow[]): Promise<LocalProcessRow[]> {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  for (let attempt = 0; attempt < UNREADABLE_REREADS; attempt++) {
    const unreadable = [...byPid.values()].filter(row => row.command === '').map(row => row.pid)
    if (unreadable.length === 0) {
      break
    }
    let resolved = false
    for (const again of await rowsOf(unreadable)) {
      if (again.startedAt === byPid.get(again.pid)?.startedAt) {
        byPid.set(again.pid, again)
        resolved ||= again.command !== ''
      }
    }
    if (!resolved) {
      break
    }
  }
  return rows.map(row => byPid.get(row.pid) ?? row)
}

/** The rows `ps` has for these pids now; one that has gone is simply absent. */
async function rowsOf(pids: readonly number[]): Promise<LocalProcessRow[]> {
  try {
    const { stdout } = await execFile('ps', ['-p', pids.join(','), '-ww', '-o', 'pid=,lstart=,args='], {
      maxBuffer: PS_MAX_BUFFER,
    })
    return parsePsTable(stdout, PS_OPTIONS)
  }
  catch {
    // Non-zero when none of the pids is left, or when `ps` will not run: either way there is
    // nothing better to replace the unreadable rows with.
    return []
  }
}

async function identify(pid: number): Promise<LocalProcessRow | undefined> {
  try {
    // The same three columns the whole-table read asks for, so one parser serves both — and
    // `-ww` for the same reason: the wrapper's marker is near the front of a long script, but a
    // truncated line is one the registry cannot recognise as ours. `-ww` is also why the buffer
    // has to be the table read's: one wrapper carrying a near-`ARG_MAX` argv already outgrows
    // the 1MB default, and an overflow here reads as "cannot say" about a process that is very
    // much alive — so recovery would not verify it and destruction would not stop it.
    const { stdout } = await execFile('ps', ['-p', String(pid), '-ww', '-o', 'pid=,lstart=,args='], {
      maxBuffer: PS_MAX_BUFFER,
    })
    return parsePsRow(stdout.split('\n')[0] ?? '', PS_OPTIONS)
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
    createFile: async (path: string, data: Uint8Array) => {
      // The contents are written in full to a sibling nobody looks for, and only then linked into
      // place. `link(2)` fails with EEXIST rather than replacing, so exactly one caller publishes
      // and the destination only ever appears with its complete contents: a loser (or a crash
      // between the write and the link) never exposes an empty or partial file at `path`.
      // The sibling shares the directory because a hard link cannot cross filesystems, and its
      // name neither ends in `.meta.json` nor equals the nonce path, so listing ignores it.
      const slash = path.lastIndexOf('/')
      const staging = `${path.slice(0, slash + 1)}.staging-${randomUUID()}.tmp`
      //
      // The write sits inside the `try` so a failure partway through it (ENOSPC, a quota) still
      // unlinks the partial sibling: without that, every failed attempt on a full disk would leave
      // another uniquely named file behind, leaking exactly when storage is scarcest.
      let linking = false
      try {
        await writeFile(staging, data, { flag: 'wx' })
        linking = true
        await link(staging, path)
        return true
      }
      catch (error) {
        // EEXIST means "someone else published the nonce" only for `link`. The same code from the
        // `wx` write is a collision on a fresh random name, which is a fault, not a lost race.
        if (linking && (error as { code?: string }).code === 'EEXIST') {
          return false
        }
        throw error
      }
      finally {
        await unlink(staging).catch(() => {})
      }
    },
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
