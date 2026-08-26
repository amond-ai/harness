/**
 * The two primitives every abort and teardown guard in this package is written out of.
 *
 * Both surfaces import them, which is why they live here rather than in whichever file needed
 * one first: `files.ts` and `process.ts` guard the same two things — a cleanup that must not
 * become the reported error, and a signal whose answer changes while a call is in flight.
 */
/**
 * One spelling of "clean up, and let the cleanup fail" — used by every teardown guard here.
 *
 * Four call sites in `process.ts` and one in `provider.ts` kill or destroy on a failure path
 * and then rethrow the cause that got them there. The cleanup must not become the reported
 * error: a `kill()` that failed too would replace "the log stream never opened" with its own
 * message and send the caller after the wrong call, and a `destroy()` that failed would erase
 * the setup failure the session was abandoned for.
 *
 * `Promise.resolve(action()).catch(() => {})` is the obvious spelling and it is the wrong one.
 * The argument is evaluated first, so an `action` that throws *before* returning a promise
 * throws while `Promise.resolve` is still being reached and escapes the handler entirely —
 * the same defect as `resumeSession`'s, one layer down (cubic review, PR #268). Neither
 * signature rules that out: the harness types `kill()` and `destroy()` as `PromiseLike<void>`,
 * which says what a settled call carries and nothing about when it fails.
 *
 * Calling `action` from inside a `then` puts the invocation itself behind the promise, so a
 * synchronous throw and a rejection arrive at the same `catch`.
 */
export function bestEffort(action: () => PromiseLike<void>): Promise<void> {
  return Promise.resolve().then(action).catch(() => {})
}

/**
 * Whether the signal has fired *as of now*, asked again rather than answered from before.
 *
 * A call rather than `abortSignal?.aborted === true` spelled inline, and not for taste: a
 * guard that already tested the same property has narrowed it to `false` for the rest of the
 * function, so TypeScript rejects the later comparison as one that "appears to be
 * unintentional" (TS2367). It is not unintentional — it is the point. `aborted` flips while
 * the caller is suspended in an `await`, which is precisely the window these guards exist
 * for, and no narrowing taken before that `await` can speak for what is true after it. Both
 * callers are shaped that way: `files.ts`'s `collect` re-asks after `await reader.read()`,
 * and `process.ts`'s failed log open re-asks after awaiting the kill it issues.
 *
 * The type predicate re-asks the question and hands back the signal itself, so the reason can
 * be read from it.
 */
export function nowAborted(abortSignal: AbortSignal | undefined): abortSignal is AbortSignal {
  return abortSignal?.aborted === true
}
