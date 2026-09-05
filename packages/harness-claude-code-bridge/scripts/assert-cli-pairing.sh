#!/usr/bin/env bash
# Assert that the Agent SDK the turn host runs is paired with the `claude` CLI the
# image baked. The SDK spawns that CLI over its stdio control protocol, and the two
# are released together: SDK 0.3.<n> speaks to CLI 2.1.<n>. A mismatch does not fail
# loudly at runtime — it fails as a control request the CLI does not answer, mid-turn,
# in a sandbox. So it is asserted at build time instead.
#
# Bump procedure: change the CLI pin in docker/config.toml, then the SDK pin in
# packages/turn-host/package.json to the same patch. Regenerate the root lockfile
# with `bun install`; docker/build-turn-host.sh regenerates the runtime lockfile it
# ships in the image.
set -euo pipefail

# The two release lines this pairing is defined over. They move together: when the
# SDK opens a new minor the CLI opens a new minor in the same release, so both
# prefixes are updated in one edit.
cli_line="2.1"
sdk_line="0.3"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sdk_package_json="${here}/../node_modules/@anthropic-ai/claude-agent-sdk/package.json"

if [ ! -f "${sdk_package_json}" ]; then
  echo "ERROR: the Agent SDK is not installed at ${sdk_package_json}" >&2
  exit 1
fi

# `2.1.215 (Claude Code)` -> `2.1.215`
cli_version="$(claude --version | awk '{print $1}')"
# `0.3.215` or `0.3.215-rc.1` -> the version string as published
sdk_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${sdk_package_json}" | head -1)"

# major.minor.patch, ignoring any `-prerelease` suffix. A version the regex does not
# match is a mismatch, not a pass: the comparison below would otherwise be over empty
# strings on both sides.
version_re='^([0-9]+)\.([0-9]+)\.([0-9]+)([-+].*)?$'

if [[ ! "${cli_version}" =~ ${version_re} ]]; then
  echo "ERROR: could not parse claude CLI version '${cli_version}'" >&2
  exit 1
fi
cli_release="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
cli_patch="${BASH_REMATCH[3]}"

if [[ ! "${sdk_version}" =~ ${version_re} ]]; then
  echo "ERROR: could not parse Agent SDK version '${sdk_version}'" >&2
  exit 1
fi
sdk_release="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
sdk_patch="${BASH_REMATCH[3]}"

if [ "${cli_release}" != "${cli_line}" ] || [ "${sdk_release}" != "${sdk_line}" ] \
  || [ "${cli_patch}" != "${sdk_patch}" ]; then
  echo "ERROR: claude CLI ${cli_version} is not paired with Agent SDK ${sdk_version}" >&2
  echo "       expected CLI ${cli_line}.<n> with Agent SDK ${sdk_line}.<n> at the same <n>;" >&2
  echo "       got CLI ${cli_release}.${cli_patch} and SDK ${sdk_release}.${sdk_patch}" >&2
  echo "       pin packages/turn-host/package.json to ${sdk_line}.${cli_patch}" >&2
  exit 1
fi

echo "turn host: claude CLI ${cli_version} paired with Agent SDK ${sdk_version}"
