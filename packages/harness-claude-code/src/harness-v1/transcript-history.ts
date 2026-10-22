/**
 * The Claude Code CLI's JSONL transcript, read back as `HarnessV1Message`s for `doReadHistory`.
 *
 * Pure on purpose: the session fetches the file, this turns text into messages, so every rule
 * below is testable without a sandbox. The cursor is a count of complete lines, which is stable
 * because the CLI only ever appends. A trailing segment with no newline is a line still being
 * written, so it is neither parsed nor counted; the next read picks it up whole.
 *
 * Which lines are conversation mirrors the Agent SDK's own `getSessionMessages` filter, so a
 * history read and a resumed session agree on what was said. The CLI writes one content block per
 * line for a single API message, so consecutive assistant lines sharing a `message.id` are one
 * assistant message here.
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

function parseCursor(since: string): number {
  const digits = since.startsWith(CURSOR_PREFIX) ? since.slice(CURSOR_PREFIX.length) : ''
  if (!/^\d+$/.test(digits)) {
    throw new Error(`Invalid claude-code history cursor: ${JSON.stringify(since)}`)
  }
  return Number(digits)
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
 * A `since` past the current end means this is not the transcript the cursor came from (the file
 * was replaced or truncated). Replaying from the start would hand the caller messages it may
 * already hold, and guessing is worse, so the read is empty and the cursor jumps to the real end.
 * A `since` that is not a cursor at all is a caller bug and throws.
 */
export function transcriptHistory(text: string, since: string | undefined): HarnessV1ReadHistoryResult {
  const start = since === undefined ? 0 : parseCursor(since)
  const lines = text.split('\n')
  lines.pop()
  const end = lines.length
  if (start > end) {
    return { messages: [], cursor: `${CURSOR_PREFIX}${end}` }
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
  return { messages, cursor: `${CURSOR_PREFIX}${end}` }
}
