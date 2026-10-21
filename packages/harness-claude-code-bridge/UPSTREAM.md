# Upstream

The turn host is a fork of Vercel's Claude Code bridge, vendored rather than
depended on: it must run inside the sandbox image against a pinned CLI, and the
patches below are not upstream yet.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `bb40cf03c5b68a4acee867d4fef9a65f71703c47`
- **Tag**: `@ai-sdk/harness-claude-code@1.0.162` (the same commit carries
  `@ai-sdk/harness@1.0.158`)
- **Packages taken from**: `@ai-sdk/harness-claude-code@1.0.162`,
  `@ai-sdk/harness@1.0.158` (re-vendored from `1.0.142` / `1.0.138`, and
  before that from `1.0.90` / `1.0.87`; patches 26–34 below are the
  adaptations the 1.0.142 re-vendor made)
- **License**: Apache-2.0 (both packages)

## File-by-file mapping

| This repository | Upstream path |
| --- | --- |
| `src/turn-driver.ts` | `@ai-sdk/harness-claude-code/src/bridge/index.ts` |
| `src/create-emit-stream-event.ts` | `@ai-sdk/harness-claude-code/src/bridge/create-emit-stream-event.ts` |
| `src/compaction-latch.ts` | `@ai-sdk/harness-claude-code/src/bridge/compaction-latch.ts` |
| `src/tool-filtering.ts` | `@ai-sdk/harness-claude-code/src/bridge/tool-filtering.ts` |
| `src/claude-skills-option.ts` | `@ai-sdk/harness-claude-code/src/bridge/claude-skills-option.ts` |
| `src/claude-code-system-prompt.ts` | `@ai-sdk/harness-claude-code/src/bridge/claude-code-system-prompt.ts` |
| `src/question-tool.ts` | `@ai-sdk/harness-claude-code/src/bridge/question-tool.ts` (its `@ai-sdk/harness` type import repointed at `@amond-ai/harness-protocol`) |
| `src/main.ts` | — (new; upstream's entry is `bridge/index.ts` itself) |
| `src/permission-policy.ts` | — (new; the run's permission posture as a `PreToolUse` hook plus a `canUseTool` fallback, and the matcher that replays a human's approval) |
| `src/session-artifacts.ts` | — (new; the paths of a turn's two durable artifacts — the CLI's session jsonl and the journal — including the CLI's project-directory encoding) |

The bridge runtime upstream keeps in `@ai-sdk/harness/src/bridge/` lives in
[`@amond-ai/harness-bridge-runtime`](../harness-bridge-runtime) instead, because a
second harness's bridge needs the same transport. Its own `UPSTREAM.md` records
what was vendored there and carries the patches that went with it — **numbered as
they are here**, so a citation by number still resolves. The gaps in the list
below are those patches.

That second harness is [`@amond-ai/harness-codex-bridge`](../harness-codex-bridge),
which shares the numbering too: it reuses a number where its patch is the Codex
side of the same change (3, 7, 8, 22) and took 23–25 for what only Codex needed.
The 1.0.142 re-vendor's patches therefore start at 26 rather than 23.

The wire protocol upstream keeps in `@ai-sdk/harness` and
`claude-code-bridge-protocol.ts` lives in
[`@amond-ai/harness-protocol`](../harness-protocol) instead, because phase 2's
Worker client needs the same schemas. Its own `UPSTREAM.md` records what was
vendored there.

## Patches carried on top of upstream

Each is a separate commit in this repository and is intended to go upstream.

1. `style(turn-host): apply the repository lint config` — formatting only.
2. `refactor(turn-host): inject query() through createTurnDriver` — the module
   no longer boots itself; `createTurnDriver({ query, workdir })` returns the
   `onStart` so tests can drive a fake `query()`.
3. `refactor(turn-host): drop host-defined tools and the MCP tool server` — the
   Worker never sends `start.tools`; the `@modelcontextprotocol/sdk` path and
   `json-schema-to-zod.ts` are gone and a `start` carrying `tools` is refused.
   The `mcp__harness-tools__` special-casing in `create-emit-stream-event.ts`
   went with it: nothing registers that server any more, so the branch and the
   `mcpToolUseIds` set it fed were unreachable.
   The host-tool half of 6c65131 is skipped for the same reason:
   `HOST_TOOL_PREFIX` calls marked as waiting on the host, the handler's
   `toolUseId` on `mcpHandlerCalls`, `findMcpHandlerCallId`,
   `resolveMcpHandlerToolUseId`, the `takeMcpHandlerCall` rewrite, and the MCP
   tool server handler's own `tool-call` dedupe and waiting marks.
4. `feat(turn-host): emit every SDK message as a raw frame` — every SDK message
   except `stream_event` rides the wire verbatim as `{ type: 'raw', rawValue }`
   ahead of the harness parts derived from it. Since the 1.0.142 re-vendor the
   frame is emitted at the top of `createEmitStreamEvent`, where upstream emits
   its own raw frames (patch 26).
6. `feat(turn-host): accept the SDK options on start` — `settingSources`, the
   SDK `permissionMode` enum, `persistSession`, `pathToClaudeCodeExecutable`,
   `maxBudgetUsd`, `sessionId`, `resume`, `emitDeltas`, `refuseTools`,
   `deferTools`, `approvedRequests`, `approvalPolicy`, `interruptGraceMs`.
7. `feat(turn-host): add an interrupt command that ends the turn with a result`
   — `query.interrupt()` instead of aborting, so the turn ends with a typed
   `result`. The `AbortController` stays as the escalation. The `interrupt`
   command itself and the `turn.onInterrupt` seam that delivers its reason are
   the runtime's half, in `harness-bridge-runtime` under the same number.
8. `feat(turn-host): report stop reason and session artifacts on finish` —
   `finish.stopped`, `finish.sessionArtifacts`, `error.phase`.
9. `feat(turn-host): enforce the run's permission posture in the host` —
   `canUseTool` never pends under `approvalPolicy: 'deny'`, and a `PreToolUse`
   hook evaluates `approvedRequests` → `refuseTools` → `deferTools`.
   Since 6c65131, a forwarded approval registers `requestToolApproval` before
   it emits `tool-approval-request`, then marks its call as waiting on the
   host (`markWaitingOnHostInput`) until the decision settles. Upstream's
   `finishApprovalStep` is gone with it. Under `'deny'` the resolver answers
   before any of that, so a denied call marks nothing and no early
   `finish-step` (patch 27) follows it.
10. `feat(turn-host): fail a routed turn whose command did not load` — a
    routed prompt whose command is missing from `system`/`init`'s
    `slash_commands` fails the turn before a token is spent.
14. `fix(turn-host): keep a subagent's recoverable error off the parent turn` —
    the terminal-error latch in `create-emit-stream-event.ts` ran above the
    `parent_tool_use_id` guard, so a Task subagent's `rate_limit`/`overloaded`
    ended the parent turn on an `error` with no `finish` once the parent's own
    `result` was empty (a `structured_output` answer). The latch moved below the
    guard.
16. `fix(turn-host): do not report an abort as a turn failure` — the catch around
    the SDK loop emitted `claude-code turn failed` for a host-initiated abort,
    which is a teardown the Worker asked for and not a failure. Every
    `abortCtl.abort()` in the file already emits its own explanation where there
    is one, so an aborted signal suppresses the generic error.

17. `fix(turn-host): exit after an uncaught crash and forward the permission
    mode the schema accepts` — the SDK permission-mode guard reads
    `sdkPermissionModeSchema` instead of a hand-copied list, so `auto` reaches
    the SDK as `auto` rather than falling through to the harness branch as
    `default`. The crash exit and the console-capture writer handling are the
    runtime's half, in `harness-bridge-runtime` under the same number.

19. `feat(turn-host): report the session id on finish` — `sessionArtifacts`
    carried the session *file*'s path but not the id the turn ran as, so a
    client that wanted to resume had to parse `<sessionId>.jsonl` out of the
    path — putting a CLI naming convention on the Worker's side of the split
    that field exists to keep on the host's. The id now rides beside the path
    (`sessionArtifactsSchema.sessionId` in `@amond-ai/harness-protocol`).

20. `feat(turn-host): report the session artifacts on a run-phase error too` —
    only `finish` named them, so the ordinary way a turn fails — the SDK
    throwing, a terminal error frame, an interrupt the query never answered —
    left the client with no session to resume, which is exactly the ending a
    retry follows. The three run-phase `error` emits now carry the same
    `sessionArtifacts` `finish` does (`turnHostErrorSchema.sessionArtifacts` in
    `@amond-ai/harness-protocol`), built by one `sessionArtifacts()` helper
    that also feeds `finish`. The `sessionId`/`sessionCwd` declarations moved above the
    interrupt handler, which is installed before the message loop that fills
    them.

21. `feat(turn-host): answer a denied request and name the deferred one` — layer 3
    of the ADR's D6 had no way to say *no* and no way to say *what* a deferral
    is waiting on. Two additions, one at each end of the wire. `start` gains
    `deniedRequests` (`deniedRequestSchema` in `@amond-ai/harness-protocol`),
    which the `PreToolUse` evaluator consumes one-shot **ahead of**
    `approvedRequests` and the defer rule: without it a human's refusal replays
    into the same `deferTools` pattern that deferred the call and defers
    forever, so the agent never hears the answer. A call on both lists is a
    contradiction the Worker should never send; it is denied, and the
    contradicting approval is consumed with the denial so an identical retry
    cannot be allowed by the entry the denial skipped. And `finish` gains
    `deferredToolUse` (`turnHostFinishSchema`), read off the SDK `result`'s
    `deferred_tool_use` beside the `terminal_reason` that already decided
    `stopped: 'deferred'` — `stopped` says a decision is owed, this says which
    request it is owed about, and an answer authorizes one request rather than
    the tool.

22. `feat(turn-host): echo the interrupt reason on the ending it caused` — the
    host answered an `interrupt` with a `finish { stopped: 'interrupted' }`, or
    with a run-phase `error` when it escalated, and neither said *which* stop it
    was answering. The Worker's own memory of the reason it sent is not durable
    — a Workflow step that never commits loses it — so a re-entered round read
    the first as an unnamed timeout and the second as a turn that failed on its
    own, and a budget stop that lost its cause started another attempt with a
    fresh budget (#388, the #358 shape). The reason the `turn.onInterrupt`
    handler receives is now remembered and echoed as `interruptedBy`
    (`turnHostFinishSchema` / `turnHostErrorSchema` in
    `@amond-ai/harness-protocol`): on `finish` only beside
    `stopped: 'interrupted'`, so an SDK abort nobody asked for still names none;
    on the escalation `error` and on a query failure during the wind-down.

26. `refactor(turn-host): forward raw frames from the stream-event mapper in
    upstream's shape` and `feat(turn-host): pass task and tool-progress
    messages through as raw only` — upstream forwards `task_*`,
    `background_tasks_changed`, `tool_progress` and subagent messages raw from
    `create-emit-stream-event.ts` and returns. Patch 4's generic raw frame moved
    there, to the top of the mapper ahead of `stream-start`, and upstream's
    branches only return: each SDK message still rides the wire raw exactly
    once, ahead of every part derived from it. A subagent's `stream_event`s
    are forwarded raw as upstream does, from inside the `parent_tool_use_id`
    guard (the top-of-mapper raw skips every `stream_event`, so each still
    yields one raw), and are journaled like every other raw frame (patch 27):
    a live-only raw would put lines in the live mirror that the
    journal-rebuilt transcript lacks. The cost is journal size — every
    subagent token delta is a journal line, so for a client that reads the
    journal through a bounded tail a long subagent stream pushes older lines
    out of that window sooner.

27. `feat(turn-host): meter steps from streamed usage and journal a
    message_stop raw` — upstream's per-step metering and its `message_stop`
    raw frame carrying the response's summed usage. Upstream sends it like any
    frame; here, like a subagent's `stream_event` raws (patch 26), it is a
    journaled raw built from a `stream_event`, where every other part derived
    from one is live-only (patch 5): a client's live mirror appends every `raw`
    it receives, so the transcript rebuilt from the journal must carry the
    same lines. The driver's live-only flag applies only to derived non-raw
    frames and never to a `raw`.
    Since the 1.0.162 re-vendor (upstream 0291550) the same `message_stop`
    also closes a tool step whose results arrived while the response still
    streamed, so that `finish-step` is built from a `stream_event` too. It is
    journaled, an exception to patch 5's live-only rule like the `raw`: a
    `finish-step` is a step's structure, not liveness, and a journal-rebuilt
    transcript without it would hold a step that never ends. The live-only
    flag therefore skips `raw` and `finish-step`.
    Since 6c65131, a step whose tool calls wait on the host (patches 9 and
    31) gets an early `finish-step` with `finishReason { unified:
    'tool-calls', raw: 'host-input' }`, zero usage, and `harnessMetadata
    ['claude-code'].inferredStep`. It is emitted once for each waiting call
    that no earlier pause in the step covered. It goes through no
    `emitFinishStep` bookkeeping, so it changes neither `stepUsage` nor the
    step's pending usage, and the step's regular `finish-step` still reports
    the usage the step streamed. When the response's `message_stop` emits it,
    it is built from a `stream_event` and journaled under the same
    `finish-step` exemption. Upstream's `modelResponseStreaming` is not
    carried: it toggles with `responseOpen` (0291550) at the same
    `message_start` and `message_stop`, and `closeStepIfReady` already returns
    while `responseOpen` is set.

28. `fix(turn-host): fail a turn whose success result the CLI flagged as an
    error` — upstream's `is_error` check, applied only when the ending would
    otherwise read `completed`: an interrupted or deferred turn ends on an
    error-shaped `result` by construction and keeps its `finish` with
    `stopped`, `interruptedBy` and `deferredToolUse` (patches 8, 21, 22).

29. `feat(turn-host): abort a turn through the graceful interrupt first` —
    upstream's host-abort path (`interrupt()`, hard abort as the fallback after
    five seconds or when `interrupt()` rejects). The fallback is upstream's
    constant, not `interruptGraceMs`: its 30 s default would outlast the
    bridge's ten-second teardown fence (patch 30).
    Upstream reports nothing for an aborted turn and suppresses errors after
    one; this host keeps the ending `fix(harness-claude-code-bridge): report a
    host abort as an error, not a completed finish` introduced — a host `abort`
    ends on a run-phase `error` carrying `sessionArtifacts`, never on a
    `finish`, because a `finish` without a `terminal_reason` reads as
    `completed`, which a client counts as success. The separate `interrupt`
    command (patch 7) is unchanged.

30. `feat(turn-host): fence a start on the aborted turn's teardown` —
    upstream's `activeTurn` fence and `turnTeardownGraceMs` (ten seconds). A
    start during a turn nobody aborted is still refused at once (patch 12); a
    start during an aborted turn's teardown waits up to the grace, and where
    upstream then lets the new turn overlap the old one, this bridge refuses it
    with the same `start`-phase error. The fence itself is the runtime's half,
    in `harness-bridge-runtime` under the same number; the five-second
    hard-abort fallback it outlasts is patch 29.

31. `feat(turn-host): answer AskUserQuestion through the host behind the run
    policy` — upstream's question tool, `requestToolResult({ matches })`
    buffering and the `askUserQuestions` names (also in `tool-filtering.ts`).
    Upstream registers the question hook as its own `AskUserQuestion` matcher;
    the SDK runs matching hooks in parallel, so here it runs inside the one
    `PreToolUse` hook, **after** the run policy (patch 9, 21): a question the
    policy decides — replayed denial or approval, `refuseTools`, `deferTools`
    — never parks
    the CLI on a host answer, and an undecided one goes to the host only under
    `approvalPolicy: 'forward'`. Because the stream mapper leaves every
    `AskUserQuestion` call to the hook, a question the host is not asked to
    answer is reported as the runtime's own `tool-call` there.
    Beyond upstream, whose buffer and pending requests live for the whole
    bridge process: the bridge remembers every `toolCallId` a request took a
    result under or was settled for, and drops a `tool-result` for one rather
    than buffering it, and buffers one result per `toolCallId` (first wins, and
    consuming one drops its duplicates), so a retransmitted answer cannot answer
    a later, identical question through `matches`. Buffered results and pending
    requests are scoped to the turn: on turn teardown (finish, error, abort,
    interrupt) and on a new `start` the buffer is cleared and every pending
    request is settled as an `isError` result, which the question hook turns
    into a deny — never an answer — so a parked hook unblocks; a result that
    arrives while no turn runs is not buffered. Cross-id
    `matches` replay therefore works only within one turn, which is its
    purpose: an answer that arrives before the hook asked. Where upstream casts
    the host's answer, the hook parses it with
    `harnessV1QuestionsToolOutputSchema` and denies one the schema refuses, and
    it leaves a call without a usable `questions` list (non-empty objects with
    a string `question`, `options` objects with a string `label`, and every
    optional field it copies of the type the questions-tool schema takes) to
    the CLI's own validation, still emitting the runtime's tool-call so the result has a
    call — and only that one: if the call then reaches `canUseTool` for approval,
    the approval request reuses it rather than emitting a second. An answer is
    the selected labels then the trimmed free text, joined
    by `, `; one with neither is left out of `answers`. Late or retransmitted
    answers are dropped by tool call id, kept for the turn after the one that
    consumed the id. The buffer, its turn scoping and the consumed-id memory
    are the runtime's half, in `harness-bridge-runtime` under the same number;
    the hook, the question translation and the answer parsing are this
    package's.
    Since 6c65131, only a question actually forwarded to the host marks its
    call as waiting on the host, before `requestToolResult`, and clears the
    mark when the request settles. A question the policy decided, or one with
    no host to answer it, is reported through the runtime's `tool-call` and
    pauses nothing. The hook's set of reported calls is now the stream state's
    `emittedToolCallIds`, which upstream adds for the mapper and the approval
    path. The mapper, the approval path and the hook share it, so each native
    call gets one `tool-call` from whichever of them sees it first. Like
    upstream, the mapper no longer skips a call whose approval was requested
    (the `approvalRequestedToolUseIds` check is gone) and relies on the shared
    set instead. It still leaves every `AskUserQuestion` call to the hook.

32. `feat(turn-host): bypass without canUseTool and with the stdio prompt
    tool` — upstream's bypass shape (no `canUseTool`, `permissionPromptToolName:
    'stdio'`), applied to the SDK's `bypassPermissions` as well as the
    harness's `allow-all`. The run posture still binds there through the
    `PreToolUse` hook, which runs ahead of the mode stage.

33. `feat(turn-host): resume the exact session a start names or the bridge last
    saw` — upstream's `resumeSessionId`, its last-observed session id and the
    `bridge-stop` payload / `finish` `harnessMetadata['claude-code'].sessionId`
    built from it. The id is held in the `createTurnDriver` closure, not at
    module level (patch 2), and `createTurnDriver` returns the `onStop` that
    reads it. `start.resume` (patch 6) is an alias: either name suppresses
    `continue`, and two different names are a `start`-phase error.
    `sessionArtifacts.sessionId` (patch 19) stays. Beyond upstream, which has
    no `sessionId` option: the implicit pin applies only when a `start` names
    none of `resume`, `resumeSessionId` and `sessionId`. A `start.sessionId`
    with no resume name opens a fresh session under that id, with neither
    `resume` nor `continue`, since the SDK documents `sessionId` as exclusive
    of both. A `start.sessionId` together with `resume` or `resumeSessionId` is
    a `start`-phase error, for the same reason.

34. `feat(turn-host): report the CLI's structured tool result, without
    originalFile` — upstream's `tool_use_result` for a message with exactly one
    `tool_result` block, minus `originalFile`: `Edit`/`Write` put the whole
    pre-edit file there, the raw `user` frame already journals it, and a
    client may read that journal only through a bounded tail.

Taken from upstream as-is in the same re-vendor: tool-input streaming (no
host-tool branch, patch 3), non-array message content, non-text tool-result
content and MCP scalars, `dynamic` on approval-gated external MCP calls,
disposing the query with `return()` on every ending, and forwarding
`agentProgressSummaries` / `forwardSubagentText`.

35. `fix(turn-host): end a turn only after its background tasks settle` —
    upstream ends the turn on the first `result`: it closes the streaming input
    and disposes the query, which kills a subagent or shell the CLI ran in the
    background. The SDK runs an `Agent` call without `run_in_background` in the
    background by default. The host now tracks the live set from
    `background_tasks_changed`, which is a level signal with replace semantics.
    `ambient` entries are not counted. A `result` that leaves work running keeps
    the input open, as do the empty `num_turns: 0` results the CLI writes when
    it answers several `task-notification` completions in one turn. Both exit
    paths, the `result` and the message after one, wait until a later `result`
    ends the turn. A stop the host asked for never waits: without
    `perTaskStopAffordance` the interrupt stops the background work too. A
    deferred or SDK-interrupted result never waits either. Since a
    turn can now carry several results, `total_cost_usd` is taken from the latest
    one rather than summed, because the SDK reports it as a running total.
    Upstream fixed the same sum in vercel/ai `a470e0dee` (#21896), unreleased at
    1.0.142 and shipped in 1.0.143, so that part of this patch is now
    upstream's behaviour too.
    An interrupt that lands while the turn already waits, before the CLI
    wakes a turn for the settled work, gets no `result`: on CLI 2.1.289 the
    idle CLI only stops the background work and resolves `interrupt()`. So
    once that interrupt settles, the host closes the input. The CLI exits,
    the stream ends, and the turn finishes as `interrupted` with
    `interruptedBy`, instead of escalating to a run-phase error and `exit(1)`.
    A main-thread message ends that idle span. An interrupt during the woken
    turn aborts it, and its `result` closes the input as usual.
    Since the 1.0.162 re-vendor, upstream's 12d249f guard skips a `result`
    that answers no message the bridge sent, before `observeResult()`: one
    that echoes none of the sent ids from a CLI known to echo them, or one
    with the `task-notification` origin. A cancelled or discarded initial
    message counts as answered. Taken as-is the guard would skip this patch's
    woken-turn result, which answers a `task-notification`, so the woken turn
    would never end. Here it yields while the turn waits on background work,
    and a result it skips changes neither the wait nor the live task count.
    It also runs first in the `result` branch, where upstream runs it after
    the error and usage handling: a skipped result's `is_error` or error
    subtype would otherwise fail the turn it does not belong to, and its usage
    would count toward it. Nor does a skipped result's `terminal_reason` or
    `deferred_tool_use` become the turn's ending, and the error its turn
    latched is dropped. It only closes the step it streamed, with that step's
    own usage.
    This amendment takes no number of its own.

The 1.0.162 re-vendor took five upstream changes:

- 18c2658 (1.0.149): `rate_limit_event` joins the raw-only early return in
  `create-emit-stream-event.ts`. Its raw frame is already the top-of-mapper
  one (patch 26), so it is not emitted twice.
- 0887035 (1.0.150): a compaction reported outside a model step closes its
  own synthetic step with a `finish-step`.
- 40c10e0 (1.0.153): `ListAgents` is a `readonly` native tool, not an edit by
  default.
- 12d249f (1.0.143): `answersSentMessage()` skips a `result` that answers no
  message the bridge sent, re-applied under patch 35.
- 0291550 (1.0.155): a tool step waits for its response's `message_stop`
  before it finishes, re-applied under patches 27 and 5.

Two upstream changes were already covered: a470e0d (the `total_cost_usd`
running total) by patch 35, and 714f3fc (host-tool calls rejected by MCP input
validation) by patch 3, which dropped host tools. Deferred: 1bebfcf
(`toModelOutput()`, with `@ai-sdk/harness`'s `convertHarnessToolModelOutput`),
the image prompts dc1d7a6 and ca2a9f7, and the SDK bump c357e52. Skipped:
bda96e8, which restarts recovered turns on the host side and is not vendored
here.

A separate change after the re-vendor took 6c65131 (1.0.151, parallel and
sequential tool approvals). Its Claude Code adapter half adds one `tool-call`
per tool call id, waiting-on-host tracking, and the early `finish-step`. It is
re-applied under patches 9, 27 and 31. Its host-tool half is skipped under
patch 3. Its protocol half came with the re-vendor (see
`harness-protocol/UPSTREAM.md`).

## Upstream behaviour deliberately dropped

- The `pnpm install` bootstrap inside the sandbox — the image ships the
  dependencies.
- Host-defined tools: the `@modelcontextprotocol/sdk` server,
  `json-schema-to-zod.ts`, and every `mcp__harness-tools__` branch upstream
  carries (patch 3), including 1.0.142's `HOST_TOOL_PREFIX` in
  `isExternalMcpTool` and the tool-input stream.
- Upstream's silence after a host abort: no `terminal error` suppression and
  no missing ending (patch 29).
- Upstream's overlap after the teardown grace (patch 30).
