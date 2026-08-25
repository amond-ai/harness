/**
 * The slice of the e2b SDK this backend uses, as a structural interface.
 *
 * Taken structurally rather than imported so the session's logic is exercisable against a
 * fake, and kept in its own module so the three files that speak to a sandbox — the session,
 * the journal reader, and the process-table reader — share one definition without importing
 * each other for it. `e2b-api.ts` is where the real SDK is bound to it.
 */

/**
 * e2b's `files.read`, in the two shapes this backend asks for.
 *
 * The streaming one exists because e2b has no byte-range read: a positioned journal read
 * still starts at offset 0, so the only way to keep the bytes before the cursor out of the
 * isolate is to drop them as they arrive rather than after.
 */
export interface E2bFileRead {
  (path: string, opts: { format: 'bytes' }): Promise<Uint8Array>
  (path: string, opts: { format: 'stream' }): Promise<ReadableStream<Uint8Array>>
}

/**
 * e2b's `CommandHandle`, narrowed to what this backend reads.
 *
 * `wait` is part of the surface because a background command's effects have not landed when
 * `run` resolves — e2b returns as soon as the command *starts*. A turn is started and left
 * running, so that is what `exec` wants; the kill walk is the opposite, and awaiting it is
 * the difference between a retry that follows a dead process tree and one that races it.
 */
export interface E2bCommandHandle {
  pid: number
  /**
   * Resolves when the command has exited, with what it exited as.
   *
   * The SDK throws `CommandExitError` on a non-zero exit, but the result is checked rather
   * than the throw relied on: a command e2b stops at its `timeoutMs` must not be able to
   * arrive here as a success and skip the fallback (cubic review, PR #260).
   */
  wait: () => Promise<{ exitCode?: number }>
}

export interface E2bSandboxLike {
  readonly sandboxId: string
  commands: {
    run: (cmd: string, opts: {
      background: true
      cwd?: string
      envs?: Record<string, string>
      /** e2b's per-command budget. `0` disables it; omitted means e2b's 60s default. */
      timeoutMs?: number
    }) => Promise<E2bCommandHandle>
    /**
     * e2b's `ProcessInfo`, narrowed to the fields this backend reads. `cmd`/`args` are the
     * part a turn cannot rewrite, which is why liveness is judged from them and not from
     * the pid recorded in the journal — see {@link livenessOf}.
     */
    list: () => Promise<{ pid: number, cmd?: string, args?: string[] }[]>
    kill: (pid: number) => Promise<boolean>
  }
  files: {
    read: E2bFileRead
    write: (path: string, data: string) => Promise<unknown>
    exists: (path: string) => Promise<boolean>
    list: (path: string) => Promise<{ name: string }[]>
    makeDir: (path: string) => Promise<boolean>
  }
  /** Re-applies the sandbox's lifetime, restarting e2b's countdown from now. */
  setTimeout: (timeoutMs: number) => Promise<void>
  kill: () => Promise<boolean>
}
