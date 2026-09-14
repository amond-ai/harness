/**
 * The real `Sandbox` statics behind {@link VercelSandboxApi}.
 *
 * Everything else in this package takes Vercel as a structural interface so it can be tested
 * without a network. This file is where the actual SDK is touched, and it is the only one that
 * imports it — which makes {@link surfaceOf}'s `satisfies` the package's single compile-time
 * check against the real 3.3.0 types. A signature that drifts in a future SDK fails `bun run
 * check` here rather than at the first production reconnect, where the symptom would be a
 * reattach that cannot find the turn it left behind.
 *
 * Authentication is the SDK's, untouched. It resolves, in order: explicit `{ token, teamId,
 * projectId }`, all three or none; `VERCEL_OIDC_TOKEN` in the environment; the Vercel CLI's
 * OAuth file. What this file adds is the *diagnosis* — see {@link VercelSandboxAuthError}.
 */
import type { Command, CommandFinished } from '@vercel/sandbox'
import type {
  VercelCommandFinished,
  VercelCommandLike,
  VercelRunParams,
  VercelSandboxLike,
} from './vercel-surface'
import { Sandbox } from '@vercel/sandbox'
import { isNotFound, isUnauthorized } from './vercel-surface'

/**
 * `Omit` that survives a union.
 *
 * `CreateSandboxParams` is a union — the snapshot-source variant has no `runtime`/`image` at
 * all, and the image-backed one forbids `runtime` rather than merely omitting it. A plain
 * `Omit<union, K>` collapses that to the properties the members share, which silently drops
 * `source: { type: 'snapshot' }` and `image` from what a caller is allowed to pass. Distributing
 * keeps each variant whole.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * What a caller may say about a sandbox this backend creates.
 *
 * Everything `Sandbox.create` accepts except the five fields this package owns: `name` is the
 * orchestrator's sandbox id, `onResume` and `signal` belong to the call being made, and the
 * three credential fields arrive through {@link VercelApiOptions} so they are configured in one
 * place rather than per-create.
 *
 * Nothing in it is defaulted. `persistent`, `runtime`, `image`, `region`, `resources` and
 * `networkPolicy` ride through exactly as given, because each of them is a decision with a bill
 * attached and a default chosen here would be one nobody asked for and nobody can see.
 */
export type VercelCreateParams = DistributiveOmit<
  NonNullable<Parameters<typeof Sandbox.create>[0]>,
  'name' | 'onResume' | 'signal' | 'token' | 'teamId' | 'projectId'
>

export interface VercelApiOptions {
  /** With `teamId` and `projectId`, or with neither: the SDK refuses a partial set. */
  token?: string
  teamId?: string
  projectId?: string
  /** Passed verbatim to `Sandbox.getOrCreate` for a sandbox that does not exist yet. */
  create?: VercelCreateParams
}

export interface VercelSandboxApi {
  /** Get the named sandbox, creating it if there is none — atomic, and server-side. */
  getOrCreate: (name: string) => Promise<VercelSandboxLike>
  /** The named sandbox, or `undefined` when there is no such sandbox. Never creates one. */
  get: (name: string) => Promise<VercelSandboxLike | undefined>
}

/**
 * The credentials could not be resolved, and no retry will change that.
 *
 * It exists because of what the SDK's raw failure looks like when nothing is configured: the
 * OIDC lookup falls through to reading the Vercel CLI's OAuth file, and the read fails with an
 * `ERR_INVALID_ARG_TYPE` about a `"path"` argument. That names an internal call in a dependency
 * of a dependency, says nothing about Vercel and nothing about what the caller left out, and is
 * the first thing a first-time user of this backend sees. So the three ways to authenticate are
 * named in the message, and the original is kept as `cause` for whoever needs it.
 */
export class VercelSandboxAuthError extends Error {
  constructor(cause: unknown) {
    super(
      'could not authenticate against the Vercel Sandbox API. Pass `token`, `teamId` and'
      + ' `projectId` together to `vercelSandboxApi()`, or set `VERCEL_OIDC_TOKEN` in the'
      + ' environment, or sign in with the Vercel CLI (`vercel login` then `vercel link`)',
      { cause },
    )
    this.name = 'VercelSandboxAuthError'
  }
}

/**
 * The error names the SDK and its OIDC dependency raise when credentials cannot be resolved.
 *
 * Matched by `name` rather than by class for the reason {@link isNotFound} is matched by status:
 * three of these are thrown by `@vercel/oidc` through `getVercelOidcToken`, so importing the
 * classes would mean importing a transitive dependency's error surface and depending on it
 * staying exported. A name is what the SDK itself sets and what survives being re-thrown.
 */
const AUTH_ERROR_NAMES = new Set([
  'AccessTokenMissingError',
  'LocalOidcContextError',
  'OAuthError',
  'RefreshAccessTokenFailedError',
  'VercelOidcContextError',
  'VercelOidcTokenError',
])

/** Whether this rejection is the credentials failing, rather than the request. */
function isAuthFailure(cause: unknown): boolean {
  if (isUnauthorized(cause)) {
    return true
  }
  return typeof cause === 'object' && cause !== null
    && AUTH_ERROR_NAMES.has(String((cause as { name?: unknown }).name))
}

/** Re-raise an auth failure as one that says what to do; leave everything else alone. */
async function withAuthDiagnosis<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  }
  catch (cause) {
    throw isAuthFailure(cause) ? new VercelSandboxAuthError(cause) : cause
  }
}

/**
 * The signal set the SDK's `kill` accepts, derived rather than imported.
 *
 * `Signal` is not exported from the package root, and it is the one place the structural surface
 * is deliberately *wider* than the SDK: `VercelCommandLike.kill` takes `string | number` so the
 * contract's `kill(signal?: number)` can be forwarded without every file that touches a signal
 * importing this union. A widening is not something the compiler can check, so it is paid by the
 * one cast in {@link commandLike} — in the one file that already owns the SDK — and an
 * unrecognised name is refused by the API rather than by the build, which is the honest place:
 * the set of signals belongs to the sandbox, not to this package.
 */
type VercelSignal = NonNullable<Parameters<Command['kill']>[0]>

/**
 * A real `Command`, on the structural surface.
 *
 * Delegating getters rather than a snapshot, because `exitCode` is *filled in* on the instance
 * by `wait()`: copying it at adapter time would leave every recovered command reading as still
 * running forever after it exited.
 */
function commandLike(command: Command): VercelCommandLike {
  return {
    get cmdId() {
      return command.cmdId
    },
    get exitCode() {
      return command.exitCode
    },
    get startedAt() {
      return command.startedAt
    },
    get cwd() {
      return command.cwd
    },
    kill: async signal => command.kill(signal as VercelSignal),
    wait: async () => finishedLike(await command.wait()),
  } satisfies VercelCommandLike
}

/** The same, for a command the API has already reported an exit for. */
function finishedLike(command: CommandFinished): VercelCommandFinished {
  return {
    ...commandLike(command),
    get exitCode() {
      return command.exitCode
    },
    stdout: async () => await command.stdout(),
    stderr: async () => await command.stderr(),
  } satisfies VercelCommandFinished
}

/**
 * A real `Sandbox`, flattened onto the structural surface.
 *
 * Written out field by field rather than returned as-is, because three of the shapes differ —
 * `currentSession()` throws where `sessionId()` answers, `readFileToBuffer` answers a `Buffer`
 * this package may not name, and `routes` is mutable where the surface is read-only — and
 * because the `satisfies` at the end is what turns all of that into a build error if the SDK
 * moves. See this module's docblock: it is the package's only compile-time contact with 3.3.0.
 *
 * Exported for `vercel-api.test.ts` and **not** re-exported through `src/index.ts`: it is a seam
 * for the one test that can catch this module diverging from the fake every other suite runs
 * against, not a supported entry point. Consumers take {@link vercelSandboxApi}.
 */
export function surfaceOf(sandbox: Sandbox): VercelSandboxLike {
  async function runCommand(params: VercelRunParams & { detached: true }): Promise<VercelCommandLike>
  async function runCommand(params: VercelRunParams): Promise<VercelCommandFinished>
  async function runCommand(params: VercelRunParams): Promise<VercelCommandLike> {
    return params.detached === true
      ? commandLike(await sandbox.runCommand({ ...params, detached: true }))
      : finishedLike(await sandbox.runCommand({ ...params, detached: false }))
  }

  return {
    name: sandbox.name,
    // A getter, not a snapshot. `provider.ts`'s route repair calls `update({ ports })` and then
    // re-reads `routes` on this object to confirm the route landed; a copy taken at construction
    // would never change, so every repair would report that an update it had just made had routed
    // nothing. The same applies to `expiresAt`, which `extendTimeout` moves.
    get routes() {
      return sandbox.routes.map(route => ({ url: route.url, subdomain: route.subdomain, port: route.port }))
    },
    get expiresAt() {
      return sandbox.expiresAt
    },
    domain: port => sandbox.domain(port),
    // `currentSession()` throws for a sandbox with no running VM, which is an ordinary state
    // and not a failure — a sandbox that has been stopped, or one nothing has run in yet.
    sessionId: () => {
      try {
        return sandbox.currentSession().sessionId
      }
      catch {
        return undefined
      }
    },
    runCommand,
    getCommand: async cmdId => commandLike(await sandbox.getCommand(cmdId)),
    readFileToBuffer: async file => await sandbox.readFileToBuffer(file),
    writeFiles: async files => sandbox.writeFiles(files),
    update: async params => sandbox.update(params),
    extendTimeout: async ms => sandbox.extendTimeout(ms),
    delete: async opts => sandbox.delete(opts),
  } satisfies VercelSandboxLike
}

export function vercelSandboxApi(options: VercelApiOptions = {}): VercelSandboxApi {
  const { token, teamId, projectId } = options
  // All three or none: the SDK throws on a partial set rather than falling back to OIDC, so a
  // half-configured caller would get "Missing credentials parameters" where it meant "use the
  // environment". Spread as one object so there is no way to pass two of them.
  const credentials = token !== undefined && teamId !== undefined && projectId !== undefined
    ? { token, teamId, projectId }
    : {}

  return {
    // `resume: true` because this is acquisition for use, not discovery: `routes` is a plain
    // getter over `currentSession()` and is not one of the SDK's auto-resuming members, so a
    // stopped sandbox handed back unresumed throws "No active session" the moment the route
    // repair reads it. `resume` only reaches the `Sandbox.get()` fallback inside `getOrCreate`;
    // the not-found branch still creates.
    getOrCreate: async name => await withAuthDiagnosis(async () =>
      surfaceOf(await Sandbox.getOrCreate({ ...options.create, ...credentials, name, resume: true }))),
    // `resume: false` because this is discovery: the contract's `getProcess`/`listProcesses`
    // answer about a sandbox the caller may never have started, and must not be the call that
    // boots one merely to be told nothing is running in it.
    get: async name => await withAuthDiagnosis(async () => {
      try {
        return surfaceOf(await Sandbox.get({ ...credentials, name, resume: false }))
      }
      catch (cause) {
        if (isNotFound(cause)) {
          return undefined
        }
        throw cause
      }
    }),
  }
}
