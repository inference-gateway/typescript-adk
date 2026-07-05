# AI-Powered Streaming A2A Example

End-to-end example of an LLM-backed A2A agent that streams its response over Server-Sent Events using `@inference-gateway/adk`: a server that wires `OpenAICompatibleLLMClient` into `DefaultStreamingTaskHandler`, exposes two tools (weather + time), and answers natural-language `message/stream` requests with live deltas; plus a client that consumes the SSE stream and prints each event as it arrives.

Mirrors the Go ADK's [`examples/ai-powered-streaming/`](https://github.com/inference-gateway/adk/tree/main/examples/ai-powered-streaming).

## What this example shows

- Boot an `A2AServer` with `capabilities.streaming = true` in its `AgentCard`.
- Register the `message/stream` JSON-RPC method via `createMessageStreamHandler`, with the executor supplied by `DefaultStreamingTaskHandler.asHandler()`.
- Drive the chat-completion loop with `DefaultStreamingTaskHandler`, which iterates LLM calls, dispatches tool calls, and yields one `StreamingTaskEvent` per lifecycle step. The streaming pipeline translates each event into a CloudEvents v1.0 frame and flushes it to the client immediately.
- Provide two tools via `DefaultToolBox` + `createTool(...)` (`get_weather`, `get_current_time`). The reserved `input_required` tool is registered automatically.
- Plug a tiny adapter between `OpenAICompatibleLLMClient.chatCompletion` (wire-shaped, snake_case) and `DefaultStreamingTaskHandler`'s structural `LLMClient.createCompletion` (camelCase). The TS ADK does not yet ship this bridge built-in - the Go ADK plumbs it internally via `OpenAICompatibleAgent.RunWithStream`. The adapter is identical to the one in [`examples/ai-powered/`](../ai-powered/).
- Drive it all from a plain `fetch`-based client that decodes the SSE frames and CloudEvents envelopes inline. `A2AClient` does not yet expose a `streamMessage` helper (deferred to a later release).

## Layout

```text
examples/ai-powered-streaming/
├── .env.example     # provider API keys + agent/model config
├── README.md
├── client.ts        # POST message/stream + read SSE + print events live
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + DefaultStreamingTaskHandler + tools
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

Copy the example env file and fill in at least the provider API key and the
provider/model you want to use:

```sh
cp examples/ai-powered-streaming/.env.example examples/ai-powered-streaming/.env
# edit examples/ai-powered-streaming/.env: set OPENAI_API_KEY (or your provider's key)
#                                          set A2A_AGENT_CLIENT_PROVIDER (e.g. openai)
#                                          set A2A_AGENT_CLIENT_MODEL    (e.g. gpt-4o-mini)
```

The example does not auto-load `.env`. Source it before starting the server (any of the usual approaches works):

```sh
set -a; . examples/ai-powered-streaming/.env; set +a
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-ai-powered-streaming start:server
```

In another terminal (in the same shell session that sourced `.env`, or with `SERVER_URL` set directly), run the client:

```sh
pnpm --filter @inference-gateway/adk-example-ai-powered-streaming start:client
```

`pnpm --filter @inference-gateway/adk-example-ai-powered-streaming start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                            | Required | Default                                                                                             | Description                                                                                                                            |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `A2A_AGENT_CLIENT_PROVIDER`        | yes      | -                                                                                                   | LLM provider id understood by the Inference Gateway / OpenAI-compatible endpoint (e.g. `openai`, `anthropic`, `groq`, `ollama`).       |
| `A2A_AGENT_CLIENT_MODEL`           | yes      | -                                                                                                   | Model identifier (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-latest`).                                                                     |
| `A2A_AGENT_CLIENT_BASE_URL`        | no       | SDK default (`http://localhost:8080/v1`)                                                            | Base URL of the OpenAI-compatible endpoint. Set to your Inference Gateway, Ollama (`http://localhost:11434/v1`), or any other gateway. |
| `A2A_AGENT_CLIENT_API_KEY`         | no       | `${PROVIDER}_API_KEY` lookup (e.g. `OPENAI_API_KEY`)                                                | Explicit API key. Overrides the per-provider lookup.                                                                                   |
| `OPENAI_API_KEY` (and peers)       | no       | -                                                                                                   | Per-provider keys. Used when `A2A_AGENT_CLIENT_API_KEY` is unset and the corresponding provider is selected.                           |
| `A2A_AGENT_NAME`                   | no       | `ai-streaming-agent`                                                                                | Agent card `name`.                                                                                                                     |
| `A2A_AGENT_DESCRIPTION`            | no       | `An LLM-backed A2A agent that streams responses with weather and time tools.`                       | Agent card `description`.                                                                                                              |
| `A2A_AGENT_VERSION`                | no       | `0.0.0`                                                                                             | Agent card `version`.                                                                                                                  |
| `A2A_AGENT_SYSTEM_PROMPT`          | no       | `You are a helpful AI assistant with access to weather and time tools. Stream your thinking and...` | System prompt prepended to every LLM call.                                                                                             |
| `A2A_SERVER_HOST`                  | no       | `127.0.0.1`                                                                                         | Listen host.                                                                                                                           |
| `A2A_SERVER_PORT`                  | no       | `8080`                                                                                              | Listen port.                                                                                                                           |
| `MAX_CHAT_COMPLETION_ITERATIONS`   | no       | `50`                                                                                                | Upper bound on chat-completion iterations per task. Read once at handler construction.                                                 |
| `STREAMING_STATUS_UPDATE_INTERVAL` | no       | `1s`                                                                                                | Interval between periodic `task.status.changed` keep-alive frames while the task is in progress. Set `0` to disable.                   |

Client (`client.ts`):

| Env var      | Default                                                                        | Description                      |
| ------------ | ------------------------------------------------------------------------------ | -------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                                        | Base URL of the A2A server.      |
| `PROMPT`     | `What's the weather in New York? Suggest a few activities that would suit it.` | Single prompt sent to the agent. |

## Switching models

The server is provider-agnostic. To switch models, change `A2A_AGENT_CLIENT_PROVIDER` and `A2A_AGENT_CLIENT_MODEL` and supply the matching API key:

- **OpenAI** → `A2A_AGENT_CLIENT_PROVIDER=openai`, `A2A_AGENT_CLIENT_MODEL=gpt-4o-mini`, `OPENAI_API_KEY=...`. Leave `A2A_AGENT_CLIENT_BASE_URL` unset to hit OpenAI directly via the SDK default, or set it to your Inference Gateway URL.
- **Anthropic** → `A2A_AGENT_CLIENT_PROVIDER=anthropic`, `A2A_AGENT_CLIENT_MODEL=claude-3-5-sonnet-latest`, `ANTHROPIC_API_KEY=...`. Anthropic is reachable through the Inference Gateway (`A2A_AGENT_CLIENT_BASE_URL=http://localhost:8080/v1`).
- **NVIDIA** → `A2A_AGENT_CLIENT_PROVIDER=nvidia`, `A2A_AGENT_CLIENT_MODEL=nvidia/meta/llama-3.1-8b-instruct`, `NVIDIA_API_KEY=...`. NVIDIA NIM models (from the [build.nvidia.com](https://build.nvidia.com) API catalog) are reached through the Inference Gateway (`A2A_AGENT_CLIENT_BASE_URL=http://localhost:8080/v1`); the leading `nvidia/` model prefix is stripped automatically.
- **Groq / DeepSeek / Cohere / Mistral / Google / Cloudflare** → same pattern: set the matching provider id, model, and `<PROVIDER>_API_KEY` (or `A2A_AGENT_CLIENT_API_KEY`).
- **Local Ollama** → `A2A_AGENT_CLIENT_PROVIDER=ollama`, `A2A_AGENT_CLIENT_MODEL=llama3.2`, `A2A_AGENT_CLIENT_BASE_URL=http://localhost:11434/v1`, no API key.

The Inference Gateway is the recommended way to mediate access: it normalizes provider quirks (auth, tool-call shapes, streaming framing) so the same agent code talks to every provider unchanged. See the [main gateway](https://github.com/inference-gateway/inference-gateway) for setup.

## Expected event order

`message/stream` opens an SSE response whose body is a sequence of CloudEvents v1.0 envelopes. For a single user prompt that triggers one tool call before the final answer, the wire stream looks like this (UUIDs and timestamps will differ):

1. `adk.agent.task.status.changed` - `state=TASK_STATE_WORKING`, `final=false`. Marks the transition from `PENDING` and is the first frame the client sees.
2. Zero or more periodic `adk.agent.task.status.changed` keep-alive frames at `STREAMING_STATUS_UPDATE_INTERVAL` (default `1s`), `final=false`. Suppressed in the example client output after the first one.
3. `adk.agent.delta` - first assistant token batch, if the model emits text before the tool call. May be absent if the model jumps straight to a tool call.
4. `adk.agent.tool.started` - the model requested `get_weather`. Payload includes the JSON-stringified `arguments`.
5. `adk.agent.tool.completed` - the tool finished. (`adk.agent.tool.failed` is emitted instead when the tool throws.)
6. `adk.agent.tool.result` - payload includes the raw string the tool returned (the JSON body fed back into the LLM conversation). `isError` distinguishes the two outcomes.
7. `adk.agent.iteration.completed` - closes iteration 1.
8. `adk.agent.delta` - the model's final natural-language answer, emitted as one or more delta frames depending on the provider's streaming granularity.
9. `adk.agent.iteration.completed` - closes the final iteration.
10. `adk.agent.task.status.changed` - `state=TASK_STATE_COMPLETED`, `final=true`. Last frame; the stream closes immediately after.

Other terminal states are possible:

- `state=TASK_STATE_INPUT_REQUIRED` if the LLM invokes the reserved `input_required` tool. An `adk.agent.input.required` frame carrying the prompt precedes the terminal status frame. The task remains in storage so a subsequent `message/stream` or `message/send` on the same `contextId` can resume it.
- `state=TASK_STATE_CANCELLED` if the client disconnects, the server shuts down, or `tasks/cancel` fires during the run.
- `state=TASK_STATE_FAILED` if the iteration cap is hit or the executor throws. The terminal frame embeds the error text in `status.message`.

## Example client output

```text
POST http://127.0.0.1:8080/  message/stream  "What's the weather in New York? Suggest a few activities that would suit it."
[task <task-id>] status=IN_PROGRESS final=false
---

[tool get_weather started] args={"location":"New York"}
[tool get_weather completed]
[tool get_weather -> ok] {"location":"New York","temperature":"22°C","condition":"sunny","humidity":"65%"}
It's currently 22°C and sunny in New York with 65% humidity - ideal for a walk in Central Park, an outdoor picnic, or visiting the rooftop bars in Brooklyn.
---
[task <task-id>] status=TASK_STATE_COMPLETED final=true
stream complete: 6 delta event(s), 2 iteration(s), 1 tool call(s)
assembled text: "It's currently 22°C and sunny in New York with 65% humidity - ideal for a walk in Central Park, an outdoor picnic, or visiting the rooftop bars in Brooklyn."
final status: { ... }
```

The exact wording, the number of delta frames, and which tools are called all vary by model. Smaller / faster models tend to emit one tool call and a short answer; larger models may chain `get_weather` + `get_current_time`.

## How the pieces fit together

1. `OpenAICompatibleLLMClient` - wraps `@inference-gateway/sdk`'s `InferenceGatewayClient`. Talks to any OpenAI-compatible endpoint via `chatCompletion(messages, opts)`. Configured with provider/model/baseURL/apiKey.
2. `DefaultToolBox` - registry of tools the LLM can invoke. Auto-registers the reserved `input_required` tool so the model can pause for user input; the handler intercepts that call before dispatching.
3. `DefaultStreamingTaskHandler` - drives the chat-completion loop. Per iteration: build the conversation from `task.messages`, advertise the toolbox, call the LLM, yield `delta` for the assistant text, dispatch any tool calls (yielding `toolStarted` + `toolResult` + `toolCompleted` / `toolFailed`), and finally yield `iterationCompleted`. Terminates the task in `COMPLETED` (no tool calls), `INPUT_REQUIRED` (reserved tool called), or `FAILED` (iteration cap / error).
4. **Adapter (`adaptLLMClient`)** - converts between the wire-shaped `chatCompletion` API and the structural `createCompletion` interface the handler depends on. Reusable as-is in your own code until the TS ADK ships the bridge built-in.
5. `createMessageStreamHandler` - the streaming pipeline. Validates params, creates/resumes the task in storage, transitions it to `IN_PROGRESS`, runs the executor returned by `handler.asHandler()`, translates each `StreamingTaskEvent` into a CloudEvents v1.0 frame, and emits the terminal status frame when the executor finishes or is cancelled.

## Troubleshooting

- **`missing required environment variable: A2A_AGENT_CLIENT_PROVIDER`** - set `A2A_AGENT_CLIENT_PROVIDER` and `A2A_AGENT_CLIENT_MODEL` in your environment (or source `.env`). The server refuses to boot without them.
- **`HTTP 406` from the client / `unexpected content-type`** - your prompt landed at a server without streaming support. Make sure the server logs show `rpc: ... method=message/stream` and that `capabilities.streaming` is true on the agent card.
- **`LLMRequestError: llm request failed after 2 retries`** - the configured `baseURL`/`apiKey` is wrong, or the provider rejected the request. Check the gateway logs, the key spelling, and that the provider you selected actually serves the model id you asked for.
- **Stream stalls / no deltas appear** - the model is taking a long time before emitting the first token. The periodic `IN_PROGRESS` keep-alive frames (every `STREAMING_STATUS_UPDATE_INTERVAL`) prove the connection is alive; raise the interval to reduce noise or drop it to `0` to suppress them entirely.
- **Tool returns `Tool "x" is not available: no toolBox configured.`** - you instantiated `DefaultStreamingTaskHandler` without passing `toolBox`. The handler accepts tool calls but refuses to dispatch them without a toolbox.

## Next steps

- Try [`examples/streaming/`](../streaming/) for the same SSE pipeline with a hand-written mock executor (no LLM).
- Try [`examples/ai-powered/`](../ai-powered/) for the non-streaming `message/send` variant of the same agent.
- Try [`examples/input-required/`](../input-required/) for the pause / client-driven resume flow - the LLM-side version is what fires when the model calls the reserved `input_required` tool, surfaced through this example as an `adk.agent.input.required` frame.
