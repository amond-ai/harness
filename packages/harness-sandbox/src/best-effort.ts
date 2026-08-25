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
