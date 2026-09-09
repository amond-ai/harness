# @amond-ai/sandbox-daytona

A [Daytona](https://www.daytona.io) backend for [`@amond-ai/sandbox`](../sandbox).

```ts
import { createDaytonaProvider, daytonaSandboxApi } from '@amond-ai/sandbox-daytona'

const provider = createDaytonaProvider({
  api: daytonaSandboxApi({ apiKey: process.env.DAYTONA_API_KEY }),
  snapshot: 'pleaseworks',
  stateRoot: '/home/daytona/.agent-runs',
})
const session = provider.session(sandboxIdForRun(runId))
```

In `apps/cf-orchestrator` you do not construct it directly — set `SANDBOX_BACKEND=daytona` and
the `DAYTONA_API_KEY` secret, and `sandboxProvider(env)` builds this instead of the Cloudflare one.

## Why this package is thin

Its sibling `@amond-ai/sandbox-e2b` is not, and the difference is one measured fact on each side.

e2b **forgets a process the moment it exits** (research note 027): `commands.connect(pid)` throws
`[not_found]`, `commands.list()` returns nothing, and the run workflow reads a turn's transcript
*after* it ends. So that backend journals stdout, stderr and the exit code to the sandbox
filesystem — and then has to defend the journal, because the turn can write to it. Every verdict
there is a file the turn could forge cross-checked against a process table it could not.

Daytona's toolbox daemon **keeps both** (research note 035 §3):

| | Daytona |
| --- | --- |
| `getSessionCommand(sid, cmdId).exitCode` after the command finishes | still answerable |
| who writes that exit code | the daemon — not reachable from inside the turn |
| `getSessionCommandLogs(sid, cmdId)` after exit | `{ output, stdout, stderr }`, retained |
| stdout and stderr | already separate, so `ProcessLogEvent`'s per-stream tag needs no demux |

The exit code is not forgeable from inside the sandbox, so one read settles liveness *and* exit
together. There is no journal here, no wrapper table, and no kill walk.

## The wrapper, and the three things Daytona does not expose

One Daytona **session per process**: the contract's process id *is* the session id, minted by this
backend. `exec` is `createSession(id)` then `executeSessionCommand(id, { command, runAsync: true })`,
and the command id is recoverable later from `getSession(id).commands[0].id` — which is what lets a
cold provider (a retried workflow step on another instance) answer `getProcess(id)` with nothing but
the id.

Daytona exposes no pid, no signal API, and no way to read a command's argv back out of its id. The
command string is therefore a wrapper:

```
setsid --wait sh -c 'printf '\''%s'\'' "$$" > <stateRoot>/<id>.pid ; cd <cwd> && exec env K=V ... <argv>'
```

- `printf … "$$"` records the pid, because `kill(1)` run beside the turn is the only signal path.
- `exec` makes that pid the *command's*, not a shell that will fork one.
- `setsid` makes it the process-group id too, which is what the default kill (`kill -KILL -- -<pid>`)
  signals — so a turn's children go with it. A named signal goes to the process alone, because
  SIGINT is how `claude` is asked to end the turn and print its `result`.

Beside it, `<stateRoot>/<id>.meta.json` records the argv, cwd and start time for `ProcessStatus`. It
is **informational only**: liveness and exit are read from the daemon, never from a file the turn
could write. A meta write that fails kills the command it just started, because a turn
`listProcesses` cannot see is one the duplicate-turn guard would start a second `claude` beside.

## Unproven: sessions across a sandbox stop/start

Daytona's docs and SDK types say nothing about whether a session survives the sandbox being stopped
and started again, and `autoStopInterval` stops an *inactive* sandbox by default after 15 minutes.
Treat it as unproven. What this backend does about it is refuse to guess: a session Daytona 404s on
is reported as the contract's `no_exit_record` — an ending, distinct from an exit — and
`getProcess(id)` still answers with a handle rather than `null` whenever the meta file is on disk,
because `null` is read upstream as a *confirmed death* and would clear the way for a second turn in
the same checkout.

There is no lifetime renewer here, unlike the e2b backend's. `autoStopInterval` counts inactivity,
and `waitForExit`'s poll is activity.

## Layout

| File | Role |
| --- | --- |
| `provider.ts` | `createDaytonaProvider` — identity by label, lazy acquisition, session cache, preview links |
| `daytona-session.ts` | The `SandboxSession`/`SandboxProcessHandle` implementation |
| `daytona-status.ts` | The one read that settles liveness and exit, and what a 404 means |
| `daytona-process.ts` | Paths, the wrapper script, and the meta record |
| `daytona-kill.ts` | `kill(1)` beside the turn: the group by default, the process for a named signal |
| `daytona-files.ts` | The contract's file surface over `fs.downloadFile`/`uploadFileStream` |
| `log-reads.ts` | The three shapes `logs()` answers in — whole transcript, positioned, following |
| `log-replay.ts` | Log strings → `ProcessLogEvent`s, with a byte-offset cursor |
| `shell-quote.ts` | Restores argv safety at Daytona's string-only command boundary |
| `daytona-surface.ts` | The SDK slice this backend uses, structurally — plus what a 404 is |
| `daytona-api.ts` | The only file that touches the real `@daytona/sdk` |

Everything except `daytona-api.ts` takes Daytona as a structural interface, so the whole backend is
testable against a fake with no network.

## Environment

Read by `apps/cf-orchestrator`'s `sandboxProvider`, not by this package:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DAYTONA_API_KEY` | *(required)* | Secret. `sandboxProvider` refuses the backend without it |
| `DAYTONA_SNAPSHOT` | *(unset)* — Daytona's default snapshot | Required with `TURN_DRIVER=sdk`: no default snapshot of ours carries `/opt/turn-host` |
| `DAYTONA_API_URL` | `https://app.daytona.io/api` | Control-plane endpoint |
| `DAYTONA_TARGET` | *(unset)* | Region a created sandbox lands in |
| `DAYTONA_STATE_ROOT` | `/home/daytona/.agent-runs` | Where the pid and meta files live, *inside the sandbox* |
| `DAYTONA_AUTO_STOP_MINUTES` | `60` | Minutes of inactivity before Daytona stops the sandbox |

The npm package is **`@daytona/sdk`**, not `@daytonaio/sdk` — the latter is deprecated in favour of
it at the same version, with the same API.
