/**
 * Settle with `work`, or reject with the signal's reason as soon as it aborts.
 *
 * For a remote read whose backend cannot be cancelled: the caller stops waiting on it rather
 * than the read stopping. The abandoned promise is left to settle on its own, with its rejection
 * handled so it cannot surface as unhandled. `throwIfAborted()` throws `signal.reason`, the value
 * the rest of the package rejects with for an aborted call.
 */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return work
  }
  // Handled up front, so the work abandoned by an already-aborted signal cannot reject unobserved.
  work.catch(() => {})
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  }
  finally {
    signal.removeEventListener('abort', onAbort!)
  }
}
