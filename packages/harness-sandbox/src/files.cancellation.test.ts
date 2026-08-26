/**
 * The abort contract of {@link createFileSurface}, split from `files.test.ts` for the reason
 * `process.cleanup.test.ts` is split from `process.test.ts`: it is a different question about
 * the same surface. That one asks what the translation produces; this one asks what it
 * refuses to start, and what it stops once started.
 */
import { describe, expect, it } from 'bun:test'
import { createFileSurface } from './files'
import { fakeSandboxProvider } from './sandbox.fixtures'

/** How long {@link stallingStream}'s pull stalls before giving up and completing. */
const STALL_MS = 200

/** The same wiring `files.test.ts` opens with — seeded state, one sandbox, one surface. */
function surface(seed: Record<string, Uint8Array | string> = {}) {
  const { provider, state } = fakeSandboxProvider()
  for (const [path, content] of Object.entries(seed)) {
    state.files('sbx').set(path, typeof content === 'string' ? new TextEncoder().encode(content) : content)
  }
  return { files: createFileSurface(provider.session('sbx')), state }
}
/**
 * Cancellation, which on this surface can only ever mean *not starting*.
 *
 * The contract's file calls take no signal — only `logs()` and `waitForExit()` do — so a call
 * already in flight cannot be cancelled from here, and the invariant left is the one that can
 * be held: no sandbox operation is started after the signal has fired. Every method makes two
 * calls, and the gap between them is a real window in wall-clock terms, so entry alone is not
 * enough. The Claude Code startup path threads its `abortSignal` into these reads and into the
 * skill/bootstrap writes, so an abort landing in that gap is what a cancelled startup does
 * (codex review, PR #268).
 */
describe('cancellation', () => {
  it('refuses every method on an already-aborted signal, before touching the sandbox', async () => {
    const { files, state } = surface({ '/a.txt': 'here' })
    const reason = new Error('caller went away')
    const abortSignal = AbortSignal.abort(reason)
    const calls = [
      () => files.readFile({ path: '/a.txt', abortSignal }),
      () => files.readBinaryFile({ path: '/a.txt', abortSignal }),
      () => files.readTextFile({ path: '/a.txt', abortSignal }),
      () => files.writeFile({ path: '/deep/a.bin', content: new Response('a').body!, abortSignal }),
      () => files.writeBinaryFile({ path: '/deep/b.bin', content: new Uint8Array([1]), abortSignal }),
      () => files.writeTextFile({ path: '/deep/c.txt', content: 'c', abortSignal }),
    ]

    for (const call of calls) {
      // The reason itself, not merely "it threw": `throwIfAborted()` throws `signal.reason`,
      // which is what `process.ts` throws one call earlier on the same path, and a caller
      // that cannot recognise its own abort reports a transport failure instead.
      await expect(call()).rejects.toBe(reason)
    }
    // Nothing reached the sandbox at all — not the write, and not the `exists` that a read
    // opens with, which is a call to a live machine like any other.
    expect(state.probes).toEqual([])
    expect(state.reads).toEqual([])
    expect(state.mkdirs).toEqual([])
    expect(state.writes).toEqual([])
    expect(state.events).toEqual([])
  })

  /**
   * The gap inside a read: `exists` said yes, and the caller aborted before the read went out.
   *
   * Written over a hand-built session for the reason the re-probe test above gives — the
   * fixture cannot make its own calls race anything — and it wraps the fixture's session
   * rather than replacing it, so every call still lands in the same recorded state.
   */
  it('does not read after an abort that lands while the existence probe is in flight', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    const reason = new Error('cancelled mid-read')
    const files = createFileSurface({
      ...session,
      exists: (path) => {
        controller.abort(reason)
        return session.exists(path)
      },
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    expect(state.probes).toEqual(['/a.txt'])
    expect(state.reads).toEqual([])
  })

  /**
   * The re-probe is a sandbox call too, and the abort reason outranks the read's own error:
   * the caller cancelled, and a surface that answered with whatever the cancelled read threw
   * would send it after a transport failure it did not have.
   */
  it('does not re-probe a failed read the caller has already cancelled', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    const reason = new Error('cancelled mid-read')
    const files = createFileSurface({
      ...session,
      readFile: (() => {
        controller.abort(reason)
        return Promise.reject(new Error('transport blew up'))
      }) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    // One probe, the one that gated the read — the re-probe never went out.
    expect(state.probes).toEqual(['/a.txt'])
  })

  /**
   * The gap inside a write, and the last point at which refusing still avoids the mutation:
   * the parent directory has been created, the file has not been written. Refusing after the
   * write would be a different thing entirely — a cancellation reported for work that landed.
   */
  it('does not write after an abort that lands while the parent directory is being created', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const controller = new AbortController()
    const reason = new Error('cancelled mid-write')
    const files = createFileSurface({
      ...session,
      mkdir: (path, options) => {
        controller.abort(reason)
        return session.mkdir(path, options)
      },
    })

    await expect(files.writeTextFile({
      path: '/deep/a.txt',
      content: 'x',
      abortSignal: controller.signal,
    })).rejects.toBe(reason)
    expect(state.events).toEqual(['mkdir /deep'])
    expect(state.writes).toEqual([])
    expect(state.files('sbx').get('/deep/a.txt')).toBeUndefined()
  })

  /**
   * Absence found *after* the caller cancelled, which is the one answer this surface must not
   * give. `null` is not a lesser error here, it is a different instruction: the startup code
   * that threads this signal reads `null` as "the file is not there, carry on without it" and
   * takes that branch — writing the bootstrap it thought was missing — on behalf of a caller
   * that had already stopped. A wrong error value is visible; a wrong branch is not.
   */
  it('refuses an absent path the caller cancelled during the probe, rather than reporting absence', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const controller = new AbortController()
    const reason = new Error('cancelled mid-probe')
    const files = createFileSurface({
      ...session,
      // `/gone` is unseeded, so this answers `{ exists: false }` — the branch that used to
      // leave before the guard that follows it.
      exists: (path) => {
        controller.abort(reason)
        return session.exists(path)
      },
    })

    await expect(files.readFile({ path: '/gone', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    expect(state.reads).toEqual([])
  })

  /**
   * The same shape one call deeper: the read failed, and the re-probe that tells a deletion
   * apart from a transport failure came back "gone" for a caller that had cancelled while it
   * was in flight. The `null` it produced is the same wrong instruction as above.
   */
  it('refuses when the caller cancels during the re-probe that finds the file gone', async () => {
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    const controller = new AbortController()
    const reason = new Error('cancelled mid-re-probe')
    let probes = 0
    const files = createFileSurface({
      ...session,
      exists: () => {
        probes += 1
        // The first probe gates the read; the second is the re-probe, and it reports the file
        // gone at the same moment the caller gives up.
        if (probes === 1) {
          return Promise.resolve({ exists: true })
        }
        controller.abort(reason)
        return Promise.resolve({ exists: false })
      },
      readFile: (() => Promise.reject(new Error('transport blew up'))) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    expect(probes).toBe(2)
  })
})

/**
 * Draining the stream is its own sandbox operation, and the caller only owns it sometimes.
 *
 * The two supports the header's "cannot cancel what is in flight" rests on are both absent
 * here: a `ReadableStream` has `cancel()`, so there is something to stop, and a read mutates
 * nothing, so stopping it leaves no half-written anything. And the bytes have not moved when
 * the stream resolves — a stream is a handle, `collect` is the operation, and it is an
 * unbounded pull loop over the transport, which is the "hang on slow sandbox I/O" this whole
 * guard exists for (codex review, PR #268).
 */
describe('cancellation and the byte stream', () => {
  it('does not drain a stream the caller cancelled while the read was in flight', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    const reason = new Error('cancelled mid-read')
    let pulls = 0
    let released = false
    const files = createFileSurface({
      ...session,
      readFile: (() => {
        controller.abort(reason)
        return Promise.resolve({ content: countingStream(() => pulls++, () => void (released = true)) })
      }) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    // Not one chunk: refusing *after* starting the drain would still hang on the byte the
    // caller no longer wants, which is the whole failure being guarded against.
    expect(pulls).toBe(0)
    // And released, because nothing else can: the stream is a local here, the caller never
    // sees it, so a refusal that skipped the cancel leaves a subscription open for good.
    expect(released).toBe(true)
  })

  /**
   * The other side of the same rule, and the reason `readFile` is left alone.
   *
   * `readFile` pulls nothing — it hands the stream to the caller, who holds it *and* the
   * signal it just aborted. Refusing here would mean destroying a live resource on behalf of
   * a caller perfectly able to decide for itself, and the invariant does not ask for it:
   * returning a handle starts no operation. So this is a documented difference between the
   * streaming read and the two that collect, not an inconsistency.
   */
  it('still hands readFile its stream, undrained and open, when the caller has aborted', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    let pulls = 0
    let released = false
    const files = createFileSurface({
      ...session,
      readFile: (() => {
        controller.abort(new Error('cancelled mid-read'))
        return Promise.resolve({ content: countingStream(() => pulls++, () => void (released = true)) })
      }) as unknown as typeof session.readFile,
    })

    const stream = await files.readFile({ path: '/a.txt', abortSignal: controller.signal })

    expect(pulls).toBe(0)
    expect(released).toBe(false)
    // Live rather than a corpse: the caller can still read it, or cancel it, as it chooses.
    expect(await new Response(stream).text()).toBe('here')
    expect(pulls).toBe(1)
  })

  /**
   * Refusing the drain must not wait for the teardown it starts.
   *
   * The refusal above releases the stream, and releasing runs the backend's own `cancel` —
   * an RPC in the real sandbox. Awaiting it made the rejection arrive no sooner than that
   * teardown did, so a backend slow (or stuck) in `cancel` held a caller that had already
   * cancelled: this surface's own defect, reintroduced by the line whose job is to prevent
   * it. Nothing reads the outcome — `bestEffort` discards it — so the wait bought only the
   * delay (codex review, PR #272).
   *
   * `cancelSettled` is what separates the two spellings, and it has to be the *settling*
   * rather than the call: both spellings start the cancel, and only one waits for it. Bounded
   * at `STALL_MS` for the reason {@link stallingStream} gives — an unbounded teardown would
   * hang the suite instead of naming the defect.
   */
  it('rejects a pre-aborted read without waiting for the stream teardown it starts', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    const reason = new Error('cancelled before the drain')
    let cancelStarted = false
    let cancelSettled = false
    const content = new ReadableStream<Uint8Array>({
      pull(controller_) {
        controller_.enqueue(new TextEncoder().encode('here'))
        controller_.close()
      },
      cancel() {
        cancelStarted = true
        return new Promise<void>(resolve => setTimeout(() => {
          cancelSettled = true
          resolve()
        }, STALL_MS))
      },
    }, { highWaterMark: 0 })
    const files = createFileSurface({
      ...session,
      readFile: (() => {
        controller.abort(reason)
        return Promise.resolve({ content })
      }) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    // Started, because nobody else holds the stream — skipping it leaks the subscription.
    expect(cancelStarted).toBe(true)
    // Not settled, because the caller is already back: the teardown outlives the rejection
    // rather than the other way round.
    expect(cancelSettled).toBe(false)
  })

  /**
   * The abort that lands one tick *into* the drain, which is where a hang lives rather than a
   * slow read: `pull` has been entered and never resolves, so the `read()` awaiting it never
   * settles and the whole call sits there for ever. Cancelling the stream late cannot rescue
   * it — a stream being drained is locked, and `stream.cancel()` on a locked stream throws
   * `TypeError: Invalid state` and leaves the pending read exactly as pending. Cancelling
   * through the *reader* is what settles it: the pending `read()` resolves `{ done: true }`
   * (measured under Bun 1.3.14), the loop falls out, and the reason is thrown.
   *
   * Three assertions, because any two of them pass over a defect the third one catches: the
   * rejection alone is produced by a drain that ran to completion and only then noticed the
   * signal; promptness alone says nothing about which value the caller got; and neither
   * notices a transport subscription left open behind the rejection.
   */
  it('stops a drain the caller cancels part-way through, rather than hanging on it', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    const reason = new Error('cancelled mid-drain')
    const stall = stallingStream(() => controller.abort(reason))
    const files = createFileSurface({
      ...session,
      readFile: (() => Promise.resolve({ content: stall.content })) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
    // Promptly: the stalled pull is still stalled. A surface that merely waited the read out
    // and checked the signal afterwards rejects with the same reason and is still the bug —
    // against a real sandbox that wait has no bound at all.
    expect(stall.stallEnded()).toBe(false)
    // And released, so the transport subscription behind it is torn down rather than left
    // holding a read nobody will ever collect.
    expect(stall.released()).toBe(true)
  })

  /**
   * A read that *fails* while the caller is cancelling, which is the one path where the two
   * candidate values collide. The loop's `read()` can reject on its own — a transport reset
   * mid-drain — and that rejection would otherwise sail past the post-loop check and reach a
   * caller who cancelled, carrying the backend's words instead of its own reason. Every other
   * abort path in this file resolves that collision the same way, so this one has to as well
   * or the surface is inconsistent about the single value a caller matches on.
   *
   * The failure is deliberate rather than a by-product of the cancel: a cancelled `read()`
   * resolves `{ done: true }`, so the rejecting path has to be scripted to appear at all.
   */
  it('hands a caller its own reason when the read fails as it cancels', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    // Seeded, so the probe says yes and the drain is actually reached — an unseeded path
    // answers `null` from the probe and never reads at all.
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const controller = new AbortController()
    const reason = new Error('cancelled mid-drain')
    const files = createFileSurface({
      ...session,
      readFile: (() => Promise.resolve({
        content: erroringStream(() => controller.abort(reason), new Error('transport blew up')),
      })) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt', abortSignal: controller.signal }))
      .rejects
      .toBe(reason)
  })

  /**
   * And the half that keeps the line above from being a swallow-everything `catch`: with no
   * abort in play, a stream that errors mid-drain is a real failure and the caller has to see
   * it. Reporting an unreachable sandbox as anything else is how an agent concludes a
   * repository is empty rather than that it cannot read it.
   */
  it('surfaces a read failure unchanged when the caller has not cancelled', async () => {
    const { provider, state } = fakeSandboxProvider()
    const session = provider.session('sbx')
    state.files('sbx').set('/a.txt', new TextEncoder().encode('here'))
    const files = createFileSurface({
      ...session,
      readFile: (() => Promise.resolve({
        content: erroringStream(() => {}, new Error('transport blew up')),
      })) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt' })).rejects.toThrow('transport blew up')
  })
})

/**
 * A stream that records whether anything actually read it.
 *
 * `highWaterMark: 0` is load-bearing: the default strategy pulls one chunk at construction —
 * measured under Bun 1.3.14, a default stream's `pull` has run before any reader exists — so
 * a fixture built the ordinary way counts one pull whether the drain happened or not, and
 * would pass with the guard removed.
 */
function countingStream(onPull: () => void, onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull()
      controller.enqueue(new TextEncoder().encode('here'))
      controller.close()
    },
    cancel() {
      onCancel()
    },
  }, { highWaterMark: 0 })
}

/**
 * A stream whose first pull stalls, and which reports whether it outlived the stall.
 *
 * The stall is *bounded* on purpose. An unbounded one would express the defect more exactly
 * and would make the unfixed code hang the suite instead of failing it — a timeout names no
 * defect and takes the runner's whole budget to produce. At 200 ms the unfixed drain resolves
 * with `late` and the rejection assertion fails in a fifth of a second, while the fixed one
 * rejects in single-digit milliseconds, so `stallEnded` separates them with four orders of
 * magnitude to spare rather than by a race.
 *
 * `highWaterMark: 0` for the reason {@link countingStream} gives: the default strategy pulls
 * one chunk at construction, before any reader exists.
 */
function stallingStream(onPull: () => void): {
  content: ReadableStream<Uint8Array>
  stallEnded: () => boolean
  released: () => boolean
} {
  let stallEnded = false
  let released = false
  const content = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull()
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!released) {
            stallEnded = true
            controller.enqueue(new TextEncoder().encode('late'))
            controller.close()
          }
          resolve()
        }, STALL_MS)
      })
    },
    cancel() {
      released = true
    },
  }, { highWaterMark: 0 })
  return { content, stallEnded: () => stallEnded, released: () => released }
}

/**
 * A stream whose first pull fails it, for the mid-drain transport reset.
 *
 * `controller.error` rather than a rejected pull promise, because that is what a reader sees
 * from a backend stream that dies part-way: the outstanding `read()` rejects with the failure.
 * `highWaterMark: 0` keeps it from erroring at construction, before anything has read it.
 */
function erroringStream(onPull: () => void, failure: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull()
      controller.error(failure)
    },
  }, { highWaterMark: 0 })
}
