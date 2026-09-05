// Long-running bridge that runs inside a sandbox alongside the `claude` CLI.
// The generic transport — WebSocket server, token auth, single-flight
// reconnect, the in-memory event log + `seq`, resume replay, and the
// lifecycle/meta files — lives in the shared bridge runtime. This file supplies
// only the Claude-specific turn driver.
//
// The Agent SDK is a type-only import here: `query()` arrives through
// `createTurnDriver`, so a test can drive the whole driver against a scripted
// fake and `main.ts` stays the one module that loads the real SDK.

import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SdkPermissionMode, StartMessage } from '@pleaseai/harness-protocol'
import type { BridgeEvent, BridgeTurn, Experimental_BridgeUserMessage, Experimental_BridgeUserMessageQueue } from './bridge-runtime'
import type { ClaudeMessage } from './create-emit-stream-event'
import { randomUUID } from 'node:crypto'
import { exit, env as procEnv } from 'node:process'
import { sdkPermissionModeSchema, startMessageSchema } from '@pleaseai/harness-protocol'

import { createClaudeCodeSystemPrompt } from './claude-code-system-prompt'
import { toClaudeSkillsOption } from './claude-skills-option'
import { createCompactionLatch } from './compaction-latch'
import {
  createClaudeStreamEventState,
  createEmitStreamEvent,
  defaultUsage,
  emitFinishStep,
  finishApprovalStep,
  mapUsage,
} from './create-emit-stream-event'
import {
  createPreToolUseEvaluator,
  DENY_BY_RUN_POLICY_MESSAGE,
} from './permission-policy'
import {
  sessionTranscriptPath,
  stoppedFromTerminalReason,
} from './session-artifacts'
import {
  resolveInactiveNativeTools,
  resolveNativeTools,
} from './tool-filtering'

/*
 * Native Claude Code tool name → cross-harness common name. Tools outside this
 * map (e.g. `WebFetch`, `NotebookEdit`) have no common equivalent; their
 * native name is forwarded as-is on `tool-call` events.
 */
type CommonBuiltinToolName
  = | 'read'
    | 'write'
    | 'edit'
    | 'bash'
    | 'glob'
    | 'grep'
    | 'webSearch'

const NATIVE_TO_COMMON: Readonly<Record<string, CommonBuiltinToolName>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebSearch: 'webSearch',
}

const NATIVE_TOOL_KINDS: Readonly<
  Record<string, 'readonly' | 'edit' | 'bash'>
> = {
  Read: 'readonly',
  Glob: 'readonly',
  Grep: 'readonly',
  WebSearch: 'readonly',
  WebFetch: 'readonly',
  TaskGet: 'readonly',
  TaskList: 'readonly',
  TaskOutput: 'readonly',
  ListMcpResources: 'readonly',
  ReadMcpResource: 'readonly',
  Write: 'edit',
  Edit: 'edit',
  NotebookEdit: 'edit',
  TodoWrite: 'edit',
  TaskCreate: 'edit',
  TaskUpdate: 'edit',
  TaskStop: 'edit',
  EnterWorktree: 'edit',
  ExitWorktree: 'edit',
  ExitPlanMode: 'edit',
  Skill: 'readonly',
  AskUserQuestion: 'readonly',
  ToolSearch: 'readonly',
  Bash: 'bash',
  Monitor: 'bash',
}

function toCommonName(nativeName: string): CommonBuiltinToolName | string {
  return NATIVE_TO_COMMON[nativeName] ?? nativeName
}

/**
 * The slash command a prompt routes to, without its leading `/`, or
 * `undefined` for a plain prompt. `/software-factory:implement #360` routes to
 * `software-factory:implement`.
 */
export function routedCommandName(prompt: string): string | undefined {
  if (!prompt.startsWith('/')) {
    return undefined
  }
  const token = prompt.slice(1).split(/\s/, 1)[0]
  return token.length > 0 ? token : undefined
}

/**
 * The `query()` seam. `main.ts` passes the real Agent SDK export; tests pass a
 * fake that yields a scripted `SDKMessage` script and spies on `interrupt()`.
 * Same shape as the host/Docker runners' `queryFn` in `packages/core`.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

export interface TurnDriverOptions {
  query: QueryFn
  /** Absolute path the turn runs in; `cwd` for every `query()` call. */
  workdir: string
  /**
   * How the host ends its own process on the interrupt escalation. Defaults
   * to `process.exit`; a test passes a spy so the escalation is observable
   * without taking the test runner down with it.
   */
  exit?: (code: number) => void
}

/** Grace the host gives `interrupt()` to produce a `result`. */
const DEFAULT_INTERRUPT_GRACE_MS = 30_000

/**
 * Build the `onStart` the bridge runtime drives one turn with. Everything the
 * driver needs beyond the `start` frame is closed over here, so the module has
 * no module-level state and no import of the real SDK.
 */
export function createTurnDriver(
  driverOptions: TurnDriverOptions,
): (start: StartMessage, turn: BridgeTurn) => Promise<void> {
  return (start, turn) => runTurn(start, turn, driverOptions)
}

type Emit = (msg: Record<string, unknown>) => void

/** Harness permission modes, the three upstream understands. */
type HarnessPermissionMode = 'allow-reads' | 'allow-edits' | 'allow-all'

/*
 * The SDK modes are whatever the wire schema accepts, read from the schema so
 * a mode added there cannot be missed here and fall through to the harness
 * branch as `default`.
 */
function isSdkPermissionMode(mode: string): mode is SdkPermissionMode {
  return sdkPermissionModeSchema.safeParse(mode).success
}

/**
 * Resolve one tool call that reached `canUseTool`. Under `approvalPolicy:
 * 'deny'` it answers immediately: the callback is allowed to stay pending
 * indefinitely, and a headless turn that waits on a human who is not there is
 * a turn that never ends. Under `'forward'` it runs upstream's
 * `tool-approval-request` / `-response` round-trip.
 */
function createApprovalResolver(input: {
  approvalPolicy: 'deny' | 'forward'
  turn: BridgeTurn
  emit: Emit
  finishApprovalStep: (approvalId: string) => void
  nativeToolCallNames: Map<string, string>
  approvalRequestedToolUseIds: Set<string>
}): (
  toolName: string,
  toolInput: Record<string, unknown>,
  approvalId: string,
) => Promise<Record<string, unknown>> {
  return async (toolName, toolInput, approvalId) => {
    if (input.approvalPolicy === 'deny') {
      return {
        behavior: 'deny',
        message: DENY_BY_RUN_POLICY_MESSAGE,
        toolUseID: approvalId,
      }
    }

    input.approvalRequestedToolUseIds.add(approvalId)
    input.nativeToolCallNames.set(approvalId, toolName)
    input.emit({
      type: 'tool-call',
      toolCallId: approvalId,
      toolName: toCommonName(toolName),
      nativeName: toolName,
      input: JSON.stringify(toolInput ?? {}),
      providerExecuted: true,
    })
    input.emit({
      type: 'tool-approval-request',
      approvalId,
      toolCallId: approvalId,
    })
    input.finishApprovalStep(approvalId)

    const decision = await input.turn.requestToolApproval(approvalId)
    return decision.approved
      ? { behavior: 'allow', updatedInput: toolInput, toolUseID: approvalId }
      : {
          behavior: 'deny',
          message: decision.reason ?? 'Denied',
          toolUseID: approvalId,
        }
  }
}

function createPermissionOptions(input: {
  start: StartMessage
  inactiveNativeTools: readonly string[]
  turn: BridgeTurn
  emit: Emit
  finishApprovalStep: (approvalId: string) => void
  nativeToolCallNames: Map<string, string>
  approvalRequestedToolUseIds: Set<string>
}): Record<string, unknown> {
  const requestedMode = input.start.permissionMode ?? 'allow-all'
  const resolveApproval = createApprovalResolver({
    approvalPolicy: input.start.approvalPolicy ?? 'deny',
    turn: input.turn,
    emit: input.emit,
    finishApprovalStep: input.finishApprovalStep,
    nativeToolCallNames: input.nativeToolCallNames,
    approvalRequestedToolUseIds: input.approvalRequestedToolUseIds,
  })

  /*
   * The Worker sends the SDK's own mode. Pass it straight through — the run's
   * posture is the Worker's call, and re-deriving it from the harness trio
   * would silently narrow `plan` or `dontAsk` to something else.
   * `bypassPermissions` needs its companion flag or the CLI refuses it.
   */
  if (isSdkPermissionMode(requestedMode)) {
    return {
      permissionMode: requestedMode,
      allowDangerouslySkipPermissions: requestedMode === 'bypassPermissions',
      canUseTool: (
        toolName: string,
        toolInput: Record<string, unknown>,
        options: { toolUseID: string },
      ) => resolveApproval(toolName, toolInput, options.toolUseID),
    }
  }

  const permissionMode: HarnessPermissionMode = requestedMode
  const inactiveNativeTools = new Set(input.inactiveNativeTools)
  const permissionSettings = createPermissionSettings({
    permissionMode,
    inactiveNativeTools,
  })
  const bypassing
    = permissionMode === 'allow-all' && inactiveNativeTools.size === 0

  return {
    permissionMode: bypassing
      ? 'bypassPermissions'
      : permissionMode === 'allow-edits'
        ? 'acceptEdits'
        : 'default',
    allowDangerouslySkipPermissions: bypassing,
    ...(!bypassing && permissionSettings
      ? { settings: permissionSettings }
      : {}),
    canUseTool: async (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: { toolUseID: string },
    ) => {
      if (
        !inactiveNativeTools.has(toolName)
        && !nativeToolRequiresApproval({
          nativeName: toolName,
          permissionMode,
        })
      ) {
        return { behavior: 'allow', updatedInput: toolInput }
      }
      return resolveApproval(toolName, toolInput, options.toolUseID)
    },
  }
}

function createPermissionSettings(input: {
  permissionMode: 'allow-reads' | 'allow-edits' | 'allow-all'
  inactiveNativeTools: ReadonlySet<string>
}): Record<string, unknown> | undefined {
  const askRules = new Set<string>()
  for (const [nativeName, kind] of Object.entries(NATIVE_TOOL_KINDS)) {
    if (
      input.inactiveNativeTools.has(nativeName)
      || (input.permissionMode === 'allow-reads'
        ? kind === 'edit' || kind === 'bash'
        : input.permissionMode === 'allow-edits'
          ? kind === 'bash'
          : false)
    ) {
      askRules.add(`${nativeName}(*)`)
    }
  }

  if (askRules.size === 0) {
    return undefined
  }

  return {
    permissions: { ask: [...askRules] },
    sandbox: { autoAllowBashIfSandboxed: false },
  }
}

function nativeToolRequiresApproval(input: {
  nativeName: string
  permissionMode: 'allow-reads' | 'allow-edits' | 'allow-all'
}): boolean {
  if (input.permissionMode === 'allow-all') {
    return false
  }
  const kind = NATIVE_TOOL_KINDS[input.nativeName] ?? 'edit'
  if (input.permissionMode === 'allow-edits') {
    return kind === 'bash'
  }
  return kind === 'edit' || kind === 'bash'
}

async function runTurn(
  startFrame: StartMessage,
  turn: BridgeTurn,
  driverOptions: TurnDriverOptions,
): Promise<void> {
  const { query, workdir } = driverOptions
  const exitProcess = driverOptions.exit ?? exit
  const graceMs = startFrame.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS
  /*
   * Frames derived from a `stream_event` SDK message — the text/reasoning
   * deltas and their start/end — are liveness, not transcript: they are sent
   * if a socket is attached and take a `seq`, but they are not journaled and
   * not replayed. `emitStreamEvent` has no way to say so itself, so the loop
   * raises this flag around the one call that can produce them.
   */
  let derivedFromStreamEvent = false
  const emit: Emit = msg =>
    turn.emit(
      msg as BridgeEvent,
      derivedFromStreamEvent ? { journal: false } : undefined,
    )

  /*
   * The `start` frame is untrusted JSON off a socket. Validate it here rather
   * than trusting the static type: a run configured with a field the host
   * cannot honour must not start at all.
   */
  const parsed = startMessageSchema.safeParse(startFrame)
  if (!parsed.success) {
    emit({
      type: 'error',
      phase: 'start',
      error: `invalid start message: ${parsed.error.message}`,
    })
    return
  }
  const start = parsed.data

  /*
   * Host-defined tools are not part of this deployment's contract. Upstream
   * stands up an in-process MCP server for `start.tools` and executes each call
   * back on the host; the Worker never sends the field, and a turn that
   * silently ran without the tools it asked for would be worse than one that
   * did not run. Refuse before `query()`.
   */
  if (start.tools && start.tools.length > 0) {
    emit({
      type: 'error',
      phase: 'start',
      error: 'start.tools is not supported by this turn host',
    })
    return
  }

  // Local controller for the Claude query. Aborted either by the host (via the
  // shared runtime's `turn.abortSignal`) or by us on a terminal error.
  const abortCtl = new AbortController()
  if (turn.abortSignal.aborted) {
    abortCtl.abort()
  }
  else {
    turn.abortSignal.addEventListener('abort', () => abortCtl.abort(), {
      once: true,
    })
  }

  const streamEventState = createClaudeStreamEventState()

  const mcpServers: Record<string, unknown> = { ...(start.mcpServers ?? {}) }

  // Compaction observation: merge Claude's `compact_boundary` message and
  // `PostCompact` hook (which arrive in either order) into one `compaction`
  // event. See `createCompactionLatch`.
  const compaction = createCompactionLatch(event => emit(event))

  // `stream-start` is emitted lazily on the first SDK message (below) so it can
  // carry the model the CLI resolved to, reported on the `system`/`init` message.

  const queryInput = createQueryInput({
    initialUserMessage: start.prompt,
    userMessages: turn.experimental_userMessages,
    abortSignal: abortCtl.signal,
  })
  const skillsOption = toClaudeSkillsOption(start.skills)
  const nativeTools = resolveNativeTools(start.builtinToolFiltering)
  const inactiveNativeTools = resolveInactiveNativeTools(
    start.builtinToolFiltering,
  )
  const evaluatePreToolUse = createPreToolUseEvaluator({
    refuseTools: start.refuseTools,
    deferTools: start.deferTools,
    approvedRequests: start.approvedRequests,
  })
  const permissionOptions = createPermissionOptions({
    start,
    inactiveNativeTools,
    turn,
    emit,
    finishApprovalStep: (approvalId) => {
      finishApprovalStep({ state: streamEventState, emit, approvalId })
    },
    nativeToolCallNames: streamEventState.nativeToolCallNames,
    approvalRequestedToolUseIds: streamEventState.approvalRequestedToolUseIds,
  })

  /*
   * The environment the SDK child actually runs with. `env` REPLACES the
   * inherited environment rather than merging into it, so setting it at all
   * would drop the credentials the Worker injected at exec — hence the merge,
   * and hence only setting the option when the Worker asked. It is resolved
   * once because `sessionArtifacts` has to read the same `CLAUDE_CONFIG_DIR`
   * the child did: reporting a path computed from the host's own environment
   * points at a transcript that is not there.
   */
  const childEnv
    = start.env !== undefined ? { ...procEnv, ...start.env } : procEnv

  const q = query({
    prompt: queryInput.input,
    options: {
      ...(start.model ? { model: start.model } : {}),
      ...(start.maxTurns !== undefined ? { maxTurns: start.maxTurns } : {}),
      // See `childEnv` above: only set when the Worker asked, already merged.
      ...(start.env !== undefined ? { env: childEnv } : {}),
      // SDK options the Worker owns; each is forwarded verbatim.
      ...(start.settingSources !== undefined
        ? { settingSources: start.settingSources }
        : {}),
      ...(start.persistSession !== undefined
        ? { persistSession: start.persistSession }
        : {}),
      ...(start.pathToClaudeCodeExecutable !== undefined
        ? { pathToClaudeCodeExecutable: start.pathToClaudeCodeExecutable }
        : {}),
      ...(start.maxBudgetUsd !== undefined
        ? { maxBudgetUsd: start.maxBudgetUsd }
        : {}),
      ...(start.sessionId !== undefined ? { sessionId: start.sessionId } : {}),
      ...(start.resume !== undefined ? { resume: start.resume } : {}),
      ...(skillsOption ? { skills: skillsOption } : {}),
      ...(nativeTools !== undefined ? { tools: nativeTools } : {}),
      ...(inactiveNativeTools.length > 0
        ? { disallowedTools: inactiveNativeTools }
        : {}),
      systemPrompt: createClaudeCodeSystemPrompt(start.instructions),
      thinking: start.thinking,
      ...(start.effort !== undefined ? { effort: start.effort } : {}),
      ...(start.responseFormat?.type === 'json'
        && start.responseFormat.schema != null
        ? {
            outputFormat: {
              type: 'json_schema' as const,
              schema: start.responseFormat.schema,
            },
          }
        : {}),
      includePartialMessages: start.emitDeltas ?? true,
      hooks: {
        /*
         * The layer that actually binds. The SDK evaluates hooks → deny rules
         * → ask rules → mode → allow rules → `canUseTool`, and this deployment
         * runs with the mode stage allowing everything, so a refuse list on
         * `canUseTool` alone would never be reached. Returning `undefined`
         * here — no decision — leaves the call to the normal pipeline.
         */
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const call = input as {
                  tool_name?: string
                  tool_input?: unknown
                }
                if (typeof call.tool_name !== 'string') {
                  return {}
                }
                const outcome = evaluatePreToolUse({
                  toolName: call.tool_name,
                  toolInput: call.tool_input,
                })
                if (outcome === undefined) {
                  return {}
                }
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse' as const,
                    permissionDecision: outcome.permissionDecision,
                    permissionDecisionReason: outcome.permissionDecisionReason,
                  },
                }
              },
            ],
          },
        ],
        // The `PostCompact` hook carries the compaction summary, which the
        // `compact_boundary` system message does not. Latch it for the unified
        // `compaction` event; return an empty output so compaction proceeds.
        PostCompact: [
          {
            hooks: [
              async (input) => {
                const summary = (input as { compact_summary?: unknown })
                  .compact_summary
                if (typeof summary === 'string') {
                  compaction.onSummary(summary)
                }
                return {}
              },
            ],
          },
        ],
      },
      /*
       * Continuation rule: the host can force-continue (resume after a
       * cross-process detach) by setting `start.continue: true`; otherwise we
       * continue every subsequent turn after the first one in this bridge
       * process. An explicit `start.resume` suppresses all of that — the SDK
       * documents `continue` and `resume` as mutually exclusive, so sending
       * both fails the query at startup, and a reused bridge would break every
       * resume it was asked for.
       */
      ...(start.resume === undefined
        && (start.continue === true || !turn.firstTurn)
        ? { continue: true }
        : {}),
      ...permissionOptions,
      // The Worker forwards MCP server configs verbatim; the host does not
      // model the SDK's config union, it only carries it across the wire.
      mcpServers: mcpServers as Options['mcpServers'],
      cwd: workdir,
      // `abortController`, not `abortSignal`: upstream passes the latter
      // through an `any` cast, and the SDK has no such option — so upstream's
      // abort never reaches the CLI child. The real types caught it.
      abortController: abortCtl,
    },
  })
  /*
   * A stop is an interrupt, not a kill: `query.interrupt()` asks the CLI to
   * wind the turn down, and the SDK then yields a normal `result` with
   * `terminal_reason: 'aborted_streaming'` (or `'aborted_tools'`). That is the
   * whole point of hosting the SDK — a `process.kill` answers with exit 143
   * and no result at all.
   *
   * Escalation, in the host so it happens even with no socket attached: if no
   * result arrives within the grace, abort the controller — which tears down
   * the CLI child — report the run phase, and exit non-zero so the Worker's
   * own SIGTERM path takes over from a known state.
   */
  let interruptRequested = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  turn.onInterrupt((reason) => {
    if (interruptRequested) {
      return
    }
    interruptRequested = true
    void Promise.resolve(q.interrupt()).catch((err) => {
      turn.emitWarning({ message: `interrupt (${reason}) failed: ${String(err)}` })
    })
    escalation = setTimeout(() => {
      emit({
        type: 'error',
        phase: 'run',
        error: `no result within ${graceMs}ms of interrupt (${reason})`,
      })
      abortCtl.abort()
      void turn.flush().finally(() => exitProcess(1))
    }, graceMs)
    escalation.unref?.()
  })

  // Reported on `finish` as `sessionArtifacts` / `stopped`. `session_id` and
  // `cwd` come off `system`/`init`; the Worker takes the paths as given.
  let sessionId: string | undefined
  let sessionCwd = workdir
  let terminalReason: string | undefined

  let turnUsage: Record<string, unknown> | undefined
  let totalCostUsd: number | undefined
  let initCheckFailed = false
  let emittedTerminalError = false
  let emittedTerminalFinish = false

  const emitTerminalError = (message: string | undefined): void => {
    const normalized = message?.trim()
    if (!normalized || emittedTerminalError || emittedTerminalFinish) {
      return
    }
    streamEventState.observedTerminalError = normalized
    emittedTerminalError = true
    turn.emitError({
      error: normalized,
      message: 'claude-code terminal error',
      phase: 'run',
    })
    queryInput.close()
    abortCtl.abort()
  }

  const emitStreamEvent = createEmitStreamEvent({
    state: streamEventState,
    emit,
    emitWarning: turn.emitWarning,
    emitTerminalError,
    onCompactionBoundary: boundary => compaction.onBoundary(boundary),
    toCommonName,
  })

  try {
    for await (const msg of q as AsyncIterable<ClaudeMessage>) {
      if (abortCtl.signal.aborted) {
        break
      }

      const type = msg.type

      if (type === 'command_lifecycle') {
        queryInput.handleLifecycle(msg)
      }

      /*
       * The SDK's messages ARE the CLI's `--output-format stream-json` lines,
       * so forwarding each one verbatim re-emits the same NDJSON the Worker
       * decodes today — the least-churn wire the ADR asked for. It goes out
       * ahead of the harness parts derived from the same message, so a
       * consumer reading only `raw` sees the transcript in the CLI's own
       * order. `stream_event` is excluded: those are token deltas, and the
       * harness already renders them as text/reasoning parts.
       */
      if (type === 'system' && msg.subtype === 'init') {
        const init = msg as ClaudeMessage & { session_id?: string, cwd?: string }
        if (typeof init.session_id === 'string') {
          sessionId = init.session_id
        }
        if (typeof init.cwd === 'string') {
          sessionCwd = init.cwd
        }
      }

      if (type === 'result') {
        terminalReason = (msg as ClaudeMessage & { terminal_reason?: string })
          .terminal_reason
      }

      if (type !== 'stream_event') {
        emit({ type: 'raw', rawValue: msg })
      }

      derivedFromStreamEvent = type === 'stream_event'
      emitStreamEvent(msg)
      derivedFromStreamEvent = false

      /*
       * A routed turn that silently ran unrouted is the one outcome worse than
       * stopping: the prompt named a slash command, the plugin did not load,
       * and the agent answers the raw text as if it were a request. `init`
       * reports what the CLI resolved, so check it before a token is spent.
       */
      if (type === 'system' && msg.subtype === 'init') {
        const routed = routedCommandName(start.prompt)
        const available
          = (msg as ClaudeMessage & { slash_commands?: string[] })
            .slash_commands ?? []
        if (
          routed !== undefined
          && !available.includes(routed)
          && !available.includes(`/${routed}`)
        ) {
          emit({
            type: 'error',
            phase: 'init',
            error: `routed command ${routed} is not available; slash_commands=[${available.join(', ')}]`,
          })
          initCheckFailed = true
          queryInput.close()
          abortCtl.abort()
          break
        }
      }

      if (type === 'result') {
        if (msg.subtype === 'success') {
          const emptyResult = !msg.result?.trim?.()
          if (emptyResult && streamEventState.observedTerminalError) {
            emitTerminalError(streamEventState.observedTerminalError)
            continue
          }
          const usage = msg.usage ?? msg.message?.usage
          const harnessUsage = mapUsage(usage)
          if (harnessUsage) {
            turnUsage = addUsage(turnUsage, harnessUsage)
          }
          if (typeof msg.total_cost_usd === 'number') {
            totalCostUsd = (totalCostUsd ?? 0) + msg.total_cost_usd
          }
          if (
            start.responseFormat?.type === 'json'
            && msg.structured_output !== undefined
          ) {
            const id = randomUUID()
            emit({ type: 'text-start', id })
            emit({
              type: 'text-delta',
              id,
              delta: JSON.stringify(msg.structured_output),
            })
            emit({ type: 'text-end', id })
            streamEventState.stepOpen = true
          }
          if (streamEventState.stepOpen) {
            emitFinishStep({
              state: streamEventState,
              emit,
              usage: streamEventState.pendingStepUsage ?? harnessUsage,
            })
          }
          queryInput.observeResult()
          if (!queryInput.hasActiveUserMessages()) {
            queryInput.close()
            break
          }
        }
        else {
          emitTerminalError(
            (Array.isArray(msg.errors) ? msg.errors.join('\n') : undefined)
            || streamEventState.observedTerminalError
            || msg.result
            || 'Unknown error',
          )
        }
        continue
      }

      if (queryInput.hasObservedResult && !queryInput.hasActiveUserMessages()) {
        queryInput.close()
        break
      }
    }
  }
  catch (err) {
    /*
     * An abort is never the SDK's own failure: every `abortCtl.abort()` in this
     * file is one this host asked for, and each has already said what happened
     * — the interrupt escalation emits its `no result within …` error, a
     * terminal error emits its own, the routed-command check emits an `init`
     * error, and a host `abort` frame is a deliberate teardown the Worker
     * asked for. The rejection that follows is the abort landing, so reporting
     * it again as `claude-code turn failed` is a second, wrong explanation.
     */
    if (!abortCtl.signal.aborted) {
      turn.emitError({
        error: err,
        message: 'claude-code turn failed',
        phase: 'run',
      })
    }
    return
  }
  finally {
    // The turn produced its result (or died trying): the escalation has
    // nothing left to escalate.
    if (escalation !== undefined) {
      clearTimeout(escalation)
    }
    queryInput.close()
  }

  if (initCheckFailed || emittedTerminalError) {
    return
  }
  emittedTerminalFinish = true
  void emittedTerminalFinish
  /*
   * An interrupt the CLI answered without a `terminal_reason` still ended the
   * turn early — say so rather than calling it complete.
   */
  const mappedStop = stoppedFromTerminalReason(terminalReason)
  const stopped
    = mappedStop === 'completed' && interruptRequested ? 'interrupted' : mappedStop

  emit({
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    totalUsage: turnUsage ?? streamEventState.stepUsage ?? defaultUsage(),
    stopped,
    /*
     * Both paths are reported as the child would see them. The transcript is
     * resolved against `childEnv`, not the host's environment, because a
     * `start.env.CLAUDE_CONFIG_DIR` moves the CLI's `projects/` tree; and it is
     * omitted under `persistSession: false`, where the SDK writes no session
     * file at all and any path would name a transcript that does not exist.
     */
    sessionArtifacts: {
      sessionTranscriptPath:
        sessionId === undefined || start.persistSession === false
          ? undefined
          : sessionTranscriptPath({
              cwd: sessionCwd,
              sessionId,
              env: childEnv,
            }),
      journalPath: turn.journalPath,
    },
    ...(totalCostUsd !== undefined
      ? { harnessMetadata: { 'claude-code': { costUsd: totalCostUsd } } }
      : {}),
  })
}

function createQueryInput({
  initialUserMessage,
  userMessages,
  abortSignal,
}: {
  initialUserMessage: string
  userMessages: Experimental_BridgeUserMessageQueue
  abortSignal: AbortSignal
}): {
  input: AsyncIterable<SDKUserMessage>
  close: (error?: unknown) => void
  handleLifecycle: (message: ClaudeMessage) => void
  hasActiveUserMessages: () => boolean
  observeResult: () => void
  readonly hasObservedResult: boolean
} {
  let closed = false
  let observedResult = false
  const submittedMessages = new Map<string, Experimental_BridgeUserMessage>()
  const close = (error?: unknown): void => {
    if (closed) {
      return
    }
    closed = true
    userMessages.close(error)
  }
  if (abortSignal.aborted) {
    close(abortSignal.reason)
  }
  else {
    abortSignal.addEventListener('abort', () => close(abortSignal.reason), {
      once: true,
    })
  }

  const toUserMessage = (options: {
    text: string
    messageId: string
    priority?: 'next'
  }): SDKUserMessage => ({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: options.text }],
    },
    parent_tool_use_id: null,
    // The SDK brands `uuid` as a UUID string. Message ids come off the wire
    // (or from `randomUUID()` for the initial prompt); the CLI only correlates
    // them, so carry whatever the Worker sent.
    uuid: options.messageId as SDKUserMessage['uuid'],
    ...(options.priority == null ? {} : { priority: options.priority }),
  })

  const messageIterator = userMessages[Symbol.asyncIterator]()

  return {
    close,
    handleLifecycle: (message) => {
      const lifecycle = message as ClaudeMessage & {
        command_uuid?: string
        state?: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded'
      }
      if (lifecycle.command_uuid == null || lifecycle.state == null) {
        return
      }
      const submitted = submittedMessages.get(lifecycle.command_uuid)
      if (submitted == null) {
        return
      }
      if (lifecycle.state === 'queued' || lifecycle.state === 'started') {
        submitted.accept()
        return
      }
      if (lifecycle.state === 'cancelled' || lifecycle.state === 'discarded') {
        submitted.reject(
          new Error(`Claude Code ${lifecycle.state} the user message.`),
        )
      }
      submittedMessages.delete(lifecycle.command_uuid)
    },
    hasActiveUserMessages: () =>
      submittedMessages.size > 0 || userMessages.pendingCount > 0,
    observeResult: () => {
      observedResult = true
    },
    get hasObservedResult() {
      return observedResult
    },
    input: {
      [Symbol.asyncIterator]() {
        let sentInitial = false
        return {
          async next() {
            if (closed || abortSignal.aborted) {
              return {
                value: undefined,
                done: true,
              } as IteratorResult<SDKUserMessage>
            }
            if (!sentInitial) {
              sentInitial = true
              return {
                value: toUserMessage({
                  text: initialUserMessage,
                  messageId: randomUUID(),
                }),
                done: false,
              }
            }
            const nextMessage = await messageIterator.next()
            if (nextMessage.done) {
              return {
                value: undefined,
                done: true,
              } as IteratorResult<SDKUserMessage>
            }
            submittedMessages.set(
              nextMessage.value.messageId,
              nextMessage.value,
            )
            return {
              value: toUserMessage({
                text: nextMessage.value.text,
                messageId: nextMessage.value.messageId,
                priority: 'next',
              }),
              done: false,
            }
          },
        }
      },
    },
  }
}

function addUsage(
  total: Record<string, unknown> | undefined,
  usage: Record<string, unknown>,
): Record<string, unknown> {
  if (total == null) {
    return usage
  }
  const result: Record<string, unknown> = { ...total }
  for (const [key, value] of Object.entries(usage)) {
    const previous = result[key]
    if (typeof value === 'number' && typeof previous === 'number') {
      result[key] = previous + value
    }
    else if (
      value != null
      && previous != null
      && typeof value === 'object'
      && typeof previous === 'object'
      && !Array.isArray(value)
      && !Array.isArray(previous)
    ) {
      result[key] = addUsage(
        previous as Record<string, unknown>,
        value as Record<string, unknown>,
      )
    }
    else {
      result[key] = value
    }
  }
  return result
}
