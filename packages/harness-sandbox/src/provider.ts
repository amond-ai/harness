/**
 * A {@link HarnessV1SandboxProvider} over any {@link SandboxProvider}.
 *
 * Written once, over the contract, it serves every backend at once — which is what
 * `packages/amond-ai/sandbox/src/types.ts` says of this translation when it explains why the
 * file surface is declared in Cloudflare's shape rather than the harness's: "the harness's
 * own shape is a further translation, and it belongs in the harness provider — written once,
 * over the contract, for every backend at once." This is that file.
 */
import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import type { SandboxProvider } from '@amond-ai/sandbox'
import { bestEffort } from './best-effort'
import { createHarnessSandboxSession } from './session'

export interface HarnessSandboxProviderOptions {
  sandboxes: SandboxProvider
  /** Passed to every session — see `HarnessSandboxSessionOptions.defaultWorkingDirectory`. */
  defaultWorkingDirectory: string
  ports: readonly number[]
  /** Defaults to `pleaseai-<backend>`, so a diagnostic names the backend that produced it. */
  providerId?: string
  /** Defaults to `crypto.randomUUID()`. Injected only so tests can pin the minted id. */
  newSessionId?: () => string
}

export function createHarnessSandboxProvider(
  options: HarnessSandboxProviderOptions,
): HarnessV1SandboxProvider {
  const { sandboxes, defaultWorkingDirectory, ports } = options
  const newSessionId = options.newSessionId ?? (() => crypto.randomUUID())

  const session = (sandboxId: string) =>
    createHarnessSandboxSession({ sandboxes, sandboxId, defaultWorkingDirectory, ports })

  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: options.providerId ?? `pleaseai-${sandboxes.backend}`,
    // `identity` — the framework's key for snapshot-based reuse — is ignored, because the
    // contract has no snapshot primitive to key anything on. A backend that grows one answers
    // it there, through the sandbox id it is already addressed by.
    createSession: async (createOptions) => {
      // `abortSignal` has nothing to cancel. `SandboxProvider.session` is synchronous and
      // free by contract — a backend whose acquisition is genuinely async defers it to the
      // session's first call, where the caller's own signal applies.
      const created = session(createOptions?.sessionId ?? newSessionId())
      // The contract cannot report whether `session(id)` found a sandbox or minted one, so
      // `createSession` is taken as the fresh path and `resumeSession` as the returning one.
      // Dropping the callback would silently skip the setup the framework baked into it.
      //
      // The failure path is the same bug class as the kill guards in `process.ts`, one layer
      // up and with a bill attached. Setup that rejects has usually already woken the backend
      // — a write or a command is what acquires a lazily-created sandbox — and `createSession`
      // then rejects with `created` never reaching the caller, so nothing is left holding a
      // handle that could reap it and a paid Cloudflare or e2b sandbox bills until its own
      // timeout. So the failure destroys first and rethrows the cause unchanged: best-effort,
      // because a teardown that failed too would replace the setup error with its own and send
      // the caller after the wrong call, and because `session.ts` clears its teardown latch on
      // rejection, which leaves a later `destroy()` free to retry rather than replaying this one.
      try {
        await createOptions?.onFirstCreate?.(created.restricted(), {
          abortSignal: createOptions.abortSignal,
        })
      }
      catch (cause) {
        // {@link bestEffort} for the reason it documents, which is the reason `run` gives in
        // `process.ts`: the harness types `destroy()` as `PromiseLike<void>`, which has no
        // `.catch` — the session underneath returns a real promise, but the shape this code
        // holds is the harness's, and it promises nothing about when the call fails.
        await bestEffort(() => created.destroy())
        throw cause
      }
      return created
    },
    // `async`, and not `({ sessionId }) => Promise.resolve(session(sessionId))`, which is what
    // it was. `SandboxProvider.session` is synchronous by contract and a backend refuses
    // there — an unknown id, a provider already torn down — and in the `Promise.resolve` form
    // that call runs *before* any promise exists, so the throw escapes as a synchronous one.
    // A caller writing the shape this signature invites, `resumeSession(…).catch(…)`, then has
    // nothing to attach the handler to and the error lands wherever the resume was called
    // from. `async` converts it into the rejection the return type already promised, which is
    // what `createSession` above has always done.
    resumeSession: async ({ sessionId }) => session(sessionId),
  } satisfies HarnessV1SandboxProvider
}
