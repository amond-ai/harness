/**
 * The turn's own terminal message, read as a value rather than as the shape of the last line.
 *
 * `claude --output-format stream-json` and the Agent SDK's `query()` both close a turn with the
 * same `SDKResultMessage` — a typed record of how the turn ended, what it cost, and whether the
 * agent itself considered the outcome an error. Until this module existed the orchestrator read
 * exactly one bit of it, "the last message has `type: 'result'`", which is why run #291 exited 0
 * on a full disk and scored `complete`: the message said `is_error: true` and nothing looked
 * (ADR "turns run through the Agent SDK in a turn host", D5).
 *
 * In the seam rather than in the orchestrator because *both* readers of the message are here now:
 * the settle-time replay is the consumer's — it reads this parse through its own re-export — and
 * the attempt loop's is the driver's. A turn's own verdict has to reach the loop that decides
 * whether to run another turn, and that decision is made from the {@link TurnVerdict} both drivers
 * now produce while they watch (#376).
 *
 * Two properties this parse has to keep, both of them about *not* being brittle:
 *
 *   - **Unknown fields never fail it.** The schema is loose everywhere, because the shape is the
 *     CLI's and the SDK's, not this repository's: a newer image adds fields on its own schedule,
 *     and a turn whose result parsed yesterday and not today would settle as a failure for a
 *     reason that has nothing to do with the turn.
 *   - **The result is found, not assumed to be last.** The window a settle judges can end in a
 *     `sandbox-log` or any other frame the host appends after the turn ended, and reading only
 *     `messages.at(-1)` would then see no result at all and fail a run that succeeded.
 *
 * A result-shaped message that does *not* parse is a warning rather than silence: that is schema
 * drift between the image and this build, and it costs the run the judgment D5 introduced. What
 * it falls back to is stated precisely in the consumer's `runFailure` (`claude-run.ts`) — the exit
 * code when the host exited non-zero, and the "no terminal result" sentence otherwise — because it
 * is not always an exit code: an `sdk` turn is judged from the host's journal and has none.
 *
 * Import-free apart from `zod` and one bound, like the rest of the pure modules here, so
 * `bun test` reaches it without workerd.
 */
import type { TurnVerdict } from './outcome'
import { SUMMARY_MAX_LENGTH } from '@amond-ai/redact'
import { z } from 'zod'

/** The `type` a `claude --output-format stream-json` turn closes with. */
export const RESULT_MESSAGE_TYPE = 'result'

/** True for the terminal `result` message a completed turn ends with. */
export function isResultMessage(message: unknown): boolean {
  return typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === RESULT_MESSAGE_TYPE
}

/**
 * The fields of `SDKResultMessage` the orchestrator reads, and nothing else.
 *
 * Loose objects throughout — see the note above. `subtype` is a plain string rather than the
 * SDK's five-name union for the same reason: `success` is the only value this module branches
 * *on*, every other value is reported as the diagnostic it already is, and a subtype added by a
 * newer CLI must read as "not success" rather than as an unparseable message.
 *
 * `permission_denials` keeps the tool *name* only. `tool_input` is the arguments a model chose
 * for a tool it was refused, which can carry anything the turn was working with — it never
 * reaches a durable surface from here (D5).
 */
export const turnResultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  /**
   * Required, not tolerated: this is the field the judgment turns on, and the SDK requires it on
   * both result shapes. A `success` that omits it is a message this build cannot read — and an
   * unreadable result falls back to `runFailure`'s two sentences rather than scoring the run
   * complete.
   */
  is_error: z.boolean(),
  /**
   * The three metrics, and the only optional-because-tolerated fields here.
   *
   * Nothing branches on them — they are recorded and never read back into a judgment — so a CLI
   * that renames or drops one must not cost the run its verdict. Required, a single renamed
   * metric would fail the parse of every clean turn and settle each of them on the fallback in
   * `runFailure`; optional, it costs one NULL column and nothing else. `is_error` above is
   * required for the mirror-image reason: the judgment turns on it.
   */
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  stop_reason: z.string().nullable().optional(),
  terminal_reason: z.string().optional(),
  /** Present on the four error subtypes; the turn's own account of what went wrong. */
  errors: z.array(z.string()).optional(),
  /** The agent's last word, present on a `success`. */
  result: z.string().optional(),
  permission_denials: z.array(z.looseObject({ tool_name: z.string() })).optional(),
})

/** One turn's terminal message, as much of it as this codebase reads. */
export type TurnResult = z.infer<typeof turnResultSchema>

/**
 * The turn's terminal message out of a replayed window, or `undefined` when there is none.
 *
 * Searched from the end so the *last readable* result wins — an attempt loop's window holds one
 * turn, but a journal that was resumed can hold more, and the turn that settled the run is the
 * later one.
 *
 * A result-shaped message that fails to parse is warned about and then **skipped**, not returned
 * on. The scan continues because the alternative discards evidence it still has: in a resumed
 * journal the drifted message may be a later turn's while an earlier, readable one sits behind
 * it, and stopping there would settle a run on the fallback while its own verdict was still in
 * the window. Taking the earlier result is the conservative reading — it is a real terminal
 * message this build understands — and the warning is what says a later one was unreadable.
 */
export function parseTurnResult(messages: unknown[]): TurnResult | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isResultMessage(message)) {
      continue
    }
    const parsed = turnResultSchema.safeParse(message)
    if (parsed.success) {
      return parsed.data
    }
    // Drift between the image's CLI and this build's schema, and the one case worth a line.
    console.warn(`turn result did not parse issues="${issueSummary(parsed.error)}"`)
  }
  return undefined
}

/**
 * Why this turn failed, as the turn itself reports it — or `undefined` when it genuinely
 * succeeded.
 *
 * Three failures the exit code cannot see, in the order D5 states them:
 *
 *   1. A non-`success` subtype: the turn hit a limit or died inside the SDK, and `errors[]` is
 *      its own account of it.
 *   2. `success` with `is_error`: the process ended cleanly and the *agent* says it could not do
 *      the thing. This is #291's "cannot proceed: the disk is full", which printed as exit 0.
 *   3. `tool_deferred`: the turn stopped to ask a human about a tool call, and nothing headless
 *      can answer. D6 turns this into an `awaiting-approval` attempt; until it does, a turn that
 *      cannot finish is a failure, and it says so in its own sentence rather than borrowing one
 *      of the two above.
 *
 * **Nothing is cut here, deliberately.** Both summaries quote agent-authored text, and the one
 * bound that may be applied to it is `sanitizeErrorSummary`'s — which redacts *before* it
 * truncates, precisely so the 500-character cut can never land inside a credential. A slice taken
 * here would land ahead of every masker and could leave a sub-32-character tail of a token
 * straddling the boundary: too short for `SECRET_RUN` to match once the text ahead of it
 * collapses to `[redacted]`, so it would reach the column intact. `sanitizeErrorSummary` also
 * bounds the scan itself (`REDACTION_SCAN_BOUND`, 64 KiB), so an unbounded `errors[]` join costs
 * a bounded pass rather than an unbounded one, and every consumer of this string — run state, the
 * history row, the tracker outcome — reaches it through that sanitizer.
 */
export function turnResultFailure(result: TurnResult): string | undefined {
  if (result.subtype !== 'success') {
    const errors = (result.errors ?? []).join('; ').trim()
    return errors === ''
      ? `turn ended ${result.subtype}`
      : `turn ended ${result.subtype}: ${errors}`
  }
  if (result.is_error) {
    const text = (result.result ?? '').trim()
    return text === '' ? 'turn reported an error' : `turn reported an error: ${text}`
  }
  if (result.terminal_reason === 'tool_deferred') {
    return 'turn deferred a tool call and cannot finish headless'
  }
  return undefined
}

/**
 * The part of a parsed result the attempt loop is allowed to see (#376).
 *
 * Three fields, and the omissions are the point. `result`, `errors[]` and `permission_denials`
 * are agent- and server-authored text, and the loop decides nothing with them: it asks only
 * whether the turn itself reported an ending worth another turn. Everything longer than that
 * stays with the settle replay, which reads the whole message through {@link turnResultFailure}
 * and puts it on the row behind a masker. Keeping the projection this small is also what lets the
 * verdict ride a Workflow step result: the loop gains the turn's judgment without the transcript
 * crossing a step boundary with it.
 */
export function turnVerdict(result: TurnResult): TurnVerdict {
  return {
    subtype: result.subtype,
    isError: result.is_error,
    // Omitted rather than set to `undefined`: a step result crosses JSON, and an absent key is
    // what says "this CLI named no terminal reason" to the loop that reads it back.
    ...(result.terminal_reason === undefined ? {} : { terminalReason: result.terminal_reason }),
  }
}

/** The zod failure as one flat line: paths and messages, never the value that failed. */
function issueSummary(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
    .slice(0, SUMMARY_MAX_LENGTH)
}
