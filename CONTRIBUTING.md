# Contributing to the TypeScript ADK

We welcome contributions to the TypeScript Agent Development Kit (ADK) for the [Inference Gateway](https://github.com/inference-gateway/inference-gateway). This document covers the dev workflow, conventions, and processes for contributing.

If you're looking for the user-facing documentation - installation, usage, API reference - start with the [README](./README.md).

## Table of Contents

- [🚀 Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Setting Up Your Development Environment](#setting-up-your-development-environment)
    - [Option 1: Using Flox (Recommended)](#option-1-using-flox-recommended)
    - [Option 2: Manual Setup](#option-2-manual-setup)
- [📋 Development Workflow](#-development-workflow)
  - [Essential Tasks](#essential-tasks)
  - [Regenerating A2A Protocol Types](#regenerating-a2a-protocol-types)
  - [Development Cycle](#development-cycle)
  - [Before Committing](#before-committing)
- [🎯 Coding Guidelines](#-coding-guidelines)
  - [TypeScript Conventions](#typescript-conventions)
  - [Style](#style)
  - [Comments](#comments)
- [🛠️ Making Changes](#️-making-changes)
  - [Feature Branches](#feature-branches)
  - [Branch Naming](#branch-naming)
  - [Commit Message Format](#commit-message-format)
- [🧪 Testing Guidelines](#-testing-guidelines)
  - [Test Layout](#test-layout)
  - [Writing Tests](#writing-tests)
  - [Running a Single Test](#running-a-single-test)
  - [Coverage](#coverage)
  - [The Generated-Types Drift Test](#the-generated-types-drift-test)
- [🔄 Continuous Integration](#-continuous-integration)
  - [Required Status Checks](#required-status-checks)
- [🚢 Releases](#-releases)
- [🔄 Pull Request Process](#-pull-request-process)
  - [Before Submitting](#before-submitting)
  - [Review Process](#review-process)
- [🐛 Reporting Issues](#-reporting-issues)
- [📞 Getting Help](#-getting-help)
- [📋 Checklist](#-checklist)

## 🚀 Getting Started

### Prerequisites

- **Node.js 24 LTS or later**
- **pnpm 10.0 or later** - `10.18.0` is pinned via `package.json#packageManager`
- **Git**

### Setting Up Your Development Environment

#### Option 1: Using Flox (Recommended)

This project ships a [Flox](https://flox.dev/) environment under `.flox/` so contributors get a pinned Node + pnpm without polluting their host machine.

1. **Install Flox** (if not already installed):

   ```sh
   curl -L https://install.flox.dev | bash
   ```

2. **Fork the repository** on GitHub.

3. **Clone your fork**:

   ```sh
   git clone https://github.com/your-username/typescript-adk.git
   cd typescript-adk
   ```

4. **Activate the Flox environment** - this pins Node and pnpm to the versions CI uses:

   ```sh
   flox activate
   ```

   **VS Code integration**: install the [Flox VS Code extension](https://marketplace.visualstudio.com/items?itemName=flox.flox) so VS Code activates the environment automatically when you open the project.

5. **Add the upstream remote**:

   ```sh
   git remote add upstream https://github.com/inference-gateway/typescript-adk.git
   ```

6. **Install dependencies and verify your setup**:

   ```sh
   pnpm install
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

#### Option 2: Manual Setup

If you'd rather manage your own Node and pnpm versions:

1. Install **Node.js 24 LTS** (`nvm install 24` / `fnm install 24` / [Volta](https://volta.sh/) / etc.).
2. Enable Corepack and activate the pinned pnpm:

   ```sh
   corepack enable
   corepack prepare pnpm@10.18.0 --activate
   ```

3. Fork, clone, add upstream, install dependencies, and verify as above.

> ⚠️ Use **pnpm**, not npm or yarn. `pnpm-lock.yaml` is the lockfile of record, and `package.json#packageManager` pins the exact pnpm version CI uses.

## 📋 Development Workflow

### Essential Tasks

| Command                       | Description                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `pnpm install`                | Install dependencies (use `--frozen-lockfile` in CI)              |
| `pnpm build`                  | Bundle to `dist/` with `tsup` (ESM + `.d.ts`)                     |
| `pnpm test`                   | Run the Vitest suite (one-shot)                                   |
| `pnpm test:watch`             | Run Vitest in watch mode                                          |
| `pnpm test:coverage`          | Generate a v8 coverage report                                     |
| `pnpm lint` / `pnpm lint:fix` | Run ESLint (with `--fix` for autofixes)                           |
| `pnpm typecheck`              | Run `tsc --noEmit`                                                |
| `pnpm format`                 | Format with Prettier                                              |
| `pnpm format:check`           | Fail if files are not Prettier-formatted                          |
| `pnpm generate:types`         | Regenerate `src/types/generated/a2a.ts` from the pinned schema    |
| `pnpm generate:types:check`   | Fail if the committed generated types drift from the pinned schema |

### Regenerating A2A Protocol Types

The A2A protocol types in `src/types/generated/` are produced by `scripts/generate-a2a-types.ts` from the canonical JSON Schema in [`inference-gateway/schemas`](https://github.com/inference-gateway/schemas), pinned by commit SHA in the `SCHEMA_REF` constant at the top of the generator. **Never hand-edit `src/types/generated/`** - ESLint excludes it, and the drift test (`tests/a2a-types.test.ts`) will fail CI if the committed file disagrees with what regenerating from `SCHEMA_REF` would produce.

To consume a newer upstream schema:

1. Bump `SCHEMA_REF` in `scripts/generate-a2a-types.ts` to the new commit SHA.
2. Run `pnpm generate:types`.
3. Commit both the SHA bump and the regenerated `src/types/generated/a2a.ts` in the same commit.

The generator does two non-obvious normalizations before handing the schema to `json-schema-to-typescript`: (1) hoist inline named enums to top-level definitions so they aren't inlined as `TaskState1`, `TaskState2`, ...; (2) strip sibling keys from `$ref` usages so structurally identical refs don't get emitted as `Struct1`, `Struct2`. If you change the generator, preserve these - losing them produces a duplicated, numbered type wall.

### Development Cycle

Typical inner loop:

```sh
pnpm test:watch       # in one terminal
# edit code...
pnpm lint:fix         # before committing
pnpm typecheck
pnpm format
```

### Before Committing

Run the same four commands CI runs:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

If you changed the pinned schema SHA or the generator, also run `pnpm generate:types:check` to confirm the committed generated types still match.

## 🎯 Coding Guidelines

### TypeScript Conventions

`tsconfig.json` is intentionally strict - several flags change how you have to write code:

- **`verbatimModuleSyntax`** + **`module: "nodenext"`** - all relative imports must include the `.js` extension even when importing from a `.ts` source file (e.g., `from './card.js'`, not `from './card'`). This is non-negotiable; the build will fail without it.
- **`noUncheckedIndexedAccess`** - indexing an array or `Record` returns `T | undefined`. Use `arr[0]?.foo` or guard with `if (item === undefined) ...`.
- **`noPropertyAccessFromIndexSignature`** - use bracket notation (`obj['key']`) for index-signature properties, not `obj.key`. This is why `process.env['BUILD_AGENT_NAME']` is bracket-notation throughout the codebase.
- **`exactOptionalPropertyTypes`** - `{ x?: string }` does **not** accept `{ x: undefined }`. Pass the key conditionally, or use a different shape.
- **`isolatedModules`** - no `const enum`; re-export types with `export type`, not `export`.

### Style

- ESLint + Prettier are enforced in CI (`pnpm lint`, `pnpm format:check`). Run `pnpm lint:fix` and `pnpm format` locally before pushing.
- Don't introduce abstractions ahead of need. Three similar lines beats a premature helper.
- Don't add `// removed code` comments, re-export shims, or other backwards-compat scaffolding when you can just change the code. Pre-1.0, breaking changes are fine - call them out in the commit message.

### Comments

- Default to writing no comments. Names should carry the meaning.
- Write a comment only when the *why* is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific upstream bug.
- Don't add doc-block boilerplate that just restates the signature. JSDoc is welcome for public API surface where it adds genuine clarification (constraints, error behavior, links to related symbols).

## 🛠️ Making Changes

### Feature Branches

```sh
git checkout main
git pull upstream main
git checkout -b feat/your-feature-name
```

### Branch Naming

- **Features**: `feat/feature-name`
- **Bug fixes**: `fix/bug-description`
- **Documentation**: `docs/doc-topic`
- **Refactoring**: `refactor/component-name`
- **Tests**: `test/area`
- **Chores**: `chore/topic`

### Commit Message Format

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) - semantic-release reads them to compute the next version. The release rules live in [`.releaserc.yaml`](./.releaserc.yaml):

| Type       | Release bump | Notes                                                     |
| ---------- | ------------ | --------------------------------------------------------- |
| `feat`     | **minor**    | New consumer-visible capability                            |
| `fix`      | patch        | Bug fix                                                    |
| `perf`     | patch        | Performance improvement                                    |
| `refactor` | patch        | Internal refactor with no API change                       |
| `impr`     | patch        | General improvement                                        |
| `docs`     | patch        | Documentation only                                         |
| `test`     | patch        | Tests only                                                 |
| `build`    | patch        | Build tooling                                              |
| `ci`       | patch        | CI config                                                  |
| `style`    | patch        | Formatting / whitespace                                    |
| `security` | patch        | Security fix                                               |
| `chore`    | patch        | Misc (scope `release` is excluded from the release bump)   |

**Format:**

```
type(scope): short description

Optional body explaining motivation.

Optional footer: BREAKING CHANGE: ..., refs #123, etc.
```

**Examples:**

```
feat(client): add retry-with-jitter to A2AClient

fix(task): reject IN_PROGRESS → IN_PROGRESS as an invalid transition

docs(readme): document the ${VAR} placeholder mechanism

test(card): cover missing-env-var failure path
```

A **breaking change** anywhere in the body (`BREAKING CHANGE: ...`) bumps the major version. Pre-1.0 we still accept breaking changes as minor bumps where it's the right thing to do - call them out clearly in the PR description so reviewers can evaluate the migration impact.

## 🧪 Testing Guidelines

### Test Layout

Tests live in `tests/**/*.test.ts` and mirror the `src/` tree:

```
src/
├── agent/card.ts
├── agent/task.ts
└── server/server.ts
tests/
├── agent/card.test.ts
├── agent/task.test.ts
└── server/server.test.ts
```

Fixtures (sample agent cards, etc.) live in `tests/agent/fixtures/`.

### Writing Tests

Vitest is configured with `globals: false`, so import every helper explicitly:

```ts
import { describe, it, expect } from 'vitest';
import { canTransition, TASK_STATE } from '../../src/agent/task.js';

describe('canTransition', () => {
  it('allows SUBMITTED -> WORKING', () => {
    expect(canTransition(TASK_STATE.SUBMITTED, TASK_STATE.WORKING)).toBe(true);
  });

  it('rejects COMPLETED -> WORKING', () => {
    expect(canTransition(TASK_STATE.COMPLETED, TASK_STATE.WORKING)).toBe(false);
  });
});
```

- Prefer **table-driven** tests for state-machine and pure-logic code (use `it.each` or a `for` loop over a `cases` array).
- Don't mock things you can run in-process - the `A2AServer` happily listens on port `0` for ephemeral ports in tests.

### Running a Single Test

```sh
pnpm vitest run tests/agent/card.test.ts                   # by file
pnpm vitest run -t "applies overrides over JSON values"    # by test name
```

### Coverage

```sh
pnpm test:coverage
```

Coverage is informational, not gated - but new modules should land with at least the same coverage as the surrounding code.

### The Generated-Types Drift Test

`tests/a2a-types.test.ts` fetches the pinned schema over HTTPS at test time, regenerates the types in memory, and compares them to the committed `src/types/generated/a2a.ts`. It has a 30s timeout because of the network fetch - if you're offline it will fail; that's the test working as designed, not a flake. Re-run with network access (or pin a local copy of the schema if you need offline iteration).

## 🔄 Continuous Integration

CI runs on every push to `main` and on every pull request via [`.github/workflows/ci.yml`](./.github/workflows/ci.yml). The workflow installs dependencies, then runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` across a matrix of **Node 22 LTS** and **Node 24 LTS** on `ubuntu-24.04`.

### Required Status Checks

Branch protection on `main` should require these status checks before merge:

- `ci (22)`
- `ci (24)`

These names follow GitHub's matrix job naming (`<job-id> (<matrix-value>)`) and must be added under **Settings → Branches → Branch protection rules → Require status checks to pass before merging**.

## 🚢 Releases

Releases are driven by [`semantic-release`](https://semantic-release.gitbook.io/) on `workflow_dispatch` via [`.github/workflows/release.yml`](./.github/workflows/release.yml). Configuration lives in [`.releaserc.yaml`](./.releaserc.yaml).

You typically don't need to touch this - just make sure your commit messages follow the conventional-commit rules above. The next release will pick up the correct version bump automatically.

## 🔄 Pull Request Process

### Before Submitting

1. **Rebase on upstream main**:

   ```sh
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run the full local CI suite**:

   ```sh
   pnpm lint
   pnpm typecheck
   pnpm build
   pnpm test
   ```

3. **If you touched the schema or generator**, also run:

   ```sh
   pnpm generate:types:check
   ```

4. **Resolve any merge conflicts.**

### Review Process

1. Automated CI must pass (`ci (22)`, `ci (24)`).
2. At least one maintainer review.
3. Address review feedback by pushing new commits (don't force-push unless asked - reviewers may want to compare diffs across rounds).
4. A maintainer will squash-merge once approved; your conventional-commit messages drive the squash title.

## 🐛 Reporting Issues

Use [GitHub Issues](https://github.com/inference-gateway/typescript-adk/issues). For bug reports include:

- Steps to reproduce
- Expected vs actual behavior
- Node version (`node --version`) and OS
- Relevant logs, stack traces, or minimal repro snippet

For feature requests, describe the use case first, then propose API shape if you have one in mind.

## 📞 Getting Help

- **GitHub Discussions**: [Project Discussions](https://github.com/inference-gateway/typescript-adk/discussions)
- **Issues**: [GitHub Issues](https://github.com/inference-gateway/typescript-adk/issues)
- **Docs**: [Official Docs](https://docs.inference-gateway.com)

Check existing issues and discussions before opening a new one - your question may already have an answer.

## 📋 Checklist

Before submitting your contribution:

- [ ] Branch is rebased on latest `upstream/main`
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` all pass locally
- [ ] If you bumped `SCHEMA_REF` or changed the generator, `pnpm generate:types:check` passes
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) - semantic-release will use them to compute the version bump
- [ ] New/changed behavior is covered by a test
- [ ] Public API changes are reflected in the [README](./README.md) where appropriate
- [ ] PR description explains the *why*, not just the *what*

---

Thank you for contributing to the TypeScript ADK!
