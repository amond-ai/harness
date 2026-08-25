/**
 * A `WebSocket` that dials a Cloudflare Sandbox, wearing the constructor `ws` exports.
 *
 * `@ai-sdk/harness-claude-code` opens its bridge with `new WebSocket(endpoint.url)` from the
 * `ws` package — one value import, at one site. Rather than patch that site (a patch lives in
 * the *consuming* repo, so three consumers would carry and drift three copies of it), the
 * swap happens at the resolver: a wrangler `alias` points `ws` here. An alias is immune to the
 * adapter's release cadence and needs no upstream change.
 *
 * The shape is not a pretence. A real `WebSocket` constructor returns immediately and connects
 * afterwards, announcing itself with `open` — so starting `wsConnect` in the constructor and
 * emitting `open` when it lands is what the class is supposed to do, not a workaround. Calls
 * made in the meantime queue, exactly as they must against any client that is still
 * connecting.
 *
 * Which of the two ways to reach a bridge a URL means is read off the URL itself: one tagged
 * with {@link SANDBOX_ID_PARAM} is routed through that sandbox's binding, and an untagged one
 * — what a backend with publicly routable ports mints — is dialed. The tag is this repo's own
 * protocol between `SandboxProvider.portEndpoint` and this class, and stripping it before the
 * request is built keeps it out of the bridge's sight either way.
 *
 * Scope warning: an alias applies to the whole Worker bundle, so anything else that imports
 * `ws` at runtime gets this too. The in-sandbox bridge is unaffected: it ships as a prebuilt
 * `.mjs` and runs against the real `ws` installed inside the container.
 */
import type { SandboxOptions } from '@cloudflare/sandbox'
import type { BridgeEndpoint } from './cf-connect'
import type { WsLike } from './ws-shim'

/**
 * How the sandbox travels from the provider to here.
 *
 * The aliased module is reached by import, never by a call, so it has no configuration
 * hook — but it does not need one: the Cloudflare backend's `portEndpoint` mints the URL the
 * adapter later hands back, so it can put the id in a search param of our own. It is stripped
 * before the request is built so the bridge never sees it, and its absence is what marks an
 * endpoint as one to dial rather than to route.
 */
export const SANDBOX_ID_PARAM = '__pf_sandbox'

/**
 * The options every `getSandbox` call for a run must agree on, wherever it is made.
 *
 * Two sites resolve the same sandbox: the backend's `session()`, which the run works through,
 * and `./ws`, which opens the bridge socket into it. `normalizeId` decides how the id becomes
 * a Durable Object id and `sleepAfter` decides how long that object lives, so a site that
 * spelled either differently would address a *different* container — and nothing would say
 * so, because both calls succeed and only the bridge stays silent. Owned here for the same
 * reason {@link SANDBOX_ID_PARAM} is: it is one half of a protocol whose halves have to
 * match, and a second literal is how they stop matching.
 */
export const SANDBOX_OPTIONS: SandboxOptions = { normalizeId: true, sleepAfter: '5m' }

export interface WebSocketClassOptions {
  /** Open the bridge socket for one sandbox — normally `createBridgeSocketOpener(sandbox)`. */
  openSocket: (sandboxId: string, endpoint: BridgeEndpoint) => Promise<WsLike>
  /** Dial an endpoint that is routable as it stands — normally `createDirectSocketOpener(fetch)`. */
  dialDirect: (endpoint: BridgeEndpoint) => Promise<WsLike>
}

/** The `ws` client surface, as the adapter and `SandboxChannel` use it. */
export interface WsClient extends WsLike {}

type Handler = (...args: any[]) => void

/**
 * Where a URL sends the connect, and what is left of it once the tag is gone.
 *
 * An untagged URL is routable as it stands and is dialed untouched — nothing was added to it,
 * so there is nothing to take back out. A tagged one names the sandbox whose binding opens
 * the socket, and the tag is stripped so the bridge never sees this repo's own protocol.
 */
function routeFor(
  url: string,
  headers?: Record<string, string>,
): { sandboxId: string | null, endpoint: BridgeEndpoint } {
  const target = new URL(url)
  const sandboxId = target.searchParams.get(SANDBOX_ID_PARAM)
  if (sandboxId === null || sandboxId === '') {
    return { sandboxId: null, endpoint: { url, headers } }
  }
  target.searchParams.delete(SANDBOX_ID_PARAM)
  return { sandboxId, endpoint: { url: target.toString(), headers } }
}

/** A `WsLike` that records instead of acting, until there is a socket to replay onto. */
interface PendingSocket extends WsLike {
  /** The connect failed: report it to whoever registered `error`, now or later. */
  fail: (cause: unknown) => void
  /** The connect landed: hand everything the caller did in the meantime to the real socket. */
  replayOnto: (socket: WsLike) => void
}

/** One handler a caller registered before there was a socket to register it on. */
interface EarlyEntry {
  event: string
  handler: Handler
}

/**
 * The handlers registered while the socket was still connecting, and what became of them.
 *
 * Kept as entries rather than as a map keyed by handler because the identity of the *entry* is
 * what a deferred report checks: `off()` drops it, so its continued presence is the only thing
 * that says the caller is still listening.
 */
interface EarlyHandlers {
  /** Record one, answering the entry whose survival means "still listening". */
  add: (event: string, handler: Handler) => EarlyEntry
  remove: (event: string, handler: Handler) => void
  listening: (entry: EarlyEntry) => boolean
  forEvent: (event: string) => Handler[]
  /** Replay onto the socket, then forget: from here they are the socket's own listeners. */
  replayOnto: (socket: WsLike) => void
}

function createEarlyHandlers(): EarlyHandlers {
  let entries: EarlyEntry[] = []
  return {
    add: (event, handler) => {
      const entry = { event, handler }
      entries.push(entry)
      return entry
    },
    remove: (event, handler) => {
      entries = entries.filter(entry => !(entry.event === event && entry.handler === handler))
    },
    listening: entry => entries.includes(entry),
    forEvent: event => entries.filter(entry => entry.event === event).map(entry => entry.handler),
    replayOnto: (socket) => {
      for (const { event, handler } of entries) {
        socket.on(event as 'message', handler)
      }
      entries = []
    },
  }
}

/**
 * Report a failure that landed before this handler was registered, on a later turn.
 *
 * Deferred because a caller that registers and then immediately takes the handler back — the
 * adapter's own connect-failure cleanup — must not be called at all. The schedule alone does
 * not establish that; the entry still being registered when the turn runs is what does.
 */
function reportLater(early: EarlyHandlers, entry: EarlyEntry, cause: unknown): void {
  setTimeout(() => {
    if (early.listening(entry)) {
      entry.handler(cause)
    }
  }, 0)
}

/** What a caller sent, or asked for, while the socket was still connecting. */
interface PendingCalls {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  terminate: () => void
  /** Frames in order, then whichever give-up call was made — so neither is dropped. */
  flushOnto: (socket: WsLike) => void
}

function createPendingCalls(): PendingCalls {
  const queued: string[] = []
  let closing: { code?: number, reason?: string } | undefined
  let terminating = false
  return {
    send: data => void queued.push(data),
    close: (code, reason) => {
      closing = { code, reason }
    },
    terminate: () => {
      terminating = true
    },
    flushOnto: (socket) => {
      for (const frame of queued.splice(0, queued.length)) {
        socket.send(frame)
      }
      if (terminating) {
        socket.terminate()
      }
      else if (closing) {
        socket.close(closing.code, closing.reason)
      }
    },
  }
}

/**
 * Everything a caller did while the socket was still connecting.
 *
 * A real `WebSocket` constructor returns immediately and connects afterwards, so calls made in
 * the meantime have to queue — that is what any client does against one that is still
 * connecting, not a workaround for this one. Handlers are replayed, sends are flushed in
 * order, and a give-up call is honoured against the socket once it lands rather than dropped,
 * so a caller that abandoned the connection does not leak a live one into the sandbox.
 */
function createPendingSocket(): PendingSocket {
  const early = createEarlyHandlers()
  const calls = createPendingCalls()
  let failed: unknown

  return {
    on: ((event: string, handler: Handler) => {
      const entry = early.add(event, handler)
      if (event === 'error' && failed !== undefined) {
        reportLater(early, entry, failed)
      }
    }) as WsLike['on'],
    off: (event, handler) => early.remove(event, handler),
    send: calls.send,
    close: calls.close,
    terminate: calls.terminate,
    fail: (cause) => {
      // A client that cannot connect reports `error`; it does not throw out of a constructor
      // that already returned. Held for handlers that register later, since the failure can
      // land before the caller has attached one.
      failed = cause
      for (const handler of early.forEvent('error')) {
        handler(cause)
      }
    },
    replayOnto: (socket) => {
      early.replayOnto(socket)
      calls.flushOnto(socket)
    },
  }
}

export function createWebSocketClass(
  options: WebSocketClassOptions,
): new (url: string, init?: { headers?: Record<string, string> }) => WsClient {
  return class SandboxWebSocket implements WsClient {
    /** The pending buffer until the socket lands, and the socket itself after. */
    #target: WsLike
    #pending = createPendingSocket()

    constructor(url: string, init?: { headers?: Record<string, string> }) {
      this.#target = this.#pending
      void this.#connect(routeFor(url, init?.headers))
    }

    async #connect(route: ReturnType<typeof routeFor>): Promise<void> {
      let socket: WsLike
      try {
        socket = route.sandboxId === null
          ? await options.dialDirect(route.endpoint)
          : await options.openSocket(route.sandboxId, route.endpoint)
      }
      catch (cause) {
        this.#pending.fail(cause)
        return
      }
      this.#target = socket
      this.#pending.replayOnto(socket)
    }

    on(event: string, handler: Handler): void {
      this.#target.on(event as 'message', handler)
    }

    off(event: string, handler: Handler): void {
      this.#target.off(event, handler)
    }

    send(data: string): void {
      this.#target.send(data)
    }

    close(code?: number, reason?: string): void {
      this.#target.close(code, reason)
    }

    terminate(): void {
      this.#target.terminate()
    }
  } as new (url: string, init?: { headers?: Record<string, string> }) => WsClient
}
