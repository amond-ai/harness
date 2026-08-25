# @pleaseai/sandbox-e2b

An [e2b](https://e2b.dev) backend for [`@pleaseai/sandbox-contract`](../sandbox-contract).

```ts
import { createE2bProvider, e2bSandboxApi } from '@pleaseai/sandbox-e2b'

const provider = createE2bProvider({
  api: e2bSandboxApi({ apiKey: process.env.E2B_API_KEY }),
  template: 'claude',
  journalRoot: '/home/user/.agent-runs',
})
const session = provider.session(sandboxIdForRun(runId))
```

In `apps/cf-orchestrator` you do not construct it directly — set `SANDBOX_BACKEND=e2b` and
the `E2B_API_KEY` secret, and `sandboxProvider(env)` builds this instead of the Cloudflare one.

## The per-command timeout is disabled on purpose

e2b's `CommandStartOpts.timeoutMs` defaults to **60 seconds**, and it applies to background
commands — measured, not inferred (`scripts/spike-e2b-command-timeout.ts`): a background
wrapper sleeping 95s left only its first marker under the default and completed under `0`.

Every `claude` turn and every repository clone longer than a minute would be killed, and the
kill lands before the journal wrapper's trailing `printf '%s' "$?"`, so it arrives as
`SandboxNoExitRecordError` rather than as a timeout — the same shape as a crashed wrapper.

`commandTimeoutMs` therefore defaults to `0`. A turn's bounds belong to the orchestrator that
started it: the liveness watchdog, the workflow step timeouts, and the sandbox lifetime. Pass
a non-zero value only if you want a budget none of those know about.

## Why this package is not thin

e2b **forgets a process the moment it exits**. Measured, not inferred (research note 027):

| | Measured |
| --- | --- |
| `commands.connect(pid)` on a *running* command | replays nothing — only output produced after the reconnect |
| `commands.connect(pid)` on an *exited* command | throws `[not_found]` |
| `commands.list()` after exit | 0 processes |
| a file the command redirected into | survives exit **and** `Sandbox.connect(sandboxId)` |

The run workflow reads a turn's transcript *after* it exits, so the first three rows are the
whole problem and the fourth is the whole answer. This backend journals four files per process
into `journalRoot`:

```
<id>.out        stdout          <id>.exit       printf '%s' "$?"
<id>.err        stderr          <id>.meta.json  id, pid, argv, cwd, startedAt
```

stdout and stderr are separate files rather than one interleaved stream because
`ProcessLogEvent` is tagged per stream and `demuxProcessEvents` splits on that tag — the NDJSON
turn output must not be polluted by whatever the CLI writes to stderr. `logs()` then projects
those files back into `ProcessLogEvent`s, and `status()`/`waitForExit()` answer from the exit
file. A cold provider that never saw the run reconnects by sandbox id and replays a
byte-identical transcript; `scripts/spike-e2b-turn.ts` measures exactly that against a live
`claude` turn.

## Two things e2b's shape forced

**Identity.** The contract addresses a sandbox by the id the orchestrator chose
(`sandboxIdForRun(runId)`); e2b mints its own. The orchestrator's id is written into e2b
`metadata` at create time and looked up through `Sandbox.list({ query: { metadata } })`, whose
default state filter covers paused sandboxes as well as running ones — a retried workflow step
must reach the sandbox its predecessor left behind, whatever state e2b put it in.

**Timing.** `SandboxProvider.session` is synchronous by contract, because the Cloudflare backend
resolves a Durable Object stub with no I/O. Acquiring an e2b sandbox is a network call, so it is
deferred to the session's first use and memoised — `session(id)` on its own costs nothing, one
sandbox is created per id, and concurrent first calls share a single acquisition rather than
racing to create two.

**One thing improves.** `listProcesses()` reports exited processes too, since it scans the
journal rather than e2b's live-only table. The idempotency guard filters with `isLive(status)`,
so this is extra information, not a behaviour change.

## Layout

| File | Role |
| --- | --- |
| `provider.ts` | `createE2bProvider` — identity, lazy acquisition, session cache |
| `e2b-session.ts` | The `SandboxSession`/`SandboxProcessHandle` implementation |
| `journal.ts` | Paths, the redirect wrapper, and the meta record |
| `log-replay.ts` | Journal bytes → `ProcessLogEvent`s, with a byte-offset cursor |
| `shell-quote.ts` | Restores argv safety at e2b's string-only command boundary |
| `e2b-api.ts` | The only file that touches the real e2b SDK |

Everything except `e2b-api.ts` takes e2b as a structural interface, so the whole backend is
testable against a fake with no network (`bun test`).
