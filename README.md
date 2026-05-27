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

## `message/stream` event sequence

The A2A `message/stream` JSON-RPC method returns a Server-Sent Events response (`Content-Type: text/event-stream`). Each frame is a [CloudEvents v1.0](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) envelope (JSON structured mode) serialised inside a single `data:` line. Sequence:

1. **`adk.agent.task.status.changed`** with `data.status.state = "TASK_STATE_WORKING"` and `data.final = false` — emitted exactly once at the start, immediately after the task transitions out of `PENDING`.
2. Zero or more **`adk.agent.delta`** frames — each one carries a partial assistant `Message` in `data`, in the order the executor produced them. State does not change.
3. Optional periodic **`adk.agent.task.status.changed`** frames — re-emitted every `STREAMING_STATUS_UPDATE_INTERVAL` (default `1000ms`) while the task is still `IN_PROGRESS`, with `data.final = false`. Set the env var to `0` to disable.
4. Optional **`adk.agent.task.status.changed`** with `data.status.state = "TASK_STATE_INPUT_REQUIRED"` and `data.final = false` — when the executor signals it needs more input. The stream then closes; the task remains active and can be resumed via `message/send` against the same `contextId`.
5. Terminal **`adk.agent.task.status.changed`** — `data.final = true`, with `state` one of `TASK_STATE_COMPLETED` / `TASK_STATE_FAILED` / `TASK_STATE_CANCELLED`. Stream then closes.

`data` payloads use the A2A schema shapes:

- `task.status.changed` → [`TaskStatusUpdateEvent`](https://github.com/inference-gateway/schemas) (`taskId`, `contextId`, `status`, `final`).
- `agent.delta` → [`Message`](https://github.com/inference-gateway/schemas) (a partial assistant message).

Each CloudEvents envelope's `subject` is the task id, so consumers can route or fan out by task without parsing `data`. SSE comment frames (`: heartbeat`) keep the connection alive; the interval is configurable via the handler's `heartbeatMs` option.

On client disconnect, the request's `AbortSignal` propagates to the executor's signal. The executor is expected to unwind promptly; the task is then persisted as `TASK_STATE_CANCELLED` in storage. The terminal frame is not delivered (the client is already gone), so storage is the source of truth for the final state.

Streaming methods are registered on the server via a dedicated entry point so they bypass the regular JSON-RPC dispatch path:

```ts
import {
  MESSAGE_STREAM_METHOD,
  createA2AServer,
  createMessageStreamHandler,
  InMemoryTaskStorage,
} from '@inference-gateway/adk';

const server = createA2AServer({ card });
server.registerStreamingMethod(
  MESSAGE_STREAM_METHOD,
  createMessageStreamHandler({
    storage: new InMemoryTaskStorage(),
    executor: async function* ({ task, message, signal }) {
      yield {
        type: 'delta',
        message: {
          messageId: 'd-1',
          role: 'ROLE_AGENT',
          parts: [{ text: 'hello' }],
        },
      };
      // Natural completion → task transitions to TASK_STATE_COMPLETED.
    },
  })
);
```

Advertise streaming support on the agent card via `capabilities.streaming = true`.

## A2A protocol types

The A2A protocol types in `src/types/generated/` are generated from the canonical schema in [inference-gateway/schemas](https://github.com/inference-gateway/schemas) and must not be hand-edited. The schema commit hash is pinned in `scripts/generate-a2a-types.ts` for reproducibility; bump it there to consume a newer schema.

```sh
pnpm generate:types         # regenerate from the pinned schema
pnpm generate:types:check   # fail if generated files drift from the schema
```

CI runs the drift check as part of `pnpm test` and fails the build if the committed types disagree with the pinned schema.

## Continuous Integration

CI runs on every push to `main` and on every pull request via `.github/workflows/ci.yml`. The workflow installs dependencies, then runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` across a matrix of Node 22 LTS and Node 24 LTS on `ubuntu-24.04`.

Branch protection on `main` should require the following status checks before merge:

- `ci (22)`
- `ci (24)`

These names follow GitHub's matrix job naming (`<job-id> (<matrix-value>)`) and must be added under **Settings → Branches → Branch protection rules → Require status checks to pass before merging**.

## License

Apache-2.0
