import { randomUUID } from 'node:crypto'

type Emit = (message: Record<string, unknown>) => void

export interface ClaudeMessage {
  type?: string
  subtype?: string
  parent_tool_use_id?: string | null
  model?: string
  error?: string
  error_status?: number | null
  attempt?: number
  max_retries?: number
  retry_delay_ms?: number
  patch?: { status?: string, error?: string }
  compact_metadata?: {
    trigger: 'manual' | 'auto'
    pre_tokens?: number
    post_tokens?: number
  }
  event?: {
    type?: string
    index?: number
    usage?: Record<string, unknown>
    message?: {
      usage?: Record<string, unknown>
    }
    content_block?: {
      type?: string
      id?: string
      name?: string
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
    }
  }
  message?: {
    content?: string | ReadonlyArray<MessageBlock>
    usage?: Record<string, unknown>
  }
  result?: string
  /** Result-message error flags; distinct from `error_status` (`api_retry`). */
  is_error?: boolean
  api_error_status?: number | null
  errors?: ReadonlyArray<string>
  usage?: Record<string, unknown>
  total_cost_usd?: number
  structured_output?: unknown
  tool_use_result?: unknown
}

interface MessageBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export interface ClaudeStreamEventState {
  /*
   * Map of native tool-use id → tool name. Claude assistant messages emit
   * `tool_use` blocks with both `id` and `name`; the matching `tool_result`
   * block on a later user message carries only `tool_use_id`, so without this
   * map the tool-result event would have to emit `toolName: 'unknown'`.
   */
  nativeToolCallNames: Map<string, string>
  approvalRequestedToolUseIds: Set<string>
  partialBlocks: Map<number, PartialBlock>
  stepUsage: Record<string, unknown> | undefined
  pendingStepToolUseIds: Set<string>
  pendingStepAssistantUsage: Record<string, unknown> | undefined
  pendingStepDeltaUsage: Record<string, unknown> | undefined
  pendingStepUsage: Record<string, unknown> | undefined
  pendingResponseUsage: Record<string, unknown> | undefined
  stepOpen: boolean
  externalMcpToolUseIds: Set<string>
  structuredOutputToolUseIds: Set<string>
  observedTerminalError: string | undefined
}

type PartialBlock
  = | { id: string, kind: 'text' | 'thinking' }
    | { id: string, kind: 'tool-input' }

export function createClaudeStreamEventState(): ClaudeStreamEventState {
  return {
    nativeToolCallNames: new Map(),
    approvalRequestedToolUseIds: new Set(),
    partialBlocks: new Map(),
    stepUsage: undefined,
    pendingStepToolUseIds: new Set(),
    pendingStepAssistantUsage: undefined,
    pendingStepDeltaUsage: undefined,
    pendingStepUsage: undefined,
    pendingResponseUsage: undefined,
    stepOpen: false,
    externalMcpToolUseIds: new Set(),
    structuredOutputToolUseIds: new Set(),
    observedTerminalError: undefined,
  }
}

const UNRECOVERABLE_API_RETRY_STATUSES = new Set([401, 403, 404])
const RAW_TASK_MESSAGE_SUBTYPES = new Set([
  'background_tasks_changed',
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
])

/*
 * Upstream also excludes its host-tool MCP server (`mcp__harness-tools__`)
 * here; that server is gone (UPSTREAM.md patch 3), so every `mcp__` tool is an
 * external one.
 */
export function isExternalMcpTool(nativeName: string): boolean {
  return nativeName.startsWith('mcp__')
}

export function createEmitStreamEvent({
  state,
  emit,
  emitWarning,
  emitTerminalError,
  onCompactionBoundary,
  toCommonName,
}: {
  state: ClaudeStreamEventState
  emit: Emit
  emitWarning: (warning: { message: string }) => void
  emitTerminalError: (message: string | undefined) => void
  onCompactionBoundary: (boundary: {
    trigger: 'manual' | 'auto'
    tokensBefore?: number
    tokensAfter?: number
  }) => void
  toCommonName: (nativeName: string) => string
}): (event: ClaudeMessage) => void {
  let streamStarted = false

  return (msg) => {
    const type = msg.type

    /*
     * The SDK's messages ARE the CLI's `--output-format stream-json` lines,
     * so forwarding each one verbatim re-emits the same NDJSON the Worker
     * decodes — the least-churn wire the ADR asked for. It goes out ahead of
     * every harness part derived from the same message, `stream-start`
     * included, so a consumer reading only `raw` sees the transcript in the
     * CLI's own order. `stream_event` is excluded: those are token deltas, and
     * the harness already renders them as text/reasoning parts — save the
     * `message_stop` `handleStreamEvent` forwards with the response's usage,
     * and a subagent's, which the subagent guard below forwards.
     */
    if (type !== 'stream_event') {
      emit({ type: 'raw', rawValue: msg })
    }

    // Emit `stream-start` once, on the first message, carrying the model the
    // CLI resolved to (the `system`/`init` message reports it — this is the
    // default model when none was configured).
    if (!streamStarted) {
      const initModel
        = type === 'system'
          && msg.subtype === 'init'
          && typeof (msg as { model?: unknown }).model === 'string'
          ? (msg as { model: string }).model
          : undefined
      emit({
        type: 'stream-start',
        ...(initModel ? { modelId: initModel } : {}),
      })
      streamStarted = true
    }

    if (type === 'system' && msg.subtype === 'api_retry') {
      if (
        typeof msg.error_status === 'number'
        && UNRECOVERABLE_API_RETRY_STATUSES.has(msg.error_status)
      ) {
        emitTerminalError(
          `HTTP ${msg.error_status}: ${msg.error ?? 'provider request failed'}`,
        )
        return
      }

      emitWarning({ message: formatApiRetryWarning(msg) })
      return
    }

    if (
      type === 'auth_status'
      && typeof msg.error === 'string'
      && msg.error.trim()
    ) {
      emitTerminalError(msg.error)
      return
    }

    if (
      type === 'system'
      && msg.subtype === 'task_updated'
      && msg.patch?.status === 'failed'
      && typeof msg.patch.error === 'string'
    ) {
      emitTerminalError(msg.patch.error)
      return
    }

    if (type === 'system' && msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata
      if (meta) {
        onCompactionBoundary({
          trigger: meta.trigger,
          ...(typeof meta.pre_tokens === 'number'
            ? { tokensBefore: meta.pre_tokens }
            : {}),
          ...(typeof meta.post_tokens === 'number'
            ? { tokensAfter: meta.post_tokens }
            : {}),
        })
      }
      return
    }

    /*
     * Task lifecycle and tool progress are for correlation and nested
     * rendering only: the `raw` frame above carried them, and they map to no
     * stream part. Upstream emits that `raw` here; this host already did.
     */
    if (
      type === 'tool_progress'
      || (type === 'system'
        && msg.subtype != null
        && RAW_TASK_MESSAGE_SUBTYPES.has(msg.subtype))
    ) {
      return
    }

    /*
     * Messages emitted by a Task-tool subagent carry the parent tool-use id.
     * They are forwarded for correlation and nested rendering — the `raw`
     * frame above — but they are not mapped into stream parts and must not
     * affect the parent step, including partial stream events that arrive
     * before assistant messages.
     *
     * A subagent's `stream_event`s are forwarded raw here, as upstream does:
     * the top-of-function `raw` skipped them with the parent's own token
     * deltas, so each still yields exactly one `raw`. Like every `raw` they
     * are journaled, keeping the live mirror and the journal-rebuilt
     * transcript in agreement, at the cost of a larger journal.
     */
    if (msg.parent_tool_use_id != null) {
      if (type === 'stream_event') {
        emit({ type: 'raw', rawValue: msg })
      }
      return
    }

    /*
     * Below the subagent guard, deliberately. A Task subagent's own messages
     * carry recoverable `error` fields (`rate_limit`, `overloaded`, …) that the
     * subagent then retries past; latching one as the *parent* turn's terminal
     * error made a turn that went on to succeed end on an `error` frame with no
     * `finish` — the driver reads this latch together with an empty `result`,
     * which is what a `structured_output` answer leaves behind.
     */
    if (typeof msg.error === 'string' && msg.error.trim()) {
      state.observedTerminalError = msg.error.trim()
    }

    if (type === 'stream_event') {
      handleStreamEvent({
        event: msg.event,
        message: msg,
        state,
        send: emit,
        toCommonName,
      })
      return
    }

    const messageContent = msg.message?.content
    if (type === 'assistant' && Array.isArray(messageContent)) {
      const usage = toUsageRecord(msg.message?.usage)
      const toolUseIds: string[] = []
      let opensStep = false
      for (const block of messageContent) {
        if (
          block.type === 'tool_use'
          && typeof block.id === 'string'
          && typeof block.name === 'string'
        ) {
          toolUseIds.push(block.id)
          if (block.name === 'StructuredOutput') {
            state.structuredOutputToolUseIds.add(block.id)
            continue
          }
          state.nativeToolCallNames.set(block.id, block.name)
          // The `PreToolUse` hook emits this call's tool-call: a host-executed
          // one when the host is asked to answer it, the runtime's otherwise.
          if (block.name === 'AskUserQuestion') {
            state.pendingStepToolUseIds.add(block.id)
            opensStep = true
            continue
          }
          const dynamic = isExternalMcpTool(block.name)
          if (dynamic) {
            state.externalMcpToolUseIds.add(block.id)
          }
          if (state.approvalRequestedToolUseIds.has(block.id)) {
            continue
          }
          state.pendingStepToolUseIds.add(block.id)
          opensStep = true
          emit({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: toCommonName(block.name),
            nativeName: block.name,
            input: JSON.stringify(block.input ?? {}),
            providerExecuted: true,
            ...(dynamic ? { dynamic: true } : {}),
          })
        }
      }
      if (opensStep || toolUseIds.length === 0) {
        state.stepOpen = true
        if (usage) {
          state.pendingStepAssistantUsage = usage
          updatePendingStepUsage(state)
        }
      }
      return
    }

    if (type === 'user' && Array.isArray(messageContent)) {
      const toolResultBlocks = messageContent.filter(
        block => block.type === 'tool_result',
      )
      // The CLI's structured result describes the message's one tool call; a
      // message carrying several leaves no way to tell whose it is.
      const toolUseResult
        = toolResultBlocks.length === 1
          ? withoutOriginalFile(
              msg.tool_use_result,
              state.nativeToolCallNames.get(String(toolResultBlocks[0]!.tool_use_id)),
            )
          : undefined

      for (const block of messageContent) {
        if (
          block.type === 'tool_result'
          && typeof block.tool_use_id === 'string'
        ) {
          if (state.structuredOutputToolUseIds.delete(block.tool_use_id)) {
            continue
          }
          state.approvalRequestedToolUseIds.delete(block.tool_use_id)
          const nativeName
            = state.nativeToolCallNames.get(block.tool_use_id) ?? 'unknown'
          state.nativeToolCallNames.delete(block.tool_use_id)
          const toolName = toCommonName(nativeName)
          const dynamic = state.externalMcpToolUseIds.delete(block.tool_use_id)
          const isError = !!block.is_error
          const result
            = toolUseResult !== undefined
              ? toolUseResult
              : resolveToolResult({
                  toolName,
                  dynamic,
                  isError,
                  rawContent: block.content,
                })
          emit({
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            toolName,
            result,
            isError,
            ...(dynamic ? { dynamic: true } : {}),
          })
          state.pendingStepToolUseIds.delete(block.tool_use_id)
        }
      }
      closeStepIfReady({ state, emit })
    }
  }
}

export function finishApprovalStep({
  state,
  emit,
  approvalId,
}: {
  state: ClaudeStreamEventState
  emit: Emit
  approvalId: string
}): void {
  state.stepOpen = true
  state.pendingStepToolUseIds.delete(approvalId)
  closeStepIfReady({ state, emit })
}

export function emitFinishStep({
  state,
  emit,
  usage,
}: {
  state: ClaudeStreamEventState
  emit: Emit
  usage: Record<string, unknown> | undefined
}): void {
  emit({
    type: 'finish-step',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: usage ?? defaultUsage(),
  })
  state.stepUsage = usage ?? state.stepUsage
  state.pendingStepAssistantUsage = undefined
  state.pendingStepDeltaUsage = undefined
  state.pendingStepUsage = undefined
  state.pendingStepToolUseIds = new Set()
  state.stepOpen = false
}

function closeStepIfReady({
  state,
  emit,
}: {
  state: ClaudeStreamEventState
  emit: Emit
}): void {
  if (
    !state.stepOpen
    || state.pendingStepToolUseIds.size > 0
    || state.partialBlocks.size > 0
  ) {
    return
  }
  emitFinishStep({ state, emit, usage: state.pendingStepUsage })
}

function formatApiRetryWarning(msg: ClaudeMessage): string {
  const details: string[] = []
  if (typeof msg.attempt === 'number') {
    const maxRetries
      = typeof msg.max_retries === 'number' ? `/${msg.max_retries}` : ''
    details.push(`attempt ${msg.attempt}${maxRetries}`)
  }
  if (typeof msg.error_status === 'number') {
    details.push(`HTTP ${msg.error_status}`)
  }
  if (typeof msg.retry_delay_ms === 'number') {
    details.push(`retrying in ${msg.retry_delay_ms}ms`)
  }
  if (msg.error) {
    details.push(msg.error)
  }
  return details.length > 0
    ? `Claude Code API retry: ${details.join('; ')}`
    : 'Claude Code API retry'
}

function handleStreamEvent({
  event,
  message,
  state,
  send,
  toCommonName,
}: {
  event: ClaudeMessage['event'] | undefined
  message: ClaudeMessage
  state: ClaudeStreamEventState
  send: Emit
  toCommonName: (nativeName: string) => string
}): void {
  if (!event) {
    return
  }

  if (event.type === 'message_start') {
    state.pendingResponseUsage = toUsageRecord(event.message?.usage)
    return
  }

  if (event.type === 'message_delta') {
    const usage = toUsageRecord(event.usage)
    if (usage) {
      state.pendingResponseUsage = mergeNonNullUsage(
        state.pendingResponseUsage,
        usage,
      )
      state.pendingStepDeltaUsage = mergeNonNullUsage(
        state.pendingStepDeltaUsage,
        usage,
      )
      updatePendingStepUsage(state)
    }
    return
  }

  /*
   * The one `stream_event` that rides the wire raw: it carries the response's
   * whole usage, summed from `message_start` and every `message_delta`, which
   * no complete SDK message reports per response. It is transcript, not
   * liveness — the driver journals it like every `raw` — so the live mirror
   * and the transcript rebuilt from the journal hold the same lines.
   */
  if (event.type === 'message_stop') {
    send({
      type: 'raw',
      rawValue: {
        ...message,
        usage: state.pendingResponseUsage ?? {},
      },
    })
    state.pendingResponseUsage = undefined
    return
  }

  if (typeof event.index !== 'number') {
    return
  }
  const index = event.index
  const partialBlocks = state.partialBlocks

  if (event.type === 'content_block_start') {
    const blockType = event.content_block?.type
    if (blockType === 'text') {
      const id = randomUUID()
      partialBlocks.set(index, { id, kind: 'text' })
      send({ type: 'text-start', id })
    }
    else if (blockType === 'thinking') {
      const id = randomUUID()
      partialBlocks.set(index, { id, kind: 'thinking' })
      send({ type: 'reasoning-start', id })
    }
    else if (
      blockType === 'tool_use'
      && typeof event.content_block?.id === 'string'
      && typeof event.content_block.name === 'string'
    ) {
      const id = event.content_block.id
      const nativeName = event.content_block.name
      if (nativeName === 'StructuredOutput') {
        return
      }
      if (nativeName === 'AskUserQuestion') {
        return
      }
      // Upstream also maps its host-tool MCP server's names here; that server
      // is gone (UPSTREAM.md patch 3), so every streamed call is the runtime's.
      const dynamic = isExternalMcpTool(nativeName)
      partialBlocks.set(index, { id, kind: 'tool-input' })
      send({
        type: 'tool-input-start',
        id,
        toolName: toCommonName(nativeName),
        providerExecuted: true,
        ...(dynamic ? { dynamic: true } : {}),
      })
    }
    return
  }

  if (event.type === 'content_block_delta') {
    const block = partialBlocks.get(index)
    if (!block) {
      return
    }
    if (
      block.kind === 'text'
      && event.delta?.type === 'text_delta'
      && typeof event.delta.text === 'string'
    ) {
      send({ type: 'text-delta', id: block.id, delta: event.delta.text })
    }
    else if (
      block.kind === 'thinking'
      && event.delta?.type === 'thinking_delta'
      && typeof event.delta.thinking === 'string'
    ) {
      send({
        type: 'reasoning-delta',
        id: block.id,
        delta: event.delta.thinking,
      })
    }
    else if (
      block.kind === 'tool-input'
      && event.delta?.type === 'input_json_delta'
      && typeof event.delta.partial_json === 'string'
    ) {
      send({
        type: 'tool-input-delta',
        id: block.id,
        delta: event.delta.partial_json,
      })
    }
    return
  }

  if (event.type === 'content_block_stop') {
    const block = partialBlocks.get(index)
    if (!block) {
      return
    }
    partialBlocks.delete(index)
    if (block.kind === 'text') {
      send({ type: 'text-end', id: block.id })
    }
    else if (block.kind === 'thinking') {
      send({ type: 'reasoning-end', id: block.id })
    }
    else {
      send({ type: 'tool-input-end', id: block.id })
    }
  }
}

function toUsageRecord(usage: unknown): Record<string, unknown> | undefined {
  return usage != null && typeof usage === 'object'
    ? (usage as Record<string, unknown>)
    : undefined
}

function mergeNonNullUsage(
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current }
  for (const [key, value] of Object.entries(update)) {
    const previous = merged[key]
    // Usage counters only grow within a response: a partial `0` must not erase the complete count.
    if (typeof value === 'number' && typeof previous === 'number') {
      merged[key] = Math.max(previous, value)
    }
    else if (value != null) {
      merged[key] = value
    }
  }
  return merged
}

function updatePendingStepUsage(state: ClaudeStreamEventState): void {
  const assistantUsage = state.pendingStepAssistantUsage
  const deltaUsage = state.pendingStepDeltaUsage
  state.pendingStepUsage = mapUsage(
    assistantUsage || deltaUsage
      ? mergeNonNullUsage(assistantUsage, deltaUsage ?? {})
      : undefined,
  )
}

function isTextEntry(entry: unknown): entry is { text?: unknown } {
  return entry != null && typeof entry === 'object' && 'text' in entry
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map(entry =>
        isTextEntry(entry) ? String(entry.text ?? '') : JSON.stringify(entry),
      )
      .join('')
  }
  return JSON.stringify(content)
}

/*
 * `Edit` and `Write` report the whole file as it stood before the change in
 * `originalFile`. The `raw` `user` frame already journals it, and a client
 * may read that journal through a bounded tail, so a second copy on the
 * tool-result would spend the bound on bytes the transcript already holds.
 * Only theirs: another tool's `originalFile`, an MCP server's included, is
 * that tool's own result and is reported as it came.
 */
const ORIGINAL_FILE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write'])

function withoutOriginalFile(result: unknown, nativeName: string | undefined): unknown {
  if (
    nativeName === undefined
    || !ORIGINAL_FILE_TOOLS.has(nativeName)
    || result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || !('originalFile' in result)
  ) {
    return result
  }
  const { originalFile: _originalFile, ...rest } = result as Record<string, unknown>
  return rest
}

function hasNonTextContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(entry => !isTextEntry(entry))
}

function resolveToolResult({
  toolName,
  dynamic,
  isError,
  rawContent,
}: {
  toolName: string
  dynamic: boolean
  isError: boolean
  rawContent: unknown
}): unknown {
  /*
   * Claude Code's Bash tool does not report the command's real numeric exit
   * code — the SDK exposes only stdout/stderr text and an is_error flag.
   * Consumers (and the example UI) render bash failures from an `exitCode`
   * field on a structured result, the shape Codex's shell tool provides
   * natively. When Claude omits `tool_use_result`, derive a binary code from
   * is_error: 1 on failure, 0 on success. This fallback is a stand-in for
   * failed/succeeded, not the process's true exit status.
   */
  if (toolName === 'bash') {
    return { exitCode: isError ? 1 : 0, stdout: stringifyContent(rawContent) }
  }
  // Must precede the MCP branch: flattening a non-text block to base64 text
  // is not recoverable by parsing it back.
  if (hasNonTextContent(rawContent)) {
    return rawContent
  }
  const content = stringifyContent(rawContent)
  return dynamic ? parseMcpToolResult(content) : content
}

function parseMcpToolResult(content: string): unknown {
  try {
    const parsed = JSON.parse(content)
    // `JSON.parse` also succeeds on scalars; keep those as the string sent.
    return parsed !== null && typeof parsed === 'object' ? parsed : content
  }
  catch {
    return content
  }
}

export function mapUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined
  }
  const u = usage as {
    input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
  }
  return {
    inputTokens: {
      total:
        (u.input_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0),
      noCache: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
    outputTokens: {
      total: u.output_tokens ?? 0,
      text: u.output_tokens ?? 0,
    },
  }
}

export function defaultUsage(): Record<string, unknown> {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0 },
  }
}
