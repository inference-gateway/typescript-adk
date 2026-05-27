# AI-Powered A2A Example

End-to-end example of an LLM-backed A2A agent built with `@inference-gateway/adk`: a server that wires `AgentBuilder` + `OpenAICompatibleLLMClient` into `DefaultBackgroundTaskHandler`, exposes two tools (weather + time), and answers natural-language `message/send` requests; plus a client that fires three example prompts at it and prints the completions.

Mirrors the Go ADK's [`examples/ai-powered/`](https://github.com/inference-gateway/adk/tree/main/examples/ai-powered).

## What this example shows

- Build an `OpenAICompatibleAgent` with `AgentBuilder` (provider/model/system prompt) backed by `OpenAICompatibleLLMClient`.
- Register a `DefaultToolBox` with two `createTool(...)` definitions (`get_weather`, `get_current_time`). The reserved `input_required` tool is registered automatically.
- Drive the chat-completion loop with `DefaultBackgroundTaskHandler`, which iterates LLM calls, dispatches tool calls, accumulates token usage, and terminates the task in `COMPLETED` / `FAILED` / `INPUT_REQUIRED`.
- Plug a tiny adapter between `OpenAICompatibleLLMClient.chatCompletion` (wire-shaped, snake_case) and `DefaultBackgroundTaskHandler`'s structural `LLMClient.createCompletion` (camelCase). The TS ADK does not yet ship this bridge built-in — the Go ADK plumbs it internally via `OpenAICompatibleAgent.RunWithStream`.
- Run a small background worker (mirrors the other examples) that dequeues each `message/send`-created task and hands it to the handler.

## Layout

```text
examples/ai-powered/
├── .env.example     # provider API keys + agent/model config
├── README.md
├── client.ts        # send three prompts, poll tasks/get until terminal, print
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + LLM-driven worker + weather/time tools
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
cp examples/ai-powered/.env.example examples/ai-powered/.env
# edit examples/ai-powered/.env: set OPENAI_API_KEY (or your provider's key)
#                                set A2A_AGENT_CLIENT_PROVIDER (e.g. openai)
#                                set A2A_AGENT_CLIENT_MODEL    (e.g. gpt-4o-mini)
```

The example does not auto-load `.env`. Source it before starting the server (any of the usual approaches works):

```sh
set -a; . examples/ai-powered/.env; set +a
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-ai-powered start:server
```

In another terminal (in the same shell session that sourced `.env`, or with `SERVER_URL` set directly), run the client:

```sh
pnpm --filter @inference-gateway/adk-example-ai-powered start:client
```

`pnpm --filter @inference-gateway/adk-example-ai-powered start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                          | Required | Default                                                                                            | Description                                                                                                                            |
| -------------------------------- | -------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `A2A_AGENT_CLIENT_PROVIDER`      | yes      | —                                                                                                  | LLM provider id understood by the Inference Gateway / OpenAI-compatible endpoint (e.g. `openai`, `anthropic`, `groq`, `ollama`).       |
| `A2A_AGENT_CLIENT_MODEL`         | yes      | —                                                                                                  | Model identifier (e.g. `gpt-4o-mini`, `claude-3-5-sonnet-latest`).                                                                     |
| `A2A_AGENT_CLIENT_BASE_URL`      | no       | SDK default (`http://localhost:8080/v1`)                                                           | Base URL of the OpenAI-compatible endpoint. Set to your Inference Gateway, Ollama (`http://localhost:11434/v1`), or any other gateway. |
| `A2A_AGENT_CLIENT_API_KEY`       | no       | `${PROVIDER}_API_KEY` lookup (e.g. `OPENAI_API_KEY`)                                               | Explicit API key. Overrides the per-provider lookup.                                                                                   |
| `OPENAI_API_KEY` (and peers)     | no       | —                                                                                                  | Per-provider keys. Used when `A2A_AGENT_CLIENT_API_KEY` is unset and the corresponding provider is selected.                           |
| `A2A_AGENT_NAME`                 | no       | `ai-powered-agent`                                                                                 | Agent card `name`.                                                                                                                     |
| `A2A_AGENT_DESCRIPTION`          | no       | `An LLM-backed A2A agent with weather and time tools.`                                             | Agent card `description`.                                                                                                              |
| `A2A_AGENT_VERSION`              | no       | `0.0.0`                                                                                            | Agent card `version`.                                                                                                                  |
| `A2A_AGENT_SYSTEM_PROMPT`        | no       | `You are a helpful AI assistant with access to weather and time tools. Be concise and friendly...` | System prompt prepended to every LLM call.                                                                                             |
| `A2A_SERVER_HOST`                | no       | `127.0.0.1`                                                                                        | Listen host.                                                                                                                           |
| `A2A_SERVER_PORT`                | no       | `8080`                                                                                             | Listen port.                                                                                                                           |
| `MAX_CHAT_COMPLETION_ITERATIONS` | no       | `50`                                                                                               | Upper bound on chat-completion iterations per task. Read once at handler construction.                                                 |

Client (`client.ts`):

| Env var      | Default                                                                                                                   | Description                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                                                                                   | Base URL of the A2A server.                                     |
| `PROMPTS`    | `What's the weather in London?` ‖ `What time is it?` ‖ `Can you check the weather in Paris and tell me the current time?` | `‖`-separated list (use `\|\|`) of prompts to run sequentially. |

## Swapping providers

The server is provider-agnostic. To switch:

- **OpenAI** → `A2A_AGENT_CLIENT_PROVIDER=openai`, `A2A_AGENT_CLIENT_MODEL=gpt-4o-mini`, `OPENAI_API_KEY=...`. Leave `A2A_AGENT_CLIENT_BASE_URL` unset to hit OpenAI directly via the SDK default, or set it to your Inference Gateway URL.
- **Anthropic** → `A2A_AGENT_CLIENT_PROVIDER=anthropic`, `A2A_AGENT_CLIENT_MODEL=claude-3-5-sonnet-latest`, `ANTHROPIC_API_KEY=...`. Anthropic is reachable through the Inference Gateway (`A2A_AGENT_CLIENT_BASE_URL=http://localhost:8080/v1`).
- **Groq / DeepSeek / Cohere / Mistral / Google / Cloudflare** → same pattern: set the matching provider id, model, and `<PROVIDER>_API_KEY` (or `A2A_AGENT_CLIENT_API_KEY`).
- **Local Ollama** → `A2A_AGENT_CLIENT_PROVIDER=ollama`, `A2A_AGENT_CLIENT_MODEL=llama3.2`, `A2A_AGENT_CLIENT_BASE_URL=http://localhost:11434/v1`, no API key.

The Inference Gateway is the recommended way to mediate access: it normalizes provider quirks (auth, tool-call shapes, streaming framing) so the same agent code talks to every provider unchanged. See the [main gateway](https://github.com/inference-gateway/inference-gateway) for setup.

## Expected output

Server (UUIDs and timestamps will differ; exact LLM responses depend on the model):

```text
ai-powered-agent listening on http://127.0.0.1:8080
  provider: openai, model: gpt-4o-mini
  card:     http://127.0.0.1:8080/.well-known/agent-card.json
  health:   http://127.0.0.1:8080/health
  rpc:      POST http://127.0.0.1:8080/
task <task-id> dequeued, dispatching to LLM...
task <task-id> -> TASK_STATE_COMPLETED
```

Client:

```text
--- Request 1 ---
> What's the weather in London?
task <task-id> created (state=TASK_STATE_SUBMITTED)
...
task <task-id> completed.
response: The current weather in London is sunny with a temperature of 22°C and 65% humidity.

--- Request 2 ---
> What time is it?
task <task-id> created (state=TASK_STATE_SUBMITTED)
...
task <task-id> completed.
response: It is currently 2026-05-27T17:42:11.123Z (UTC).
```

The exact wording will vary by model. The first request exercises the `get_weather` tool, the second exercises `get_current_time`, and the third exercises both in a single conversation — proving the iteration loop dispatches multiple tool calls and feeds their results back to the model before producing the final answer.

## How the pieces fit together

1. `OpenAICompatibleLLMClient` — wraps `@inference-gateway/sdk`'s `InferenceGatewayClient`. Talks to any OpenAI-compatible endpoint via `chatCompletion(messages, opts)`. Configured with provider/model/baseURL/apiKey.
2. `AgentBuilder` — fluent builder that bundles the LLM client + system prompt + sampling parameters into an `OpenAICompatibleAgentImpl`. The TS variant is currently a configuration container; the iteration loop lives in the handler (mirrors the Go ADK at present).
3. `DefaultToolBox` — registry of tools the LLM can invoke. Auto-registers the reserved `input_required` tool so the model can pause for user input; the handler intercepts that call before dispatching.
4. `DefaultBackgroundTaskHandler` — drives the chat-completion loop. Per iteration: build the conversation from `task.messages`, advertise the toolbox, call the LLM, dispatch any tool calls, feed results back. Terminates the task in `COMPLETED` (no tool calls), `INPUT_REQUIRED` (reserved tool called), or `FAILED` (iteration cap / error).
5. **Adapter (`adaptLLMClient`)** — converts between the wire-shaped `chatCompletion` API and the structural `createCompletion` interface the handler depends on. Reusable as-is in your own code until the TS ADK ships the bridge built-in.
6. **Worker loop** — `await storage.dequeue(signal)` blocks until a `message/send` enqueues a new task, then hands it to `handler.handle({ task, message, signal })`. Terminal tasks are dead-lettered so `tasks/get` can still serve them.

## Troubleshooting

- **`missing required environment variable: A2A_AGENT_CLIENT_PROVIDER`** — set `A2A_AGENT_CLIENT_PROVIDER` and `A2A_AGENT_CLIENT_MODEL` in your environment (or source `.env`). The server refuses to boot without them.
- **`LLMRequestError: llm request failed after 2 retries`** — the configured `baseURL`/`apiKey` is wrong, or the provider rejected the request. Check the gateway logs, the key spelling, and that the provider you selected actually serves the model id you asked for.
- **Tasks stay in `TASK_STATE_WORKING` forever** — the worker died (check server stderr for `worker crashed:` log) or the LLM looped past the iteration cap. Lower `MAX_CHAT_COMPLETION_ITERATIONS` to see the failure surfaced as `TASK_STATE_FAILED` faster.
- **Tool returns `Tool "x" is not available: no toolBox configured.`** — you instantiated `DefaultBackgroundTaskHandler` without passing `toolBox`. The handler accepts tool calls but refuses to dispatch them without a toolbox.

## Next steps

- Try [`examples/minimal/`](../minimal/) for the smallest end-to-end A2A loop with no LLM.
- Try [`examples/streaming/`](../streaming/) for the SSE-based `message/stream` flow.
- Try [`examples/input-required/`](../input-required/) for the pause / client-driven resume flow — the LLM-side version is what fires when the model calls the reserved `input_required` tool.
