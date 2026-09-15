---
name: amond-ai-harness-pr-conventions
description: PR conventions for amond-ai/harness — draft-by-default decision basis, repo PR template shape, no merge queue
metadata:
  type: project
---

`amond-ai/harness` is a public repo outside the `chatbot-pf` / `pleaseai` orgs, so
the skill's draft-by-default rule does not apply to it by org. Open feature PRs
there are nonetheless created as drafts in practice (#14, #15 as of 2026-09-14),
while the small merged infra PRs (#3, #8, #9) went straight to ready.

**Why:** feature work in this repo lands as a planned multi-PR split with known
outstanding follow-up (rebases, conflicts), so ready-for-review would be
premature. Small self-contained infra changes have no such tail.

**How to apply:** absent `--ready`, open feature/refactor PRs here as draft and
state the reason (repo practice + outstanding work), not the org rule. Open
one-shot infra/docs/build PRs ready.

Two further facts worth not re-deriving:

- No merge queue on `main` (`repository.mergeQueue` is `null`), and no
  stacked-PR tool tracks the worktrees — `detect-stack-tool.sh` is silent. Plain
  `gh`/`gh please` merge semantics apply.
- `.github/PULL_REQUEST_TEMPLATE.md` is a single template with exactly three
  `##` sections: `## Summary`, `## Related issue`, `## Checklist` (6 boxes keyed
  to `bun run test` / `bun run lint` / `bun run check`), above them a leading
  Conventional-Commits title comment — a comment, not a section. Extra sections
  (design notes, verification, rebase warnings) slot in cleanly between Summary
  and Related issue; the checklist must stay last.
- The repo ships no AI-reviewer config (`.github` has only `dependabot.yml`,
  `ISSUE_TEMPLATE`, `DISCUSSION_TEMPLATE`, and `ci.yml`/`release-please.yml`/
  `zizmor.yml`), so the ready flip does not itself trigger a bot review.
