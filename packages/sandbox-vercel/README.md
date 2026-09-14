# @amond-ai/sandbox-vercel

A [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) backend for
[`@amond-ai/sandbox`](../sandbox). After reading this you will know what this backend can and
cannot promise, how to construct it, where it keeps its bookkeeping, and which of its guarantees
are weaker than the e2b backend's.

```ts
import { createVercelProvider, vercelSandboxApi } from '@amond-ai/sandbox-vercel'

const provider = createVercelProvider({
  api: vercelSandboxApi({ create: { runtime: 'node22' } }),
  stateRoot: '/vercel/sandbox/.agent-runs',
  ports: [3000],
})
const session = provider.session(sandboxIdForRun(runId))
```

## What Vercel does not remember

Read this before choosing this backend. Four things a caller usually assumes a sandbox knows
are simply not there, and every design decision below follows from them.

| Question | Vercel's answer |
| --- | --- |
| What is running in this sandbox? | There is no process list. |
| What argv did this command have? | Not exposed. |
| What pid does it have? | Not exposed. |
| What did command `<cmdId>` exit with, after a resume? | A command id is scoped to the session that ran it. A resumed sandbox is a **new** session, and an id minted before the resume resolves nothing in it. |

The run workflow, meanwhile, reads a turn's transcript *after* the turn ends, from a step that may
run on a different machine than the one that started it. So this backend writes its own record —
the journal — into the sandbox filesystem, and answers `logs()`, `status()` and `waitForExit()`
from there. Where the session still holds the command, Vercel's own `exitCode` is read too and
preferred; see "`ProcessStatus.command` is written by the turn" for why that distinction carries
weight.

## The wrapper, and what the image must provide

`exec` does not run your argv. It runs a wrapper, built by `journal.ts`:

```sh
setsid --wait sh -c ": '<id>' ; printf '%s' "$$" > '<root>/<id>.pgid' ; \
  { <argv> ; } > '<root>/<id>.out' 2> '<root>/<id>.err' & __c=$! ; \
  printf '%s' "$__c" > '<root>/<id>.pid' ; wait $__c ; __e=$? ; \
  printf '%s' "$__e" > '<root>/<id>.exit.pending' ; \
  command -p mv -- '<root>/<id>.exit.pending' '<root>/<id>.exit'"
```

Line-wrapped for reading; it is one line in the argv, and it is written as one string so
`parseJournalScript` can recover a process id from a command line it did not start.


- `setsid` gives the turn a process group of its own. That group is what the default `kill`
  reaps, so a turn's `git`, `bun` and language servers go with it.
- `--wait` is not optional. A bare `setsid` forks and exits immediately, which would report every
  turn finished the moment it started.
- The exit record is published by renaming `<id>.exit.pending` onto `<id>.exit` within one
  directory, so a reader never sees a half-written code.
- `cwd` and `env` ride Vercel's own `runCommand` parameters. There is no `cd` or `env` prologue in
  the script.

Two prerequisites of the sandbox image follow:

1. **`setsid` must be on `PATH`.** Without it `exec` fails outright.
2. **`/proc` must be readable.** Liveness is decided by reading `/proc/<pgid>/cmdline` and
   comparing it against the wrapper's own marker. Where that read fails, liveness degrades to
   `'unknown'` — which this backend reports as `running`, never as dead. A turn that cannot be
   observed is not an evidently-dead one, and the two mistakes are not symmetric: guessing
   "running" wrong costs one more poll, guessing "dead" wrong starts a second agent in a checkout
   that already has one.

## `ProcessStatus.command` is written by the turn

`ProcessStatus.command`, `cwd` and `startedAt` come from `<id>.meta.json` — a file in the sandbox
the turn itself can write to. This backend is therefore **weaker than the e2b backend**, which
reads a live process's argv out of e2b's own process table, and **equal to the Daytona backend**.

What keeps that from mattering is that nothing load-bearing reads it. The liveness verdict comes
from the probe, which compares `/proc/<pgid>/cmdline` against a marker derived from the process
*id*, not from the meta file and not from anything the recorded command line says. A turn that
rewrites its own meta changes what `status()` reports about it and changes nothing about whether
this backend believes it is alive.

## A routed port is publicly reachable

`portEndpoint` returns a `*.vercel.run` URL and **no headers**, because there is nothing to put in
them: Vercel Sandbox has no preview-token equivalent of the header the Daytona backend hands back.
Anyone who knows the subdomain can reach the port. For the AI SDK bridge, the per-turn token the
bridge itself requires in the query string is the only thing gating it.

Ports can be routed after the sandbox exists, and that is deliberate rather than incidental: the
`sdk` driver does not know the bridge's port until the host process prints `bridge-ready` with it,
so a backend that could only route ports at create time would make that driver impossible to run.
`portEndpoint` therefore repairs routing on demand, sending the **union** of what is already
routed with the port being asked for — Vercel reads `ports` as the full desired list and
deregisters everything omitted. The SDK's create parameters cap `ports` at 15; past that,
`portEndpoint` throws and names what is already routed rather than evicting someone else's port by
a policy nobody chose.

The scheme is always TLS. `http` is answered with `https` and `ws` with `wss`, preserving the kind
but not the plaintext: `*.vercel.run` is an HTTPS edge, so honouring `http` literally could only
mint a URL that cannot be dialed.

## There is no ranged read

`readFileToBuffer` reads a whole file. A positioned `logs({ since })` therefore buffers the entire
journal file and discards what precedes the cursor, and a following `logs({ follow: true })` pays
the same on any poll that transfers anything. Budget for a turn's full transcript in memory, once
per read.

What bounds the cost is that most polls transfer nothing. The liveness probe is a single
`runCommand` that answers liveness, both journal lengths (`wc -c`), the timeout marker and the exit
record together, and the follow loop drains a file **only** when a length has grown past its
cursor. A quiet follow — the bridge's usual state, waiting on a request — issues one command per
interval and reads no bytes at all.

`{ type: 'truncated' }` is never emitted. The contract has that event for a backend whose retained
log is a bounded buffer; here the journal is two ordinary files in the sandbox filesystem, and
nothing rotates, evicts or caps them for the sandbox's life.

## Where things live

Eight files per process, under `stateRoot`:

```text
<stateRoot>/
  <processId>.out           stdout, as the wrapper redirected it
  <processId>.err           stderr
  <processId>.exit          $?, written by the wrapper after it waits
  <processId>.exit.pending  the same record before it is renamed into place
  <processId>.pid           the wrapped command's pid, for aiming a named signal
  <processId>.pgid          the wrapper's process group, for reaping the tree
  <processId>.timeout       present when the wrapper's own watchdog hit the deadline
  <processId>.meta.json     the process record: command, cwd, startedAt, cmdId, sessionId
```

`stateRoot` defaults to `/vercel/sandbox/.agent-runs`. `listProcesses` screens the directory on
`.meta.json`, so a foreign filename landing in it is ignored rather than taking the whole listing
down.

## Options

| Option | Default | What it decides |
| --- | --- | --- |
| `api` | *(required)* | The `VercelSandboxApi` that creates and looks up sandboxes — normally `vercelSandboxApi(...)`. |
| `stateRoot` | `/vercel/sandbox/.agent-runs` | Where the journal goes, inside the sandbox. |
| `namePrefix` | `''` | Prefixed to every sandbox name, so one Vercel project can hold several deployments' runs. |
| `sandboxName` | `sandboxNameFor` | The sandbox id → name mapping. **Must be injective.** |
| `ports` | `[]` | Ports routed as part of acquiring the sandbox. |
| `sandboxTimeoutMs` | *(unset)* | The lifetime the sandbox was created with. Unset disables renewal. |
| `extendTimeoutMs` | `sandboxTimeoutMs` | How much one renewal adds, when the plan's cap on a single extension is below the lifetime. |
| `commandTimeoutMs` | *(the sandbox's own)* | Vercel's budget for the *wrapper*. See the warning below. |
| `probeTimeoutMs` | *(the sandbox's own)* | Vercel's budget for one liveness probe. |
| `pollIntervalMs` | `1000` | How often `waitForExit` probes. |
| `followIntervalMs` | `1000` | How often a following `logs()` probes. |
| `deleteOrphanSnapshots` | `true` | Whether `destroy()` also collects snapshots the sandbox left behind. |

A sandbox's **name is its identity** — Vercel has no metadata or label to look one up by, and the
name also becomes a subdomain. `sandboxNameFor` therefore **throws** on an id that is not a DNS
label rather than hashing or slugifying it: a lossy mapping puts two runs in one sandbox, silently,
at whichever collision happens first.

While a wait is in flight the sandbox's stop-clock is pushed back with `extendTimeout`, which
**adds** to the deadline rather than re-applying a window — so the renewer tracks the deadline and
skips a call while there is still more than half an increment of headroom on it. It seeds that
deadline from `sandbox.expiresAt` when Vercel reports one, and from `sandboxTimeoutMs` only when it
does not. The API's own answer is preferred because the lifetime is declared twice — here and in
`VercelApiOptions.create.timeout` — and nothing checks that the two agree: declaring a lifetime
*shorter* than the truth only renews sooner than necessary, while declaring one *longer* lets the
sandbox stop in the middle of a turn.

`commandTimeoutMs` and `SandboxExecOptions.timeout` are not the same budget and should not be
conflated. `timeout` is enforced by a watchdog inside the wrapper, which survives to record the
exit code and the timeout marker. `commandTimeoutMs` is enforced by Vercel against the wrapper
itself, so a turn it kills journals no `$?` at all and surfaces as `SandboxNoExitRecordError`
rather than as a timeout.

## Authentication

**This package reads no environment variable itself.** `vercelSandboxApi` forwards the credentials
you hand it to `@vercel/sandbox`, and when you hand it none the SDK resolves its own. The three
paths, in the order the SDK tries them:

| Path | What you supply | Who reads it |
| --- | --- | --- |
| Explicit | `vercelSandboxApi({ token, teamId, projectId })` — **all three or none** | This package, forwarded to the SDK. |
| OIDC | `VERCEL_OIDC_TOKEN` in the environment | `@vercel/oidc`, a transitive dependency the SDK reaches through `getVercelOidcToken`. The token's payload carries `owner_id` and `project_id`, so nothing else is needed. |
| Vercel CLI | Nothing — the CLI's cached OAuth credentials on disk | The SDK, from the Vercel CLI's own data directory. This is why `vercel link` then `vercel env pull` is the usual local setup. |

`VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` are **not** environment variables this
package or the SDK reads. They are a naming convention from the SDK's own README for values you
read yourself and pass in:

```ts
vercelSandboxApi({
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
})
```

All three or none is enforced here rather than left to the SDK: a partial set is rejected, because
a half-applied credential fails later and further away, as an authorization error against a project
id nobody passed.

When no path resolves, the SDK throws one of its own credential errors; `vercelSandboxApi` catches
those and rethrows a `VercelSandboxAuthError` naming all three, because the SDK's message names
only the path it happened to try. For what the CLI writes and where, see
[Vercel's CLI documentation](https://vercel.com/docs/cli) — this document does not restate a file
layout it would only go stale against.

## Testing

Every module except `vercel-api.ts` takes Vercel as a **structural interface**
(`VercelSandboxLike` in `vercel-surface.ts`), never as an SDK import. `vercel-api.ts` is the single
adapter that binds the real `Sandbox` to it. So the whole backend — the probe's branch order, the
kill ladder, a forged exit record, a SIGKILLed wrapper, a recycled pid — is exercised against a
fake with no network and no credentials (`src/vercel-sandbox.fake.ts`).

The adapter is the one module that can diverge from that fake, and it has: it shipped `routes` and
`expiresAt` as values copied at construction where the fake models them as live views, which would
have made route repair — and therefore `portEndpoint` for the `sdk` driver — fail while every
other suite stayed green. `src/vercel-api.test.ts` pins those two properties specifically, driving
`surfaceOf` with a hand-rolled `Sandbox`-shaped object whose fields change under it. It is not
coverage of the adapter as a whole: the rest of `vercel-api.ts` is still only exercised against a
live Vercel account.

The package imports no `node:`, `bun:` or `cloudflare:` builtin anywhere in `src/`, which
`packages/harness-claude-code/src/closure.test.ts` asserts on every run.

## What has and has not been verified

Everything stated here is verified against `@vercel/sandbox`'s published types and, for the shell
wrapper and the liveness probe, against a real `sh` run locally — the generated scripts were
executed and their output, exit codes and journal files inspected. Nothing here has been measured
against a live Vercel sandbox. Timing, resume behaviour under load, and the exact shape of the
SDK's resume-on-410 retry are therefore taken from the types and the documentation rather than
from observation, and should be treated as open until someone runs them.
