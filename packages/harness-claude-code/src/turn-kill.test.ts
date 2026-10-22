import type { ProcessExit, ProcessStatus, SandboxProcessHandle, SandboxSession, WaitForExitOptions } from '@amond-ai/sandbox'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS, killTurn } from './turn-kill'

const SIGINT = 2

const EXITED: ProcessStatus = {
  id: 'p1',
  pid: 42,
  command: ['claude'],
  startedAt: '2026-10-03T00:00:00.000Z',
  state: 'exited',
  exit: { code: 130, timedOut: false },
  endedAt: '2026-10-03T00:00:01.000Z',
}
const RUNNING: ProcessStatus = { id: 'p1', pid: 42, command: ['claude'], startedAt: '2026-10-03T00:00:00.000Z', state: 'running' }

interface FakeTurn {
  /** Each `waitForExit` call takes the next entry: an exit to resolve, or an error to reject. */
  waits: Array<ProcessExit | Error>
  /** What the re-check's `status()` reads. */
  status?: ProcessStatus
  /** Rejects the default (signal-less) kill, as a backend whose process is gone may. */
  defaultKillRejects?: Error
  /** Rejects the SIGINT, as a backend that cannot send a named signal may. */
  interruptKillRejects?: Error
}

function fakeSession(turn: FakeTurn) {
  const kill = vi.fn(async (signal?: number) => {
    if (signal === undefined && turn.defaultKillRejects) {
      throw turn.defaultKillRejects
    }
    if (signal === SIGINT && turn.interruptKillRejects) {
      throw turn.interruptKillRejects
    }
  })
  const waitForExit = vi.fn(async (_options?: WaitForExitOptions) => {
    const next = turn.waits.shift()
    if (next === undefined) {
      throw new Error('unexpected waitForExit')
    }
    if (next instanceof Error) {
      throw next
    }
    return next
  })
  const handle = {
    id: 'p1',
    kill,
    waitForExit,
    status: async () => turn.status ?? EXITED,
  } as unknown as SandboxProcessHandle
  const getProcess = vi.fn(async (_id: string) => handle as SandboxProcessHandle | null)
  const sandbox = { getProcess } as unknown as SandboxSession
  return { sandbox, kill, waitForExit, getProcess }
}

describe('killTurn', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * The group SIGINT kills the journal wrapper, so the wait ends with no exit record,
   * while background members that ignore SIGINT keep running. One default kill must follow
   * before the re-check, and it is not waited on — the wrapper is already gone.
   */
  it('sends one default kill after an interrupt that settles without an exit record', async () => {
    const { sandbox, kill, waitForExit } = fakeSession({ waits: [new SandboxNoExitRecordError('p1')] })

    expect(await killTurn(sandbox, 'p1')).toBe(true)
    expect(kill.mock.calls).toEqual([[SIGINT], []])
    expect(waitForExit).toHaveBeenCalledTimes(1)
  })

  it('keeps the verdict when that default kill rejects on a process already gone', async () => {
    const { sandbox, kill } = fakeSession({
      waits: [new SandboxNoExitRecordError('p1')],
      defaultKillRejects: new Error('process not found'),
    })

    expect(await killTurn(sandbox, 'p1')).toBe(true)
    expect(kill.mock.calls).toEqual([[SIGINT], []])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('watchdog survivor sweep failed'))
  })

  it('leaves the verdict to the re-check after that default kill', async () => {
    const { sandbox, kill } = fakeSession({ waits: [new SandboxNoExitRecordError('p1')], status: RUNNING })

    expect(await killTurn(sandbox, 'p1')).toBe(false)
    expect(kill.mock.calls).toEqual([[SIGINT], []])
  })

  it('stops at the interrupt when the turn records its exit', async () => {
    const { sandbox, kill, waitForExit } = fakeSession({ waits: [{ code: 0, timedOut: false }] })

    expect(await killTurn(sandbox, 'p1')).toBe(true)
    expect(kill.mock.calls).toEqual([[SIGINT]])
    expect(waitForExit.mock.calls).toEqual([[{ timeout: INTERRUPT_SETTLE_TIMEOUT_MS }]])
  })

  it('escalates to a waited default kill when the interrupt does not settle', async () => {
    const { sandbox, kill, waitForExit } = fakeSession({
      waits: [new SandboxWaitTimeoutError('p1', INTERRUPT_SETTLE_TIMEOUT_MS), { code: 143, signal: 15, timedOut: false }],
    })

    expect(await killTurn(sandbox, 'p1')).toBe(true)
    expect(kill.mock.calls).toEqual([[SIGINT], []])
    expect(waitForExit.mock.calls).toEqual([
      [{ timeout: INTERRUPT_SETTLE_TIMEOUT_MS }],
      [{ timeout: KILL_SETTLE_TIMEOUT_MS }],
    ])
  })

  it('escalates to a waited default kill when the interrupt cannot be sent', async () => {
    const { sandbox, kill, waitForExit } = fakeSession({
      waits: [{ code: 143, signal: 15, timedOut: false }],
      interruptKillRejects: new Error('signal not supported'),
    })

    expect(await killTurn(sandbox, 'p1')).toBe(true)
    expect(kill.mock.calls).toEqual([[SIGINT], []])
    expect(waitForExit.mock.calls).toEqual([[{ timeout: KILL_SETTLE_TIMEOUT_MS }]])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('watchdog interrupt request failed'))
  })

  it('leaves the verdict to the re-check when the escalated kill itself fails', async () => {
    const { sandbox, kill } = fakeSession({
      waits: [new SandboxWaitTimeoutError('p1', INTERRUPT_SETTLE_TIMEOUT_MS)],
      defaultKillRejects: new Error('control plane down'),
      status: RUNNING,
    })

    expect(await killTurn(sandbox, 'p1')).toBe(false)
    expect(kill.mock.calls).toEqual([[SIGINT], []])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('watchdog kill failed'))
  })

  it('signals nothing when the process is already gone', async () => {
    const { sandbox, kill, getProcess } = fakeSession({ waits: [] })
    getProcess.mockResolvedValueOnce(null)

    expect(await killTurn(sandbox, 'p1')).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })
})
