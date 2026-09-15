/**
 * The slice of the `@vercel/sandbox` SDK this backend uses, as a structural interface.
 *
 * Taken structurally rather than imported so the session's logic is exercisable against a fake,
 * and kept in its own module so the files that speak to a sandbox — the session, the journal
 * reader, and the kill path — share one definition without importing each other for it.
 * `vercel-api.ts` is where the real SDK is bound to it, and it is the only file in the package
 * that imports `@vercel/sandbox` at all.
 *
 * Every signature here is the 3.3.0 one, confirmed against the shipped `.d.ts`. Three of them
 * are narrowed rather than transcribed, and each narrowing is a decision:
 *
 * - {@link VercelSandboxLike.readFileToBuffer} answers a `Uint8Array`, not the SDK's `Buffer`.
 *   `Buffer` is a `Uint8Array` at runtime and a `node:buffer` type at compile time, and this
 *   package has to typecheck and run wherever a `fetch` does.
 * - {@link VercelSandboxLike.sessionId} is a *method returning `string | undefined`*, not the
 *   SDK's `currentSession()`. That call **throws** when the sandbox has no active session, which
 *   is an ordinary state for a sandbox nobody has run anything in yet; a caller that has to
 *   wrap every read of it in a `try` reads the absence as a failure sooner or later.
 * - `kill` widens the SDK's `Signal` union to `string | number`, so the contract's `kill(signal?:
 *   number)` can be carried through without every file that forwards a signal importing the
 *   SDK's type for it. An unrecognised name is then refused by the API rather than by the
 *   compiler, which is the honest place: the set of signals is the sandbox's, not ours.
 *
 * Deliberately absent, and not by oversight:
 *
 * - `sandbox.fs` — a `node:fs/promises`-shaped surface whose types name `Buffer` and `Dirent`.
 * - `readFile` — returns a `NodeJS.ReadableStream`, which is the same import one layer down.
 *   Its absence is what makes {@link JournalIo.readSliceFrom} a whole-file read; see the cost
 *   noted there.
 * - `stop`, `fork`, `listSessions`, `openInteractive`, `mounts`, `networkPolicy` — no caller in
 *   this backend reaches for them, and a structural surface that declares what nobody calls
 *   bills every fake for implementing it.
 */

/** One exposed port, as the SDK's `SandboxRouteData` carries it. */
export interface VercelRoute {
  readonly url: string
  readonly subdomain: string
  readonly port: number
}

/** The SDK's `RunCommandParams`, minus the two `Writable` fields no portable runtime has. */
export interface VercelRunParams {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  sudo?: boolean
  detached?: boolean
  signal?: AbortSignal
  /** The sandbox's own per-command budget, enforced at exec time with SIGKILL. */
  timeoutMs?: number
}

/**
 * The SDK's `Command`, narrowed to what this backend reads.
 *
 * `startedAt` is epoch **milliseconds**, not an ISO string — the contract's `ProcessStatus`
 * wants the latter, and the conversion is the session's job rather than a lie told here.
 */
export interface VercelCommandLike {
  readonly cmdId: string
  /** `null` until the command has been waited on, or looked up after it exited. */
  readonly exitCode: number | null
  readonly startedAt: number
  readonly cwd: string
  kill: (signal?: string | number) => Promise<void>
  wait: () => Promise<VercelCommandFinished>
}

/**
 * A command the API has already reported an exit for — the SDK's `CommandFinished`.
 *
 * `stdout`/`stderr` are here and not on {@link VercelCommandLike} because they are collected
 * output, which only means anything once there is no more of it coming. A turn's transcript is
 * read from the journal instead; these serve the short, bounded commands this backend runs
 * *about* a turn — `ls`, `test -d`, `wc -c` — where the output is the answer.
 */
export interface VercelCommandFinished extends VercelCommandLike {
  readonly exitCode: number
  stdout: () => Promise<string>
  stderr: () => Promise<string>
}

/**
 * `runCommand`'s two shapes, as one callable.
 *
 * The overload is the whole reason this is an interface rather than a field type: `detached:
 * true` hands back a live {@link VercelCommandLike} whose exit is not known yet, and everything
 * else resolves only once the command has finished. A single signature returning the union
 * would make every caller of the short commands narrow an exit code that is always there.
 */
export interface VercelRunCommand {
  (params: VercelRunParams & { detached: true }): Promise<VercelCommandLike>
  (params: VercelRunParams): Promise<VercelCommandFinished>
}

export interface VercelSandboxLike {
  /** The sandbox's name, which is the id `Sandbox.get` resolves. */
  readonly name: string
  readonly routes: readonly VercelRoute[]
  /** The public host for a port. **Throws** `No route for port <p>` when it is not routed. */
  domain: (port: number) => string
  /** The running VM's id, or `undefined` when there is no session — see the module docblock. */
  sessionId: () => string | undefined
  /**
   * When Vercel will stop this sandbox, as the API reported it — `undefined` when it did not.
   *
   * The authoritative seed for `lifetime.ts`'s deadline, and the reason it is worth a field of
   * its own: a consumer declares the lifetime twice today, once in `VercelApiOptions.create` and
   * once as `sandboxTimeoutMs`, and nothing checks that the two agree. A declared lifetime that
   * is *shorter* than the truth only renews sooner than necessary; one that is *longer* lets the
   * sandbox stop mid-turn. Reading the real deadline removes the whole class rather than the
   * harmless half.
   */
  readonly expiresAt: Date | undefined
  runCommand: VercelRunCommand
  getCommand: (cmdId: string) => Promise<VercelCommandLike>
  /** `null` for a file that is not there, rather than a rejection. */
  readFileToBuffer: (file: { path: string }) => Promise<Uint8Array | null>
  writeFiles: (files: { path: string, content: string | Uint8Array, mode?: number }[]) => Promise<void>
  /** `ports` is the *full* desired list: a port left out of it is deregistered. */
  update: (params: { ports?: number[], timeout?: number }) => Promise<void>
  /** **Adds** to the deadline rather than restarting it, and is capped by the plan's maximum. */
  extendTimeout: (ms: number) => Promise<void>
  delete: (opts?: { deleteOrphanSnapshots?: boolean }) => Promise<void>
}

/** The HTTP status a rejection carries, when it carries one at all. */
function statusOf(cause: unknown): unknown {
  if (typeof cause !== 'object' || cause === null) {
    return undefined
  }
  return (cause as { response?: { status?: unknown } }).response?.status
}

/**
 * Whether a rejection is Vercel's "there is no such thing", and not any other failure.
 *
 * The discriminator is `response.status`, not the error class. `APIError` is exported by the
 * SDK, but importing it here would put the real SDK in every file that asks the question and end
 * the property this package is built on — the whole backend is exercisable against a fake.
 * `daytona-surface.ts:107` carries the same reasoning one field over, where the status lives
 * directly on the error instead of on a `Response`.
 *
 * The distinction is load-bearing wherever absence and failure mean opposite things: `get`
 * answers `undefined` only for a sandbox confirmed gone, `entries()` answers `[]` only for a
 * journal root confirmed missing, and a transport blip must reach neither as "nothing here".
 */
export function isNotFound(cause: unknown): boolean {
  return statusOf(cause) === 404
}

/**
 * Whether a rejection is the API refusing the caller's credentials.
 *
 * Read the same way and for the same reason as {@link isNotFound}. It exists separately because
 * 401 and 403 are the one class of failure a retry cannot fix and a message can: they are turned
 * into a {@link import('./vercel-api').VercelSandboxAuthError} naming the three ways to
 * authenticate, rather than surfacing as one more transport failure the caller will retry.
 */
export function isUnauthorized(cause: unknown): boolean {
  const status = statusOf(cause)
  return status === 401 || status === 403
}
