/**
 * The slice of the Daytona SDK this backend uses, as a structural interface.
 *
 * Taken structurally rather than imported so the session's logic is exercisable against a fake,
 * and kept in its own module so the files that speak to a sandbox — the session, the file
 * surface, the kill path and the log reads — share one definition without importing each other
 * for it. `daytona-api.ts` is where the real SDK is bound to it.
 *
 * Every signature here is the 0.211.2 one, verified against the shipped `.d.ts` (research note
 * 035). The narrowing is deliberate in two places: the streaming `getSessionCommandLogs`
 * overload is absent because it needs a WebSocket, and the PTY surface is absent because a turn
 * is not a terminal.
 */

/** Daytona's `Command`: what a session ran, and how it ended once it has. */
export interface DaytonaSessionCommand {
  readonly id: string
  readonly command: string
  /** Written by the toolbox daemon, not by the turn — see the package README. */
  readonly exitCode?: number
}

/** Daytona's `Session`. One per process here, so `commands` holds exactly one entry. */
export interface DaytonaSession {
  readonly sessionId: string
  readonly commands: readonly DaytonaSessionCommand[]
}

/** The buffered `getSessionCommandLogs` response: stdout and stderr kept apart, plus a merge. */
export interface DaytonaSessionLogs {
  readonly output?: string
  readonly stdout?: string
  readonly stderr?: string
}

export interface DaytonaSandboxLike {
  readonly id: string
  /**
   * Daytona's `SandboxState`, when it answered with one.
   *
   * Optional because the SDK types it optional, and because `list` hands back partial DTOs
   * (research note 035 §6). An absent state is not "running" — it is "Daytona did not say", which
   * is why the reattach wake in `provider.ts` leaves it alone rather than guessing.
   */
  readonly state?: string
  /** Start a stopped sandbox, or restore an archived one. Returns once Daytona accepted the ask. */
  start: (timeout?: number) => Promise<void>
  /** Block until the sandbox reports `started` — the readiness `start` alone does not promise. */
  waitUntilStarted: (timeout?: number) => Promise<void>
  /** Block until a sandbox on its way down reaches `stopped`, which is where `start` can take it. */
  waitUntilStopped: (timeout?: number) => Promise<void>
  process: {
    createSession: (sessionId: string) => Promise<void>
    getSession: (sessionId: string) => Promise<DaytonaSession>
    listSessions: () => Promise<DaytonaSession[]>
    deleteSession: (sessionId: string) => Promise<void>
    getSessionCommand: (sessionId: string, commandId: string) => Promise<DaytonaSessionCommand>
    /** `runAsync: true` starts the command and returns; the turn is left running. */
    executeSessionCommand: (
      sessionId: string,
      request: { command: string, runAsync?: boolean },
    ) => Promise<{ cmdId: string }>
    getSessionCommandLogs: (sessionId: string, commandId: string) => Promise<DaytonaSessionLogs>
    /**
     * A one-shot command outside any session, awaited to completion.
     *
     * The kill path's only tool: Daytona exposes no signal API for a session command
     * (research note 035 §3), so a kill is an ordinary `kill(1)` run beside the turn.
     */
    executeCommand: (command: string) => Promise<{ exitCode: number, result: string }>
  }
  fs: {
    createFolder: (path: string, mode: string) => Promise<void>
    /** Node's `Buffer` in the real SDK, which is a `Uint8Array`; nothing here needs more. */
    downloadFile: (remotePath: string) => Promise<Uint8Array>
    /** The Buffer-free write path — `uploadFile` would need one, this one takes bytes. */
    uploadFileStream: (source: Uint8Array, remotePath: string) => Promise<void>
    /** Throws a 404-carrying error for a path that is not there, rather than answering. */
    getFileDetails: (path: string) => Promise<{ name: string }>
  }
  /** `{ url, token }` for a public TLS preview host. The token authenticates the caller. */
  getPreviewLink: (port: number) => Promise<{ url: string, token: string }>
  delete: () => Promise<void>
}

/**
 * Whether a rejection is Daytona's "there is no such thing", and not any other failure.
 *
 * The discriminator is `statusCode`, not the error class. `DaytonaNotFoundError` is exported by
 * the SDK, but importing it here would put the real SDK in every file that asks the question and
 * end the property this package is built on — the whole backend is exercisable against a fake.
 * `statusCode` is the field the SDK's own `errorClassFromStatusCode` derives that class from, so
 * reading it is reading the same fact one layer earlier rather than guessing at a message.
 *
 * The distinction is load-bearing in three places, all of which mean the opposite thing on a
 * transport failure: `exists` answers `false` only for a real absence, `getProcess` answers
 * `null` only for a process confirmed gone, and `status()` reports `no_exit_record` only once
 * Daytona says the session is not there.
 */
export function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null
    && (cause as { statusCode?: unknown }).statusCode === 404
}
