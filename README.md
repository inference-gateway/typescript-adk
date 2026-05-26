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

## License

Apache-2.0
