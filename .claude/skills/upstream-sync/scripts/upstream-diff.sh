#!/usr/bin/env bash
# Compare two published versions of an upstream npm package for a vendored package.
#
# Usage: upstream-diff.sh <npm-package> <from-version> <to-version> [path ...]
#
#   <path>  Paths inside the package to diff, e.g. src/bridge src/v1/harness-v1-stream-part.ts.
#           Defaults to src.
#
# Downloads both tarballs into a fresh temp directory. The script only extracts and diffs
# them; nothing it downloads is executed. Prints:
#   1. the temp directory, so the full trees can be read afterwards
#   2. the changeset entries (`- <hash>: ...`) after <from-version> up to and including
#      <to-version>; `Updated dependencies` and bare version-bump lines are left out
#   3. the changed files and the unified diff of each requested path
#   4. the runtime dependencies of <to-version>, for aligning version pins
set -euo pipefail

if [ "$#" -lt 3 ]; then
  sed -n '2,8p' "$0" >&2
  exit 2
fi

pkg="$1"
from="$2"
to="$3"
shift 3
paths=("$@")
[ "${#paths[@]}" -eq 0 ] && paths=(src)

work=$(mktemp -d "${TMPDIR:-/tmp}/upstream-diff.XXXXXX")
for version in "$from" "$to"; do
  mkdir "$work/$version"
  (cd "$work/$version" && npm pack "$pkg@$version" --silent >/dev/null && tar xzf ./*.tgz)
done
echo "## Workdir"
echo "$work  (from: $work/$from/package, to: $work/$to/package)"

echo
echo "## CHANGELOG ($pkg, after $from up to $to)"
awk -v to="## $to" -v from="## $from" '
  $0 == to { on = 1 }
  $0 == from { exit }
  !on { next }
  # A version heading is printed only when an entry follows it.
  /^## / { heading = $0; entry = 0; next }
  /^- [0-9a-f]{7,40}:/ { if (heading != "") { print heading; heading = "" } print; entry = 1; blank = ""; next }
  # An entry continues on indented lines, paragraph breaks included, until the next bullet or
  # heading.
  /^[-#]/ { entry = 0; blank = ""; next }
  !entry { next }
  # changesets can append a dependency bump to an entry as an indented `- <pkg>@<version>` bullet.
  /^ +- (@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]/ { next }
  /^$/ { blank = blank "\n"; next }
  /^ +/ { printf "%s", blank; blank = ""; print }
' "$work/$to/package/CHANGELOG.md"

echo
echo "## Changed files"
for path in "${paths[@]}"; do
  diff -rqN "$work/$from/package/$path" "$work/$to/package/$path" || true
done

echo
echo "## Diff"
for path in "${paths[@]}"; do
  diff -ruN "$work/$from/package/$path" "$work/$to/package/$path" || true
done

echo
echo "## Dependencies of $pkg@$to"
npm view "$pkg@$to" dependencies --json
