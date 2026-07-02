# Usage Metadata A2A Example (no LLM)

End-to-end example of per-task **usage metadata** in `@inference-gateway/adk`: both `DefaultBackgroundTaskHandler` and `DefaultStreamingTaskHandler` track per-task token counters and execution statistics, then attach them to `task.metadata` on completion when `setEnableUsageMetadata(true)` is enabled.

Mirrors the Go ADK's [`examples/usage-metadata/`](https://github.com/inference-gateway/adk/tree/main/examples/usage-metadata) and `server/usage_tracker.go`. The fake LLM client embedded in `server.ts` keeps the example self-contained - no provider key needed.

## What this example shows

The `UsageTracker` accumulates per-task counters across the agent loop:

| Counter (wire form)            | Meaning                                          |
| ------------------------------ | ------------------------------------------------ |
| `usage.prompt_tokens`          | Total prompt tokens across every LLM call.       |
| `usage.completion_tokens`      | Total completion tokens.                         |
| `usage.total_tokens`           | Sum (or upstream-reported total, when provided). |
| `execution_stats.iterations`   | Number of LLM iterations the loop performed.     |
| `execution_stats.tool_calls`   | Number of tool calls dispatched.                 |
| `execution_stats.failed_tools` | Number of tool calls that errored.               |

When the task reaches a terminal state (`COMPLETED` / `FAILED` / `CANCELLED` / `INPUT_REQUIRED`), the counters are serialized into `task.metadata` like this:

```json
{
  "usage": {
    "prompt_tokens": 56,
    "completion_tokens": 28,
    "total_tokens": 84
  },
  "execution_stats": {
    "iterations": 2,
    "tool_calls": 1,
    "failed_tools": 0
  }
}
```

The server in this example wires both handlers with usage metadata enabled and exposes:

- `message/send` — background path. Worker dequeues, runs `DefaultBackgroundTaskHandler`, attaches metadata, stores in dead-letter. The client reads it back via `tasks/get`.
- `message/stream` — streaming path. `DefaultStreamingTaskHandler` emits a terminal `statusChanged` event with metadata attached; the streaming pipeline shallow-merges it into `task.metadata` before persisting. The client reads it from the final SSE frame _and_ via `tasks/get`.

## Layout

```text
examples/usage-metadata/
├── README.md
├── client.ts        # sends two background prompts and one streaming prompt; prints metadata
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + fake LLM + both default handlers with usage metadata on
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-usage-metadata start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-usage-metadata start:client
```

`pnpm --filter @inference-gateway/adk-example-usage-metadata start` is an alias for `start:server`.

### Configuration

| Environment variable    | Default                        | Description                               |
| ----------------------- | ------------------------------ | ----------------------------------------- |
| `A2A_AGENT_NAME`        | `usage-metadata-agent`         | Agent name advertised on the card.        |
| `A2A_AGENT_DESCRIPTION` | (canned demo string)           | Agent description advertised on the card. |
| `A2A_AGENT_VERSION`     | `0.0.0`                        | Agent version advertised on the card.     |
| `A2A_SERVER_HOST`       | `127.0.0.1`                    | Bind host.                                |
| `A2A_SERVER_PORT`       | `8080`                         | Bind port.                                |
| `SERVER_URL`            | `http://127.0.0.1:8080`        | Client target URL.                        |
| `SEND_PROMPTS`          | (canned 2-prompt list)         | `                                         |     | `-separated prompts for the `message/send` portion. |
| `STREAM_PROMPT`         | `What's the weather in Tokyo?` | Prompt for the `message/stream` portion.  |

## Expected output

Background portion (one entry per prompt):

```text
--- send 1 ---
> What's the weather in Paris?
final state: TASK_STATE_COMPLETED
response: The weather in Paris is sunny and 22C.
task.metadata:
{
  "execution_stats": { "iterations": 2, "tool_calls": 1, "failed_tools": 0 },
  "usage":           { "prompt_tokens": 56, "completion_tokens": 28, "total_tokens": 84 }
}
```

Streaming portion:

```text
[status] state=TASK_STATE_WORKING final=false
[status] state=TASK_STATE_COMPLETED final=true  metadata=yes

final stream status: TASK_STATE_COMPLETED
task.metadata (from terminal status event):
{
  "execution_stats": { "iterations": 2, "tool_calls": 1, "failed_tools": 0 },
  "usage":           { "prompt_tokens": 56, "completion_tokens": 28, "total_tokens": 84 }
}

task.metadata (from tasks/get):
{
  "execution_stats": { "iterations": 2, "tool_calls": 1, "failed_tools": 0 },
  "usage":           { "prompt_tokens": 56, "completion_tokens": 28, "total_tokens": 84 }
}
```

## Opting in from your own code

```ts
import { DefaultBackgroundTaskHandler } from '@inference-gateway/adk';

const handler = new DefaultBackgroundTaskHandler({ llmClient, toolBox });
handler.setEnableUsageMetadata(true); // off by default
```

The streaming handler is the same:

```ts
import { DefaultStreamingTaskHandler } from '@inference-gateway/adk';

const streaming = new DefaultStreamingTaskHandler({ llmClient, toolBox });
streaming.setEnableUsageMetadata(true);
```

Both handlers expose `isUsageMetadataEnabled()` for diagnostics. The opt-in is intentionally off-by-default so existing tasks do not gain new metadata keys until you ask for them.
