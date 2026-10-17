import type { ProcessLogEvent, SandboxProcessHandle } from '@amond-ai/sandbox'
import { SandboxNoExitRecordError } from '@amond-ai/sandbox'
import { describe, expect, it, vi } from 'vitest'
import { KILL_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'
import { BRIDGE_READY_TIMEOUT_MS, startTurnHost, TurnHostBootError } from './sdk-turn-start'

/**
 * A host process that has already ended, with the stderr it left and nothing on stdout — what a
 * mise shim refusing an untrusted config looks like from outside.
 */
function exitedHost(stderr: string | readonly string[], code = 1): SandboxProcessHandle {
  const chunks = typeof stderr === 'string' ? [stderr] : stderr
  // Incremental, as the contract's cursor reads are: a read from `since` serves only the chunks
  // after it, so the read that follows the exit sees nothing it has already seen.
  const logs = async (options?: { since?: string }): Promise<ReadableStream<ProcessLogEvent>> => new ReadableStream({
    start(controller) {
      const from = Number(options?.since ?? 0)
      chunks.forEach((chunk, index) => {
        if (index >= from) {
          controller.enqueue({
            type: 'stderr',
            cursor: String(index + 1),
            timestamp: '2026-10-09T00:00:00.000Z',
            data: new TextEncoder().encode(chunk),
          })
        }
      })
      controller.close()
    },
  })
  const status = async () => ({
    id: 'host-1',
    pid: 1,
    command: ['node'],
    startedAt: '2026-10-09T00:00:00.000Z',
    state: 'exited' as const,
    exit: { code, timedOut: false },
    endedAt: '2026-10-09T00:00:01.000Z',
  })
  return { id: 'host-1', logs, status } as unknown as SandboxProcessHandle
}

type ScriptedStatus = 'running' | 'error' | { exited: number } | Error

/**
 * A host whose log reads and status reads are scripted call by call — each `logs()` takes the
 * next batch (or throws it), each `status()` the next state (or throws it); the last entry of
 * each script repeats once it is reached.
 */
function scriptedHost(script: {
  reads: ReadonlyArray<readonly ProcessLogEvent[] | Error>
  statuses: readonly ScriptedStatus[]
}): SandboxProcessHandle {
  let read = 0
  let polled = 0
  const at = <T>(list: readonly T[], index: number): T => list[Math.min(index, list.length - 1)]!
  const logs = async (): Promise<ReadableStream<ProcessLogEvent>> => {
    const batch = at(script.reads, read++)
    if (batch instanceof Error) {
      throw batch
    }
    return new ReadableStream({
      start(controller) {
        batch.forEach(event => controller.enqueue(event))
        controller.close()
      },
    })
  }
  const status = async () => {
    const next = at(script.statuses, polled++)
    if (next instanceof Error) {
      throw next
    }
    const base = { id: 'host-1', pid: 1, command: ['node'], startedAt: '2026-10-09T00:00:00.000Z' }
    if (next === 'running') {
      return { ...base, state: 'running' as const }
    }
    if (next === 'error') {
      return { ...base, state: 'error' as const, error: { message: 'spawn failed' }, endedAt: '2026-10-09T00:00:01.000Z' }
    }
    return { ...base, state: 'exited' as const, exit: { code: next.exited, timedOut: false }, endedAt: '2026-10-09T00:00:01.000Z' }
  }
  return { id: 'host-1', logs, status } as unknown as SandboxProcessHandle
}

const AT = '2026-10-09T00:00:00.000Z'

function stdoutLine(text: string): ProcessLogEvent {
  return { type: 'stdout', cursor: 'o', timestamp: AT, data: new TextEncoder().encode(`${text}\n`) }
}

function startOn(process: SandboxProcessHandle): Promise<unknown> {
  return startTurnHost({
    process,
    connect: async () => {
      throw new Error('never reached')
    },
    prompt: 'do the thing',
    permissionMode: 'bypassPermissions',
    settingSources: ['project'],
    startedAtMs: 1_000,
    port: 39_100,
    token: 'tok',
    stateDir: '/workspace/.turn-host/run-1/1',
  })
}

describe('a turn host that exits before announcing a socket', () => {
  it('fails at once with its exit code and stderr instead of waiting out the readiness budget', async () => {
    const started = Date.now()

    await expect(startOn(exitedHost('mise ERROR Config files in /workspace/x/mise.toml are not trusted.\n')))
      .rejects
      .toThrow(/exited with code 1 before announcing a listening socket: mise ERROR Config files .* are not trusted\./)

    expect(Date.now() - started).toBeLessThan(BRIDGE_READY_TIMEOUT_MS / 10)
  })

  it('masks a credential in the stderr it reports', async () => {
    const run = startOn(exitedHost('boom\nGITHUB_TOKEN=github_pat_obvious_fake\n', 2))

    await expect(run).rejects.toThrow(/exited with code 2/)
    await expect(run).rejects.not.toThrow(/github_pat_obvious_fake/)
  })

  it('keeps a bounded stderr tail that ends with the last line', async () => {
    const lines = Array.from({ length: 5_000 }, (_, index) => `line ${String(index)}\n`)
    const run = startOn(exitedHost([...lines, 'the last line\n']))

    await expect(run).rejects.toThrow(/: (?:[^\n]*\n)*the last line$/)
    const message = await run.then(() => '', (cause: unknown) => (cause as Error).message)
    expect(message.length).toBeLessThan(2_200)
  })

  it('drops an unterminated line too long to keep rather than a cut piece of it', async () => {
    const run = startOn(exitedHost(`boom\nGITHUB_TOKEN=github_pat_${'A'.repeat(20_000)}`))

    await expect(run).rejects.toThrow(/boom\n\[stderr line too long to keep\]$/)
    await expect(run).rejects.not.toThrow(/github_pat_|A{10}/)
  })

  it('drops the rest of a too-long line that a later chunk carries, up to its newline', async () => {
    const run = startOn(exitedHost([`GITHUB_TOKEN=github_pat_${'A'.repeat(20_000)}`, 'ZZsecretsuffix\nboom\n']))

    await expect(run).rejects.toThrow(/\[stderr line too long to keep\]\nboom$/)
    await expect(run).rejects.not.toThrow(/github_pat_|A{10}|ZZsecretsuffix/)
  })

  it('reads the exit code off a terminal log event', async () => {
    const terminal = { type: 'terminal', state: 'exited', timestamp: AT, exit: { code: 3, timedOut: false } }
    const host = scriptedHost({
      // Unterminated: the line still being written is masked at the end, not dropped.
      reads: [[{ type: 'truncated', timestamp: AT }, { type: 'stderr', cursor: 'e', timestamp: AT, data: new TextEncoder().encode('boom') }, terminal as unknown as ProcessLogEvent], []],
      statuses: ['running'],
    })

    await expect(startOn(host)).rejects.toThrow(/exited with code 3 before announcing a listening socket: boom$/)
  })

  it.each([
    ['its status', scriptedHost({ reads: [[]], statuses: ['error'] })],
    ['a terminal log event', scriptedHost({
      reads: [[{ type: 'terminal', state: 'error', cursor: 't', timestamp: AT, error: { message: 'spawn failed' } } as unknown as ProcessLogEvent], []],
      statuses: ['running'],
    })],
  ])('reports an unknown code for a host that %s says ended in error', async (_, host) => {
    await expect(startOn(host)).rejects.toThrow(/^turn host exited with code unknown before announcing a listening socket$/)
  })

  it('keeps polling a running host and honors a ready announced in the read after it exits', async () => {
    const host = scriptedHost({
      reads: [new Error('log read failed'), [], [], [stdoutLine('{"type":"bridge-ready","port":39100}')]],
      statuses: [new Error('status unavailable'), 'running', { exited: 0 }],
    })

    // Past readiness the hand-off connects, which this fake refuses — proof the wait returned.
    await expect(startOn(host)).rejects.toThrow('never reached')
  })

  it('raises a bridge-fatal as the refusal it is', async () => {
    const host = scriptedHost({
      reads: [[stdoutLine('{"type":"bridge-fatal","message":"port taken"}')]],
      statuses: ['running'],
    })

    await expect(startOn(host)).rejects.toThrow('turn host refused to start: port taken')
  })

  it('masks a credential whose line arrives split across two chunks', async () => {
    const run = startOn(exitedHost(['GITHUB_TOKEN=github_pat_obv', 'ious_fake\nboom\n']))

    await expect(run).rejects.toThrow(/boom$/)
    await expect(run).rejects.not.toThrow(/github_pat_|ious_fake/)
  })
})

/** What a start rejected with, for the assertions a `rejects` matcher cannot make. */
async function failureOf(run: Promise<unknown>): Promise<unknown> {
  return await run.then(() => undefined, (cause: unknown) => cause)
}

/**
 * The three ways a host fails before `bridge-ready` are typed apart, so the attempt loop can start
 * another attempt; their messages are the ones above, unchanged, and each names the host.
 */
describe('a turn host that never announced readiness', () => {
  it.each([
    ['exited', () => exitedHost('boom\n'), /^turn host exited with code 1 /],
    ['refused', () => scriptedHost({
      reads: [[stdoutLine('{"type":"bridge-fatal","message":"port taken"}')]],
      statuses: ['running'],
    }), /^turn host refused to start: port taken$/],
  ])('is a boot error when it %s, naming its process and state directory', async (_, host, message) => {
    const failure = await failureOf(startOn(host()))

    expect(failure).toBeInstanceOf(TurnHostBootError)
    expect((failure as Error).message).toMatch(message)
    expect(failure).toMatchObject({ processId: 'host-1', bridgeStateDir: '/workspace/.turn-host/run-1/1' })
  })

  it('is a boot error when it times out, and the host it gave up on is stopped', async () => {
    const kill = vi.fn(async () => {})
    const host = { ...scriptedHost({ reads: [[]], statuses: ['running'] }), kill } as unknown as SandboxProcessHandle
    vi.useFakeTimers()
    try {
      const failure = failureOf(startOn(host))
      await vi.advanceTimersByTimeAsync(BRIDGE_READY_TIMEOUT_MS + 1_000)

      const raised = await failure
      expect(raised).toBeInstanceOf(TurnHostBootError)
      expect((raised as Error).message).toBe(`turn host did not announce a listening socket within ${String(BRIDGE_READY_TIMEOUT_MS)}ms`)
      expect(kill).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('waits, bounded, for the stopped host to exit before raising the timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const order: string[] = []
    const kill = vi.fn(async () => {
      order.push('kill')
    })
    const waitForExit = vi.fn(async (): Promise<never> => {
      order.push('wait')
      return await new Promise<never>(() => {})
    })
    const host = { ...scriptedHost({ reads: [[]], statuses: ['running'] }), kill, waitForExit } as unknown as SandboxProcessHandle
    vi.useFakeTimers()
    try {
      let settled = false
      const failure = failureOf(startOn(host)).finally(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(BRIDGE_READY_TIMEOUT_MS + 1_000)
      expect(order).toEqual(['kill', 'wait'])
      expect(waitForExit).toHaveBeenCalledWith({ timeout: KILL_SETTLE_TIMEOUT_MS })
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(KILL_SETTLE_TIMEOUT_MS)
      expect(await failure).toBeInstanceOf(TurnHostBootError)
      expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toMatch(/exit after readiness timeout not confirmed/)
    }
    finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  describe('how the stopped host\'s exit is judged', () => {
    /**
     * Boots a host that never announces, with `waitForExit` and the status read after it scripted,
     * and returns whether the stop reported the exit as unconfirmed. `status()` answers `running`
     * until the wait is asked for, so the boot loop itself is unaffected.
     */
    async function unconfirmed(options: {
      kill?: () => Promise<void>
      waitForExit: () => Promise<never>
      after?: 'running' | 'exited'
    }): Promise<{ reported: boolean, waited: boolean }> {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let waited = false
      const base = scriptedHost({ reads: [[]], statuses: ['running'] })
      const host = {
        ...base,
        kill: vi.fn(options.kill ?? (async () => {})),
        waitForExit: vi.fn(async () => {
          waited = true
          return await options.waitForExit()
        }),
        status: async () => {
          const running = await base.status()
          return waited && options.after === 'exited'
            ? { ...running, state: 'exited' as const, exit: { code: 137, timedOut: false }, endedAt: AT }
            : running
        },
      } as unknown as SandboxProcessHandle
      vi.useFakeTimers()
      try {
        const failure = failureOf(startOn(host))
        await vi.advanceTimersByTimeAsync(BRIDGE_READY_TIMEOUT_MS + 3 * KILL_SETTLE_TIMEOUT_MS)
        expect(await failure).toBeInstanceOf(TurnHostBootError)
        const reported = warn.mock.calls.some(([message]) => /exit after readiness timeout not confirmed/.test(String(message)))
        return { reported, waited }
      }
      finally {
        vi.useRealTimers()
        warn.mockRestore()
      }
    }

    it('takes a missing exit record as the exit once the status agrees', async () => {
      const result = await unconfirmed({
        waitForExit: async () => { throw new SandboxNoExitRecordError('host-1') },
        after: 'exited',
      })
      expect(result.reported).toBe(false)
    })

    it('reports a missing exit record while the status still says running', async () => {
      // A backend that could not aim the kill ends the session instead, and the wait rejects the
      // same way while the host runs on.
      const result = await unconfirmed({
        waitForExit: async () => { throw new SandboxNoExitRecordError('host-1') },
        after: 'running',
      })
      expect(result.reported).toBe(true)
    })

    it('reports any other rejection of the wait', async () => {
      const result = await unconfirmed({
        waitForExit: async () => { throw new Error('wait refused') },
        after: 'exited',
      })
      expect(result.reported).toBe(true)
    })

    it('still waits for the exit when the kill itself failed', async () => {
      // A kill RPC that failed or timed out may still have delivered its signal.
      const result = await unconfirmed({
        kill: async () => { throw new Error('kill refused') },
        waitForExit: async () => { throw new SandboxNoExitRecordError('host-1') },
        after: 'exited',
      })
      expect(result.waited).toBe(true)
      expect(result.reported).toBe(false)
    })
  })

  it('still raises the timeout when stopping the host fails', async () => {
    const kill = vi.fn(async () => {
      throw new Error('kill refused')
    })
    const host = { ...scriptedHost({ reads: [[]], statuses: ['running'] }), kill } as unknown as SandboxProcessHandle
    vi.useFakeTimers()
    try {
      const failure = failureOf(startOn(host))
      await vi.advanceTimersByTimeAsync(BRIDGE_READY_TIMEOUT_MS + 1_000)

      expect(await failure).toBeInstanceOf(TurnHostBootError)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('still raises the timeout when stopping the host never settles', async () => {
    const kill = vi.fn(async () => new Promise<void>(() => {}))
    const host = { ...scriptedHost({ reads: [[]], statuses: ['running'] }), kill } as unknown as SandboxProcessHandle
    vi.useFakeTimers()
    try {
      const failure = failureOf(startOn(host))
      await vi.advanceTimersByTimeAsync(BRIDGE_READY_TIMEOUT_MS + KILL_SETTLE_TIMEOUT_MS + 1_000)

      expect(await failure).toBeInstanceOf(TurnHostBootError)
      expect(kill).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('is not what a failure past readiness is', async () => {
    const host = scriptedHost({ reads: [[stdoutLine('{"type":"bridge-ready","port":39100}')]], statuses: ['running'] })

    const failure = await failureOf(startOn(host))

    expect((failure as Error).message).toBe('never reached')
    expect(failure).not.toBeInstanceOf(TurnHostBootError)
  })
})
