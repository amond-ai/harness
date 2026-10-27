import type { ProcessLogEvent } from '@amond-ai/sandbox'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { describe, expect, it, vi } from 'vitest'
import { drain, endProcess, fakeSandbox, leapingClock, processOf, writeLog } from './cloudflare.fixtures'

vi.mock('cloudflare:workers', async () => (await import('./fake-workers')).workersModule)
vi.mock('@cloudflare/sandbox', async () => (await import('./fake-workers')).sandboxModule)

const text = (event: ProcessLogEvent): string => 'data' in event ? new TextDecoder().decode(event.data) : ''

describe('waitForExit', () => {
  it('resolves from the recorded exit', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    endProcess(container, 'run-1', 7)

    expect(await handle.waitForExit()).toEqual({ code: 7, timedOut: false })
  })

  it('rejects with SandboxWaitTimeoutError once its budget elapses', async () => {
    const { session } = fakeSandbox()
    const handle = await session({ monotonicNowMs: leapingClock(1_000) }).exec(['claude'])

    await expect(handle.waitForExit({ timeout: 2_500 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('rejects with SandboxNoExitRecordError for a process that ended without recording an exit', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    processOf(container, 'run-1').phase = 'lost'

    await expect(handle.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })

  it('rejects with SandboxNoExitRecordError once the container itself has stopped', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    container.running = false

    await expect(handle.waitForExit()).rejects.toBeInstanceOf(SandboxNoExitRecordError)
  })

  it('rejects at its deadline while a status read is still pending', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    container.holdStatus = new Promise(() => {})

    await expect(handle.waitForExit({ timeout: 50 })).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })

  it('rejects promptly on abort while a status read is still pending', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    container.holdStatus = new Promise(() => {})
    const controller = new AbortController()

    const waiting = handle.waitForExit({ signal: controller.signal })
    controller.abort()

    await expect(waiting).rejects.toBeInstanceOf(SandboxWaitTimeoutError)
  })
})

describe('logs', () => {
  it('replays stdout, then stderr, then the terminal event', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    writeLog(container, 'run-1', 'stdout', '{"type":"result"}\n')
    writeLog(container, 'run-1', 'stderr', 'warn\n')
    endProcess(container, 'run-1', 0)

    const events = await drain(await handle.logs({ replay: true }))
    expect(events.map(event => event.type)).toEqual(['stdout', 'stderr', 'terminal'])
    expect(events.map(text)).toEqual(['{"type":"result"}\n', 'warn\n', ''])
    expect(events[2]).toMatchObject({ state: 'exited', exit: { code: 0 }, cursor: '18:5' })
  })

  it('errors the replay with the reason when the caller aborts a log read that hangs', async () => {
    // The replay reads under `'fail'`, but the abort must not depend on that: it is the caller
    // leaving, not a read that died (cubic review, PR #66; #69).
    const { container, sandbox, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    writeLog(container, 'run-1', 'stdout', '{"type":"result"}\n')
    endProcess(container, 'run-1', 0)
    sandbox.readProcessLog = () => new Promise(() => {})
    const controller = new AbortController()

    const replay = drain(await handle.logs({ replay: true, signal: controller.signal }))
    setTimeout(() => controller.abort(new Error('caller left')), 5)

    await expect(replay).rejects.toThrow('caller left')
  })

  it('carries a timed-out exit into the replay\'s terminal event', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'], { timeout: 1_000 })
    endProcess(container, 'run-1', 143, true)

    const events = await drain(await handle.logs({ replay: true }))
    expect(events.at(-1)).toMatchObject({ type: 'terminal', state: 'exited', exit: { code: 143, timedOut: true } })
  })

  it('resumes from a cursor without re-serving what the caller already read', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    writeLog(container, 'run-1', 'stdout', 'one\n')
    const [first] = await drain(await handle.logs({ since: '0:0' }))
    writeLog(container, 'run-1', 'stdout', 'two\n')
    writeLog(container, 'run-1', 'stderr', 'oops\n')

    const next = await drain(await handle.logs({ since: first!.cursor }))
    expect(next.map(text)).toEqual(['two\n', 'oops\n'])
    expect(next.at(-1)?.cursor).toBe('8:5')
  })

  it('serves a positioned read to EOF even past one reply\'s byte limit', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    const big = 'x'.repeat(1024 * 1024 + 10)
    writeLog(container, 'run-1', 'stdout', big)

    const events = await drain(await handle.logs({ since: '0:0' }))
    expect(events.map(text).join('')).toBe(big)
    expect(events.at(-1)?.cursor).toBe(`${big.length}:0`)
  })

  it('reads only to the end the log had when the read began, however fast it grows', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    const chunk = 'x'.repeat(1024 * 1024)
    writeLog(container, 'run-1', 'stdout', chunk)
    let grown = 0
    container.afterRead = () => {
      if (grown++ < 3) {
        writeLog(container, 'run-1', 'stdout', chunk)
      }
    }

    const [first] = await drain(await handle.logs({ since: '0:0' }))
    expect(first?.cursor).toBe(`${chunk.length}:0`)
  })

  it('follows the live log until the process exits and ends with a terminal event', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['bridge'])
    writeLog(container, 'run-1', 'stdout', 'ready\n')
    const reader = (await handle.logs({ follow: true, replay: true })).getReader()

    expect(text((await reader.read()).value!)).toBe('ready\n')
    writeLog(container, 'run-1', 'stdout', 'bye\n')
    endProcess(container, 'run-1', 0)
    const rest: ProcessLogEvent[] = []
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      rest.push(next.value)
    }
    expect(rest.map(text)).toEqual(['bye\n', ''])
    expect(rest.at(-1)).toMatchObject({ type: 'terminal', state: 'exited', exit: { code: 0 } })
  })
})
