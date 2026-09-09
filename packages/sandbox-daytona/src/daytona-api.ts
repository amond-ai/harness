/**
 * The real `Daytona` client behind {@link DaytonaSandboxApi}.
 *
 * Everything else in this package takes Daytona as a structural interface so it can be tested
 * without a network. This file is where the actual SDK is touched, and it stays this thin on
 * purpose: the only real work is draining `Daytona.list`'s async iterator, since a label lookup
 * for one orchestrator sandbox id matches at most one sandbox.
 *
 * The package is `@daytona/sdk`, not `@daytonaio/sdk` — the latter is deprecated in favour of it
 * at the same version and with the same API (research note 035 §0).
 */
import type { DaytonaSandboxLike } from './daytona-session'
import type { DaytonaSandboxApi } from './provider'
import { Daytona } from '@daytona/sdk'

export interface DaytonaApiOptions {
  /** Falls back to Daytona's own `DAYTONA_API_KEY` lookup when unset. */
  apiKey?: string
  /** Falls back to `DAYTONA_API_URL`, whose own default is `https://app.daytona.io/api`. */
  apiUrl?: string
  /** Falls back to `DAYTONA_TARGET` — the region a created sandbox lands in. */
  target?: string
}

export function daytonaSandboxApi(options: DaytonaApiOptions = {}): DaytonaSandboxApi {
  const daytona = new Daytona({ apiKey: options.apiKey, apiUrl: options.apiUrl, target: options.target })
  return {
    create: async params => await daytona.create(params) satisfies DaytonaSandboxLike,
    connect: async sandboxId => await daytona.get(sandboxId) satisfies DaytonaSandboxLike,
    list: async (query) => {
      // Pulled once rather than drained: `list` is an async *iterator* that pages, the label
      // identifies at most one sandbox, and no state filter is passed — a stopped or archived
      // sandbox is still the one a retried step must reattach to (research note 035 §6).
      const first = await daytona.list(query).next()
      return first.done === true ? [] : [{ id: first.value.id }]
    },
  }
}
