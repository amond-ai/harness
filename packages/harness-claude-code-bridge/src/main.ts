// Entry point for the turn host. The one module that loads the real Agent SDK:
// it parses argv, injects `query()` into the turn driver, and hands the
// resulting `onStart` to the bridge runtime. Everything the Worker talks to
// lives behind the WebSocket the runtime binds.

import type { StartMessage } from '@amond-ai/harness-protocol'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process, { argv, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { runBridge } from './bridge-runtime'
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

try {
  // eslint-disable-next-line antfu/no-top-level-await
  await runBridge<StartMessage>({
    bridgeType: 'claude-code',
    bridgeStateDir: args.bridgeStateDir,
    onStart: createTurnDriver({ query, workdir: args.workdir }),
    // Claude Code's session state lives on the sandbox filesystem; the resume
    // payload is empty.
    onStop: () => ({}),
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
 * it cannot drift from what is actually resolved at runtime — the same file
 * `scripts/assert-cli-pairing.sh` compares against `claude --version`. The
 * package does not export `./package.json`, so resolve its entry point and read
 * the manifest beside it.
 */
function sdkVersion(): string {
  const entry = fileURLToPath(
    import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
  )
  const manifest = JSON.parse(
    readFileSync(join(dirname(entry), 'package.json'), 'utf8'),
  ) as { version?: string }
  return manifest.version ?? 'unknown'
}
