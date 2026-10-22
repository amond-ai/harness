/**
 * The Claude Code CLI's JSONL transcript, read back as `HarnessV1Message`s for `doReadHistory`.
 *
 * Pure on purpose: the session fetches the file, this turns text into messages, so every rule
 * below is testable without a sandbox. The cursor is a count of complete lines, which is stable
 * because the CLI only ever appends, plus the `uuid` of the last counted line that has one
 * (`lines:<n>:<uuid>`; metadata lines carry none)
 * so a transcript replaced at the same path is told apart from one that merely grew. A trailing
 * segment with no newline is a line still being written, so it is neither parsed nor counted; the
 * next read picks it up whole.
 *
 * Which lines are conversation applies the Agent SDK's per-line filters in file order: user and
 * assistant entries only, no sidechain, no team, no meta, and compact summaries dropped. It does
 * not rebuild the `parentUuid` chain that `getSessionMessages` walks, so a transcript with rewound
 * or forked branches would show the abandoned branch too. This bridge never rewinds or forks a
 * session (no `resumeSessionAt`, no `forkSession`), so file order is the conversation.
 *
 * The CLI writes one content block per line for a single API message, so consecutive assistant
 * lines sharing a `message.id` are one assistant message here. A read can end between two lines of
 * one message; the next read then returns the rest as a separate assistant message, because
 * merging across reads would mean holding back or repeating the tail.
 */
import type { HarnessV1Message, HarnessV1ReadHistoryResult } from '@ai-sdk/harness'

const CURSOR_PREFIX = 'lines:'

/** Must match `NATIVE_TO_COMMON` in packages/harness-claude-code-bridge/src/turn-driver.ts. */
const NATIVE_TO_COMMON: Readonly<Record<string, string>> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebSearch: 'webSearch',
  AskUserQuestion: 'askUserQuestions',
}

type Json = Record<string, unknown>
type UserPart = Extract<HarnessV1Message, { role: 'user' }>['content'][number]
type AssistantPart = Extract<HarnessV1Message, { role: 'assistant' }>['content'][number]
type ToolPart = Extract<HarnessV1Message, { role: 'tool' }>['content'][number]

const toCommonName = (nativeName: string): string => NATIVE_TO_COMMON[nativeName] ?? nativeName

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLine(line: string): Json | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return isObject(parsed) ? parsed : undefined
  }
  catch {
    return undefined
  }
}

const CURSOR_PATTERN = /^lines:(\d+)(?::([\w-]+))?$/
const FINGERPRINT_PATTERN = /^[\w-]+$/

function parseCursor(since: string): { count: number, fingerprint: string | undefined } {
  const match = CURSOR_PATTERN.exec(since)
  if (match === null) {
    throw new Error(`Invalid claude-code history cursor: ${JSON.stringify(since)}`)
  }
  return { count: Number(match[1]), fingerprint: match[2] }
}

/** The `uuid` of the last line at or before `index` that carries one a cursor can hold. */
function uuidAt(lines: readonly string[], index: number): string | undefined {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i--) {
    const uuid = parseLine(lines[i]!)?.uuid
    if (typeof uuid === 'string' && FINGERPRINT_PATTERN.test(uuid)) {
      return uuid
    }
  }
  return undefined
}

function cursorFor(lines: readonly string[]): string {
  const uuid = uuidAt(lines, lines.length - 1)
  return uuid === undefined ? `${CURSOR_PREFIX}${lines.length}` : `${CURSOR_PREFIX}${lines.length}:${uuid}`
}

function blocksOf(entry: Json): Json[] {
  const content = isObject(entry.message) ? entry.message.content : undefined
  return Array.isArray(content) ? content.filter(isObject) : []
}

/** Tool-use ids to the common names they ran under, from every line, whatever the cursor. */
function toolNamesById(entries: ReadonlyArray<Json | undefined>): Map<string, string> {
  const names = new Map<string, string>()
  for (const entry of entries) {
    if (entry === undefined || entry.type !== 'assistant') {
      continue
    }
    for (const block of blocksOf(entry)) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        names.set(block.id, toCommonName(block.name))
      }
    }
  }
  return names
}

function isConversation(entry: Json): boolean {
  return (entry.type === 'user' || entry.type === 'assistant')
    && entry.isSidechain !== true
    && (entry.teamName === undefined || entry.teamName === null || entry.teamName === '')
    && entry.isMeta !== true
    && entry.isCompactSummary !== true
}

function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .filter(isObject)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

function userMessages(entry: Json, names: ReadonlyMap<string, string>, at: string | undefined): HarnessV1Message[] {
  const content = isObject(entry.message) ? entry.message.content : undefined
  const user: UserPart[] = []
  const results: ToolPart[] = []
  if (typeof content === 'string') {
    user.push({ type: 'text', text: content })
  }
  for (const block of blocksOf(entry)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      user.push({ type: 'text', text: block.text })
    }
    else if (block.type === 'image' && isObject(block.source) && block.source.type === 'base64'
      && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
      user.push({ type: 'file', mediaType: block.source.media_type, data: { type: 'data', data: block.source.data } })
    }
    else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const value = resultText(block.content)
      results.push({
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: names.get(block.tool_use_id) ?? 'unknown',
        output: block.is_error === true ? { type: 'error-text', value } : { type: 'text', value },
      })
    }
  }
  const stamp = at === undefined ? {} : { at }
  return [
    ...(results.length > 0 ? [{ role: 'tool', content: results, ...stamp } as const] : []),
    ...(user.length > 0 ? [{ role: 'user', content: user, ...stamp } as const] : []),
  ]
}

function assistantParts(entry: Json): AssistantPart[] {
  const parts: AssistantPart[] = []
  for (const block of blocksOf(entry)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    }
    else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push({ type: 'reasoning', text: block.thinking })
    }
    else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      parts.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: toCommonName(block.name),
        nativeName: block.name,
        input: block.input,
        providerExecuted: true,
      })
    }
  }
  return parts
}

/**
 * Messages recorded after `since` (all of them when it is undefined) and the cursor to pass back
 * for what follows.
 *
 * A `since` past the current end, or one whose fingerprint is not the `uuid` of the last line it
 * counted that has one, means this is not the transcript the cursor came from (the file was replaced or
 * truncated; a replacement that grew past the old count shows only in the fingerprint). Replaying
 * from the start would hand the caller messages it may already hold, and guessing is worse, so the
 * read is empty and the cursor jumps to the real end. A cursor without a fingerprint is still
 * accepted and is checked by count alone. A `since` that is not a cursor at all is a caller bug
 * and throws.
 */
export function transcriptHistory(text: string, since: string | undefined): HarnessV1ReadHistoryResult {
  const { count: start, fingerprint } = since === undefined ? { count: 0, fingerprint: undefined } : parseCursor(since)
  const lines = text.split('\n')
  lines.pop()
  if (start > lines.length || (fingerprint !== undefined && uuidAt(lines, start - 1) !== fingerprint)) {
    return { messages: [], cursor: cursorFor(lines) }
  }
  const entries = lines.map(parseLine)
  const names = toolNamesById(entries)

  const messages: HarnessV1Message[] = []
  let openId: string | undefined
  for (const entry of entries.slice(start)) {
    if (entry === undefined || !isConversation(entry)) {
      continue
    }
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
    if (entry.type === 'user') {
      openId = undefined
      messages.push(...userMessages(entry, names, at))
      continue
    }
    const parts = assistantParts(entry)
    if (parts.length === 0) {
      continue
    }
    const id = isObject(entry.message) && typeof entry.message.id === 'string' ? entry.message.id : undefined
    const last = messages.at(-1)
    if (id !== undefined && id === openId && last?.role === 'assistant') {
      last.content.push(...parts)
    }
    else {
      messages.push({ role: 'assistant', content: parts, ...(at === undefined ? {} : { at }) })
    }
    openId = id
  }
  return { messages, cursor: cursorFor(lines) }
}
