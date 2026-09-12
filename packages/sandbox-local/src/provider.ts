/**
 * `SandboxProvider` over the local machine.
 *
 * The two reconciliations the remote backends spend most of their provider on do not arise
 * here, and it is worth saying why rather than leaving their absence to be noticed:
 *
 * **Identity.** e2b and Daytona mint their own sandbox ids and have to map the orchestrator's
 * onto them through metadata or labels. A directory can simply be *named* the orchestrator's
 * id, so the mapping is the path — which is also why the id is validated rather than escaped
 * (`./paths.ts`): it is about to become a path component.
 *
 * **Waking.** The contract makes a reattached sandbox usable the backend's obligation, because
 * a remote one can be paused, archived, or evicted between two workflow steps. A directory is
 * never asleep. What replaces that obligation here is the one the remote backends get for free:
 * a *process* must be re-findable after the orchestrator itself has restarted, which is what
 * the registry and the journal are for.
 *
 * What is left is ownership, and it is the decision this file exists to make. By default a
 * sandbox id names a directory the provider created under its own root, and `destroy()` removes
 * it. A consumer with a workspace layout of its own passes `resolveRoot`, and the directory it
 * names is then never deleted — only the processes in it are ended and only the provider's own
 * bookkeeping is cleared. See `./paths.ts` for why that decision is taken at resolution rather
 * than argued about at deletion.
 */
import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { LocalSessionOptions } from './local-session'
import type { LocalHost } from './local-surface'
import { createLocalSession } from './local-session'
import { nodeLocalHost } from './node-host'
import { sandboxPaths } from './paths'

export interface LocalProviderOptions extends Partial<Omit<LocalSessionOptions, 'host' | 'paths'>> {
  /**
   * Where the provider keeps the sandbox directories it owns.
   *
   * Also the default parent of the state directory, which is why a sandbox id may not start
   * with a dot: `<root>/.state` has to be unmistakably not a sandbox.
   */
  root: string
  /** Bookkeeping root, when it should not live under {@link root}. */
  stateRoot?: string
  /**
   * Name the working directory for a sandbox id yourself, and keep it.
   *
   * The escape hatch for an app that already has a workspace layout. The provider stops owning
   * the directory the moment this names it: `destroy()` will end the sandbox's processes and
   * remove the provider's own state, and will not touch the tree it was pointed at.
   */
  resolveRoot?: (sandboxId: string) => string
  /** The host primitives. Defaults to the Node builtins; injected by tests, and by Deno if it must. */
  host?: LocalHost
  /**
   * The address {@link SandboxProvider.portEndpoint} hands back. Defaults to `127.0.0.1`.
   *
   * Loopback rather than a hostname, and never `0.0.0.0`: the port is being dialed by the same
   * machine that opened it, and anything broader would be an address other machines can reach —
   * which, for a backend with no network policy of any kind, is a decision no default should
   * make on a consumer's behalf.
   */
  loopbackHost?: string
}

const DEFAULT_LOOPBACK_HOST = '127.0.0.1'

/**
 * The scheme a caller that named none gets.
 *
 * `http`, and this is the one place where the local backend's default is the *opposite* of the
 * e2b backend's for the same reason. e2b answers `https` because its ports are reached across
 * the public internet through an edge that terminates TLS, and a plaintext e2b endpoint does
 * not exist. A loopback port has no edge and nothing listening on 443 unless the command in the
 * sandbox put it there, so upgrading a caller's request here could only produce a URL that
 * provably cannot be dialed. Whatever the caller asks for is what it gets.
 */
const DEFAULT_PROTOCOL = 'http'

export function createLocalProvider(options: LocalProviderOptions): SandboxProvider {
  const host = options.host ?? nodeLocalHost()
  const loopback = options.loopbackHost ?? DEFAULT_LOOPBACK_HOST

  /**
   * One session per sandbox id, for this provider's lifetime.
   *
   * Not for the reason the remote backends memoise — resolving a path costs nothing, so there
   * is no round trip to save. It is the registry's identity cache that wants to survive: a
   * fresh session per call would re-read the process table for every liveness question, and
   * the orchestrator asks one per workflow step.
   */
  const sessions = new Map<string, SandboxSession>()

  return {
    backend: 'local',
    session: (sandboxId: string) => {
      const cached = sessions.get(sandboxId)
      if (cached) {
        return cached
      }
      const created = createLocalSession({
        host,
        paths: sandboxPaths(options, sandboxId),
        env: options.env,
        newProcessId: options.newProcessId,
        now: options.now,
        monotonicNowMs: options.monotonicNowMs,
        pollIntervalMs: options.pollIntervalMs,
        followIntervalMs: options.followIntervalMs,
        identityTtlMs: options.identityTtlMs,
      })
      sessions.set(sandboxId, created)
      return created
    },
    /**
     * Where a port inside the sandbox can be reached — which is simply where it is.
     *
     * No round trip and no lookup: a local process binds a port on the machine that is asking,
     * so the answer is a formatting job. The sandbox id is still validated, because an id this
     * provider would refuse everywhere else must not be quietly accepted here.
     *
     * **Ports are not per-sandbox.** Two sandboxes that both bind 3000 collide, and the second
     * one fails to bind rather than getting its own 3000 the way a container would. That is not
     * a gap this method can close — it is the same absence of isolation the package README is
     * about — and a consumer running concurrent sandboxes has to allocate ports itself.
     */
    portEndpoint: async (
      sandboxId: string,
      port: number,
      endpointOptions?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => {
      sandboxPaths(options, sandboxId)
      const protocol = endpointOptions?.protocol ?? DEFAULT_PROTOCOL
      return { url: new URL(`${protocol}://${loopback}:${String(port)}`).toString() }
    },
  }
}
