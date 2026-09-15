/*
 * The half of this deployment's bridge extension that does not know which agent runs inside the
 * sandbox: the `interrupt` command, the ending's `stopped` / `phase` vocabulary, and the
 * `bridge-started` frame the runtime emits itself.
 *
 * That sentence is the membership rule, and it is the rule rather than "what this deployment
 * added" because the latter describes every line of `protocol.ts` too and so admits anything.
 * A field only belongs here if a bridge with no Claude and no Codex behind it would still send or
 * accept it — which is exactly the set `@amond-ai/harness-bridge-runtime` owns. `settingSources`,
 * a session transcript path and a deferred tool call each fail that test and stay in
 * `protocol.ts`.
 *
 * Split out when the runtime became its own package. `turnHostStartedSchema` is the case that
 * forced it: `bridge-started` is emitted by the runtime, not by any adapter, so its schema sitting
 * in a file whose header reads "the turn host's `start` payload" and whose first import is
 * Claude's start shape was simply the wrong address. `protocol.ts` re-exports everything here, so
 * no consumer's import changed.
 */

import { z } from 'zod/v4'

/**
 * Why the client is stopping the turn — named on the `interrupt` command, and echoed back on
 * the ending the host answers it with (`turnHostFinishSchema` / `turnHostErrorSchema`).
 *
 * Shared by both directions on purpose: the client's memory of what it asked for is not
 * durable, so the host's echo is what a re-entered round reads the cause from.
 *
 * `@amond-ai/harness-bridge-runtime` keeps the same list as a plain `const` and validates an
 * inbound reason against it, because the frame reaches it as a cast rather than a parse. The two
 * are mirrors with no dependency between them; a test in that package asserts they stay equal.
 */
export const interruptReasonSchema = z.enum(['watchdog', 'budget', 'operator'])

export type InterruptReason = z.infer<typeof interruptReasonSchema>

/**
 * End the running turn early but keep it a turn: the host asks its runtime to stop and still
 * produce a `result`, so the bridge still emits `finish`. `abort` tears the process down instead.
 *
 * Not optional for an adapter to accept: the runtime routes this command to whatever handler the
 * turn registered, so every bridge built on it answers `interrupt` on the wire.
 */
export const interruptInboundSchema = z.object({
  type: z.literal('interrupt'),
  reason: interruptReasonSchema,
})

/**
 * How the turn ended, as the host judged it from its runtime's own terminal reason.
 *
 * `deferred` is reachable only where the adapter forwards tool approvals; an adapter that runs its
 * agent under a never-ask policy never emits it. One enum rather than one per adapter, so a
 * consumer reading an ending does not meet two incompatible `StoppedReason` types at one seam.
 */
export const stoppedReasonSchema = z.enum(['completed', 'interrupted', 'deferred'])

export type StoppedReason = z.infer<typeof stoppedReasonSchema>

/** Which stage of the turn an `error` came from — stripped by the upstream schema. */
export const bridgeErrorPhaseSchema = z.enum(['start', 'init', 'run'])

export type BridgeErrorPhase = z.infer<typeof bridgeErrorPhaseSchema>

/**
 * The host's acknowledgement that a `start` was taken: sent the moment the bridge enters
 * `running`, before the agent produces anything, so a client can tell "the turn is starting" from
 * "the model has not spoken yet". Journaled like every other frame, so it carries a `seq`.
 */
export const turnHostStartedSchema = z.object({ type: z.literal('bridge-started') })

export type TurnHostStarted = z.infer<typeof turnHostStartedSchema>
