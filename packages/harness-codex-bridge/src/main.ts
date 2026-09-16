// Entry point for the turn host. The one module that loads the real Codex SDK:
// it parses argv, injects the `Codex` constructor into the turn driver, and
// hands the resulting `onStart`/`onStop` to the bridge runtime. Everything the
// Worker talks to lives behind the WebSocket the runtime binds.

import type { CodexFactory, CodexLike } from './turn-driver'
import { readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import process, { argv, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { runBridge } from '@amond-ai/harness-bridge-runtime'
import { Codex } from '@openai/codex-sdk'
import { createTurnDriver } from './turn-driver'

const args = parseArgs(argv.slice(2))

/*
 * `--version` is the image build's smoke test: it loads the bundle and the real
 * SDK, prints both versions, and exits 0. A bundle that cannot resolve its
 * runtime dependencies fails the build here rather than mid-turn in a sandbox.
 */
if (argv.includes('--version')) {
  stdout.write(
    `${JSON.stringify({
      type: 'turn-host-version',
      sdk: sdkVersion(),
      node: process.versions.node,
    })}\n`,
  )
  process.exit(0)
}

if (!args.workdir) {
  emitFatal('Missing --workdir argument.')
}
if (!args.bridgeStateDir) {
  emitFatal('Missing --bridge-state-dir argument.')
}

/*
 * The one cast in the package. The options this host builds are wider than
 * `CodexOptions`/`ThreadOptions` declare — `config` is an open TOML-shaped
 * record — and the SDK's `ThreadEvent` union is narrower than the wire shapes
 * the translation reads, which are what an older or newer CLI actually emits.
 * Confining both to this line keeps every call site in `turn-driver.ts`
 * checked against `CodexLike`.
 */
const createCodex: CodexFactory = options =>
  new Codex(options as ConstructorParameters<typeof Codex>[0]) as unknown as CodexLike

const driver = createTurnDriver({ createCodex, workdir: args.workdir })

try {
  // eslint-disable-next-line antfu/no-top-level-await
  await runBridge({
    bridgeType: 'codex',
    bridgeStateDir: args.bridgeStateDir,
    onStart: driver.onStart,
    // Codex's session state lives in `~/.codex/sessions` on the sandbox
    // filesystem; the resume payload is the thread id that indexes it.
    onStop: driver.onStop,
    // Both lifecycle commands exit the process; an in-flight turn's `codex
    // exec` child only dies with the signal the driver aborts here.
    onDestroy: driver.onDestroy,
  })
}
catch (err) {
  // A refusal to start — a missing channel token, a port already taken — is a
  // configuration fault, and the Worker reads `bridge-fatal` for those. Without
  // this it would surface as an unhandled rejection the host cannot parse.
  emitFatal(err instanceof Error ? err.message : String(err))
}

function parseArgs(argsIn: string[]): {
  workdir?: string
  bridgeStateDir?: string
} {
  const out: { workdir?: string, bridgeStateDir?: string } = {}
  for (let i = 0; i < argsIn.length; i++) {
    if (argsIn[i] === '--workdir' && i + 1 < argsIn.length) {
      out.workdir = argsIn[++i]
    }
    else if (argsIn[i] === '--bridge-state-dir' && i + 1 < argsIn.length) {
      out.bridgeStateDir = argsIn[++i]
    }
  }
  return out
}

function emitFatal(message: string): never {
  stdout.write(`${JSON.stringify({ type: 'bridge-fatal', message })}\n`)
  process.exit(1)
}

/**
 * The installed SDK's version, read from its manifest rather than a constant so
 * it cannot drift from what is actually resolved at runtime.
 *
 * Walked up from the resolved entry point rather than resolved directly: the
 * package's `exports` map has one entry and does not publish
 * `./package.json`, and the entry itself sits in `dist/`, so the manifest is
 * not the file beside it. The walk stops at the first `package.json` that
 * names this package, so a stray manifest inside `dist/` cannot answer for it.
 */
function sdkVersion(): string {
  const packageName = '@openai/codex-sdk'
  let directory = dirname(fileURLToPath(import.meta.resolve(packageName)))
  const { root } = parse(directory)
  while (true) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      ) as { name?: string, version?: string }
      if (manifest.name === packageName) {
        return manifest.version ?? 'unknown'
      }
    }
    catch {}
    if (directory === root) {
      return 'unknown'
    }
    directory = dirname(directory)
  }
}
