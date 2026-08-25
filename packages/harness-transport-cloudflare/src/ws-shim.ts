/**
 * A platform `WebSocket` wearing the `ws` package's face.
 *
 * `@ai-sdk/harness-claude-code` opens its bridge socket with the `ws` package, which cannot
 * run in a Worker at all: workerd resolves ws's `browser` export condition to a stub that
 * throws, and forcing its node entry dies at construction because workerd's `node:http`
 * `ClientRequest` does not implement `options.createConnection` (measured — see
 * `apps/cf-orchestrator/test/workerd-spike/`). Cloudflare hands out a perfectly good socket
 * from `Sandbox.wsConnect`; it just speaks `addEventListener`, while the adapter and
 * `@ai-sdk/harness`'s own `SandboxChannel` speak `.on()`. This is that translation, and
 * nothing more.
 *
 * The surface is deliberately the *used* one, read off both consumers rather than guessed:
 * `SandboxChannel` calls `on`, `send` and `close`; the adapter's connect path calls `on`,
 * `off` and `terminate`. Events are `open`, `message`, `close` and `error`. Widen it when a
 * caller appears, not before.
 */

/**
 * The four events a platform `WebSocket` reports, spelled out rather than left as `string`.
 *
 * workerd's own `WebSocket` types `addEventListener` against `keyof WebSocketEventMap`, so a
 * `string` parameter here makes the real socket unassignable to this interface — which is
 * only visible from a project that compiles both, and cost a build once it was one.
 */
export type PlatformEvent = 'open' | 'message' | 'close' | 'error'

/** The half of the platform `WebSocket` this module consumes. */
export interface PlatformSocket {
  addEventListener: (type: PlatformEvent, listener: (event: any) => void) => void
  removeEventListener: (type: PlatformEvent, listener: (event: any) => void) => void
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

/**
 * A close reason that answers `.toString('utf8')`.
 *
 * `SandboxChannel.wire` reads the reason as `reason?.toString?.('utf8') ?? ''` because `ws`
 * hands it a `Buffer`. A plain string satisfies that call — `String.prototype.toString`
 * ignores the argument — so the reason crosses unchanged rather than being re-encoded.
 */
export type CloseReason = string

export interface WsLike {
  // `error` carries the cause: `SandboxChannel.wire` ignores it, but the adapter's own handler
  // is `err => settle(err)`, so a no-argument signature here would type away the only thing
  // that explains a failed connect.
  on: ((event: 'open', handler: () => void) => void)
    & ((event: 'error', handler: (err: unknown) => void) => void)
    & ((event: 'message', handler: (raw: string | ArrayBuffer) => void) => void)
    & ((event: 'close', handler: (code: number, reason: CloseReason) => void) => void)
  off: (event: string, handler: (...args: any[]) => void) => void
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  terminate: () => void
}

/**
 * What `ws` reports for an abnormal close — the code a dropped socket's peer synthesises.
 *
 * Read-only here: it fills in a close event that arrived without one, and is never *sent*.
 * RFC 6455 §7.4.1 reserves 1006 for exactly that synthesis and forbids an endpoint from
 * putting it in a close frame, and workerd enforces the ban — see `terminate()` below.
 */
const ABNORMAL_CLOSURE = 1006

/**
 * How much unread bridge traffic is held before the socket is given up on — see
 * {@link createFrameBuffer} for why there is a budget at all, and why overflow closes rather
 * than dropping. 8 MiB is far past any handover, so reaching it means a stall.
 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024

/**
 * One encoder for every frame measured, since {@link frameBytes} runs per queued frame.
 *
 * `TextEncoder` is stateless for `encode`, so a shared instance is the same measurement
 * without an allocation per call.
 */
const FRAME_ENCODER = new TextEncoder()

/**
 * What one frame costs the queue, in bytes rather than in whatever `length` happens to count.
 *
 * A string's `length` is UTF-16 code units. One `가` is one code unit and three UTF-8 bytes, so
 * a code-unit count under-reads a non-ASCII frame by up to 3x — and an 8 MiB cap counted that
 * way bounds up to 24 MiB, which is not the cap it claims to be. Claude's `stream-json` relays
 * arbitrary user text, so that is the ordinary case rather than a contrived one.
 *
 * Measured exactly rather than bounded conservatively — `length * 3` would be O(1) and never
 * under-read, but it would also close on 2.67 MiB of ASCII while claiming 8 MiB, which trades
 * one wrong number for another. The encode pass is affordable because of where it is called
 * from: {@link frameCharge} is its only caller and {@link createFrameBuffer}'s `push` the only
 * caller of that, and a frame is only pushed while the queue is *holding* — the delivered path
 * never reaches here. So the cost falls on the handover window (a few frames), and each copy is
 * of a frame already in memory and is garbage immediately. A frame already over the budget does
 * not pay it at all — see {@link frameCharge}.
 */
function frameBytes(raw: unknown): number {
  if (typeof raw === 'string') {
    return FRAME_ENCODER.encode(raw).byteLength
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength
  }
  return ArrayBuffer.isView(raw) ? raw.byteLength : 0
}

/**
 * What to charge the queue for one frame — exactly, unless exactness cannot change the answer.
 *
 * {@link frameBytes} is exact and that is why it allocates: `encode` returns a fresh
 * `Uint8Array` per call, up to 3x the frame. For a frame that *fits* that copy is the price of
 * a cap that means what it says, and it is bounded by a string already resident. For a frame
 * already past the budget it is the price of confirming a rejection — an allocation the cap
 * exists to prevent, made on the path taken because memory is running out, inside an isolate
 * capped at 128 MiB (cubic review, PR #268).
 *
 * A UTF-16 code unit encodes to at least one UTF-8 byte (a surrogate pair is two units and four
 * bytes), so `length` is a lower bound on the exact count and never over-reads. A frame over
 * budget by the bound is therefore over budget measured exactly, and the caller resets the
 * total on that branch anyway, so the imprecise number is never carried forward. Nothing is
 * traded: the cap stays exact wherever exactness decides anything.
 */
function frameCharge(pendingBytes: number, raw: unknown): number {
  const lowerBound = typeof raw === 'string' ? raw.length : frameBytes(raw)
  return pendingBytes + lowerBound > MAX_PENDING_BYTES ? lowerBound : frameBytes(raw)
}

/** A `ws`-shaped handler, and the platform listener registered on its behalf. */
type Handler = (...args: any[]) => void
type Wrapper = (event: any) => void

/**
 * Where a handler's platform listener is kept, so `off` can find the one it registered.
 *
 * Handlers are not forwarded straight to `addEventListener` because each one needs the event
 * unwrapped into `ws`'s positional arguments. Keying by handler keeps `off` exact: removing
 * one listener must not silence a sibling watching the same event.
 */
function createWrapperRegistry(): (event: string) => Map<Handler, Wrapper> {
  const wrappers = new Map<string, Map<Handler, Wrapper>>()
  return (event) => {
    const existing = wrappers.get(event)
    if (existing) {
      return existing
    }
    const created = new Map<Handler, Wrapper>()
    wrappers.set(event, created)
    return created
  }
}

/** One platform event, unwrapped into the positional arguments `ws` hands its handlers. */
function positionalWrapper(event: string, handler: Handler): Wrapper {
  if (event === 'close') {
    return (raw: any) => handler(raw?.code ?? ABNORMAL_CLOSURE, raw?.reason ?? '')
  }
  return (raw: any) => handler(raw)
}

interface MessageQueue {
  /** Attach a handler, handing it whatever queued if the socket has already been announced. */
  add: (handler: (raw: unknown) => void) => void
  remove: (handler: (raw: unknown) => void) => void
  /** The socket is now announced open: deliver from here on, starting with what queued. */
  announceOpen: () => void
}

/**
 * Frames that arrived before anything could be handed them.
 *
 * There are three windows, and in all of them a dropped frame is invisible — the bridge
 * considers it sent and the host simply waits forever. The socket is live from `accept()`,
 * which runs inside the opener, while the adapter attaches its `message` handler only after
 * the returned promise resolves; the bridge sends `bridge-hello` at once, so it can land in
 * that gap. The second window is the handover: the adapter `off`s its own handlers before
 * `SandboxChannel.wire` attaches its own. The third is the turn before the synthetic `open`
 * is reported, which is held back for its own reason — see {@link createOpenAnnouncer}.
 *
 * So delivery is gated on both a listener and an announced socket rather than on the event
 * arriving: short of either, the payload queues, and the queue drains in order the moment
 * both hold. `ws` over a real socket gets the same effect for free from Node's I/O queue;
 * here it has to be explicit.
 */
interface FrameBuffer {
  /** Hold a frame — or give up on the socket, if the budget is spent. */
  push: (raw: unknown) => void
  /** Everything held, in arrival order, leaving the buffer empty. */
  takeAll: () => unknown[]
  size: () => number
}

/**
 * The held frames, and the budget that stops them accumulating without end.
 *
 * The queue covers a handover measured in one turn; it is not a buffer for a stream. The
 * bridge relays Claude's `stream-json` output, which is unbounded, so a consumer that stops
 * draining — or never attaches at all — would turn this into an unbounded allocation inside a
 * Worker isolate capped at 128 MiB. {@link MAX_PENDING_BYTES} is far past any handover and can
 * only be reached by a stall, so reaching it is read as one.
 *
 * Overflow closes rather than dropping a frame from either end. Dropping is what the queue
 * exists to prevent: a bridge protocol frame that silently never arrives leaves the host
 * waiting forever, and picking the oldest or the newest only chooses which hang to get. A
 * closed socket is a failure the caller can see — see {@link createCloseLatch} for what makes
 * that true when nobody is listening yet.
 */
function createFrameBuffer(socket: PlatformSocket): FrameBuffer {
  const pending: unknown[] = []
  let pendingBytes = 0
  return {
    push: (raw) => {
      pendingBytes += frameCharge(pendingBytes, raw)
      if (pendingBytes > MAX_PENDING_BYTES) {
        pending.length = 0
        pendingBytes = 0
        socket.close()
        return
      }
      pending.push(raw)
    },
    takeAll: () => {
      pendingBytes = 0
      return pending.splice(0, pending.length)
    },
    size: () => pending.length,
  }
}

function createMessageQueue(socket: PlatformSocket): MessageQueue {
  const buffer = createFrameBuffer(socket)
  const handlers = new Set<(raw: unknown) => void>()
  let opened = false

  const deliver = (raw: unknown): void => {
    for (const handler of handlers) {
      handler(raw)
    }
  }

  const drain = (): void => {
    // Nothing held, or nobody to hand it to. The second guard is load-bearing and was once
    // missing: `announceOpen` drains unconditionally, and the open turn is scheduled at
    // construction while the adapter attaches its `message` handler only after the opener's
    // promise resolves. Nothing orders those two, so the open turn routinely runs first — and
    // without this it emptied the queue into an empty handler set, discarding the very
    // `bridge-hello` the queue exists to hold.
    if (buffer.size() === 0 || handlers.size === 0) {
      return
    }
    for (const raw of buffer.takeAll()) {
      deliver(raw)
    }
  }

  socket.addEventListener('message', (event: any) => {
    const raw = event?.data
    if (opened && handlers.size > 0) {
      deliver(raw)
      return
    }
    buffer.push(raw)
  })

  return {
    add: (handler) => {
      const wasIdle = handlers.size === 0
      handlers.add(handler)
      if (wasIdle && opened) {
        drain()
      }
    },
    remove: handler => void handlers.delete(handler),
    announceOpen: () => {
      opened = true
      drain()
    },
  }
}

interface OpenAnnouncer {
  /** Whether the open turn has already run. */
  announced: () => boolean
  /** Give a handler that registered after that turn one of its own. */
  scheduleLate: (handler: () => void) => void
}

/**
 * `open` never arrives, so it is delivered here.
 *
 * A socket from `wsConnect` is already open by the time `accept()` returns — the event fired,
 * if it ever did, before this shim existed. The adapter waits for it: its `onOpen` is what
 * sets `opened`, starts the `bridge-hello` timer and resolves the connect promise, so a shim
 * that stayed faithful to "no event, no call" would hang every connection until
 * `openTimeoutMs` and report a timeout for a socket that was open the whole time.
 *
 * The turn is scheduled here rather than from the first `on('open')`, so it runs whether or
 * not anyone asked for the event: the message queue is gated on it, and a consumer that only
 * listens for `message` would otherwise never be handed a frame. Delivery is asynchronous so
 * a caller that registers and then immediately removes — the adapter's own cleanup path — is
 * not called at all, and a handler that registers after the turn gets one of its own, since
 * it would otherwise never hear the event.
 */
function createOpenAnnouncer(
  wrappersFor: (event: string) => Map<Handler, Wrapper>,
  messages: MessageQueue,
): OpenAnnouncer {
  let announced = false
  const fire = (handler: () => void): void => {
    if (wrappersFor('open').has(handler)) {
      handler()
    }
  }
  setTimeout(() => {
    announced = true
    for (const handler of [...wrappersFor('open').keys()]) {
      fire(handler as () => void)
    }
    // After the handlers, never before: the whole point of holding the queue back is that
    // nothing is delivered until the state `onOpen` sets up actually exists.
    messages.announceOpen()
  }, 0)
  return {
    announced: () => announced,
    scheduleLate: handler => void setTimeout(fire, 0, handler),
  }
}

interface CloseLatch {
  /** The close event, if the socket has already reported one. */
  reported: () => { code: number, reason: CloseReason } | undefined
}

/**
 * The close event, remembered for a handler that was not there to hear it.
 *
 * Same window as the message queue's, and for the same reason: the socket is live from
 * `accept()`, and during the adapter-to-`SandboxChannel` handover there is a stretch with no
 * `close` handler registered at all. A platform event does not replay, so a close landing in
 * that stretch is simply lost — measured: a handler attached after the event fired hears
 * nothing, while one attached before hears it normally.
 *
 * That matters most for the one close this module issues itself. The overflow branch in
 * {@link createMessageQueue} closes deliberately, so the caller can *see* a stalled bridge
 * rather than meet an out-of-memory isolate — and a failure signal nobody receives is not a
 * signal. Latching it is what makes that claim true.
 */
function createCloseLatch(socket: PlatformSocket): CloseLatch {
  let reported: { code: number, reason: CloseReason } | undefined
  // Registered before any caller's, so the event is recorded whether or not one is listening.
  socket.addEventListener('close', (event: any) => {
    reported ??= { code: event?.code ?? ABNORMAL_CLOSURE, reason: event?.reason ?? '' }
  })
  return { reported: () => reported }
}

interface ShimParts {
  socket: PlatformSocket
  wrappersFor: (event: string) => Map<Handler, Wrapper>
  messages: MessageQueue
  open: OpenAnnouncer
  closeLatch: CloseLatch
}

function createOn({ socket, wrappersFor, messages, open, closeLatch }: ShimParts): (event: string, handler: Handler) => void {
  return (event, handler) => {
    const registered = wrappersFor(event)
    if (registered.has(handler)) {
      return
    }
    // `open` and `message` are both registered without a platform listener of their own: the
    // announcer owns the first and the queue's pump owns the second.
    if (event === 'open') {
      registered.set(handler, () => {})
      if (open.announced()) {
        open.scheduleLate(handler as () => void)
      }
      return
    }
    if (event === 'message') {
      registered.set(handler, () => {})
      messages.add(handler as (raw: unknown) => void)
      return
    }
    const wrapper = positionalWrapper(event, handler)
    registered.set(handler, wrapper)
    socket.addEventListener(event as PlatformEvent, wrapper)
    const reported = event === 'close' ? closeLatch.reported() : undefined
    if (reported !== undefined) {
      // The socket closed before this handler existed. The platform event has fired and will
      // not fire again, so the listener just registered would never hear it. Delivered on a
      // later turn, and only if still registered, exactly as `open` is.
      setTimeout(() => {
        if (wrappersFor('close').has(handler)) {
          handler(reported.code, reported.reason)
        }
      }, 0)
    }
  }
}

function createOff({ socket, wrappersFor, messages }: ShimParts): (event: string, handler: Handler) => void {
  return (event, handler) => {
    const registered = wrappersFor(event)
    const wrapper = registered.get(handler)
    if (!wrapper) {
      return
    }
    registered.delete(handler)
    if (event === 'message') {
      messages.remove(handler as (raw: unknown) => void)
    }
    else if (event !== 'open') {
      socket.removeEventListener(event as PlatformEvent, wrapper)
    }
  }
}

export function toWsLike(socket: PlatformSocket): WsLike {
  const wrappersFor = createWrapperRegistry()
  const messages = createMessageQueue(socket)
  const parts: ShimParts = {
    socket,
    wrappersFor,
    messages,
    open: createOpenAnnouncer(wrappersFor, messages),
    closeLatch: createCloseLatch(socket),
  }
  return {
    on: createOn(parts) as WsLike['on'],
    off: createOff(parts),
    send: data => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    // `ws.terminate()` drops the connection without a closing handshake. The platform socket
    // has no such call, so the nearest thing is a `close` that says nothing — no code, no
    // reason — and that omission is deliberate rather than lazy.
    //
    // The faithful translation looks like `close(ABNORMAL_CLOSURE)`, since 1006 is what the
    // peer of a dropped `ws` socket observes, and that is what this line was. It throws:
    // measured under workerd, `close(1006)` raises `InvalidAccessError: Invalid WebSocket
    // close code: 1006.`, as does 1005, while 1000 and a bare `close()` are accepted
    // (`apps/cf-orchestrator/test/workerd/websocket-close-codes.test.ts`). RFC 6455 §7.4.1
    // reserves both codes for the receiving side to synthesise and forbids sending them.
    //
    // The throw was not cosmetic. The adapter calls `terminate()` from its connect-failure
    // cleanup, so a failed connect ended in an `InvalidAccessError` thrown out of the cleanup
    // path, leaving the socket open and masking the failure that got there first. A bare
    // `close()` is the only spelling of "end it, saying nothing" the runtime accepts.
    terminate: () => socket.close(),
  }
}
