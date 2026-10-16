/**
 * Whether the turn host is waiting on background work, read off the transcript the rounds see
 * go past.
 *
 * A turn whose `result` leaves background tasks running is not over: the host keeps the turn
 * open until the CLI wakes a `task-notification` turn for the work that settled, and while
 * no turn runs the host emits nothing at all. The silence watchdog cannot tell that wait
 * from a wedge — it counts frame arrivals — so a full test gate moved to the background read as
 * five minutes of silence and was interrupted. This fold is the same reading the host makes,
 * from the same messages, so the round can hold the watchdog off for exactly the span the host
 * holds the turn open.
 *
 * Import-free for the reason `sdk-round-state.ts` gives: it decides whether a turn is alive, and
 * has to be readable from `bun test`. Its semantics mirror the host's
 * (`packages/harness-claude-code-bridge/src/turn-driver.ts`, `countActiveBackgroundTasks` and the `result`
 * arm), and an unreadable line changes nothing — a reading the round cannot make is not evidence
 * either way.
 *
 * One flag where the host keeps two: `awaitingBackground` is the host's `backgroundWaitIdle`
 * (cleared when the main thread speaks), and it also stands in for the host's sticky
 * `awaitingBackground` latch in the batched-result rule. They part only if the main thread speaks
 * before an empty batched result in the same wake, an order no fixture shows; the fold then drops
 * a wait the host still holds, and silence is judged as it was before.
 */

/** The part of a round's carried state this fold owns; both absent is "no background work". */
export interface BackgroundWait {
  /** The live non-ambient tasks of the last `background_tasks_changed`; absent when none. */
  backgroundTasks?: number
  /** Set from a `result` that left work running until the main thread speaks again. */
  awaitingBackground?: true
}

interface TranscriptMessage {
  type?: unknown
  subtype?: unknown
  tasks?: unknown
  parent_tool_use_id?: unknown
  terminal_reason?: unknown
  is_error?: unknown
  origin?: { kind?: unknown }
  num_turns?: unknown
}

/** Fold one transcript line — one SDK message as JSON — into the wait the round carries. */
export function foldBackgroundWait<S extends BackgroundWait>(state: S, line: string): S {
  const message = parsed(line)
  if (message === undefined) {
    return state
  }
  const tasks = state.backgroundTasks ?? 0
  if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
    // A level signal: the set replaces the count rather than adding to it.
    return withWait(state, activeTasks(message.tasks), state.awaitingBackground === true)
  }
  if (isMainThread(message)) {
    // The CLI woke a turn: frames flow again, and silence means what it always meant.
    return withWait(state, tasks, false)
  }
  if (message.type === 'result') {
    return withWait(state, tasks, waitsAfter(message, tasks, state.awaitingBackground === true))
  }
  return state
}

/**
 * Fold one main-thread stream part — a `text-start`, a delta — into the wait the round carries.
 *
 * The host clears its wait on the main thread's `stream_event`s as well as on complete messages,
 * but forwards those only as stream parts, never as `raw` lines {@link foldBackgroundWait} reads.
 * Without this, a woken turn that stalls before its first complete message would keep the
 * watchdog off until the wall-clock budget.
 */
export function foldStreamPart<S extends BackgroundWait>(state: S): S {
  return state.awaitingBackground === true ? withWait(state, state.backgroundTasks ?? 0, false) : state
}

/** The terminal reasons the host does not count as a completed turn; every other one is. */
const UNCOMPLETED_REASONS: ReadonlySet<unknown> = new Set(['aborted_streaming', 'aborted_tools', 'tool_deferred'])

/**
 * Whether the host keeps the turn open after this `result`: a completed turn that left work
 * running, or one of the empty results the CLI writes when it answers several completions in one
 * wake (`num_turns: 0`, `task-notification` origin) while the wait is already on.
 */
function waitsAfter(message: TranscriptMessage, tasks: number, waiting: boolean): boolean {
  // A `success` the CLI flagged `is_error` is a failed turn: the host ends it on a run error
  // before its background-wait rule is reached, so it holds nothing open.
  const completed = message.subtype === 'success'
    && message.is_error !== true
    && !UNCOMPLETED_REASONS.has(message.terminal_reason)
  if (!completed) {
    return false
  }
  return tasks > 0 || (waiting && message.origin?.kind === 'task-notification' && message.num_turns === 0)
}

/** The main thread speaking: a subagent's messages carry their `parent_tool_use_id`. */
function isMainThread(message: TranscriptMessage): boolean {
  return (message.type === 'assistant' || message.type === 'user' || message.type === 'stream_event')
    && message.parent_tool_use_id == null
}

/** How many tasks are activity; `ambient` ones are not work a turn waits on, as the host counts. */
function activeTasks(tasks: unknown): number {
  if (!Array.isArray(tasks)) {
    return 0
  }
  return tasks.filter(task => (task as { ambient?: unknown } | null)?.ambient !== true).length
}

/** The state with the wait set, keeping both fields absent rather than zero or false. */
function withWait<S extends BackgroundWait>(state: S, tasks: number, waiting: boolean): S {
  const next: S = { ...state }
  delete next.backgroundTasks
  delete next.awaitingBackground
  return {
    ...next,
    ...(tasks > 0 ? { backgroundTasks: tasks } : {}),
    ...(waiting ? { awaitingBackground: true } : {}),
  }
}

function parsed(line: string): TranscriptMessage | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null ? value as TranscriptMessage : undefined
  }
  catch {
    return undefined
  }
}
