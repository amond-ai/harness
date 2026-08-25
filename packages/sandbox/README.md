# @pleaseai/sandbox-contract

The sandbox surface the orchestrator runs against — **owned here, not borrowed**.

`apps/cf-orchestrator` used to type its sandbox against `@cloudflare/sandbox`'s own
`ISandbox` and `SandboxProcess`. That made the platform a compile-time fact: every module
that touched a process imported Cloudflare, so a second backend could not exist without
rewriting the call sites. This package is those shapes, restated as a contract the
orchestrator owns.

```ts
interface SandboxProvider {
  readonly backend: string
  session: (sandboxId: string) => SandboxSession
}

interface SandboxSession {
  exec: (command: SandboxCommand, options?: SandboxExecOptions) => Promise<SandboxProcessHandle>
  getProcess: (id: string) => Promise<SandboxProcessHandle | null>
  listProcesses: () => Promise<ProcessStatus[]>
  exists: (path: string) => Promise<{ exists: boolean }>
  destroy: () => Promise<void>
}

interface SandboxProcessHandle {
  readonly id: string
  status: () => Promise<ProcessStatus>
  logs: (options?: ProcessLogsOptions) => Promise<ReadableStream<ProcessLogEvent>>
  waitForExit: (options?: WaitForExitOptions) => Promise<ProcessExit>
  kill: (signal?: number) => Promise<void>
}
```

## Why the shapes are copies, not imports

They are structural copies of Cloudflare's, deliberately. Importing them would put the
vendor dependency back in every consumer — the thing this package exists to remove — while
inventing different ones would mean writing and maintaining a mapping layer for the backend
that already has the right semantics.

The copy costs nothing and buys both: `getSandbox(...)`'s return value satisfies
`SandboxSession` with **zero mapping**, so `sandbox-cloudflare.ts` in the orchestrator is a
naming layer that returns the client unchanged, and its `satisfies SandboxProvider` fails at
build time if upstream ever diverges — rather than at the first replay in production.

## What a backend must supply

**Process durability.** `getProcess` + `logs({ replay: true })` are the load-bearing pair: the
run workflow reads a turn's transcript **after** the process exits. The Cloudflare container
retains that natively. A backend where it does not — e2b drops a process from
`commands.list()` the moment it exits and `commands.connect(pid)` then throws — has to
reproduce the durability itself. See [`@pleaseai/sandbox-e2b`](../sandbox-e2b) for what that
costs, and research note 027 for the measurements.

**A wait that ends before the process does must reject.** `waitForExit` resolving a synthetic
exit for an expired wait is not a lesser version of throwing — it is the opposite claim. Every
caller's `catch` *is* its timeout path (`killTurn`, `materializationExit`, `awaitTurn` in
`run/run-workflow.ts`), so resolving converts "I stopped watching" into "it is dead", and the
workflow starts a second turn beside the first. `SandboxWaitTimeoutError` is the
contract's spelling of that rejection.

**A credential path for repository access** — which the contract does **not** express, and
which a reader of the two obligations above would wrongly conclude is not owed. On Cloudflare
it is supplied out of band: `apps/cf-orchestrator/src/index.ts` sets `Sandbox.outboundByHost`
so the container's egress to github.com is intercepted *in the Worker* and the git credential
injected there, outside the container (`run/git-credentials.ts` — nothing authenticating ever
reaches the container's filesystem, environment, or argv). An e2b microVM's egress never
traverses the Worker, so **the e2b backend does not supply this yet**: a run against a private
repository fails at clone, and one against a public repository clones anonymously and then
fails at `git push`. Solving it is not a matter of putting a token in `envs` — that would hand
the turn an unscoped, long-lived credential, which is the arrangement the Cloudflare path
exists to avoid.

## Implementations

| Backend | Package | Notes |
| --- | --- | --- |
| `cloudflare` | `apps/cf-orchestrator/src/run/sandbox-cloudflare.ts` | Wraps `getSandbox` — no mapping |
| `e2b` | [`@pleaseai/sandbox-e2b`](../sandbox-e2b) | Journals transcripts and exit status to the sandbox filesystem |

`SANDBOX_BACKEND` selects between them; see `apps/cf-orchestrator/src/run/sandbox-provider.ts`.
