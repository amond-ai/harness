/**
 * Prove a built e2b template can actually run a turn (#385).
 *
 * ```sh
 * infisical run --silent -- bun packages/sandbox-e2b/scripts/check-template.ts
 * ```
 *
 * It boots `E2B_TEMPLATE` (default `pleaseworks`) with the plain e2b SDK — no provider, no
 * journal — and asserts the four things the `sdk` driver depends on: that commands run as
 * `user`, that they run in that user's home, that the baked turn host loads under `node`, and
 * that the `claude` the SDK spawns is on PATH. All four are `test`s rather than prints,
 * because a probe whose output only a reader can judge is not a check. The probe is handed to
 * e2b bare: envd already wraps every command in `/bin/bash -l -c`, so a PATH that only exists
 * for a non-login shell fails here rather than on the first turn — and a second `bash -lc`
 * of our own would only have the outer shell expand `$HOME` before the inner one ran.
 */
import process from 'node:process'
import { CommandExitError, Sandbox } from 'e2b'

const template = process.env.E2B_TEMPLATE?.trim() || 'pleaseworks'
// `set -e` because `bash -l -c` otherwise reports only the *last* command's status: without it
// a failing assertion would be masked by the `claude --version` that follows it. The identity
// is echoed as well as asserted, so a failure's transcript says what it actually was.
const PROBE = [
  'set -e',
  'echo "user=$(id -un) home=$HOME"',
  'test "$(id -un)" = user',
  'test "$HOME" = /home/user',
  'node /opt/turn-host/bridge.mjs --version',
  'claude --version',
].join('; ')

const sandbox = await Sandbox.create(template)
try {
  // `timeoutMs: 0` for the reason the package README gives: e2b's 60s per-command default
  // would kill a cold probe rather than answer it.
  const result = await sandbox.commands.run(PROBE, { timeoutMs: 0 })
  console.log(result.stdout)
  console.log(`template '${template}' carries the turn host`)
}
catch (cause) {
  // The transcript is the whole point of running this, and `run` throws it away into an
  // error's fields on a non-zero exit — so print it before letting the failure out.
  if (cause instanceof CommandExitError) {
    console.log(cause.stdout)
    console.error(cause.stderr)
    throw new Error(`template '${template}' failed the turn-host probe with exit ${cause.exitCode}`)
  }
  throw cause
}
finally {
  await sandbox.kill()
}
