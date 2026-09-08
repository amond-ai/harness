/**
 * The adapter under `HarnessAgent`, against a fake turn host: no network, no container, and no
 * part of the driver stubbed out — the agent drives `createClaudeCode`, which drives the `sdk`
 * driver, which execs, handshakes, sends `start` and then attaches round by round.
 *
 * The three things worth proving are the three the contract is built on. A turn runs end to end.
 * A slice boundary — `suspendTurn` → `createSession({ continueFrom })` → `continueGenerate` —
 * loses nothing and repeats nothing, because the second slice attaches at the cursor the first
 * one stopped at. And a session parked between turns carries the Claude session id forward, so
 * the next turn runs under the same conversation.
 */
import type { HarnessV1 } from '@ai-sdk/harness'
import type { SandboxProvider } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from '../config'
import type { FakeTurnHost } from './turn-host.fixtures'
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { describe, expect, it } from 'vitest'
import { createClaudeCode } from './create-claude-code'
import { createFakeTurnHost } from './turn-host.fixtures'

const WORDS = ['hello', ' ', 'world', ' ', 'from', ' ', 'the', ' ', 'host']

const CONFIG: TurnDriverConfig = {
  watchdogTimeoutMs: 60_000,
  livenessWindowMs: 60_000,
  livenessSampleIntervalMs: 5,
  turnWallClockBudgetMs: 60_000,
  turnDeferTools: [],
  turnRefuseTools: [],
  workspaceRoot: '/workspace',
}

/** The agent touches only these three members of a caller-provided session; `id` is the driver's. */
const SANDBOX_SESSION = {
  id: 'sbx-1',
  defaultWorkingDirectory: '/workspace',
  run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
} as never

const USAGE = {
  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: WORDS.length, text: WORDS.length, reasoning: 0 },
}
const FINISH_REASON = { unified: 'stop', raw: 'end_turn' }

/** One turn's frames, as the host journals them: a text stream, then the D8 artifacts. */
function turnFrames(): Record<string, unknown>[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    ...WORDS.map(delta => ({ type: 'text-delta', id: 't1', delta })),
    { type: 'text-end', id: 't1' },
    { type: 'finish-step', finishReason: FINISH_REASON, usage: USAGE },
    {
      type: 'finish',
      finishReason: FINISH_REASON,
      totalUsage: USAGE,
      stopped: 'completed',
      sessionArtifacts: {
        sessionId: 'sess-1',
        sessionTranscriptPath: '/root/.claude/projects/-workspace/sess-1.jsonl',
        journalPath: '/workspace/.turn-host/s1/1/event-log.ndjson',
      },
    },
  ]
}

function harnessOver(host: FakeTurnHost): HarnessV1 {
  return createClaudeCode({
    sandboxes: host.provider,
    openSocket: host.openSocket,
    config: CONFIG,
    settingSources: ['project'],
    env: () => ({ ANTHROPIC_API_KEY: 'test-key' }),
  })
}

function fakeHost(): FakeTurnHost {
  return createFakeTurnHost({ frames: () => turnFrames() })
}

describe('the claude-code harness under HarnessAgent', () => {
  it('runs a whole turn: exec, start, attach, and the text the host streamed', async () => {
    const host = fakeHost()
    const agent = new HarnessAgent({ harness: harnessOver(host), permissionMode: 'allow-all' })
    const session = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })

    const result = await agent.generate({ session, prompt: 'say hello' })

    expect(result.text).toBe(WORDS.join(''))
    expect(host.starts).toHaveLength(1)
    expect(host.starts[0]).toMatchObject({ type: 'start', prompt: 'say hello', permissionMode: 'bypassPermissions' })
    // One turn, one attach: the round consumed the journal in a single window.
    expect(host.attaches).toEqual([0])
    await session.destroy()
  })

  it('suspends mid-stream and continues from that cursor, losing and repeating nothing', async () => {
    const host = fakeHost()
    const agent = new HarnessAgent({ harness: harnessOver(host), permissionMode: 'allow-all' })
    const first = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })

    const stream = await agent.stream({ session: first, prompt: 'say hello' })
    const seen: string[] = []
    for await (const delta of stream.textStream) {
      seen.push(delta)
      if (seen.length === 2) {
        break
      }
    }
    const state = await first.suspendTurn()
    const cursor = (state.data as { round?: { since: number } }).round?.since

    const second = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION, continueFrom: state })
    const rest = await agent.continueGenerate({ session: second })

    // The second slice attached where the first stopped — the host replayed from there, and the
    // turn was never restarted: one `start` for both slices.
    expect(host.attaches).toEqual([0, cursor])
    expect(host.starts).toHaveLength(1)
    expect(seen.join('') + rest.text).toBe(WORDS.join(''))
    // Both halves are real halves: the suspend landed inside the turn rather than after it.
    expect(seen).toHaveLength(2)
    expect(rest.text.length).toBeLessThan(WORDS.join('').length)
    await second.destroy()
  })

  it('carries the session the host named into the next turn after a detach', async () => {
    const host = fakeHost()
    const harness = harnessOver(host)
    const agent = new HarnessAgent({ harness, permissionMode: 'allow-all' })
    const first = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })
    await agent.generate({ session: first, prompt: 'say hello' })

    const parked = await first.detach()
    expect(parked.type).toBe('resume-session')
    expect(parked.data).toMatchObject({ session: { sessionId: 'sess-1' } })

    const resumed = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION, resumeFrom: parked })
    await agent.generate({ session: resumed, prompt: 'say it again' })

    // The second turn runs under the conversation the first one left behind, by the id the host
    // itself named — never one this side reconstructed from a transcript path.
    expect(host.starts[1]).toMatchObject({ prompt: 'say it again', sessionId: 'sess-1' })
    await resumed.destroy()
  })

  it('resumes the transcript after a detach when it is still in the container', async () => {
    const host = fakeHost()
    const agent = new HarnessAgent({ harness: harnessOver(host), permissionMode: 'allow-all' })
    const first = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })
    await agent.generate({ session: first, prompt: 'say hello' })
    const parked = await first.detach()
    await host.provider.session('sbx-1').writeFile('/root/.claude/projects/-workspace/sess-1.jsonl', '{}\n')

    const resumed = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION, resumeFrom: parked })
    await agent.generate({ session: resumed, prompt: 'say it again' })

    // `resume` and `sessionId` are the SDK's two mutually exclusive ways of naming a session:
    // with the transcript present the turn restores it, rather than starting anew under its id.
    expect(host.starts[1]).toMatchObject({ prompt: 'say it again', resume: 'sess-1' })
    expect(host.starts[1]).not.toHaveProperty('sessionId')
    await resumed.destroy()
  })

  it('starts fresh under the same id when the transcript check itself fails', async () => {
    const host = fakeHost()
    const sandboxes: SandboxProvider = {
      ...host.provider,
      session: id => ({
        ...host.provider.session(id),
        // Only the transcript lookup fails; the driver's own adoption probe still answers.
        exists: async (path: string) => {
          if (path.endsWith('.jsonl')) {
            throw new Error('gateway unreachable')
          }
          return host.provider.session(id).exists(path)
        },
      }),
    }
    const harness = createClaudeCode({ sandboxes, openSocket: host.openSocket, config: CONFIG, settingSources: ['project'], env: () => ({}) })
    const agent = new HarnessAgent({ harness, permissionMode: 'allow-all' })
    const first = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })
    await agent.generate({ session: first, prompt: 'say hello' })
    const parked = await first.detach()

    const resumed = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION, resumeFrom: parked })
    await agent.generate({ session: resumed, prompt: 'say it again' })

    // The resume thunk never rejects: a check it cannot complete is "not in this container",
    // and the turn still starts — under the old id, as an honest fresh start.
    expect(host.starts[1]).toMatchObject({ prompt: 'say it again', sessionId: 'sess-1' })
    expect(host.starts[1]).not.toHaveProperty('resume')
    await resumed.destroy()
  })

  it('leaves the suspended host running when the spent session is destroyed', async () => {
    const host = fakeHost()
    const session = await harnessOver(host).doStart({ sessionId: 's1', sandboxSession: SANDBOX_SESSION, sessionWorkDir: '/workspace' })
    let inFlight: () => void = () => {}
    const firstDelta = new Promise<void>((resolve) => {
      inFlight = resolve
    })
    const turn = await session.doPromptTurn({ prompt: 'say hello', emit: (part) => {
      if (part.type === 'text-delta') {
        inFlight()
      }
    } })
    await firstDelta
    await session.doSuspendTurn()
    await session.doDestroy()
    await turn.done

    // The host now belongs to the continue state the suspend returned; destroying the instance
    // that produced it must not kill what the next slice is about to attach to.
    expect(host.kills).toEqual([])
  })

  it('kills the suspended host when a continued session is destroyed before it continues', async () => {
    const host = fakeHost()
    const agent = new HarnessAgent({ harness: harnessOver(host), permissionMode: 'allow-all' })
    const first = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })
    const stream = await agent.stream({ session: first, prompt: 'say hello' })
    // One delta is enough to prove the turn is in flight before it is suspended.
    await stream.textStream[Symbol.asyncIterator]().next()
    const state = await first.suspendTurn()
    expect(host.kills).toEqual([])

    const second = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION, continueFrom: state })
    await second.destroy()

    // No local loop existed on the second session, but the host it was handed was still running
    // the turn — and this destroy discarded the only state that could ever reach it again.
    expect(host.kills).toEqual(['host-1'])
  })

  it('reports a turn the watchdog cut off as an error, not as a clean finish', async () => {
    // The host narrates an interrupt as a `finish` — with `finishReason: 'stop'` like every other
    // ending — and the contract's schema strips the `stopped`/`interruptedBy` that distinguish it.
    // A consumer handed the stripped part would read a cut-off turn as a completed one.
    const host = createFakeTurnHost({
      frames: () => [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'half a th' },
        {
          type: 'finish',
          finishReason: FINISH_REASON,
          totalUsage: USAGE,
          stopped: 'interrupted',
          interruptedBy: 'watchdog',
          sessionArtifacts: { journalPath: '/workspace/.turn-host/s1/1/event-log.ndjson' },
        },
      ],
    })
    const agent = new HarnessAgent({ harness: harnessOver(host), permissionMode: 'allow-all' })
    const session = await agent.createSession({ sessionId: 's1', sandboxSession: SANDBOX_SESSION })

    await expect(agent.generate({ session, prompt: 'say hello' }))
      .rejects
      .toThrow(/interrupted \(watchdog\)/)

    await session.destroy()
  })
})
