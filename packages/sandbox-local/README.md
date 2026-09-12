# @amond-ai/sandbox-local

A local-process backend for [`@amond-ai/sandbox`](../sandbox): the command runs on this
machine, in a directory named after the sandbox id.

```ts
import { createLocalProvider } from '@amond-ai/sandbox-local'

const provider = createLocalProvider({ root: `${Deno.env.get('HOME')}/.myapp/sandboxes` })
const session = provider.session(sandboxIdForRun(runId))
```

It exists for the desktop case. e2b works from a desktop app, but every turn ships the user's
workspace to a remote host, needs an account and an API key, and turns an offline-capable app
into one that fails without network — which inverts the design of an app whose whole premise is
local files. Docker gives real isolation and is the honest answer for a server, but it is a
prerequisite the user has to install and keep running, and it does not help the offline case
any more than a local process does.

## This is not a sandbox

The name is the contract's, not a claim about this backend. There is **no filesystem boundary,
no network policy and no resource limit**. A command started through `exec` can read and write
anything the user can, reach the network, and use the whole machine.

What the backend does do is narrower, and worth stating exactly so nobody assumes the rest:

- paths passed to `readFile`/`writeFile`/`mkdir`/`exists` and to `exec`'s `cwd` are resolved
  *inside* the sandbox directory, and a leading `/` means the sandbox's root rather than the
  machine's — so `readFile('/etc/passwd')` reads the sandbox's copy or nothing at all. That is
  a path mapping, so that callers written against container-absolute paths keep working; it
  does not follow symlinks, and it constrains nothing a running command does;
- the sandbox directory the provider created is the only tree `destroy()` will remove.

For the desktop case this is acceptable, because the code and the machine belong to the same
person. On a server it is not a security boundary, and reaching for it as one is the mistake
this section exists to prevent.

## What it costs to run a turn

Nothing is installed. The `cli` driver execs a `claude` the machine already has and
`claudeArgv` is injected, so this backend brings no bootstrap directory, no pinned
`@anthropic-ai/*` copy, and no second platform build of a ~385 MB binary. A command inherits
the orchestrator's own environment by default — that is how `PATH` finds `claude`, and it is
one more way this is not a sandbox. Pass `env` to narrow it.

## Where things live

```text
<root>/
  <sandboxId>/                  the working directory, when the provider owns it
  .state/
    <sandboxId>/
      <processId>.out           stdout, as the wrapper redirected it
      <processId>.err           stderr
      <processId>.pid           the command's own pid, for aiming a signal
      <processId>.exit          $?, written by the wrapper after it waits
      <processId>.timeout       present when the wrapper's own watchdog killed the command
      <processId>.meta.json     the process record
```

The bookkeeping never lives inside the working directory, which is what lets the two be owned
separately — and what keeps anything shared between sandboxes (a bootstrap, a package store, a
bridge bundle) safe from a `destroy()`. Nothing removes `<root>` or `<root>/.state`.

| Option | Default | What it decides |
| --- | --- | --- |
| `root` | *(required)* | Where the provider puts the sandbox directories it owns. |
| `stateRoot` | `<root>/.state` | Where the journals and process records go. |
| `resolveRoot` | *(unset)* | Name the working directory yourself — and keep it; see below. |
| `env` | the orchestrator's own | The environment a command starts with. |
| `host` | the Node builtins | The host primitives, for a runtime that needs its own binding. |
| `loopbackHost` | `127.0.0.1` | The address `portEndpoint` answers with. |

## Ownership, and what `destroy()` removes

By default a sandbox id resolves to `<root>/<id>`, the provider created it, and `destroy()`
removes it. Pass `resolveRoot` when the app already has a workspace layout:

```ts
createLocalProvider({ root, resolveRoot: id => workspacePathFor(id) })
```

The provider then stops owning that directory. `destroy()` still ends the sandbox's processes
and still removes the provider's own state for it, and it does not delete a tree it was merely
pointed at. The decision is taken at resolution rather than argued about at deletion, so the
dangerous case cannot be reached by getting one line wrong.

## Finding a process after the app was quit

A desktop app is killed and relaunched far more casually than a worker is evicted, and the
contract requires `getProcess`/`listProcesses` to answer about a sandbox this process may never
have started. Three things make that work, and each is a decision rather than a detail:

1. **The exit code is written by the shell, not by the parent.** A host-side `'exit'` listener
   is the obvious implementation and it is wrong in exactly this case: quit the app mid-turn
   and nothing is left to observe the exit, so a turn that finished perfectly comes back as
   `SandboxNoExitRecordError`. The wrapper records `$?` from inside the tree.
2. **Liveness is verified, never inferred from the record.** Pids are reused. The record keeps
   the kernel's own start time for the pid beside it and the pair is compared, so a pid that
   was reissued after a reboot reads as gone rather than as a turn still in progress.
3. **A process is over when its *group* is empty**, not when the wrapper exited. A command that
   detaches a child and returns leaves that child writing to the checkout, and a caller told
   "finished" starts a second one beside it.

A `timeout` on `exec` is enforced by the wrapper too, for the same reason as (1): a host-side
timer would quietly stop existing the moment the app was quit.

## Ports are not per-sandbox

`portEndpoint` answers `http://127.0.0.1:<port>` — the port is on the machine that is asking,
so there is nothing to look up and no round trip to pay. There is also nothing to isolate: two
sandboxes that both bind 3000 collide, and the second fails to bind rather than getting its own
3000 the way a container would. A consumer running concurrent sandboxes has to allocate ports
itself.

Unlike the e2b backend, the scheme a caller asks for is the scheme it gets. e2b upgrades `http`
and `ws` because its ports are reached across the internet through a TLS edge and a plaintext
endpoint does not exist there; a loopback port has no edge, so upgrading could only hand back a
URL that provably cannot be dialed.

## POSIX only

Process groups, signal numbers and `ps` all mean something specific here, and Windows has no
equivalent for any of the three. macOS and Linux are supported; the real-machine suite
(`src/local.real.test.ts`) skips itself elsewhere rather than pretending.

`src/node-host.ts` is the only module that imports a `node:` builtin, and it uses specifiers
rather than any one engine's API, so it runs on Node, Bun and Deno alike. Everything else in
the package is written against the structural `LocalHost` surface it satisfies — which is what
makes pid reuse, a lost record and an orphaned child testable at all, and what
`closure.test.ts` asserts on every run.
