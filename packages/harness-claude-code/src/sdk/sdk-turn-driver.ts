/**
 * The `sdk` driver: a turn is the Agent SDK's `query()`, hosted in a per-turn process inside the
 * sandbox, driven over a WebSocket the provider knows how to reach (ADR D1/D2/D4).
 *
 * It is the same seam the `cli` driver fills and a different shape behind it. Starting a turn is
 * an exec *and* a handshake; waiting on one is a sequence of bounded attach rounds rather than a
 * single wait; stopping one is an `interrupt` the agent answers with a real `result`, and only
 * then the signal ladder. What it does not change is the decision: `watchdog.ts` judges liveness
 * and the budget for both drivers, from frame arrivals here and log bytes there.
 *
 * The provider, not just the session, because dialing is `SandboxProvider.portEndpoint`'s to
 * answer — the Cloudflare backend mints a tagged URL its Durable Object opens, e2b a routable
 * one — and that keeps the driver orthogonal to `SANDBOX_BACKEND`, which is D3's whole point.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import type { SandboxProvider, SandboxSession } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from '../config'
import type { AttemptResult, TurnDriver, TurnHandle, TurnResume, TurnRoundSpec, TurnRoundState, TurnStartSpec } from '../turn-driver'
import { killTurn } from '../cli-turn-kill'
import { clampedTurnBudget } from '../watchdog'
import { adoptOrExec } from './sdk-adopt'
import {
  bridgeEndpointUrl,
  mintChannelToken,
  turnHostArgv,
  turnHostEnv,
  turnHostPort,
  turnHostStateDir,
} from './sdk-bridge-config'
import { runAttachRound } from './sdk-round'
import { handTurnToHost, startTurnHost } from './sdk-turn-start'

export interface SdkTurnDriverInput {
  provider: SandboxProvider
  sandboxId: string
  config: TurnDriverConfig
  runId: string
  /** Dial one endpoint URL — the consumer's socket opener in production, a scripted one in a test. */
  openSocket: (url: string) => Promise<WsLike>
  /** `settingSources` for the `start` frame, as the consumer names them. */
  settingSources: readonly string[]
  /** Entropy for the per-turn channel token; production passes `crypto.getRandomValues`. */
  randomFill?: (into: Uint8Array) => void
}

/**
 * The per-run ceilings this deployment set, as the `start` frame carries them (D5).
 *
 * Absent keys rather than `undefined` values, so an unlimited turn says nothing at all about
 * limits — `TurnDriverConfig` leaves both off for an unset var, and the frame keeps that shape.
 */
function turnLimits(config: TurnDriverConfig): { maxBudgetUsd?: number, maxTurns?: number } {
  return {
    ...(config.turnMaxBudgetUsd === undefined ? {} : { maxBudgetUsd: config.turnMaxBudgetUsd }),
    ...(config.turnMaxTurns === undefined ? {} : { maxTurns: config.turnMaxTurns }),
  }
}

/**
 * The run's permission posture, as the `start` frame carries it (D6 layers 1 and 3).
 *
 * The run's own lists when the workflow pinned them at dispatch, and the deployment's config
 * otherwise — which is what a workflow instance older than {@link TurnStartSpec.policy} carries.
 * Either way this is an `sdk`-only concern: both lists are `start`-frame fields the *host*
 * enforces, so the `cli` driver would only have received members it must ignore.
 */
function turnPolicy(
  spec: TurnStartSpec,
  config: TurnDriverConfig,
): { refuseTools?: readonly string[], deferTools?: readonly string[] } {
  // The run's pinned lists when it has them, the deployment's only for an instance older than
  // the field: a turn resumed after a day-long wait must be governed by the rules that deferred
  // it, not by whatever shipped in the meantime.
  const refuseTools = spec.policy?.refuseTools ?? config.turnRefuseTools
  const deferTools = spec.policy?.deferTools ?? config.turnDeferTools
  return {
    ...(refuseTools.length === 0 ? {} : { refuseTools }),
    ...(deferTools.length === 0 ? {} : { deferTools }),
  }
}

export function sdkTurnDriver(input: SdkTurnDriverInput): TurnDriver {
  // Resolved per operation, never held: `SandboxProvider` requires that because a Durable Object
  // stub does not survive a step boundary, and `start`, each attach round and a kill are all
  // different steps here (`packages/sandbox/src/types.ts`). One round *does* keep the
  // session it resolved for the length of that round, which is one step.
  const session = (): SandboxSession => input.provider.session(input.sandboxId)
  const fill = input.randomFill ?? ((into: Uint8Array) => crypto.getRandomValues(into))

  const connect = (handle: TurnHandle) => async (): Promise<WsLike> => {
    if (handle.port === undefined) {
      // Every handle this driver makes carries one, so an absent port is a handle from somewhere
      // else — and a default would dial attempt 1's host, which is another turn's.
      throw new Error(`sdk turn handle has no port process_id=${handle.processId}`)
    }
    const endpoint = await input.provider.portEndpoint(input.sandboxId, handle.port, { protocol: 'ws' })
    return await input.openSocket(bridgeEndpointUrl(endpoint.url, handle.token ?? ''))
  }

  return {
    mode: 'rounds',

    async start(turn: TurnStartSpec): Promise<TurnHandle> {
      const turnSession = session()
      const port = turnHostPort(turn.attempt)
      const stateDir = turnHostStateDir({
        workspaceRoot: input.config.workspaceRoot,
        runId: input.runId,
        attempt: turn.attempt,
      })
      const token = mintChannelToken(fill)
      // Resolved once, and never before the turn is known to start: whether the session file is
      // in *this* container is not a fact a step result may carry across a container
      // replacement, and a `start` sent with a `resume` whose transcript is absent starts a new
      // session under the old id (`TurnStartSpec.resume`). The exec path asks below, past the
      // checkout guard; an adopted host that is still waiting asks when its `start` goes out,
      // which is the one other moment a `start` leaves this driver.
      let resumed: Promise<TurnResume | undefined> | undefined
      const resolveResume = (): Promise<TurnResume | undefined> =>
        (resumed ??= turn.resume?.() ?? Promise.resolve(undefined))
      // `--workdir` is hard-fatal in the host and a turn with no checkout is legal here, so the
      // driver defaults it to the directory the image's `WORKDIR` already puts a turn in.
      const argv = turnHostArgv({ workdir: turn.cwd ?? input.config.workspaceRoot, stateDir })
      const started = await adoptOrExec({
        session: turnSession,
        argv,
        cwd: turn.cwd,
        // Passed as the thunk it arrived as, so the guard inside `adoptOrExec` runs first: the
        // bridge's own two variables are cheap, but `turn.env()` can refuse a configuration.
        env: () => turnHostEnv(turn.env(), { token, port }),
        recordedProcessId: turn.recordedProcessId,
        started: turn.started,
        // Both run past the adoption guard, in this order: the checkout guard can refuse the
        // turn outright, and a turn that is not going to start has no reason to have a session
        // file put back for it.
        beforeExec: async () => {
          await turn.beforeExec?.()
          await resolveResume()
        },
        stateDir,
        token,
      })
      const handOff = {
        prompt: turn.prompt,
        permissionMode: turn.permissionMode,
        instructions: turn.instructions,
        // The two ceilings are read off the deployment's config rather than carried on the spec:
        // they are `start`-frame fields the SDK enforces, so the `cli` driver would only have
        // received a member it must ignore. This driver already holds the config.
        settingSources: input.settingSources,
        limits: turnLimits(input.config),
        policy: turnPolicy(turn, input.config),
        approvedRequests: turn.approvedRequests,
        deniedRequests: turn.deniedRequests,
        startedAtMs: Date.now(),
        port,
        stateDir,
        // Only the id: the file it names is confirmed — or put back — in this container by the
        // thunk (D8), and the SDK locates it itself. A host adopted while still *waiting* is the
        // case that makes this lazy: its container is the one the live process is in, so the
        // check is as good there as on the exec path, and a deferred conversation parked on a
        // human's decision (D6) would otherwise restart fresh in exactly the window a restart
        // is meant to cover.
        resume: async () => (await resolveResume())?.sessionId,
        // The other half of the same decision: a turn that is not resuming still runs under the
        // run's own id, so what it leaves behind is a session the next attempt can ask for by
        // name rather than one only this workflow instance ever saw (D8, D6).
        sessionId: turn.sessionId,
      }
      if (started.adopted) {
        // A live host is not necessarily a host with a turn: a restart between the `exec` and
        // the start's acknowledgement finds one that is still waiting, and a round only ever
        // sends `resume`. `handTurnToHost` reads the greeting and starts only a waiting host.
        return await handTurnToHost({
          ...handOff,
          processId: started.processId,
          connect: connect({ processId: started.processId, port, token: started.token }),
          token: started.token,
        })
      }
      return await startTurnHost({
        ...handOff,
        process: started.process,
        connect: connect({ processId: started.processId, port, token }),
        token,
      })
    },

    async awaitRound(handle: TurnHandle, spec: TurnRoundSpec): Promise<TurnRoundState> {
      return await runAttachRound({
        session: session(),
        handle,
        connect: connect(handle),
        config: spec.config,
        mirror: spec.mirror,
        // Kept for the `sdk` driver even though rounds make it conservative rather than
        // necessary: no single step holds the turn any more, so the platform's own step ceiling
        // is no longer what the budget has to stay under. Clamping anyway keeps one answer to
        // "how long may a turn run" across both drivers.
        budgetMs: clampedTurnBudget(spec.config.turnWallClockBudgetMs),
        previous: spec.previous,
        onFrame: spec.onFrame,
        signal: spec.signal,
        now: () => Date.now(),
      })
    },

    async kill(handle: TurnHandle): Promise<boolean> {
      return await killTurn(session(), handle.processId)
    },
  } satisfies TurnDriver & { mode: 'rounds' } as TurnDriver
}

/** Re-exported so the workflow can name the type without reaching into the sdk directory. */
export type { AttemptResult }
