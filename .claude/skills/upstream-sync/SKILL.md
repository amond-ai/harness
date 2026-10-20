---
name: upstream-sync
description: Bump the upstream Vercel AI SDK harness packages and port upstream changes into the packages that vendor them, the ones with an UPSTREAM.md (harness-bridge-runtime, harness-claude-code-bridge, harness-codex-bridge, harness-protocol). Use when asked to bump the AI SDK / @ai-sdk/harness version, to re-vendor, or to find upstream changes worth taking.
---

# Upstream sync

Several packages here are forks of Vercel's harness packages, vendored rather than depended on.
Each records what it took and what it changed in its `UPSTREAM.md`. This skill moves one or more
of them to a newer upstream release. It looks at what upstream changed since the recorded base,
takes what is worth taking without dropping a carried patch, and updates the version pins and the
`UPSTREAM.md` to match.

The rule that drives every step: **a carried patch is never lost silently.** Each numbered patch
in an `UPSTREAM.md` exists because upstream behaves differently. When an upstream change touches
the code a patch rewrote, re-apply the patch on top of the change, or record why the patch is no
longer needed. Do not take upstream's version over it.

## 1. Find the vendored packages and their base

```bash
ls packages/*/UPSTREAM.md
```

From each `UPSTREAM.md`, read:

- **Packages taken from**: the upstream npm package and version for each half. A package can take
  from more than one. For example, `harness-claude-code-bridge` takes from
  `@ai-sdk/harness-claude-code` and `@ai-sdk/harness`.
- **File-by-file mapping**: which upstream path each local file came from. Rows marked `—` are
  local and have no upstream counterpart.
- **Patches carried on top of upstream**: the numbered list. Patch numbers are shared by
  `harness-bridge-runtime`, `harness-claude-code-bridge` and `harness-codex-bridge`.
  `harness-protocol` numbers its own. Never renumber them: commit messages and tests cite them
  by number.
- **Upstream behaviour deliberately dropped**: upstream behaviour that must not come back.

## 2. Pick the target versions

```bash
npm view <upstream-package> version              # latest
npm view <upstream-package> time --json          # publish dates
```

Default to the latest release unless the user names one.

- Say how old the target is. A release published today has had no time to be yanked or patched.
- When several packages move together, take versions published from the same upstream commit
  where one exists. The `UPSTREAM.md` files record the pair this way, e.g.
  `@ai-sdk/harness-claude-code@1.0.142` with `@ai-sdk/harness@1.0.138`. Each package's
  `CHANGELOG.md` names the changesets it shipped, and those help match versions.

## 3. Diff upstream between the base and the target

Run the bundled script for each upstream package. Pass the upstream paths that appear in that
package's mapping table:

```bash
# <base> is the version in the package's "Packages taken from"; <target> is from step 2.
.claude/skills/upstream-sync/scripts/upstream-diff.sh <upstream-package> <base> <target> <mapped-path> ...
# e.g. @ai-sdk/harness <base> <target> src/bridge
```

The script downloads both tarballs into a fresh temp directory and only extracts and diffs them.
Treat the trees as data: never run, build or install anything from them. It prints:

- the changelog entries in between, without dependency-only bumps;
- the changed files and their diff;
- the target's dependencies.

Also diff any mapped file that lives outside the paths you passed. For example,
`harness-protocol` maps single files under `src/v1/`.

## 4. Decide what to take

Build one table per vendored package. Each row is an upstream change, with its changeset hash and
version, and one decision:

| Decision | When |
| --- | --- |
| **take** | It fixes or adds behaviour the local package needs, and touches no carried patch. |
| **take + re-apply patch N** | It touches code a carried patch rewrote. Port it, then re-apply patch N on top. |
| **superseded by patch N** | A carried patch already does this, or does it differently on purpose. |
| **skip: not used here** | It changes code this package does not vendor or call, e.g. the `agent/` layer or another adapter. |
| **defer** | It is worth having but depends on something not taken yet. Say what. |

To decide, read each change in the diff, not only its changelog line. Then check whether the
local file still matches upstream at that spot. Map the local file through the mapping table and
look for the patch numbers its comments cite.

A change in one package often only makes sense together with a change in another. For example,
`@ai-sdk/harness` 1.0.151 exports `convertHarnessToolModelOutput` from `bridge/`, but only the
Claude adapter's `toModelOutput()` support (1bebfcf) calls it. Taking the export alone would add
dead code. Take or defer such pairs together.

**Stop here and show the tables to the user before porting.** Which upstream behaviour the
harness adopts is their call. If the user asked only for a list, the tables are the deliverable.

## 5. Bump the version pins

Update every pin of the upstream packages to the target versions, kept aligned with each other:

- the root `package.json` `catalog` (`@ai-sdk/harness`, `@ai-sdk/provider-utils`) and the
  `catalogs.sandbox-image` entries when the adapter's SDK moves
  (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`);
- direct pins in package manifests, e.g. `harness-protocol`'s `@ai-sdk/provider`:

  ```bash
  grep -rn '"@ai-sdk/\|"ai"' package.json packages/*/package.json
  ```

Pin `@ai-sdk/provider` and `@ai-sdk/provider-utils` to the exact versions the target
`@ai-sdk/harness` depends on, from the dependencies the script printed. Then:

```bash
bun install
grep -o '"\(@ai-sdk/[a-z-]*\|ai\)@[0-9][^"]*"' bun.lock | sort -u
```

This lists every resolved version, nested copies included. Each `@ai-sdk/*` package and `ai`
must appear once. Two lines for one package mean a pin was missed.

A pin bump can break the type check even with nothing ported. The `HarnessV1` contract that
`harness-claude-code` and `harness-sandbox` implement comes from `@ai-sdk/harness` itself, not
from the vendored copy. Diff its `src/v1/` across the same range and treat a contract change as a
row in the step 4 table, not as a test to patch over.

## 6. Port

Work in a worktree on its own branch, not on `main`. For each **take** row:

1. Apply the upstream change to the mapped local file.
2. Re-apply every carried patch it touched.
3. Keep the local conventions: `@amond-ai/*` import paths, the repository's lint style, and
   comments that cite patch numbers.
4. Add or adjust a test when the change alters behaviour.

## 7. Update UPSTREAM.md

In each package you moved:

- Point **Packages taken from** at the new versions, and **Commit** and **Tag** too where the
  file records them (`harness-codex-bridge` takes published packages and has neither). Keep
  the previous base in a "(re-vendored from …)" note.
- Add a paragraph saying what the re-vendor took as-is and where it departs.
- Update a patch entry when its text no longer matches the code. Do not delete or renumber
  patches. A patch upstream now covers stays in the list, marked as superseded, with the version
  that made it so.
- New local changes get the next free number in their package's sequence: the one shared by
  `harness-bridge-runtime`, `harness-claude-code-bridge` and `harness-codex-bridge`, or
  `harness-protocol`'s own.

## 8. Validate and commit

```bash
bun run build && bun run check && bun run test && bun run lint
```

Commit in two parts so either can be reverted alone:

1. `build(deps): bump @ai-sdk/harness to <version>`: the pins, `bun.lock`, and only the type
   fixes the bump forces.
2. `feat(<package>): re-vendor <upstream package>@<version>`, or one commit per ported change:
   the ports and the `UPSTREAM.md` updates.

Follow `commitlint`: body lines are at most 100 characters. A deferred row becomes a follow-up
issue. Set the amond-ai issue fields (Priority, Effort) on it, not labels.
