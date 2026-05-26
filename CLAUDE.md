# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Agent Development Kit (ADK) for the [Inference Gateway](https://github.com/inference-gateway/inference-gateway), shipped as the npm package `@inference-gateway/adk`. ESM-only, targeted at Node 24 LTS+, currently in early bootstrap (public API not stable). Sibling to the Go ADK in the broader `inference-gateway` org — patterns here often mirror the Go implementation (see `BuildAgentName`/`BuildAgentDescription`/`BuildAgentVersion` in the Go `server/metadata.go`).

## Commands

Package manager is **pnpm 10.18.0** (pinned in `package.json#packageManager`). Use pnpm, not npm/yarn — `pnpm-lock.yaml` is the lockfile of record.

```sh
pnpm install                     # install deps (frozen-lockfile in CI)
pnpm build                       # tsup → dist/ (ESM, with .d.ts)
pnpm test                        # vitest run (one-shot)
pnpm test:watch                  # vitest watch
pnpm test:coverage               # v8 coverage
pnpm lint                        # eslint .
pnpm lint:fix                    # eslint --fix
pnpm typecheck                   # tsc --noEmit
pnpm format                      # prettier --write **/*
pnpm format:check                # prettier --check **/*
pnpm generate:types              # regenerate src/types/generated/a2a.ts
pnpm generate:types:check        # fail if generated types drift from pinned schema
```

Run a single test file: `pnpm vitest run tests/agent/card.test.ts`
Run a single test by name: `pnpm vitest run -t "applies overrides over JSON values"`

CI (`.github/workflows/ci.yml`) runs `pnpm lint && pnpm typecheck && pnpm build && pnpm test` on a Node `[22, 24]` matrix. Required status checks for `main` are `ci (22)` and `ci (24)`.

Releases are driven by semantic-release on `workflow_dispatch` (`.github/workflows/release.yml` + `.releaserc.yaml`). Commit messages must follow conventional commits; the release rules in `.releaserc.yaml` map `feat` → minor and most others (`fix`/`refactor`/`perf`/`docs`/`chore`/...) → patch.

## Architecture

The public surface is the barrel re-export in `src/index.ts`:

```
src/
├── index.ts                  # packageMetadata + re-exports from types/, agent/
├── types/
│   ├── index.ts              # re-exports generated/a2a.ts
│   └── generated/a2a.ts      # GENERATED — do not edit
└── agent/
    ├── index.ts              # barrel for card + build-metadata
    ├── card.ts               # AgentCard loading + runtime validation
    └── build-metadata.ts     # build-time name/description/version injection
```

### A2A types are generated from an external pinned schema

`src/types/generated/a2a.ts` is produced by `scripts/generate-a2a-types.ts` from the canonical JSON Schema in [inference-gateway/schemas](https://github.com/inference-gateway/schemas), pinned by commit SHA in `SCHEMA_REF` (`scripts/generate-a2a-types.ts:17`). **Never hand-edit `src/types/generated/`** — `pnpm test` runs a drift check (`tests/a2a-types.test.ts`) that fails the build if the committed file disagrees with what regenerating from `SCHEMA_REF` would produce. To consume a newer upstream schema: bump `SCHEMA_REF`, run `pnpm generate:types`, commit the result.

The generator does two non-obvious normalizations before handing the schema to `json-schema-to-typescript` (`scripts/generate-a2a-types.ts:81`): (1) hoist inline named enums to top-level definitions so they don't get inlined as `TaskState`, `TaskState1`, ...; (2) strip sibling keys from `$ref` usages so structurally identical refs don't get emitted as `Struct1`, `Struct2`. If you change the generator, preserve these — losing them produces a duplicated, numbered type wall.

`eslint.config.mjs` ignores `src/types/generated/**`; ESLint rules don't apply there.

### AgentCard load pipeline

`loadAgentCardFromFile` / `loadAgentCardFromJSON` (`src/agent/card.ts`) implement a four-step pipeline, in this order:

1. Parse JSON.
2. Resolve `${VAR}` placeholders against `options.env` (defaults to `process.env`). A missing env var **throws `AgentCardLoadError`** rather than substituting empty string — this is intentional, and tests assert it (`tests/agent/card.test.ts:163`).
3. Shallow-merge `options.overrides` over the resolved object (overrides win).
4. Runtime-validate via `validateAgentCard`, which checks only the required-field subset (`name`, `description`, `version`, `protocolVersion`, `defaultInputModes`, `defaultOutputModes`, `capabilities`, `skills`). Optional fields are left loose by design so callers can compose partial cards.

`loadAgentCardFromFile` is **synchronous by design** (uses `readFileSync`) — it's meant for boot-time configuration. Don't call it on the request path.

Two error classes, both exported: `AgentCardValidationError` (carries an optional `field` hint) and `AgentCardLoadError` (carries the triggering error via `Error.cause`). Validation errors and load errors are distinct — tests distinguish them, so don't collapse them into one.

### Build metadata (mirrors the Go ADK)

`src/agent/build-metadata.ts` is the TS equivalent of `BuildAgentName`/`BuildAgentDescription`/`BuildAgentVersion` in the Go ADK's `server/metadata.go`. Values are read from `process.env` **once at first import** and frozen into `buildMetadata`. An empty string means "not injected" — `applyBuildMetadata(card)` treats empty values as no-ops, so it's safe to call unconditionally.

Injection options for downstream consumers:
- **Bundle-time**: tsup `define`, e.g. `define: { 'process.env.BUILD_AGENT_NAME': JSON.stringify('my-agent') }`
- **Runtime**: set `BUILD_AGENT_NAME` (etc.) in the environment before the module is first imported

## TypeScript conventions

`tsconfig.json` is intentionally strict. Several flags change how you have to write code:

- **`verbatimModuleSyntax`** + **`module: "nodenext"`** → all relative imports must include the `.js` extension even when importing a `.ts` source file (e.g., `from './card.js'`, not `from './card'`). This is non-negotiable; the build will fail without it.
- **`noUncheckedIndexedAccess`** → indexing an array or `Record` returns `T | undefined`. Tests use `skills[0]?.id` for this reason; do the same.
- **`noPropertyAccessFromIndexSignature`** → use `obj['key']` for index-signature properties, not `obj.key`. This is why `process.env['BUILD_AGENT_NAME']` is bracket-notation throughout.
- **`exactOptionalPropertyTypes`** → `{ x?: string }` doesn't accept `{ x: undefined }`. Pass the key conditionally or use a different shape.
- **`isolatedModules`** → no `const enum`, no re-exporting types without `export type`.

The build (`tsup.config.ts`) emits ESM only, targets ES2024, and uses `tsconfig.build.json` which excludes tests.

## Tests

Vitest with `globals: false` — import `describe`, `it`, `expect` explicitly from `vitest`. Tests live in `tests/**/*.test.ts` (mirror of `src/`) plus the drift check at `tests/a2a-types.test.ts`. Fixtures sit in `tests/agent/fixtures/`.

The drift test has a 30s timeout because it fetches the pinned schema over HTTPS — if you're offline it will fail; that's the test working as designed, not a flaky test.

`build-metadata.test.ts:77` reads the live `buildMetadata` (which reflects whatever was in `process.env` at module load), so the assertion is conditional. Don't "simplify" it to a hard equality — the conditional is correct.
