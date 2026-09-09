/**
 * The real `Sandbox` statics behind {@link E2bSandboxApi}.
 *
 * Everything else in this package takes e2b as a structural interface so it can be tested
 * without a network. This file is where the actual SDK is touched, and it stays this thin
 * on purpose: the only real work is flattening `Sandbox.list`'s paginator, since a metadata
 * lookup for one orchestrator sandbox id matches at most one sandbox and never needs a
 * second page.
 */
import type { E2bSandboxLike } from './e2b-session'
import type { E2bSandboxApi } from './provider'
import { Sandbox } from 'e2b'

export interface E2bApiOptions {
  /** Falls back to e2b's own `E2B_API_KEY` lookup when unset. */
  apiKey?: string
}

export function e2bSandboxApi(options: E2bApiOptions = {}): E2bSandboxApi {
  const { apiKey } = options
  return {
    create: async (template, opts) =>
      await Sandbox.create(template, { ...opts, apiKey }) satisfies E2bSandboxLike,
    connect: async sandboxId =>
      await Sandbox.connect(sandboxId, { apiKey }) satisfies E2bSandboxLike,
    kill: async sandboxId => await Sandbox.kill(sandboxId, { apiKey }),
    list: async (query) => {
      const page = await Sandbox.list({ query: { metadata: query }, apiKey }).nextItems()
      return page.map(info => ({ sandboxId: info.sandboxId }))
    },
  }
}
