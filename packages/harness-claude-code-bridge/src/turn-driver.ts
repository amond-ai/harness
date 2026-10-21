// Long-running bridge that runs inside a sandbox alongside the `claude` CLI.
// The generic transport — WebSocket server, token auth, single-flight
// reconnect, the in-memory event log + `seq`, resume replay, and the
// lifecycle/meta files — lives in the shared bridge runtime. This file supplies
// only the Claude-specific turn driver.
//
// The Agent SDK is a type-only import here: `query()` arrives through
// `createTurnDriver`, so a test can drive the whole driver against a scripted
// fake and `main.ts` stays the one module that loads the real SDK.

import type { BridgeEvent, BridgeTurn, Experimental_BridgeUserMessage, Experimental_BridgeUserMessageQueue, InterruptReason } from '@amond-ai/harness-bridge-runtime'
import type { SdkPermissionMode, StartMessage } from '@amond-ai/harness-protocol/claude-code'
import type { HookCallback, HookJSONOutput, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeMessage } from './create-emit-stream-event'
import { randomUUID } from 'node:crypto'
import { exit, env as procEnv } from 'node:process'
import { harnessV1QuestionsToolOutputSchema, sdkPermissionModeSchema, startMessageSchema } from '@amond-ai/harness-protocol/claude-code'
import { z } from 'zod/v4'

import { createClaudeCodeSystemPrompt } from './claude-code-system-prompt'
import { toClaudeSkillsOption } from './claude-skills-option'
import { createCompactionLatch } from './compaction-latch'
import {
  createClaudeStreamEventState,
  createEmitStreamEvent,
  defaultUsage,
  emitFinishStep,
  finishApprovalStep,
  isExternalMcpTool,
  mapUsage,
} from './create-emit-stream-event'
import {
  createPreToolUseEvaluator,
  DENY_BY_RUN_POLICY_MESSAGE,
} from './permission-policy'
import {
  claudeCodeQuestionKey,
  toClaudeCodeQuestionResult,
  toHarnessQuestionsInput,
} from './question-tool'
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
    | 'askUserQuestions'

const NATIVE_TO_COMMON: Readonly<Record<string, CommonBuiltinToolName>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebSearch: 'webSearch',
  AskUserQuestion: 'askUserQuestions',
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
  ListAgents: 'readonly',
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
  /**
   * How long a host `abort` waits on the graceful `interrupt()` before it
   * aborts the query outright. Defaults to upstream's five seconds; a test
   * passes a short one so the fallback is observable.
   */
  abortFallbackMs?: number
}

/** Grace the host gives `interrupt()` to produce a `result`. */
const DEFAULT_INTERRUPT_GRACE_MS = 30_000

/*
 * Upstream's hard-abort fallback, not `interruptGraceMs`: the bridge runtime
 * fences a replacement `start` on this turn's teardown for ten seconds
 * (`turnTeardownGraceMs`), and the interrupt grace — 30 s by default — would
 * outlast that fence, so a retry after an abort would be refused rather than
 * run.
 */
const DEFAULT_ABORT_FALLBACK_MS = 5_000

/** The `onStart` the bridge runtime drives a turn with, and the `onStop` it answers `stop` with. */
export type TurnDriver = ((start: StartMessage, turn: BridgeTurn) => Promise<void>) & {
  /**
   * The resume payload for `bridge-stop`: the exact conversation the last
   * turn belonged to, so a later resume does not have to fall back to "most
   * recent in this workdir". Empty before any turn reported a session.
   */
  onStop: () => { claudeSessionId?: string }
}

/**
 * What one bridge process remembers across its turns — upstream keeps it at
 * module level; here it lives in the driver's closure (patch 2).
 */
interface DriverSession {
  /**
   * The Claude session id most recently reported by the SDK, captured from
   * the message stream. Every turn may fork a new id (the SDK's `continue` and
   * `resume` create a new session linked to the previous one), so the latest
   * observation is the one a later resume must name.
   */
  lastClaudeSessionId?: string
}

/**
 * Build the `onStart` the bridge runtime drives one turn with. Everything the
 * driver needs beyond the `start` frame is closed over here, so the module has
 * no module-level state and no import of the real SDK.
 */
export function createTurnDriver(
  driverOptions: TurnDriverOptions,
): TurnDriver {
  const session: DriverSession = {}
  const onStart = (start: StartMessage, turn: BridgeTurn): Promise<void> =>
    runTurn({ startFrame: start, turn, driverOptions, session })
  return Object.assign(onStart, {
    onStop: () =>
      session.lastClaudeSessionId === undefined
        ? {}
        : { claudeSessionId: session.lastClaudeSessionId },
  })
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
  /** Calls the `PreToolUse` hook already reported; their approval reuses that `tool-call`. */
  reportedToolCallIds: ReadonlySet<string>
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
    // A question the hook could not forward was reported there, and then left
    // to the pipeline that brought it here: one native call, one `tool-call`.
    if (!input.reportedToolCallIds.has(approvalId)) {
      input.emit({
        type: 'tool-call',
        toolCallId: approvalId,
        toolName: toCommonName(toolName),
        nativeName: toolName,
        input: JSON.stringify(toolInput ?? {}),
        providerExecuted: true,
        ...(isExternalMcpTool(toolName) ? { dynamic: true } : {}),
      })
    }
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

/*
 * What a bypassing turn adds, from upstream: no `canUseTool` — the bypass
 * guarantees the SDK never invokes it — and the `stdio` prompt tool, because
 * Claude Code exposes `AskUserQuestion` in a headless SDK session only when a
 * permission prompt tool is configured. The run's own posture is unaffected:
 * refuse, defer and the replayed answers live in the `PreToolUse` hook, which
 * runs before the permission mode is consulted (`permission-policy.ts`).
 */
const BYPASS_PERMISSION_OPTIONS = { permissionPromptToolName: 'stdio' } as const

function createPermissionOptions(input: {
  start: StartMessage
  inactiveNativeTools: readonly string[]
  turn: BridgeTurn
  emit: Emit
  finishApprovalStep: (approvalId: string) => void
  nativeToolCallNames: Map<string, string>
  approvalRequestedToolUseIds: Set<string>
  reportedToolCallIds: ReadonlySet<string>
}): Record<string, unknown> {
  const requestedMode = input.start.permissionMode ?? 'allow-all'
  const resolveApproval = createApprovalResolver({
    approvalPolicy: input.start.approvalPolicy ?? 'deny',
    turn: input.turn,
    emit: input.emit,
    finishApprovalStep: input.finishApprovalStep,
    nativeToolCallNames: input.nativeToolCallNames,
    approvalRequestedToolUseIds: input.approvalRequestedToolUseIds,
    reportedToolCallIds: input.reportedToolCallIds,
  })

  /*
   * The Worker sends the SDK's own mode. Pass it straight through — the run's
   * posture is the Worker's call, and re-deriving it from the harness trio
   * would silently narrow `plan` or `dontAsk` to something else.
   * `bypassPermissions` needs its companion flag or the CLI refuses it, and
   * gets the bypass shape upstream gives `allow-all` below.
   */
  if (isSdkPermissionMode(requestedMode)) {
    const bypassing = requestedMode === 'bypassPermissions'
    return {
      permissionMode: requestedMode,
      allowDangerouslySkipPermissions: bypassing,
      ...(bypassing
        ? BYPASS_PERMISSION_OPTIONS
        : {
            canUseTool: (
              toolName: string,
              toolInput: Record<string, unknown>,
              options: { toolUseID: string },
            ) => resolveApproval(toolName, toolInput, options.toolUseID),
          }),
    }
  }

  const permissionMode: HarnessPermissionMode = requestedMode
  const inactiveNativeTools = new Set(input.inactiveNativeTools)
  const permissionSettings = createPermissionSettings({
    permissionMode,
    inactiveNativeTools,
  })

  const baseOptions = {
    permissionMode:
      permissionMode === 'allow-all'
        ? 'bypassPermissions'
        : permissionMode === 'allow-edits'
          ? 'acceptEdits'
          : 'default',
    allowDangerouslySkipPermissions: permissionMode === 'allow-all',
    ...(permissionSettings ? { settings: permissionSettings } : {}),
  }

  if (permissionMode === 'allow-all') {
    return { ...baseOptions, ...BYPASS_PERMISSION_OPTIONS }
  }

  return {
    ...baseOptions,
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

/**
 * Whether a question call is one the host can be asked to answer. The tool
 * input is the model's JSON, so this checks the shape `toHarnessQuestionsInput`
 * reads — a non-empty list of objects with a string `question` and, when
 * present, `options` that are objects with a string `label` — and the type of
 * every optional field it copies (`header`, `multiSelect`, an option's
 * `description` and `preview`), so what goes to the host is what
 * `harnessV1QuestionsToolInputSchema` accepts. Anything else is left to the
 * CLI's own input validation.
 */
function isForwardableQuestionInput(
  nativeInput: unknown,
): nativeInput is Parameters<typeof toHarnessQuestionsInput>[0] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null
  const isOptionalString = (value: unknown): boolean =>
    value === undefined || typeof value === 'string'
  const questions = isObject(nativeInput) ? nativeInput.questions : undefined
  return (
    Array.isArray(questions)
    && questions.length > 0
    && questions.every(
      question => isObject(question)
        && typeof question.question === 'string'
        && question.question !== ''
        && isOptionalString(question.header)
        && (question.multiSelect === undefined
          || typeof question.multiSelect === 'boolean')
        && (question.options === undefined
          || (Array.isArray(question.options)
            && question.options.every(
              option => isObject(option)
                && typeof option.label === 'string'
                && option.label !== ''
                && isOptionalString(option.description)
                && isOptionalString(option.preview),
            ))),
    )
  )
}

/**
 * The native result of a question the host answered. An error result is no
 * answer: the bridge settles a request the turn ended under that way, and a
 * host's own error carries no `answers`. A result is untrusted JSON off the
 * socket, so one the questions-tool schema refuses is no answer either.
 */
function toNativeQuestionResult(input: {
  result: { output: unknown, isError?: boolean }
  nativeInput: Parameters<typeof toHarnessQuestionsInput>[0]
  toolCallId: string
}): ReturnType<typeof toClaudeCodeQuestionResult> {
  const { result } = input
  const output = result.isError === true
    ? undefined
    : harnessV1QuestionsToolOutputSchema.safeParse(result.output)
  if (output?.success === true) {
    return toClaudeCodeQuestionResult({
      nativeInput: input.nativeInput,
      output: output.data,
    })
  }
  if (output?.success === false) {
    // The model only sees the generic deny reason; the bridge forwards console output as `sandbox-log` frames.
    console.warn(
      `AskUserQuestion result refused (${input.toolCallId}): ${z.prettifyError(output.error)}`,
    )
  }
  return {
    behavior: 'deny',
    message: result.isError === true && typeof result.output === 'string'
      ? result.output
      : 'The questions were not answered.',
  }
}

/**
 * Upstream's question flow: ask the host to answer an `AskUserQuestion` call
 * as a host-executed tool, and run the call with the answers it sent back.
 * Parks the CLI on `requestToolResult` until the host answers, so the driver
 * only runs it where nothing else has decided the call (see the `PreToolUse`
 * hook in `runTurn`).
 */
function createQuestionPreToolUseHook(input: {
  turn: BridgeTurn
  emit: Emit
  nativeToolCallNames: Map<string, string>
}): HookCallback {
  return async (hookInput, toolUseID): Promise<HookJSONOutput> => {
    if (
      hookInput.hook_event_name !== 'PreToolUse'
      || hookInput.tool_name !== 'AskUserQuestion'
    ) {
      return {}
    }

    const nativeInput: unknown = hookInput.tool_input
    if (!isForwardableQuestionInput(nativeInput)) {
      return {}
    }
    const canonicalInput = toHarnessQuestionsInput(nativeInput)
    const toolCallId = toolUseID ?? hookInput.tool_use_id
    input.nativeToolCallNames.set(toolCallId, hookInput.tool_name)
    input.emit({
      type: 'tool-call',
      toolCallId,
      toolName: 'askUserQuestions',
      nativeName: hookInput.tool_name,
      input: JSON.stringify(canonicalInput),
      providerExecuted: false,
      providerMetadata: {
        'claude-code': {
          nativeRequest: nativeInput,
        },
      },
    })

    const questionKey = claudeCodeQuestionKey(nativeInput)
    const result = await input.turn.requestToolResult({
      toolCallId,
      matches: (candidate) => {
        const nativeRequest = candidate.toolResult?.providerOptions?.[
          'claude-code'
        ]?.nativeRequest as
        | Parameters<typeof claudeCodeQuestionKey>[0]
        | undefined
        return (
          nativeRequest != null
          && claudeCodeQuestionKey(nativeRequest) === questionKey
        )
      },
    })
    const nativeResult = toNativeQuestionResult({
      result,
      nativeInput,
      toolCallId,
    })

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        ...(nativeResult.behavior === 'allow'
          ? {
              permissionDecision: 'allow',
              updatedInput: {
                ...nativeResult.updatedInput,
              } as Record<string, unknown>,
            }
          : {
              permissionDecision: 'deny',
              permissionDecisionReason: nativeResult.message,
            }),
      },
    }
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

async function runTurn({
  startFrame,
  turn,
  driverOptions,
  session,
}: {
  startFrame: StartMessage
  turn: BridgeTurn
  driverOptions: TurnDriverOptions
  session: DriverSession
}): Promise<void> {
  const { query, workdir } = driverOptions
  const exitProcess = driverOptions.exit ?? exit
  const graceMs = startFrame.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS
  /*
   * Frames derived from a `stream_event` SDK message — the text/reasoning
   * deltas, the tool input, and their start/end — are liveness, not
   * transcript: they are sent if a socket is attached and take a `seq`, but
   * they are not journaled and not replayed. `emitStreamEvent` has no way to
   * say so itself, so the loop raises this flag around the one call that can
   * produce them.
   *
   * A `raw` frame is never live-only, even one built from a `stream_event`
   * (the `message_stop` that carries a response's usage): a client's live
   * mirror appends every `raw` it receives, and the transcript it rebuilds
   * from the journal must hold the same lines.
   *
   * Nor is a `finish-step`: it is a step's structure, not liveness. The
   * response's `message_stop` closes a tool step whose results arrived while
   * it streamed, and a transcript rebuilt from the journal without that
   * `finish-step` would hold a step that never ends.
   */
  let derivedFromStreamEvent = false
  const emit: Emit = msg =>
    turn.emit(
      msg as BridgeEvent,
      derivedFromStreamEvent && msg.type !== 'raw' && msg.type !== 'finish-step'
        ? { journal: false }
        : undefined,
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
  /*
   * `resume` is this host's name for the exact session to resume and
   * `resumeSessionId` upstream's; either one names it. Two different names
   * are a client fault, not a choice to make on its behalf.
   */
  if (
    start.resume !== undefined
    && start.resumeSessionId !== undefined
    && start.resume !== start.resumeSessionId
  ) {
    emit({
      type: 'error',
      phase: 'start',
      error: `start.resume (${start.resume}) and start.resumeSessionId (${start.resumeSessionId}) name different sessions`,
    })
    return
  }
  const resumeSessionId = start.resumeSessionId ?? start.resume
  /*
   * The SDK documents `sessionId` as exclusive of `resume` (and `continue`):
   * `sessionId` opens a fresh session under that id, a resume name picks an
   * existing one. Refuse the combination rather than hand it to `query()`.
   */
  if (start.sessionId !== undefined && resumeSessionId !== undefined) {
    emit({
      type: 'error',
      phase: 'start',
      error: 'start.sessionId cannot be combined with start.resume or start.resumeSessionId',
    })
    return
  }
  /*
   * Without a named session a turn after the first stays pinned to the one
   * this bridge last observed, rather than whatever `continue` would resolve
   * to — upstream's rule. Read before the query starts: its own messages move
   * the observation on.
   *
   * A `start.sessionId` with no resume name opens a fresh session under that
   * id, so it takes neither the pin nor `continue`: the SDK documents
   * `sessionId` as exclusive of both, and the host must not build that
   * combination itself. Upstream has no `sessionId` option.
   */
  const freshNamedSession = start.sessionId !== undefined && resumeSessionId === undefined
  const resumeTarget = freshNamedSession
    ? undefined
    : resumeSessionId ?? session.lastClaudeSessionId

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
  // A host abort prefers the SDK's graceful `interrupt()` — Esc semantics: the
  // in-flight turn is persisted to the session transcript and settles with an
  // interrupted result, so a later resume still sees the work done before the
  // abort. The hard abort kills the CLI process and loses that turn's records,
  // so it is only the fallback — armed unconditionally, because aborting an
  // already-settled query is a no-op — and the immediate path when the abort
  // arrives before the query exists.
  let gracefulAbort: (() => void) | undefined
  let hardAbortTimer: ReturnType<typeof setTimeout> | undefined
  const onHostAbort = (): void => {
    if (gracefulAbort) {
      gracefulAbort()
    }
    else {
      abortCtl.abort()
    }
  }
  if (turn.abortSignal.aborted) {
    abortCtl.abort()
  }
  else {
    turn.abortSignal.addEventListener('abort', onHostAbort, { once: true })
  }

  const streamEventState = createClaudeStreamEventState()

  const mcpServers: Record<string, unknown> = { ...(start.mcpServers ?? {}) }

  // Compaction observation: merge Claude's `compact_boundary` message and
  // `PostCompact` hook (which arrive in either order) into one `compaction`
  // event. See `createCompactionLatch`.
  const compaction = createCompactionLatch((event) => {
    const hasOpenStep = streamEventState.stepOpen
    emit(event)
    // The harness translates compaction into synthetic step content. When
    // Claude reports it outside a model step, close that synthetic step here;
    // otherwise the existing model step will close it with its own usage.
    if (!hasOpenStep) {
      emitFinishStep({
        state: streamEventState,
        emit,
        usage: undefined,
      })
    }
  })

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
    deniedRequests: start.deniedRequests,
  })
  const questionPreToolUseHook = createQuestionPreToolUseHook({
    turn,
    emit,
    nativeToolCallNames: streamEventState.nativeToolCallNames,
  })
  /*
   * The host answers a question itself only when the run forwards decisions
   * to it. Under `approvalPolicy: 'deny'` nobody is there to answer, and a
   * parked CLI is a turn that never ends.
   */
  const hostAnswersQuestions = (start.approvalPolicy ?? 'deny') === 'forward'
  /*
   * The tool-call of a question the host is not asked to answer. The stream
   * mapper leaves every `AskUserQuestion` call to this hook (upstream emits it
   * only from the question flow), so a question the run policy decided —
   * deferred, answered by a replayed approval, refused — would otherwise
   * reach the client as a result with no call.
   */
  const runtimeQuestionCallIds = new Set<string>()
  const emitRuntimeQuestionCall = (call: {
    toolName: string
    toolInput: unknown
    toolCallId: string | undefined
  }): void => {
    if (call.toolName !== 'AskUserQuestion' || call.toolCallId === undefined) {
      return
    }
    runtimeQuestionCallIds.add(call.toolCallId)
    emit({
      type: 'tool-call',
      toolCallId: call.toolCallId,
      toolName: toCommonName(call.toolName),
      nativeName: call.toolName,
      input: JSON.stringify(call.toolInput ?? {}),
      providerExecuted: true,
    })
  }
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
    reportedToolCallIds: runtimeQuestionCallIds,
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

  // Reported on `finish` as `sessionArtifacts` / `stopped`. `session_id` and
  // `cwd` come off `system`/`init`; the Worker takes the paths as given.
  //
  // Declared here rather than beside the loop that fills them because the
  // error paths below report them too, and one of those — the interrupt
  // escalation — is installed before the loop runs.
  let sessionId: string | undefined
  let sessionCwd = workdir
  let terminalReason: string | undefined
  /*
   * The call a deferred turn stopped on, lifted off the SDK's `result` and reported on `finish`.
   *
   * `stopped: 'deferred'` says a decision is owed; this says what it is owed about, and the
   * whole of D6 layer 3 is that an answer authorizes one request rather than the tool. Read
   * here, beside `terminal_reason`, because both come off the same message.
   */
  let deferredToolUse: Record<string, unknown> | undefined

  /*
   * The two files this turn leaves behind, as they stand right now.
   *
   * Reported on every terminal frame this host can send, not only on `finish`.
   * A run-phase `error` is the ordinary way a turn fails, and by then
   * `system`/`init` has long since named a session — so a client that retries
   * needs exactly these paths, and a frame that withheld them would make a
   * failed attempt the one case whose session cannot be preserved.
   *
   * Both paths are reported as the child would see them. The transcript is
   * resolved against `childEnv`, not the host's environment, because a
   * `start.env.CLAUDE_CONFIG_DIR` moves the CLI's `projects/` tree; and it is
   * omitted under `persistSession: false`, where the SDK writes no session
   * file at all and any path would name a transcript that does not exist.
   */
  const sessionArtifacts = (): {
    sessionId?: string
    sessionTranscriptPath?: string
    journalPath: string
  } => ({
    /*
     * The id itself, not just the file named after it: the Worker resumes
     * with `start.resume`, and reading the id back out of the path would put
     * the `<sessionId>.jsonl` convention on the Worker's side of the split
     * this whole field exists to keep on the host's. Reported whenever the
     * turn learned one, including under `persistSession: false` — the id is
     * what the turn ran as either way, and a caller that means to resume
     * needs the transcript below as well.
     */
    sessionId,
    sessionTranscriptPath:
      sessionId === undefined || start.persistSession === false
        ? undefined
        : sessionTranscriptPath({ cwd: sessionCwd, sessionId, env: childEnv }),
    journalPath: turn.journalPath,
  })

  const q = query({
    prompt: queryInput.input,
    options: {
      ...(start.model ? { model: start.model } : {}),
      ...(start.maxTurns !== undefined ? { maxTurns: start.maxTurns } : {}),
      ...(start.agentProgressSummaries !== undefined
        ? { agentProgressSummaries: start.agentProgressSummaries }
        : {}),
      ...(start.forwardSubagentText !== undefined
        ? { forwardSubagentText: start.forwardSubagentText }
        : {}),
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
         *
         * One hook, not upstream's separate `AskUserQuestion` matcher: the SDK
         * runs the hooks of every matching entry in parallel, so two entries
         * would let the question flow park the CLI on a host answer for a
         * call the run policy had already deferred. Here the order is the
         * code's: the policy decides first — a replayed denial or approval,
         * `refuseTools`, `deferTools` — and only a question none of that
         * decided, under `approvalPolicy: 'forward'`, goes to the host.
         */
        PreToolUse: [
          {
            hooks: [
              async (input, toolUseID, hookOptions) => {
                const call = input as {
                  tool_name?: string
                  tool_input?: unknown
                  tool_use_id?: string
                }
                if (typeof call.tool_name !== 'string') {
                  return {}
                }
                const outcome = evaluatePreToolUse({
                  toolName: call.tool_name,
                  toolInput: call.tool_input,
                })
                if (outcome === undefined) {
                  /*
                   * A question the host cannot be asked (malformed input) takes the
                   * runtime-call path below, so its result never lacks a call.
                   */
                  if (
                    call.tool_name === 'AskUserQuestion'
                    && hostAnswersQuestions
                    && isForwardableQuestionInput(call.tool_input)
                  ) {
                    return questionPreToolUseHook(input, toolUseID, hookOptions)
                  }
                  emitRuntimeQuestionCall({
                    toolName: call.tool_name,
                    toolInput: call.tool_input,
                    toolCallId: toolUseID ?? call.tool_use_id,
                  })
                  return {}
                }
                emitRuntimeQuestionCall({
                  toolName: call.tool_name,
                  toolInput: call.tool_input,
                  toolCallId: toolUseID ?? call.tool_use_id,
                })
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
       * Continuation rule, most specific first.
       *
       * A named session (`start.resumeSessionId`, or its alias `start.resume`)
       * is what a cross-process resume should use: `continue` means "most
       * recent thread in this workdir", which silently picks the wrong one
       * once anything else has run there. The bridge also retains the id it
       * observed during its previous query, so every later query stays pinned
       * to that conversation. The SDK documents `continue` and `resume` as
       * mutually exclusive, so either one suppresses `continue`.
       *
       * Otherwise the host can force-continue by setting `start.continue`, and
       * turns after the first fall back to the cwd-based behaviour when no
       * exact id was observed.
       */
      ...(resumeTarget !== undefined
        ? { resume: resumeTarget }
        : !freshNamedSession && (start.continue === true || !turn.firstTurn)
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

  gracefulAbort = () => {
    // Backstop for the whole teardown, not just the interrupt call: if the
    // stream has not settled within the fallback of a graceful interrupt
    // being requested, abort outright. `unref` keeps the timer from pinning
    // the process open on its own.
    hardAbortTimer = setTimeout(
      () => abortCtl.abort(),
      driverOptions.abortFallbackMs ?? DEFAULT_ABORT_FALLBACK_MS,
    )
    hardAbortTimer.unref?.()
    void Promise.resolve()
      .then(() => q.interrupt())
      .catch(() => abortCtl.abort())
  }
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
  /*
   * Background work the turn must outlive. The count is the live set of the last
   * `background_tasks_changed`, which is a level signal: it replaces rather than accumulates, and
   * starts empty because this turn's query is a fresh CLI process. `awaitingBackground` holds
   * from a `result` that left work running until the `result` that ends the turn. That span
   * includes the turn the CLI wakes when the work settles; `backgroundWaitIdle` is the part of it
   * before that turn starts, when the CLI runs no turn at all. Declared ahead of the
   * interrupt handler, which reads them.
   */
  let liveBackgroundTasks = 0
  let awaitingBackground = false
  let backgroundWaitIdle = false
  let interruptRequested = false
  // Remembered rather than only acted on: the ending this host reports echoes the reason back,
  // because the Worker's own memory of the stop it asked for does not survive a step that never
  // committed — and without the echo the ending reads as an unnamed timeout (#388).
  let interruptReason: InterruptReason | undefined
  let escalation: ReturnType<typeof setTimeout> | undefined
  // Declared ahead of the escalation that sets it, which is the first of its writers.
  let emittedTerminalError = false
  turn.onInterrupt((reason) => {
    if (interruptRequested) {
      return
    }
    interruptRequested = true
    interruptReason = reason
    void Promise.resolve(q.interrupt())
      .catch((err) => {
        turn.emitWarning({ message: `interrupt (${reason}) failed: ${String(err)}` })
      })
      .finally(() => {
        /*
         * While the turn waits on background work and the CLI has not yet woken a turn for it,
         * no turn is in flight, and the CLI answers this interrupt with no `result` (as
         * measured on CLI 2.1.289): it only stops the background work. Closing the input once the
         * interrupt has gone out lets the idle CLI exit, which ends the stream, and the turn
         * finishes as `interrupted` instead of escalating. Not before the interrupt settles: it
         * travels over the same stdin. Once the woken turn runs, the interrupt aborts it, and its
         * `result` closes the input as any interrupted turn's does.
         */
        if (backgroundWaitIdle) {
          queryInput.close()
        }
      })
    escalation = setTimeout(() => {
      emit({
        type: 'error',
        phase: 'run',
        error: `no result within ${graceMs}ms of interrupt (${reason})`,
        sessionArtifacts: sessionArtifacts(),
        interruptedBy: reason,
      })
      // This *is* the turn's terminal frame: the loop below unwinds on the abort, and without
      // the flag it would report a second ending — a `finish` — after this `error`.
      emittedTerminalError = true
      abortCtl.abort()
      void turn.flush().finally(() => exitProcess(1))
    }, graceMs)
    escalation.unref?.()
  })

  let turnUsage: Record<string, unknown> | undefined
  let totalCostUsd: number | undefined
  let initCheckFailed = false
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
      sessionArtifacts: sessionArtifacts(),
      // A terminal error that lands during the wind-down is the interrupt's ending as much as
      // the escalation is — a `result` that failed, an auth or retry failure — so it names the
      // stop too, and omits the key on every failure no stop preceded.
      ...(interruptReason === undefined ? {} : { interruptedBy: interruptReason }),
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

      // Every SDK message carries the session id of the conversation it
      // belongs to. Track the latest so the stop payload, the finish
      // metadata and the session artifacts all name the exact conversation:
      // a resume can fork after `init`, and resuming the init id would lose
      // the fork's turns.
      const messageSessionId = (msg as { session_id?: unknown }).session_id
      if (typeof messageSessionId === 'string' && messageSessionId.length > 0) {
        session.lastClaudeSessionId = messageSessionId
        sessionId = messageSessionId
      }

      if (type === 'system' && msg.subtype === 'init') {
        const init = msg as ClaudeMessage & { session_id?: string, cwd?: string }
        if (typeof init.session_id === 'string') {
          sessionId = init.session_id
        }
        if (typeof init.cwd === 'string') {
          sessionCwd = init.cwd
        }
      }

      if (type === 'system' && msg.subtype === 'background_tasks_changed') {
        liveBackgroundTasks = countActiveBackgroundTasks(msg)
      }

      // The main thread speaking again is the woken turn. A background subagent's messages carry
      // its `parent_tool_use_id` and leave the CLI as idle as before.
      if (
        (type === 'assistant' || type === 'user' || type === 'stream_event')
        && (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id == null
      ) {
        backgroundWaitIdle = false
      }

      // `emitStreamEvent` forwards the message itself as a `raw` frame, ahead
      // of the parts it derives from it.
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
        /*
         * A result that answers no message this input sent is not the turn's: it is
         * skipped before its ending, error or usage can count for the turn. It only
         * closes the step it streamed, and drops the error that turn latched. Except
         * while the turn waits on background work (patch 35): the turn the CLI wakes
         * when that work settles answers a `task-notification`, not a sent message, and
         * its result is the one that ends the turn.
         */
        const answersSentMessage = queryInput.answersSentMessage(msg)
        if (!awaitingBackground && !answersSentMessage) {
          if (streamEventState.stepOpen) {
            emitFinishStep({
              state: streamEventState,
              emit,
              usage: streamEventState.pendingStepUsage,
            })
          }
          streamEventState.observedTerminalError = undefined
          continue
        }
        const result = msg as ClaudeMessage & {
          terminal_reason?: string
          deferred_tool_use?: Record<string, unknown>
        }
        terminalReason = result.terminal_reason
        deferredToolUse = result.deferred_tool_use
        if (msg.subtype === 'success') {
          /*
           * `success` does not mean the turn succeeded: the CLI flags a
           * rejected request with `is_error` and puts the message in
           * `result`, which the empty-result rescue below cannot catch.
           *
           * Only on an ending that would otherwise read `completed`. An
           * interrupted or deferred turn ends on an error-shaped `result` by
           * construction, and those endings keep their `finish` — the
           * `stopped`, `interruptedBy` and `deferredToolUse` the caller acts
           * on — and a host `abort` already ends as a run-phase error below.
           */
          if (
            msg.is_error
            && stoppedFromTerminalReason(terminalReason) === 'completed'
            && !interruptRequested
            && !turn.abortSignal.aborted
          ) {
            emitTerminalError(
              msg.result?.trim()
              || streamEventState.observedTerminalError
              || (typeof msg.api_error_status === 'number'
                ? `Claude Code reported an API error (HTTP ${msg.api_error_status})`
                : 'Claude Code reported a failed result'),
            )
            continue
          }
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
          // A running total across the turns of a streaming-input session, so the latest
          // result's value is the turn's — summing counted every earlier result again.
          if (typeof msg.total_cost_usd === 'number') {
            totalCostUsd = msg.total_cost_usd
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
          /*
           * A `result` that leaves background work running is not the turn's end: the
           * CLI wakes the model with a `task-notification` turn when the work settles, and
           * closing the input here kills that work with the process. Two cases wait:
           * - work is still running;
           * - this result is one of a batch of completions answered together. All but the last
           *   of them are empty (`num_turns: 0`), and the last carries the turn.
           * A stop the host asked for never waits. Without `perTaskStopAffordance` the
           * interrupt stops the background work too. One that lands while the turn already waits,
           * before the CLI wakes a turn, gets no result, and the interrupt handler closes the
           * input instead. A deferred
           * or SDK-interrupted result never waits either: the caller routes the deferral.
           */
          awaitingBackground = !interruptRequested
            && stoppedFromTerminalReason(terminalReason) === 'completed'
            && !turn.abortSignal.aborted
            && (liveBackgroundTasks > 0
              || (awaitingBackground && isBatchedTaskNotificationResult(msg)))
          backgroundWaitIdle = awaitingBackground
          if (!awaitingBackground && !queryInput.hasActiveUserMessages()) {
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

      // While background work holds the turn open, every message up to the next `result` is
      // part of it: the settled task's `task_notification` and the turn it wakes.
      if (
        queryInput.hasObservedResult
        && !awaitingBackground
        && !queryInput.hasActiveUserMessages()
      ) {
        queryInput.close()
        break
      }
    }
  }
  catch (err) {
    /*
     * An abort is never the SDK's own failure: every `abortCtl.abort()` in this
     * file is one this host asked for, and most have already said what happened
     * — the interrupt escalation emits its `no result within …` error, a
     * terminal error emits its own, the routed-command check emits an `init`
     * error. The rejection that follows is the abort landing, so reporting
     * it again as `claude-code turn failed` is a second, wrong explanation.
     * The one abort that has said nothing yet — a host `abort` frame — falls
     * through to the ending below, which is where the `break` path lands too;
     * so does a throw after one, which is the stop the host asked for (the
     * hard-abort fallback killing the CLI, a rejected `interrupt()`).
     */
    if (!abortCtl.signal.aborted && !turn.abortSignal.aborted) {
      turn.emitError({
        error: err,
        message: 'claude-code turn failed',
        phase: 'run',
        sessionArtifacts: sessionArtifacts(),
        // Only when a stop was asked for: a query that failed during the wind-down is the
        // interrupt's ending too, and the key is omitted on every other failure.
        ...(interruptReason === undefined ? {} : { interruptedBy: interruptReason }),
      })
      return
    }
  }
  finally {
    // The turn is over; disarm the host-abort path first. An abort of this
    // turn's signal arriving after this point must not interrupt the disposed
    // query or arm the hard-abort fallback for it.
    gracefulAbort = undefined
    if (hardAbortTimer !== undefined) {
      clearTimeout(hardAbortTimer)
    }
    turn.abortSignal.removeEventListener('abort', onHostAbort)
    // The turn produced its result (or died trying): the escalation has
    // nothing left to escalate.
    if (escalation !== undefined) {
      clearTimeout(escalation)
    }
    queryInput.close()
    // Dispose the query explicitly: with streaming input the SDK keeps its
    // CLI subprocess alive for more user messages, and a turn that ended
    // through an interrupt or error path can otherwise leak that process —
    // observed upstream as orphaned `claude` processes holding the very
    // conversation the next turn continues.
    try {
      await (q as { return?: (value?: unknown) => Promise<unknown> }).return?.(
        undefined,
      )
    }
    catch {
      // Best effort; the abort controller tears the process down otherwise.
    }
  }

  if (initCheckFailed || emittedTerminalError) {
    return
  }
  /*
   * A host `abort` is a teardown the client asked for, not an ending to
   * describe as one: the graceful `interrupt()` above may well have produced
   * a `result`, but a `finish` would then read as `interrupted` at best — and
   * after the hard fallback, with no `result`, as `completed`, which the
   * caller counts as success. Upstream reports nothing at all here; this host
   * reports a run-phase `error` carrying the session, so the attempt a client
   * retries can resume it. Reached on both unwinds — the `break` above
   * and a rejected iteration.
   */
  if (abortCtl.signal.aborted || turn.abortSignal.aborted) {
    turn.emitError({
      error: new Error('turn aborted by the host'),
      message: 'claude-code turn aborted',
      phase: 'run',
      sessionArtifacts: sessionArtifacts(),
    })
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
    sessionArtifacts: sessionArtifacts(),
    // Only on the ending it describes, and only when the SDK named one: the key is omitted
    // rather than sent as `undefined`, so a `finish` that carries it is proof of a deferral the
    // Worker can act on.
    ...(stopped === 'deferred' && deferredToolUse !== undefined
      ? { deferredToolUse }
      : {}),
    // Likewise only on the ending it describes: an SDK abort the Worker never asked for also
    // stops the turn early, and it names no reason because there is none to name.
    ...(stopped === 'interrupted' && interruptReason !== undefined
      ? { interruptedBy: interruptReason }
      : {}),
    ...(totalCostUsd !== undefined || session.lastClaudeSessionId !== undefined
      ? {
          harnessMetadata: {
            'claude-code': {
              ...(totalCostUsd !== undefined ? { costUsd: totalCostUsd } : {}),
              // The conversation this turn belongs to, resumable outside the
              // SDK with `claude --resume <sessionId>`. Upstream's field;
              // `sessionArtifacts.sessionId` above is this host's.
              ...(session.lastClaudeSessionId !== undefined
                ? { sessionId: session.lastClaudeSessionId }
                : {}),
            },
          },
        }
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
  answersSentMessage: (result: ClaudeMessage) => boolean
  observeResult: () => void
  readonly hasObservedResult: boolean
} {
  let closed = false
  let observedResult = false
  const submittedMessages = new Map<string, Experimental_BridgeUserMessage>()
  /*
   * The ids of every message this input sent, so a `result` can be matched to
   * the message it answers. Once the CLI has echoed one of them it is known to
   * echo them, and a result naming none answers nothing this input sent.
   */
  const initialMessageId = randomUUID()
  const sentMessageIds = new Set<string>([initialMessageId])
  let cliEchoesMessageIds = false
  const noteEcho = (ids: readonly unknown[]): boolean => {
    const echoed = ids.some(
      id => typeof id === 'string' && sentMessageIds.has(id),
    )
    if (echoed) {
      cliEchoesMessageIds = true
    }
    return echoed
  }
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
      noteEcho([lifecycle.command_uuid])
      // An initial message the CLI dropped gets no result: count it as answered.
      if (
        lifecycle.command_uuid === initialMessageId
        && (lifecycle.state === 'cancelled' || lifecycle.state === 'discarded')
      ) {
        observedResult = true
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
    /*
     * Whether a `result` answers a message this input sent. A resumed session
     * can write the result of a background task's `task-notification` turn
     * before the CLI reads the new prompt; that result names none of the sent
     * ids, and taken as the turn's own it ends the turn on empty text.
     */
    answersSentMessage: (result) => {
      const { user_message_uuid, user_message_uuids, origin } = result as {
        user_message_uuid?: unknown
        user_message_uuids?: unknown
        origin?: { kind?: string }
      }
      const echoed = noteEcho([
        user_message_uuid,
        ...(Array.isArray(user_message_uuids) ? user_message_uuids : []),
      ])
      return echoed || (!cliEchoesMessageIds && origin?.kind !== 'task-notification')
    },
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
                  messageId: initialMessageId,
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
            sentMessageIds.add(nextMessage.value.messageId)
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

/**
 * How many tasks of a `background_tasks_changed` set are activity. `ambient` tasks are excluded,
 * as the SDK asks: every `skip_transcript` task and every live-update watcher. They are not work
 * a turn waits on, and a watcher may never settle.
 */
function countActiveBackgroundTasks(message: ClaudeMessage): number {
  const tasks = (message as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) {
    return 0
  }
  return tasks.filter(task =>
    (task as { ambient?: unknown } | null)?.ambient !== true,
  ).length
}

/**
 * Whether a `result` is one of the empty results the CLI writes when it answers several
 * background-task completions in one turn. Each completion gets its own result with the
 * `task-notification` origin. All but the last have `num_turns: 0`, and the last carries the turn.
 */
function isBatchedTaskNotificationResult(message: ClaudeMessage): boolean {
  const result = message as { origin?: { kind?: unknown }, num_turns?: unknown }
  return result.origin?.kind === 'task-notification' && result.num_turns === 0
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
