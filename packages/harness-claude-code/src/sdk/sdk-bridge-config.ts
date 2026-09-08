/**
 * Everything about *where* and *how* a turn host is started, decided without touching anything.
 *
 * Import-free on purpose: the port a turn's bridge listens on, the credential that gates it and
 * the directory its journal lives in are the parts a test has to be able to pin exactly, and the
 * modules that exec and dial are not reachable from `bun test`.
 */

/** The bundle `docker/Dockerfile` bakes at `/opt/turn-host`; `node` runs it. */
export const TURN_HOST_BUNDLE = '/opt/turn-host/bridge.mjs'

/**
 * The first port a turn host binds, with the attempt as the offset.
 *
 * Fixed by the Worker rather than left ephemeral, which is a departure from upstream's default
 * of `0`, and it buys two things. A replayed `start-turn-N` that adopts a live host knows the
 * port by arithmetic instead of by re-reading a log line that may have aged out; and the
 * `TurnHandle` — a persisted step result — stays a fact the Worker chose rather than one it
 * observed.
 *
 * The attempt is the offset because **the host does not exit when the turn ends**: only `stop`
 * and `destroy` end the process (`bridge-runtime.ts`), so a second attempt starting on the same
 * fixed port would collide with a predecessor that has not been torn down yet. The driver does
 * send `destroy` at every terminal frame, and the offset is what makes the collision impossible
 * rather than merely unlikely.
 *
 * High enough to sit above anything the image itself binds, and **below** Linux's default
 * ephemeral floor of 32768 (`net.ipv4.ip_local_port_range` is 32768-60999) so a host port cannot
 * be handed out to an outbound connection first. The image reserves nothing —
 * `ip_local_reserved_ports` is empty and a container cannot set it — so staying under the floor
 * is the whole protection: a turn's own `git fetch` or API call taking 30001 before the host
 * bound it would fail the host's listen, which is the failure this number exists to avoid.
 */
export const TURN_HOST_BASE_PORT = 30_000

export function turnHostPort(attempt: number): number {
  return TURN_HOST_BASE_PORT + attempt
}

/**
 * Where one attempt's bridge state — `event-log.ndjson` above all — lives inside the sandbox.
 *
 * Under the workspace root rather than the container home, and that is not arbitrary. The two
 * images run as different users with different homes (`/root` in the Cloudflare sandbox,
 * `/home/user` on e2b — the same asymmetry `E2B_JOURNAL_ROOT` exists for), while `WORKDIR` is
 * `/workspace` in both and writable by both. A state dir derived from the home would be the
 * `E2B_JOURNAL_ROOT` trap again: the host would fail to write its journal and the turn would
 * present as a missing transcript.
 *
 * A sibling of the checkout, never inside it: the checkout is `${workspaceRoot}/${repository}`,
 * so nothing here can be committed by the turn it is recording.
 *
 * Derived from the run and the attempt rather than carried anywhere, so the settle path can
 * name the journal from a `RunWorkflowResult` alone (`replay-turn.ts`).
 */
export function turnHostStateDir(input: {
  workspaceRoot: string
  runId: string
  attempt: number
}): string {
  return `${input.workspaceRoot}/.turn-host/${input.runId}/${String(input.attempt)}`
}

/** `<stateDir>/event-log.ndjson` — the name `bridge-runtime.ts` writes the journal under. */
export function turnHostJournalPath(stateDir: string): string {
  return `${stateDir}/event-log.ndjson`
}

/**
 * The host's argv.
 *
 * Both flags are hard-fatal in the host (`main.ts` writes `bridge-fatal` and exits 1 without
 * either), so the driver never omits `--workdir`: a turn with no checkout is legal here and
 * would otherwise die at exec. It is defaulted in the driver rather than in the host so a
 * missing flag stays a host fatal that reaches nobody and a driver bug that is caught by a test.
 *
 * The channel token is deliberately *not* here. Argv is what the adoption guard compares and
 * what `listProcesses()` reports, so a token in it would be a credential in a diagnostic
 * surface; it travels in the environment, where the run's other credentials already do.
 */
export function turnHostArgv(input: {
  workdir: string
  stateDir: string
}): readonly [executable: string, ...args: string[]] {
  return ['node', TURN_HOST_BUNDLE, '--workdir', input.workdir, '--bridge-state-dir', input.stateDir]
}

/**
 * The bridge's own two variables, merged over the environment the caller assembled.
 *
 * `BRIDGE_CHANNEL_TOKEN` is required by the host, which throws *before binding* when it is
 * empty — so an unconfigured token is a `bridge-fatal` on stdout and a closed port, never an
 * open one. `BRIDGE_WS_PORT` is the port above.
 */
export function turnHostEnv(
  base: Record<string, string>,
  bridge: { token: string, port: number },
): Record<string, string> {
  return { ...base, BRIDGE_CHANNEL_TOKEN: bridge.token, BRIDGE_WS_PORT: String(bridge.port) }
}

/**
 * The upgrade credential for one turn: 32 random bytes, hex.
 *
 * Minted per turn and carried on the `TurnHandle` so a replayed `start-turn-N` that adopts a
 * live host presents the token that host was started with. That does put it in a Workflow step
 * result, which is durable storage — accepted, because the token authorises nothing beyond one
 * bridge port inside one container the Worker already controls end to end, and the alternative
 * (an HMAC of `runId:attempt`) buys that back only by adding a Workers secret this stage was
 * not asked to introduce.
 *
 * The entropy source is a parameter so a test can pin the value; production passes
 * `crypto.getRandomValues`.
 */
export function mintChannelToken(fill: (into: Uint8Array) => void): string {
  const bytes = new Uint8Array(32)
  fill(bytes)
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** The bridge's query parameter, spelled as `bridge-runtime.ts` reads it off the upgrade URL. */
const BRIDGE_TOKEN_PARAM = 'agent_bridge_token'

/**
 * The dialable URL, with the token the bridge gates the upgrade on.
 *
 * Neither backend's `portEndpoint` adds it — on Cloudflare the URL is a tag carrying
 * `__pf_sandbox`, on e2b a public host — because the harness adapter used to append it and
 * this driver does not use the adapter. A connect that skipped this authenticates as nobody
 * and is closed with 1008, which is a refusal with nothing pointing at its cause.
 *
 * Every other part of the URL survives byte-for-byte, `__pf_sandbox` included: that tag is what
 * tells the transport to route through the sandbox binding rather than dial.
 */
export function bridgeEndpointUrl(url: string, token: string): string {
  const target = new URL(url)
  target.searchParams.set(BRIDGE_TOKEN_PARAM, token)
  return target.toString()
}

/** What the host announces on stdout before it serves anything. */
export type BridgeAnnouncement
  = | { status: 'ready', port: number }
    | { status: 'fatal', message: string }

/**
 * Read the host's stdout for the one line that says it is listening — or the one that says it
 * never will be.
 *
 * Verified against the real bundle rather than read: `node bridge.mjs` with `BRIDGE_WS_PORT`
 * set writes `{"type":"bridge-ready","port":<n>}` to the real stdout, and it does so from the
 * server's `listening` handler — before any turn, and therefore before the console capture that
 * a later `start` may install. (That capture forwards to the original writer anyway, so the line
 * would survive it either way.)
 *
 * `bridge-fatal` is the other half and the reason this parses rather than merely waits: a host
 * with no channel token, or one whose port is taken, prints it and exits 1. Waiting for a ready
 * line that is never coming would spend the whole readiness budget on a failure that named
 * itself in the first millisecond.
 *
 * Lines that are neither are ignored rather than refused: the host is free to print anything
 * else on its way up, and a strict reader would turn a log line into a failed turn.
 */
export function readBridgeAnnouncement(text: string): BridgeAnnouncement | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    }
    catch {
      continue
    }
    const frame = parsed as { type?: unknown, port?: unknown, message?: unknown }
    if (frame.type === 'bridge-ready' && typeof frame.port === 'number') {
      return { status: 'ready', port: frame.port }
    }
    if (frame.type === 'bridge-fatal') {
      return { status: 'fatal', message: typeof frame.message === 'string' ? frame.message : 'unknown' }
    }
  }
  return undefined
}
