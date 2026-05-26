# typescript-adk

Agent Development Kit (ADK) for the [Inference Gateway](https://github.com/inference-gateway/inference-gateway), written in TypeScript.

> Status: early bootstrap — public API is not yet defined.

## Installation

```sh
pnpm add @inference-gateway/adk
```

Requires Node.js 24 LTS or newer.

## Usage

```ts
import { packageMetadata } from '@inference-gateway/adk';

console.log(packageMetadata.name, packageMetadata.version);
```

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## Continuous Integration

CI runs on every push to `main` and on every pull request via `.github/workflows/ci.yml`. The workflow installs dependencies, then runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` across a matrix of Node 22 LTS and Node 24 LTS on `ubuntu-24.04`.

Branch protection on `main` should require the following status checks before merge:

- `ci (22)`
- `ci (24)`

These names follow GitHub's matrix job naming (`<job-id> (<matrix-value>)`) and must be added under **Settings → Branches → Branch protection rules → Require status checks to pass before merging**.

## License

Apache-2.0
