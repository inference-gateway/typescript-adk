# AGENTS.md

The TypeScript Agent Development Kit (`@inference-gateway/adk`) — a Node.js library for building A2A-protocol agents. ESM-only; requires Node 24+ and pnpm 10+ (pinned via `package.json#packageManager`).

## Commands

Use pnpm with Node 24+.

- `pnpm install` — install from the lockfile
- `pnpm build` — bundle with `tsup` into `dist/`
- `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` — Vitest (v8 coverage)
- `pnpm lint` / `pnpm lint:fix` — ESLint (Prettier enforced as rules)
- `pnpm format` / `pnpm format:check` — Prettier write/check
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm generate:types` / `pnpm generate:types:check` — regenerate/verify `src/types/generated/a2a.ts` against the schema pinned by `SCHEMA_REF` in `scripts/generate-a2a-types.ts`

Run one test: `pnpm vitest run tests/agent/card.test.ts`, or by name with `-t`. Before release work, mirror `prepublishOnly`: clean, lint, typecheck, test, build.

## Architecture

Public exports start at `src/index.ts` (barrel). Domain code lives in `src/agent/` (agent card, build metadata, task state machine), `src/server/`, `src/client/`, `src/llm/`, `src/auth/`, `src/storage/`, `src/artifacts/`, `src/mcp/`, `src/testing/`. Tests mirror `src/` under `tests/**/*.test.ts`; fixtures live in `tests/agent/fixtures/`. Each `examples/<name>/` is a standalone package.

## Generated A2A types

`src/types/generated/a2a.ts` is generated from the canonical JSON Schema in `inference-gateway/schemas`, pinned by commit SHA in `SCHEMA_REF` (`scripts/generate-a2a-types.ts`). **Never hand-edit `src/types/generated/`.** The drift check in `pnpm test` (`tests/a2a-types.test.ts`) fetches the pinned schema and fails if the committed file disagrees with regeneration — it has a 30s timeout and fails offline by design, not as a flake. Schema bump: change `SCHEMA_REF`, run `pnpm generate:types`, commit both.

## Code Style

- `verbatimModuleSyntax` + `module: nodenext`: relative imports need `.js` extensions (`from './card.js'`); the build fails without them.
- `noUncheckedIndexedAccess`: indexing returns `T | undefined` — use `arr[0]?.x`.
- `noPropertyAccessFromIndexSignature`: bracket notation for index signatures (`process.env['BUILD_AGENT_NAME']`).
- `exactOptionalPropertyTypes`: `{ x?: string }` rejects `{ x: undefined }`.
- `isolatedModules`: types re-exported with `export type`.
- Unused variables are errors unless `_`-prefixed. PascalCase classes/types, camelCase functions/variables.

## Testing

Vitest runs in the Node environment with `globals: false` — import `describe`/`it`/`expect` from `vitest`. Prefer table-driven tests (`it.each`) for pure logic; don't mock what runs in-process (the server can bind port 0). Coverage is informational, not gated.

## Commits & Releases

Conventional Commits; semantic-release reads them (`feat` → minor, rest → patch). CI runs lint, typecheck, build, test on a Node 22/24 matrix; required status checks are `ci (22)` and `ci (24)`.

## Security & Configuration

Never commit secrets or local env files. Agent-card `${VAR}` placeholders resolve from environment values at load time; a missing variable **throws `AgentCardLoadError`** rather than substituting an empty string. Tests should pass explicit `env` objects, not rely on machine state. `loadAgentCardFromFile` is synchronous by design (boot-time config, not the request path); `AgentCardLoadError` and `AgentCardValidationError` are distinct error classes — keep them that way.
