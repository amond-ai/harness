import type { SandboxCommand } from '@amond-ai/sandbox'
/**
 * The Durable Object a Cloudflare sandbox lives in.
 *
 * Consumers export it and bind it in wrangler
 * (`export { HarnessSandbox } from '@amond-ai/sandbox-cloudflare'`).
 *
 * Every step after `start()` may run again after a deploy restarts the object, so each is
 * idempotent.
 *
 * A subclass overrides the defaults through the protected members, since consumers never
 * construct a Durable Object themselves.
 */
import type {
  HarnessSandboxRpc,
  KillOutcome,
  ProcessLogFile,
  ProcessMeta,
  ProcessReport,
  StartProcessOptions,
} from './rpc'
import { SANDBOX_PORT_HEADER } from '@amond-ai/harness-transport-cloudflare'
import { Files, SandboxFileError } from '@cloudflare/sandbox'
import { DurableObject } from 'cloudflare:workers'
import { bridge } from './bridge'
import {
  isProcessId,
  KILL,
  KILL_EXITED,
  KILL_NO_PID,
  LIST,
  parseMeta,
  parseState,
  PREPARE,
  PROCESS_ROOT,
  processDir,
  READ_SLICE,
  RUN,
  signalName,
  SIZE,
  STATUS,
} from './process-scripts'

const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000
const ALARM_INTERVAL_MS = 60_000
const PROCESS_KEY_PREFIX = 'process:'
const PID_WAIT_MS = 5_000
const PID_POLL_MS = 100
const ENV_NAME = /^[A-Z_]\w*$/i

const LOG_FILES: ReadonlySet<string> = new Set<ProcessLogFile>(['stdout.log', 'stderr.log'])

interface RunResult {
  exitCode: number
  stdout: Uint8Array
}

/** The options the container is started with; see {@link HarnessSandbox.containerOptions}. */
export type HarnessContainerOptions = Parameters<Container['start']>[0]

export class HarnessSandbox<Env = unknown> extends DurableObject<Env> implements HarnessSandboxRpc {
  private setup: Promise<void> | null = null
  private filesFor: { container: Container, files: Files } | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Neither the inactivity timeout nor `setupContainer` survives a restart of this object, so
    // one that finds the container already running sets both up again before serving anything —
    // `fetch` and the discovery reads never call `ensureRunning` themselves. A failed setup has
    // already stopped the container; it is logged rather than thrown, which would reset the object.
    if (ctx.container?.running === true) {
      void ctx.blockConcurrencyWhile(() => this.ensureRunning().catch((error: unknown) => {
        console.error('HarnessSandbox restart setup failed', error)
      }))
    }
  }

  /** How long the container may sit idle before it stops. At most six hours. */
  protected inactivityTimeoutMs(): number {
    return DEFAULT_INACTIVITY_TIMEOUT_MS
  }

  /**
   * How a new container starts. The image is the one wrangler builds under `images.sandbox`.
   *
   * `enableInternet` must be passed on every start: the agent in the container needs its model
   * API.
   */
  protected containerOptions(): HarnessContainerOptions {
    const image = this.container.images.sandbox
    if (image === undefined) {
      throw new Error(
        'no `sandbox` image on this container: add `images.sandbox` to the `containers` entry '
        + 'for this class in wrangler, or override containerOptions()',
      )
    }
    return { image, instance: 'standard-1', enableInternet: true }
  }

  /**
   * Runs once for each container this object starts, and again when a restarted object finds
   * one running — where to intercept outbound traffic (`interceptOutboundHttps`), for instance.
   * It must be safe to run twice. A throw stops the container, so nothing runs in one that was
   * not set up.
   */
  protected async setupContainer(_container: Container, _fresh: boolean): Promise<void> {}

  private get container(): Container {
    const container = this.ctx.container
    if (!container) {
      throw new Error('The container binding is not configured')
    }
    return container
  }

  private get files(): Files {
    const container = this.container
    if (this.filesFor?.container !== container) {
      this.filesFor = { container, files: new Files(container) }
    }
    return this.filesFor.files
  }

  private ensureRunning(): Promise<void> {
    if (this.setup === null || !this.container.running) {
      this.setup = this.startContainer().catch((error: unknown) => {
        this.setup = null
        throw error
      })
    }
    return this.setup
  }

  private async startContainer(): Promise<void> {
    const container = this.container
    const fresh = !container.running
    if (fresh) {
      container.start(this.containerOptions())
    }
    try {
      await container.setInactivityTimeout(this.inactivityTimeoutMs())
      await this.setupContainer(container, fresh)
    }
    catch (error) {
      await container.destroy()
      throw error
    }
  }

  private runningContainer(): Container | undefined {
    const container = this.ctx.container
    return container?.running === true ? container : undefined
  }

  private async run(container: Container, argv: string[]): Promise<RunResult> {
    const process = await container.exec(argv)
    const output = await process.output()
    return { exitCode: output.exitCode, stdout: new Uint8Array(output.stdout) }
  }

  private async script(container: Container, script: string, ...args: string[]): Promise<RunResult> {
    return this.run(container, ['sh', '-c', script, 'sh', ...args])
  }

  async startProcess(id: string, command: SandboxCommand, options?: StartProcessOptions): Promise<ProcessReport> {
    const dir = processDir(id)
    if (command.length === 0) {
      throw new Error('cannot start an empty argv: there is no command to run')
    }
    const badName = Object.keys(options?.env ?? {}).find(name => !ENV_NAME.test(name))
    if (badName !== undefined) {
      throw new Error(`invalid environment variable name '${badName}': expected [A-Za-z_][A-Za-z0-9_]*`)
    }
    await this.ensureRunning()
    const container = this.container
    const meta: ProcessMeta = { id, command: [...command], cwd: options?.cwd, startedAt: new Date().toISOString() }
    const prepared = await this.script(container, PREPARE, PROCESS_ROOT, dir, JSON.stringify(meta))
    if (prepared.exitCode !== 0) {
      throw new Error(`process '${id}' could not be created: its id is in use or ${PROCESS_ROOT} is not writable`)
    }
    const seconds = options?.timeout === undefined ? '' : String(Math.max(0, options.timeout) / 1000)
    const key = `${PROCESS_KEY_PREFIX}${id}`
    try {
      // Tracked before it launches, so no storage failure can leave a live process the alarm
      // never sees: until RUN writes its pid the process reads `starting`, which the alarm keeps.
      await this.ctx.storage.put(key, [...command])
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
      // Ignoring the output is what lets the process outlive this request. The env travels in the
      // environment, not argv, so its values stay out of `ps`; RUN shields itself from its `PATH`.
      await container.exec(['sh', '-c', RUN, 'sh', dir, seconds, ...command], {
        cwd: options?.cwd,
        env: options?.env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
    }
    catch (cause) {
      // Key first: once the dir is gone a concurrent start may reuse the id, and keep its key.
      await this.ctx.storage.delete(key).catch(() => undefined)
      await this.run(container, ['rm', '-rf', dir]).catch(() => undefined)
      throw cause
    }

    const deadline = Date.now() + PID_WAIT_MS
    for (;;) {
      const report = await this.processStatus(id)
      if (report === undefined) {
        return { id, meta, state: { state: 'lost' } }
      }
      if (report.state.state !== 'starting' || Date.now() >= deadline) {
        return report
      }
      await new Promise(resolve => setTimeout(resolve, PID_POLL_MS))
    }
  }

  async processStatus(id: string): Promise<ProcessReport | undefined> {
    const container = this.runningContainer()
    if (container === undefined || !isProcessId(id)) {
      return undefined
    }
    const { stdout } = await this.script(container, STATUS, processDir(id))
    const [status = '', marker = '', meta = ''] = new TextDecoder().decode(stdout).split('\n')
    return reportOf(id, status, marker, meta)
  }

  async listProcesses(): Promise<ProcessReport[]> {
    const container = this.runningContainer()
    if (container === undefined) {
      return []
    }
    const { stdout } = await this.script(container, LIST, PROCESS_ROOT)
    const lines = new TextDecoder().decode(stdout).split('\n')
    const reports: ProcessReport[] = []
    for (let at = 0; at + 3 < lines.length; at += 4) {
      const id = lines[at]!
      const report = isProcessId(id) ? reportOf(id, lines[at + 1]!, lines[at + 2]!, lines[at + 3]!) : undefined
      if (report !== undefined) {
        reports.push(report)
      }
    }
    return reports
  }

  async readProcessLog(id: string, file: ProcessLogFile, offset: number, limit: number): Promise<Uint8Array> {
    const container = this.runningContainer()
    if (container === undefined) {
      return new Uint8Array()
    }
    const result = await this.script(container, READ_SLICE, logPath(id, file), String(offset), String(limit))
    if (result.exitCode !== 0) {
      throw new Error(`reading ${file} of process '${id}' failed with exit code ${result.exitCode}`)
    }
    return result.stdout
  }

  async processLogSize(id: string, file: ProcessLogFile): Promise<number> {
    const container = this.runningContainer()
    if (container === undefined) {
      return 0
    }
    const result = await this.script(container, SIZE, logPath(id, file))
    const size = Number(new TextDecoder().decode(result.stdout).trim())
    if (result.exitCode !== 0 || !Number.isSafeInteger(size)) {
      throw new Error(`sizing ${file} of process '${id}' failed with exit code ${result.exitCode}`)
    }
    return size
  }

  async killProcess(id: string, signal?: number): Promise<KillOutcome> {
    const name = signal === undefined ? 'TERM' : signalName(signal)
    if (name === undefined) {
      return { delivered: false, reason: 'unknown-signal', detail: `no name for signal ${String(signal)}` }
    }
    const container = this.runningContainer()
    if (container === undefined) {
      return { delivered: false, reason: 'not-running' }
    }
    const { exitCode } = await this.script(container, KILL, processDir(id), name)
    if (exitCode === 0) {
      return { delivered: true }
    }
    if (exitCode === KILL_EXITED) {
      return { delivered: false, reason: 'exited' }
    }
    return exitCode === KILL_NO_PID
      ? { delivered: false, reason: 'no-pid' }
      : { delivered: false, reason: 'failed', detail: `kill exited with ${exitCode}` }
  }

  async readFile(path: string): Promise<Uint8Array> {
    await this.ensureRunning()
    return new Uint8Array(await (await this.files.readFile(path)).arrayBuffer())
  }

  async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
    await this.ensureRunning()
    const response = await this.files.readFile(path)
    return response.body ?? new ReadableStream({ start: controller => controller.close() })
  }

  /** Creates the parent first: the contract's callers rely on it, and 1.0's `Files` does not. */
  async writeFile(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    await this.ensureRunning()
    const parent = path.slice(0, path.lastIndexOf('/'))
    if (parent !== '') {
      await this.files.mkdir(parent, { recursive: true })
    }
    await this.files.writeFile(path, content)
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    await this.ensureRunning()
    await this.files.mkdir(path, { recursive })
  }

  /** The call that boots the container, by the contract's design. */
  async exists(path: string): Promise<boolean> {
    await this.ensureRunning()
    try {
      await this.files.stat(path)
      return true
    }
    catch (cause) {
      if (SandboxFileError.is(cause) && cause.code === 'ENOENT') {
        return false
      }
      throw cause
    }
  }

  async destroySandbox(): Promise<void> {
    const container = this.runningContainer()
    if (container !== undefined) {
      await container.destroy()
    }
    this.setup = null
    const keys = await this.ctx.storage.list({ prefix: PROCESS_KEY_PREFIX })
    await this.ctx.storage.delete([...keys.keys()])
    await this.ctx.storage.deleteAlarm()
  }

  /**
   * Keeps the container running while any process does, since a running process alone does not.
   */
  override async alarm(): Promise<void> {
    let active = false
    const processes = await this.ctx.storage.list<string[]>({ prefix: PROCESS_KEY_PREFIX })
    for (const key of processes.keys()) {
      const id = key.slice(PROCESS_KEY_PREFIX.length)
      const report = await this.processStatus(id)
      if (report?.state.state === 'running' || report?.state.state === 'starting') {
        active = true
      }
      else {
        await this.ctx.storage.delete(key)
      }
    }
    if (active) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
    }
  }

  /**
   * Forwards a request into the container on the port {@link SANDBOX_PORT_HEADER} names.
   * Never starts the container. The header is trusted because a Durable Object is reachable
   * only through its binding; a Worker that routes visitor requests here must strip it first.
   */
  override async fetch(request: Request): Promise<Response> {
    const container = this.runningContainer()
    if (container === undefined) {
      return new Response('The sandbox is not running', { status: 503 })
    }
    const port = Number(request.headers.get(SANDBOX_PORT_HEADER))
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return new Response(`${SANDBOX_PORT_HEADER} must name a TCP port`, { status: 400 })
    }
    const url = new URL(request.url)
    url.protocol = 'http:'
    const forwarded = new Request(url, request)
    forwarded.headers.delete(SANDBOX_PORT_HEADER)
    try {
      const response = await container.getTcpPort(port).fetch(forwarded)
      return response.webSocket ? bridge(response.webSocket) : response
    }
    catch {
      return new Response('Nothing is listening on this port', { status: 503 })
    }
  }
}

function reportOf(id: string, status: string, marker: string, meta: string): ProcessReport | undefined {
  const state = parseState(status, marker)
  return state === undefined ? undefined : { id, meta: parseMeta(meta, id), state }
}

function logPath(id: string, file: ProcessLogFile): string {
  if (!LOG_FILES.has(file)) {
    throw new Error(`'${String(file)}' is not a process log`)
  }
  return `${processDir(id)}/${file}`
}
