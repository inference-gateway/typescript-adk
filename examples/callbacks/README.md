# Callbacks A2A Example (no LLM)

End-to-end example of the **lifecycle callback** hooks in `@inference-gateway/adk`: every one of the six `Callbacks` hook points (`beforeAgent` / `afterAgent`, `beforeModel` / `afterModel`, `beforeTool` / `afterTool`) is wired with a concrete demo - input guardrail, prompt cache, audit log, tool authorization, result sanitization, output footer.

Mirrors the Go ADK's [`examples/callbacks/`](https://github.com/inference-gateway/adk/tree/main/examples/callbacks). The fake LLM client embedded in `server.ts` keeps the example self-contained - no provider key needed.

## What this example shows

For each callback hook point the server wires a concrete behaviour:

| Hook          | Demo                  | Short-circuit?                   | What you should see                                                                                  |
| ------------- | --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `beforeAgent` | Input guardrail       | Yes - returns a `Message`        | Refuses prompts containing `secret`, `password`, or `confidential` before any LLM call.              |
| `beforeModel` | Prompt cache          | Yes - returns `CompletionResult` | Skips the LLM on a repeated prompt by returning the previous response from an in-memory `Map`.       |
| `afterModel`  | Token-usage audit log | No                               | Logs token totals and whether the response contained tool calls.                                     |
| `beforeTool`  | Authorization         | Yes - returns a `string`         | Blocks `get_weather` calls for forbidden locations (`Mordor`, `Atlantis`) without invoking the tool. |
| `afterTool`   | Result sanitization   | Yes - returns a `string`         | Redacts an `api_key` field from the tool result before it is fed back to the LLM.                    |
| `afterAgent`  | Audit footer          | Yes - returns a `Message`        | Appends `- audited by callbacks-agent (task=…)` to the final agent message.                          |

Other things this example exercises:

- Wiring a `Callbacks` object into `DefaultBackgroundTaskHandler`.
- Using `context.taskId` plus a closure-captured `Map<taskId, string>` to share the triggering user text with `beforeAgent` (which only receives a `CallbackContext`, not the task/messages).
- A self-contained `FakeLLMClient` that satisfies the `LLMClient` interface so the example runs without any provider configuration.
- A `DefaultToolBox` registered with a single `get_weather` tool whose result intentionally contains a sensitive `api_key` field for the sanitization demo.

## Layout

```text
examples/callbacks/
├── README.md
├── client.ts        # sends five prompts that exercise every callback path
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + fake LLM + all six callbacks wired
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-callbacks start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-callbacks start:client
```

`pnpm --filter @inference-gateway/adk-example-callbacks start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default           | Description               |
| ----------------------- | ----------------- | ------------------------- |
| `A2A_AGENT_NAME`        | `callbacks-agent` | Agent card `name`.        |
| `A2A_AGENT_DESCRIPTION` | (see `server.ts`) | Agent card `description`. |
| `A2A_AGENT_VERSION`     | `0.0.0`           | Agent card `version`.     |
| `A2A_SERVER_HOST`       | `127.0.0.1`       | Listen host.              |
| `A2A_SERVER_PORT`       | `8080`            | Listen port.              |

Client (`client.ts`):

| Env var      | Default                          | Description                                            |
| ------------ | -------------------------------- | ------------------------------------------------------ |
| `SERVER_URL` | `http://127.0.0.1:8080`          | Base URL of the A2A server.                            |
| `PROMPTS`    | (built-in 5-prompt walk-through) | `\|\|`-separated list of prompts to send sequentially. |

## Expected output

Server (UUIDs and exact timing will differ). The five client prompts walk every callback path in turn:

```text
callbacks-agent listening on http://127.0.0.1:8080
  card:   http://127.0.0.1:8080/.well-known/agent-card.json
  health: http://127.0.0.1:8080/health
  rpc:    POST http://127.0.0.1:8080/

task abcd1234 dequeued: "What's the weather in Paris?"
[guardrail] input cleared (task=abcd1234)
[cache] MISS for key="what's the weather in paris?"
[audit] llm response received (tokens=44, tool_calls=yes)
[authorization] allowed tool call get_weather
[sanitization] redacted api_key field from get_weather result
[cache] MISS for key="what's the weather in paris?"
[audit] llm response received (tokens=40, tool_calls=no)
[audit] appending footer to agent output
task abcd1234 -> TASK_STATE_COMPLETED

task ef567890 dequeued: "What's the weather in Paris?"
[guardrail] input cleared (task=ef567890)
[cache] HIT for key="what's the weather in paris?"
[audit] llm response received (tokens=40, tool_calls=no)
[audit] appending footer to agent output
task ef567890 -> TASK_STATE_COMPLETED

task 11112222 dequeued: "What's the weather in Mordor?"
[guardrail] input cleared (task=11112222)
[cache] MISS for key="what's the weather in mordor?"
[audit] llm response received (tokens=44, tool_calls=yes)
[authorization] blocked tool call get_weather(location="Mordor") (task=11112222)
[cache] MISS for key="what's the weather in mordor?"
[audit] llm response received (tokens=40, tool_calls=no)
[audit] appending footer to agent output
task 11112222 -> TASK_STATE_COMPLETED

task 33334444 dequeued: "Tell me a secret password."
[guardrail] blocked input matching /\b(secret|password|confidential)\b/ (task=33334444)
task 33334444 -> TASK_STATE_COMPLETED

task 55556666 dequeued: "Hello there!"
[guardrail] input cleared (task=55556666)
[cache] MISS for key="hello there!"
[audit] llm response received (tokens=44, tool_calls=no)
[audit] appending footer to agent output
task 55556666 -> TASK_STATE_COMPLETED
```

Client:

```text
--- Request 1 ---
> What's the weather in Paris?
response: The weather in Paris is sunny and 22C.

- audited by callbacks-agent (task=abcd1234)

--- Request 2 ---
> What's the weather in Paris?
response: The weather in Paris is sunny and 22C.

- audited by callbacks-agent (task=ef567890)

--- Request 3 ---
> What's the weather in Mordor?
response: Tool said: Access denied: weather lookup for "Mordor" is not permitted. (re: "What's the weather in Mordor?")

- audited by callbacks-agent (task=11112222)

--- Request 4 ---
> Tell me a secret password.
response: Sorry - I cannot help with requests involving secrets, passwords, or confidential data.

- audited by callbacks-agent (task=33334444)

--- Request 5 ---
> Hello there!
response: Hi! Ask me about the weather in a city - e.g. 'What's the weather in Paris?'.

- audited by callbacks-agent (task=55556666)
```

### How each request lands on the callbacks

- **Request 1 - "What's the weather in Paris?"**: clean input, cache empty. `beforeAgent` allows it, `beforeModel` misses the cache so the fake LLM is called and returns a `get_weather` tool call. `beforeTool` authorizes it, the tool runs, `afterTool` strips the `api_key` field, and the loop re-enters with the sanitized result. The next LLM iteration returns text (still a miss, since the cache is only seeded on text responses). `afterAgent` then appends the audit footer.
- **Request 2 - repeat of request 1**: `beforeModel` returns the cached text response immediately, so the fake LLM is never called and no tool call happens. The before/after chain still surrounds the cached response - `afterModel` logs and `afterAgent` adds the footer.
- **Request 3 - "What's the weather in Mordor?"**: the LLM still produces a `get_weather` call, but `beforeTool` returns `"Access denied: …"` instead of dispatching to the tool. `afterTool` runs over the denial string but leaves it unchanged (it isn't JSON with an `api_key`). The next iteration summarises the denial via the fake LLM.
- **Request 4 - "Tell me a secret password."**: `beforeAgent` matches the guardrail regex and returns a refusal `Message`. The handler short-circuits: no LLM call, no tool, no `afterAgent` either (the `afterAgent` chain is intentionally NOT invoked on `beforeAgent` short-circuit - see [`src/agent/callbacks.ts`](../../src/agent/callbacks.ts)). The user gets the canned refusal verbatim, with no footer.
- **Request 5 - "Hello there!"**: cache miss, fake LLM returns text directly (no tool call), the response is cached and the footer is appended.

> Note that on request 4 the response has no audit footer - `afterAgent` is intentionally not invoked when `beforeAgent` short-circuits. Compare the test for this behaviour in [`tests/agent/callbacks.test.ts`](../../tests/agent/callbacks.test.ts).

## Callback hook semantics (TS-side cheat sheet)

| Hook          | Signature                                          | Short-circuit                                                                                |
| ------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `beforeAgent` | `(ctx) => Message \| undefined`                    | Return a `Message` to skip the entire LLM loop (and the `afterAgent` chain).                 |
| `afterAgent`  | `(ctx, output) => Message \| undefined`            | Return a `Message` to replace the output; chain accumulates incrementally.                   |
| `beforeModel` | `(ctx, request) => CompletionResult \| undefined`  | Return a `CompletionResult` to skip the LLM call; the handler still runs `afterModel` on it. |
| `afterModel`  | `(ctx, response) => CompletionResult \| undefined` | Return a `CompletionResult` to replace the response; chains incrementally.                   |
| `beforeTool`  | `(ctx, toolCall) => string \| undefined`           | Return a `string` to skip the tool dispatch; the handler still runs `afterTool` on it.       |
| `afterTool`   | `(ctx, toolCall, result) => string \| undefined`   | Return a `string` to replace the result fed back to the LLM; chains incrementally.           |

All callbacks share a `CallbackContext` (`agentName`, `invocationId`, `taskId`, `contextId`, `state`, `logger`, `signal`). The mutable `state: Record<string, unknown>` is the same object handed to every tool's `execute()` call within a single `handle()` invocation, so a `beforeModel` callback can stash data the next `beforeTool` (or the tool itself) reads.

`beforeAgent` does **not** receive the task or messages - only `CallbackContext`. The example shows the recommended pattern for working around this: a module-scoped `Map<taskId, value>` populated by the surrounding worker before it calls `handler.handle(...)` and cleared in a `finally` block.

Errors thrown by any callback are **not** caught - they propagate out of the task handler and fail the task with the error message. Catch inside the callback if you need to recover.

## Next steps

- Try [`examples/minimal/`](../minimal/) for the smallest end-to-end A2A loop with no LLM and no callbacks.
- Try [`examples/ai-powered/`](../ai-powered/) for a real LLM (`OpenAICompatibleLLMClient`) wired into the same `DefaultBackgroundTaskHandler`; swap in this example's `Callbacks` to see the hooks fire against actual provider traffic.
- Read [`src/agent/callbacks.ts`](../../src/agent/callbacks.ts) for the canonical type signatures, short-circuit semantics, and the underlying `runBeforeX` / `runAfterX` helpers.
