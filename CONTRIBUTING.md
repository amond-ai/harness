# Contributing

Thanks for your interest in contributing! This guide covers how to get from a clone to a merged pull request.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md). All documentation, code, comments, and commit messages in this repository are written in **English**.

## Getting started

```bash
git clone https://github.com/amond-ai/harness.git
cd harness
mise install        # install the pinned tool versions (bun, node)
bun install         # install dependencies and the git hooks
```

## Development workflow

1. Create a branch from `main` (e.g. `feat/short-description` or `fix/issue-123`).
2. Make focused changes — keep each pull request to one logical change.
3. Run the checks below and make sure they pass.
4. Open a pull request and fill out the template.

```bash
bun run build       # build every package into dist/ (what gets published)
bun run lint        # lint and format
bun run check       # type-check every package (tsc --noEmit)
bun run test        # run the test suite
```

`test` depends on its own package's `build`, so turbo runs that for you. `check` depends only on
its **dependencies'** builds — it does not build the package being checked — so run `build`
yourself when you want to inspect what a package would ship.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, where `type` is one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, etc. Breaking changes include a `BREAKING CHANGE:` footer. Versioning and the changelog are generated automatically from these messages, so accurate types matter.

## Pull requests

Please open an issue or a discussion before a substantial PR. A well-framed
problem is easier to guide than a finished patch, and it keeps us from turning
down work you have already done. Small, obvious fixes can go straight to a PR.

- Reference the issue your PR addresses (e.g. `Closes #123`).
- Use a Conventional-Commit-style PR title — it becomes the squash-merge commit.
- Make sure CI is green before requesting review.

## Reporting bugs and requesting features

| You want to…                     | File it as…      | Humans                                                                         | Agents                                                                           |
| -------------------------------- | ---------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Report a bug or propose a fix    | an **Issue**     | [New issue](https://github.com/amond-ai/harness/issues/new/choose)                 | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE)                              |
| Request a feature or enhancement | a **Discussion** | [New discussion](https://github.com/amond-ai/harness/discussions/categories/ideas) | [`.github/DISCUSSION_TEMPLATE/ideas.yml`](.github/DISCUSSION_TEMPLATE/ideas.yml) |

A well-framed problem is worth more to us than a finished PR. Send the clearest
account of the bug, or the strongest case for the feature — the full context
that lets us guide the work. Accepted proposals are promoted to issues before
implementation, and if we take yours on, we credit you.

**Security vulnerabilities** → **do not** open a public issue — follow
[SECURITY.md](./SECURITY.md).
