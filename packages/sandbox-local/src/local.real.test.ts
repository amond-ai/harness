/**
 * The backend against a real machine.
 *
 * The one thing a local provider can do that a remote one cannot: run its own contract for
 * real, in the suite, in under a second. Everything else in this package is exercised against
 * a fake host, which is what makes pid reuse and a lost record testable at all — but a fake
 * cannot tell whether the wrapper script is valid POSIX shell, whether `$!` is really the
 * command's pid, or whether an exit code survives the orchestrator. Those are exactly the
 * claims the rest of the package rests on, so they are checked here against `/bin/sh`.
 *
 * POSIX only, and skipped elsewhere rather than pretended: process groups, signal numbers and
 * `ps` have no Windows equivalent, which is a limit of the backend and not of this suite.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalProvider } from './provider'

const posix = process.platform !== 'win32'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-local-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A provider over the shared root, minting one known process id per sandbox. */
function providerFor(processId: string) {
  return createLocalProvider({ root, newProcessId: () => processId })
}

async function transcript(stream: ReadableStream<{ type: string, data?: Uint8Array }>) {
  const out: string[] = []
  const err: string[] = []
  for await (const event of stream) {
    if (event.type === 'stdout' && event.data) {
      out.push(new TextDecoder().decode(event.data))
    }
    if (event.type === 'stderr' && event.data) {
      err.push(new TextDecoder().decode(event.data))
    }
  }
  return { out: out.join(''), err: err.join('') }
}

describe.skipIf(!posix)('against a real machine', () => {
  it('runs a command, journals both streams, and records the exit', async () => {
    const session = providerFor('p-basic').session('run-basic')
    const handle = await session.exec(['sh', '-c', 'echo out ; echo err 1>&2 ; exit 3'])

    await expect(handle.waitForExit({ timeout: 10_000 })).resolves.toEqual({ code: 3, timedOut: false })
    expect(await transcript(await handle.logs())).toEqual({ out: 'out\n', err: 'err\n' })
  })

  it('passes an argv through the shell without the shell reading any of it', async () => {
    // The prompt travels as one argv element and is attacker-influenced text; the wrapper is a
    // shell script, which is the boundary where that guarantee would otherwise stop holding.
    //
    // The payload is a canary under this suite's own temp root rather than anything destructive.
    // A literal `rm -rf /` would be inert only for as long as the quoting under test is correct
    // — the developer's machine would be staked on the very code the test exists to doubt, with
    // no `--no-preserve-root` backstop on macOS. A `touch` proves the same thing: every
    // metacharacter that could reach the shell here would leave the file behind.
    const canary = join(root, 'argv-was-interpreted')
    const hostile = `$(touch ${canary}) ; touch ${canary} && 'quoted' "double" \`touch ${canary}\``
    const session = providerFor('p-quoting').session('run-quoting')
    const handle = await session.exec(['printf', '%s', hostile])

    await expect(handle.waitForExit({ timeout: 10_000 })).resolves.toEqual({ code: 0, timedOut: false })
    expect((await transcript(await handle.logs())).out).toBe(hostile)
    await expect(stat(canary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces a timeout from inside the tree, and says that is what happened', async () => {
    const session = providerFor('p-timeout').session('run-timeout')
    const handle = await session.exec(['sleep', '30'], { timeout: 300 })

    await expect(handle.waitForExit({ timeout: 10_000 })).resolves.toMatchObject({ timedOut: true })
  })

  it('bounds a timeout even when the command leaves a child running', async () => {
    // Signalling the command alone bounds nothing here: `sh -c 'sleep 30 & wait'` answers
    // SIGTERM with 143 while its child keeps running in the wrapper's group, and this backend
    // reads a non-empty group as a live process — correctly — so the caller's wait would carry
    // on past the deadline it set. The wrapper reaps its own group after recording the exit.
    const session = providerFor('p-orphan').session('run-orphan')
    const handle = await session.exec(['sh', '-c', 'sleep 30 & wait'], { timeout: 300 })

    await expect(handle.waitForExit({ timeout: 15_000 })).resolves.toMatchObject({ timedOut: true })
    // And the process really is over — the orphan went with it, rather than being left to write
    // to the checkout while the caller believes the turn ended.
    await expect(handle.status()).resolves.toMatchObject({ state: 'exited' })
  })

  it('delivers a signal to the command while the wrapper lives to record the exit', async () => {
    // A group-wide kill would take the wrapper with it, and the exit would never be written.
    const session = providerFor('p-kill').session('run-kill')
    const handle = await session.exec(['sleep', '30'])
    await handle.kill()

    await expect(handle.waitForExit({ timeout: 10_000 })).resolves.toEqual({ code: 143, timedOut: false })
  })

  it('publishes the exit under an environment that carries no PATH at all', async () => {
    // `mv` is the wrapper's one unrecoverable dependency: an exit that is never renamed into
    // place is a turn that reads as still running forever, and `waitForExit` only ever times
    // out. Resolving it on the caller's PATH puts that outcome one narrowed `env` away, so the
    // wrapper asks for the system default one instead — which is what `command -p` is for.
    // `echo` is a shell builtin, so the command itself needs no PATH to prove the point.
    const session = createLocalProvider({ root, env: {}, newProcessId: () => 'p-no-path' })
      .session('run-no-path')
    const handle = await session.exec(['echo', 'ok'])

    await expect(handle.waitForExit({ timeout: 10_000 })).resolves.toEqual({ code: 0, timedOut: false })
    expect((await transcript(await handle.logs())).out).toBe('ok\n')
  })

  it('finds and reads a process a different provider started', async () => {
    // The case the backend exists for: the desktop app was quit mid-turn and relaunched, and
    // nothing in this process ever held a handle to what is running.
    const started = providerFor('p-reattach').session('run-reattach')
    await started.exec(['sh', '-c', 'echo before ; sleep 0.4 ; echo after'])

    const relaunched = providerFor('p-reattach').session('run-reattach')
    const found = await relaunched.getProcess('p-reattach')
    expect(found).not.toBeNull()
    await expect(found!.status()).resolves.toMatchObject({ state: 'running' })
    await expect(found!.waitForExit({ timeout: 10_000 })).resolves.toEqual({ code: 0, timedOut: false })
    expect((await transcript(await found!.logs())).out).toBe('before\nafter\n')

    await expect(relaunched.listProcesses()).resolves.toMatchObject([{ id: 'p-reattach', state: 'exited' }])
  })

  it('resolves a caller\'s absolute path inside the sandbox', async () => {
    const session = providerFor('p-files').session('run-files')
    await session.writeFile('/home/user/notes.txt', 'inside')
    await expect(session.readFile('/home/user/notes.txt')).resolves.toEqual({
      content: 'inside',
      encoding: 'utf-8',
    })
    await expect(session.exists('/home/user/notes.txt')).resolves.toEqual({ exists: true })

    await session.destroy()
    await expect(session.exists('/home/user/notes.txt')).resolves.toEqual({ exists: false })
  })
})
