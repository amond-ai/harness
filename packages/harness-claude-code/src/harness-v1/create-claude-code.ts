/**
 * The `HarnessV1` adapter: `HarnessAgent` on one side, this repository's turn driver on the
 * other.
 *
 * Everything the driver already refuses to decide is still injected here — which sandbox
 * provider, how a socket is opened, what a turn's environment is, where its bytes go — because
 * the harness contract does not name any of them either. What this adds is the translation: a
 * `HarnessV1StartOptions` becomes a `TurnDriverRun`, a lifecycle state becomes a handle and a
 * cursor, and the host's frames become stream parts (`frame-to-part.ts`).
 *
 * No `getBootstrap`. The sandbox image already contains the turn host bundle
 * (`docker/build-turn-host.sh`), so there is nothing to ship in and nothing to cache — which is
 * also what keeps this adapter free of the `node:fs` reads that make the reference adapter's
 * bootstrap unrunnable on workerd (research note 033).
 */
import type {
  HarnessV1,
  HarnessV1ContinueTurnState,
  HarnessV1PermissionMode,
  HarnessV1ResumeSessionState,
  HarnessV1Session,
  HarnessV1StartOptions,
} from '@ai-sdk/harness'
import type { WsLike } from '@amond-ai/harness-transport'
import type { SandboxProvider } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from '../config'
import type { LiveMirror } from '../mirror'
import type { PermissionMode } from '../permission-mode'
import type { ClaudeArgv, TurnDriver, TurnStartSpec } from '../turn-driver'
import type { TurnDriverKind } from '../turn-driver-kind'
import type { ClaudeCodeLifecycleState } from './lifecycle-state'
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness'
import { turnDriver } from '../turn-driver'
import { createClaudeCodeSession } from './claude-code-session'
import { claudeCodeLifecycleStateSchema, defaultPermissionMode } from './lifecycle-state'

/** The harness id this adapter's lifecycle states are stamped with, and refuse to import past. */
export const CLAUDE_CODE_HARNESS_ID = 'claude-code'

export interface CreateClaudeCodeOptions {
  /** The sandbox provider a turn runs in; a session's `id` is the sandbox id the driver dials. */
  sandboxes: SandboxProvider
  /** Dial one bridge endpoint URL — the one part that cannot be written once for every runtime. */
  openSocket: (url: string) => Promise<WsLike>
  config: TurnDriverConfig
  /** `settingSources` for the host's `start` frame, as the consumer names them. */
  settingSources: readonly string[]
  /**
   * Which driver a turn runs through. `sdk` — the turn host — is the only one this adapter can
   * serve: the `cli` driver waits once rather than in rounds, and a turn with no round boundary
   * has nothing for `doSuspendTurn` to suspend at. The option stays so the shape does not have
   * to change when it can.
   */
  kind?: TurnDriverKind
  /** The `cli` driver's argv builder; required only by a kind this adapter does not yet accept. */
  claudeArgv?: (turn: TurnStartSpec) => ClaudeArgv
  /** The turn's environment, assembled by the consumer — the only way credentials enter a turn. */
  env: () => Record<string, string>
  /** How a harness permission mode maps onto the CLI's six; {@link defaultPermissionMode} unless set. */
  permissionMode?: (mode: HarnessV1PermissionMode | undefined) => PermissionMode
  /** Where a turn's bytes are mirrored while it runs, per turn. */
  mirror?: (turn: { sessionId: string, attempt: number }) => LiveMirror | undefined
  /**
   * The driver a session runs on, for tests that drive the adapter without a container.
   *
   * @internal
   */
  driverFactory?: (run: { sandboxId: string, runId: string }) => TurnDriver
}

export function createClaudeCode(options: CreateClaudeCodeOptions): HarnessV1 {
  return {
    specificationVersion: 'harness-v1',
    harnessId: CLAUDE_CODE_HARNESS_ID,
    // Empty for v1: the turn host runs the Agent SDK's own tools and the Worker never sees an
    // approval request, so declaring built-ins would promise a filtering surface that does not
    // exist yet. Builtin-tool approvals are the follow-up (research note 033, "not measured").
    builtinTools: {},
    lifecycleStateSchema: claudeCodeLifecycleStateSchema,
    doStart: async (startOptions: HarnessV1StartOptions): Promise<HarnessV1Session> => {
      const state = importedState(startOptions)
      const sandboxId = state?.sandboxId ?? sandboxIdOf(startOptions)
      const driver = driverFor(options, { sandboxId, runId: startOptions.sessionId })
      if (driver.mode !== 'rounds') {
        throw new HarnessCapabilityUnsupportedError({
          harnessId: CLAUDE_CODE_HARNESS_ID,
          message: `The claude-code harness needs the 'sdk' turn driver: the 'cli' driver waits for a turn in one window, so a turn it runs cannot be suspended at a round boundary.`,
        })
      }
      return createClaudeCodeSession({
        driver,
        sandboxes: options.sandboxes,
        harnessId: CLAUDE_CODE_HARNESS_ID,
        sessionId: startOptions.sessionId,
        sandboxId,
        config: options.config,
        permissionMode: (options.permissionMode ?? defaultPermissionMode)(startOptions.permissionMode),
        env: options.env,
        workDir: startOptions.sessionWorkDir,
        ...(options.mirror === undefined ? {} : { mirror: options.mirror }),
        state: state ?? { sandboxId, attempt: 1 },
        isResume: startOptions.resumeFrom !== undefined || startOptions.continueFrom !== undefined,
        continuing: continuationOf(startOptions) !== undefined,
      })
    },
  }
}

/** The driver this session's turns go through; the injected one only when a test supplied it. */
function driverFor(
  options: CreateClaudeCodeOptions,
  run: { sandboxId: string, runId: string },
): TurnDriver {
  if (options.driverFactory !== undefined) {
    return options.driverFactory(run)
  }
  return turnDriver(options.sandboxes, {
    sandboxId: run.sandboxId,
    runId: run.runId,
    config: options.config,
    openSocket: options.openSocket,
    kind: options.kind ?? 'sdk',
    // Only the `cli` driver reads it, and that kind is refused above — but a driver built with a
    // thrower rather than with a stub is one that cannot silently run the wrong command.
    claudeArgv: options.claudeArgv ?? (() => {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: CLAUDE_CODE_HARNESS_ID,
        message: `The claude-code harness was created without a claudeArgv builder, which the 'cli' driver requires.`,
      })
    }),
    settingSources: options.settingSources,
  })
}

/**
 * The sandbox this session runs in, as the framework's session reports it.
 *
 * A *network* sandbox session, because `id` is what the driver dials by and only that shape has
 * one. A caller-provided basic session names no resource, so there is nothing to attach to and
 * nothing to resume — which is a missing capability rather than a bad argument.
 */
function sandboxIdOf(startOptions: HarnessV1StartOptions): string {
  const id = (startOptions.sandboxSession as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: CLAUDE_CODE_HARNESS_ID,
      message: `The claude-code harness needs a network sandbox session with an id — create one with @amond-ai/harness-sandbox's createHarnessSandboxProvider.`,
    })
  }
  return id
}

/** The continuation this start carries, whether given directly or nested in a resume payload. */
function continuationOf(startOptions: HarnessV1StartOptions): HarnessV1ContinueTurnState | undefined {
  return startOptions.continueFrom ?? startOptions.resumeFrom?.continueFrom
}

/**
 * The state this start imports, validated, or nothing at all for a fresh session.
 *
 * The `harnessId` is checked before the payload is: a state another adapter wrote may well
 * validate — `sandboxId` and `attempt` are not distinctive — and starting a turn on it would
 * dial a container this harness never provisioned.
 */
function importedState(startOptions: HarnessV1StartOptions): ClaudeCodeLifecycleState | undefined {
  const imported: HarnessV1ContinueTurnState | HarnessV1ResumeSessionState | undefined
    = continuationOf(startOptions) ?? startOptions.resumeFrom
  if (imported === undefined) {
    return undefined
  }
  if (imported.harnessId !== CLAUDE_CODE_HARNESS_ID) {
    throw new Error(`claude-code cannot import a '${imported.harnessId}' lifecycle state: expected '${CLAUDE_CODE_HARNESS_ID}'`)
  }
  const validated = claudeCodeLifecycleStateSchema.safeParse(imported.data)
  if (!validated.success) {
    throw new Error(`claude-code lifecycle state is not readable: ${validated.error.message}`)
  }
  return validated.data
}
