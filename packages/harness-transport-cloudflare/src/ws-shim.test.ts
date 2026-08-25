import { describe, expect, it, spyOn } from 'bun:test'
import { toWsLike } from './ws-shim'

/** The half of `WebSocket` the shim consumes, plus the hooks a test needs to drive it. */
function fakeSocket() {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const sent: string[] = []
  const closed: { code?: number, reason?: string }[] = []
  return {
    sent,
    closed,
    emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event)
      }
    },
    socket: {
      addEventListener(type: string, listener: (event: unknown) => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener(type: string, listener: (event: unknown) => void) {
        listeners.get(type)?.delete(listener)
      },
      send(data: string) {
        sent.push(data)
      },
      close(code?: number, reason?: string) {
        closed.push({ code, reason })
      },
    },
    /** What a real platform socket does after `close()`: the close event lands later. */
    settleClose(code: number) {
      for (const listener of listeners.get('close') ?? []) {
        listener({ code, reason: '' })
      }
    },
  }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('toWsLike buffering', () => {
  it('holds frames that arrive before any message handler exists, then flushes in order', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    fake.emit('message', { data: 'hello' })
    fake.emit('message', { data: 'second' })
    const seen: unknown[] = []
    ws.on('message', raw => seen.push(raw))
    await tick()
    expect(seen).toEqual(['hello', 'second'])
  })

  it('resumes buffering once the last handler is removed, so the adapter handover loses nothing', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    const first = (): void => {}
    ws.on('message', first)
    ws.off('message', first)
    await tick()
    fake.emit('message', { data: 'between' })
    const seen: unknown[] = []
    ws.on('message', raw => seen.push(raw))
    expect(seen).toEqual(['between'])
  })

  /**
   * A real `ws` client cannot deliver a message before `open`, and the adapter relies on it:
   * its `onOpen` is what initialises connection state and starts the bridge-hello timer. The
   * queue's whole purpose is the case where `bridge-hello` lands before the handlers attach,
   * so draining it on registration is precisely when the ordering would be inverted.
   */
  it('reports the synthetic open before any frame it queued behind it', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    fake.emit('message', { data: 'bridge-hello' })
    const order: string[] = []
    ws.on('open', () => order.push('open'))
    ws.on('message', raw => order.push(`message:${String(raw)}`))
    await tick()
    expect(order).toEqual(['open', 'message:bridge-hello'])
  })

  it('flushes a frame that arrived after open while no handler was attached', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.on('open', () => {})
    await tick()
    fake.emit('message', { data: 'after-open' })
    const seen: unknown[] = []
    ws.on('message', raw => seen.push(raw))
    expect(seen).toEqual(['after-open'])
  })

  /**
   * The case the queue exists for, and the one it lost.
   *
   * The socket is live from `accept()` and the bridge sends `bridge-hello` at once, while the
   * adapter attaches its `message` handler only after the opener's promise resolves. The open
   * turn is a `setTimeout` scheduled at shim construction, and nothing orders those two — so
   * the turn routinely runs while the queue holds the hello and no handler exists yet.
   */
  it('keeps a frame that queued before open when no handler was attached yet', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    fake.emit('message', { data: 'bridge-hello' })
    await tick()
    const seen: unknown[] = []
    ws.on('message', raw => seen.push(raw))
    await tick()

    expect(seen).toEqual(['bridge-hello'])
  })

  /**
   * The queue covers a handover, not a stream. A consumer that never attaches a handler would
   * otherwise hold every frame the bridge relays — Claude's `stream-json` output is unbounded
   * — inside a Worker isolate capped at 128 MiB.
   */
  it('holds frames up to the budget and closes on the one that crosses it', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.on('open', () => {})
    await tick()
    const megabyte = 'x'.repeat(1024 * 1024)
    for (let frame = 0; frame < 8; frame++) {
      fake.emit('message', { data: megabyte })
    }

    // Exactly the budget is not past it: a `>=` here would give up one frame early, on a
    // handover that was still within what the queue promises to hold.
    expect(fake.closed).toEqual([])

    fake.emit('message', { data: megabyte })

    // No code and no reason, and that is the assertion rather than a detail: workerd rejects
    // the reserved codes outright (`InvalidAccessError`, measured in
    // `apps/cf-orchestrator/test/workerd/websocket-close-codes.test.ts`), so a bare `close()`
    // is the only spelling of "give up, saying nothing" the runtime accepts.
    expect(fake.closed).toEqual([{ code: undefined, reason: undefined }])
  })

  /**
   * The budget is bytes; a string's `length` is UTF-16 code units. One `가` is one code unit
   * and three UTF-8 bytes, so a code-unit count under-reads a non-ASCII frame by up to 3x —
   * and an 8 MiB cap counted that way bounds nothing it claims to. Claude's `stream-json`
   * relays arbitrary user text, so this is the ordinary case, not a contrived one.
   */
  it('counts what a non-ASCII frame really costs, not its code units', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.on('open', () => {})
    await tick()
    const megaunit = '\uAC00'.repeat(1024 * 1024)
    // 3 MiB each: two are within the budget, the third crosses it.
    for (let frame = 0; frame < 2; frame++) {
      fake.emit('message', { data: megaunit })
    }
    expect(fake.closed).toEqual([])

    fake.emit('message', { data: megaunit })

    expect(fake.closed).toEqual([{ code: undefined, reason: undefined }])
  })

  /**
   * The cap must not cost the allocation it exists to prevent.
   *
   * Measuring exactly means encoding, and encoding a frame that is already over the budget
   * allocates up to 3x its size purely to confirm a rejection — inside a Worker isolate capped
   * at 128 MiB, on the path that exists because memory is running out (cubic review, PR #268).
   * A UTF-16 code unit is at least one UTF-8 byte, so `length` is a *lower* bound on what the
   * encode would report: a frame already over budget counted that way is over budget counted
   * exactly, and the encode cannot change the answer. Frames that fit are still measured
   * exactly — the bound only ever short-circuits a rejection, never an admission.
   */
  it('gives up on a frame already over the budget without encoding it', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.on('open', () => {})
    await tick()
    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1)

    const encode = spyOn(TextEncoder.prototype, 'encode')
    let encodes = -1
    try {
      fake.emit('message', { data: oversized })
      // Read before the restore, never after: `mockRestore()` clears the call record under
      // Bun 1.3.14 (measured), so `expect(encode).not.toHaveBeenCalled()` on a restored spy
      // passes over a frame that was encoded — a green assertion that pins nothing.
      encodes = encode.mock.calls.length
    }
    finally {
      encode.mockRestore()
    }

    expect(fake.closed).toEqual([{ code: undefined, reason: undefined }])
    expect(encodes).toBe(0)
  })

  /**
   * A failure signal nobody receives is not a signal.
   *
   * The overflow above closes deliberately so a stalled bridge surfaces as a closed socket
   * rather than an out-of-memory isolate — but a caller stalled enough to overflow the queue
   * is exactly the caller that may not have a `close` handler attached yet, and a platform
   * event does not replay. Measured before this was latched: a handler attached after the
   * event fired saw nothing, while one attached before saw it normally.
   */
  it('reports a close that landed before the handler existed', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    await tick()
    fake.settleClose(1006)
    const seen: { code: number, reason: string }[] = []
    ws.on('close', (code, reason) => seen.push({ code, reason }))
    await tick()

    expect(seen).toEqual([{ code: 1006, reason: '' }])
  })

  it('reports the close the overflow itself issued, to a handler attached afterwards', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.on('open', () => {})
    await tick()
    const megabyte = 'x'.repeat(1024 * 1024)
    for (let frame = 0; frame < 9; frame++) {
      fake.emit('message', { data: megabyte })
    }
    expect(fake.closed).toHaveLength(1)
    fake.settleClose(1006)

    const seen: { code: number, reason: string }[] = []
    ws.on('close', (code, reason) => seen.push({ code, reason }))
    await tick()

    expect(seen).toEqual([{ code: 1006, reason: '' }])
  })

  it('reports a close exactly once to a handler that was already listening', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    const seen: { code: number, reason: string }[] = []
    ws.on('close', (code, reason) => seen.push({ code, reason }))
    await tick()
    fake.settleClose(1001)
    await tick()

    expect(seen).toEqual([{ code: 1001, reason: '' }])
  })

  it('delivers live frames straight through while a handler is attached', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    const seen: unknown[] = []
    ws.on('message', raw => seen.push(raw))
    await tick()
    fake.emit('message', { data: 'live' })
    expect(seen).toEqual(['live'])
  })
})

describe('toWsLike', () => {
  it('synthesises `open`, which an accepted socket never fires on its own', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    let opened = 0
    ws.on('open', () => {
      opened++
    })
    await tick()
    expect(opened).toBe(1)
  })

  it('delivers `open` to a handler registered after the first delivery', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.on('open', () => {})
    await tick()
    let late = 0
    ws.on('open', () => {
      late++
    })
    await tick()
    expect(late).toBe(1)
  })

  it('does not deliver `open` to a handler removed before the turn runs', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    let opened = 0
    const handler = (): void => {
      opened++
    }
    ws.on('open', handler)
    ws.off('open', handler)
    await tick()
    expect(opened).toBe(0)
  })

  it('unwraps a message event to the raw payload the bridge reader expects', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    const seen: unknown[] = []
    ws.on('message', raw => seen.push(raw))
    await tick()
    fake.emit('message', { data: '{"type":"bridge-hello"}' })
    fake.emit('message', { data: new Uint8Array([123, 125]).buffer })
    expect(seen[0]).toBe('{"type":"bridge-hello"}')
    expect(seen[1]).toBeInstanceOf(ArrayBuffer)
  })

  it('passes close code and a reason that survives `.toString("utf8")`', () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    const seen: { code: number, reason: string }[] = []
    // Read back the way `SandboxChannel.wire` reads it — `reason?.toString?.('utf8')`.
    // `String.prototype.toString` ignores the argument, which is exactly why a plain string
    // stands in for ws's `Buffer` here; TypeScript types it as 0-arity, hence the cast.
    ws.on('close', (code, reason) => seen.push({
      code,
      reason: (reason as { toString: (encoding?: string) => string }).toString('utf8'),
    }))
    fake.emit('close', { code: 1006, reason: 'suspended' })
    expect(seen).toEqual([{ code: 1006, reason: 'suspended' }])
  })

  it('removes only the handler named by `off`', async () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    const kept: string[] = []
    const dropped: string[] = []
    const keptHandler = (raw: unknown): number => kept.push(String(raw))
    const droppedHandler = (raw: unknown): number => dropped.push(String(raw))
    ws.on('message', keptHandler)
    ws.on('message', droppedHandler)
    ws.off('message', droppedHandler)
    await tick()
    fake.emit('message', { data: 'x' })
    expect(kept).toEqual(['x'])
    expect(dropped).toEqual([])
  })

  /**
   * `terminate()` sends *no* code, and this used to assert 1006.
   *
   * The abrupt-close code is what a dropped `ws` socket's peer observes, so it looked like the
   * faithful translation — but it is reserved for the receiving side to synthesise, and workerd
   * throws `InvalidAccessError` when an application sets it. This fake cannot see that: its
   * `close` records whatever number it is handed, which is why the code was wrong here for as
   * long as it was. The measurement lives where it can be made, in
   * `apps/cf-orchestrator/test/workerd/websocket-close-codes.test.ts`; what is left for this
   * test is the argument list itself, since "no code" is the only spelling that survives.
   */
  it('forwards send and close, and terminates with a close that carries no code', () => {
    const fake = fakeSocket()
    const ws = toWsLike(fake.socket)
    ws.send('frame')
    ws.close(1000, 'done')
    ws.terminate()
    expect(fake.sent).toEqual(['frame'])
    expect(fake.closed).toEqual([
      { code: 1000, reason: 'done' },
      { code: undefined, reason: undefined },
    ])
  })
})
