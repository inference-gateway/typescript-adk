# Repository Guidelines

## Project Structure & Module Organization

This package is a TypeScript ESM Agent Development Kit published as `@inference-gateway/adk`. Source lives in `src/`: public exports start at `src/index.ts`, agent card logic is in `src/agent/`, and shared types are in `src/types/`. Generated A2A protocol types are committed under `src/types/generated/`; do not edit them by hand. Tests live in `tests/`, with fixtures in `tests/agent/fixtures/`. Build and generation scripts live in `scripts/`.

## Build, Test, and Development Commands

Use pnpm with Node.js 24 or newer.

- `pnpm install`: install dependencies from the lockfile.
- `pnpm build`: bundle the library with `tsup` into `dist/`.
- `pnpm test`: run the Vitest suite once.
- `pnpm test:watch`: run Vitest in watch mode during development.
- `pnpm test:coverage`: generate V8 coverage reports in `coverage/`.
- `pnpm lint`: run ESLint and Prettier checks.
- `pnpm typecheck`: run `tsc --noEmit`.
- `pnpm generate:types`: regenerate A2A types from the pinned schema.
- `pnpm generate:types:check`: verify generated types have not drifted.

Before release work, mirror `prepublishOnly`: clean, lint, typecheck, test, then build.

## Coding Style & Naming Conventions

Write modern TypeScript ESM. Include `.js` extensions in relative runtime imports. Prefer explicit exported types and narrow runtime validation for public inputs. Prettier is enforced through ESLint; run `pnpm format` or `pnpm lint:fix` for mechanical fixes. Unused variables are errors unless prefixed with `_`. Use PascalCase for classes and types, camelCase for functions and variables, and uppercase constants for shared immutable values.

## Testing Guidelines

Vitest runs in the Node environment and matches `tests/**/*.test.ts` and `src/**/*.test.ts`. Place behavior tests near the relevant domain folder, for example `tests/agent/card.test.ts`. Use descriptive `describe` blocks and `it('...')` cases. Keep fixtures under `tests/**/fixtures/`. Run `pnpm test` normally and `pnpm test:coverage` when changing shared behavior.

## Commit & Pull Request Guidelines

Git history follows Conventional Commits, often with scopes: `feat(a2a): ...`, `fix: ...`, `ci: ...`, `chore(release): ...`, `docs: ...`. Keep commits focused and imperative. Pull requests should summarize the change, mention linked issues, and list verification commands such as `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test`. For generated type updates, state the schema bump and include `pnpm generate:types:check` results.

## Security & Configuration Tips

Do not commit secrets or local environment files. Agent card placeholders like `${VAR}` are resolved from environment values at load time, so tests should pass explicit `env` objects instead of relying on machine state.
