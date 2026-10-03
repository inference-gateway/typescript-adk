# Default Handlers A2A Example

End-to-end example of `A2AServerBuilder.withDefaultTaskHandlers()` - boots a single A2A server that exposes both `SendMessage` and `SendStreamingMessage` using the **builder-installed default task handlers**, and a client that exercises both paths back-to-back.

Mirrors the Go ADK's [`examples/default-handlers/`](https://github.com/inference-gateway/adk/tree/main/examples/default-handlers).

## What this example shows

- `A2AServerBuilder` as a one-liner: `new A2AServerBuilder({ storage }).withAgentCard(card).withDefaultTaskHandlers().build()`.
- A card with `capabilities.streaming = true`, so the builder registers `SendMessage`, `SendStreamingMessage`, `CancelTask`, and `SubscribeToTask` automatically.
- A minimal background worker that pulls tasks from `InMemoryTaskStorage` and runs the builder-installed background handler.
- A client that drives both the polled `SendMessage` path **and** the SSE `SendStreamingMessage` path in the same run.

## What "default handlers" means here

`withDefaultTaskHandlers()` installs two **deliberately minimal** stub handlers, useful as the lowest-friction scaffold while you wire the rest of an agent together:

| Path                   | Default handler behavior                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SendMessage`          | Transitions the task `TASK_STATE_SUBMITTED -> TASK_STATE_WORKING -> TASK_STATE_COMPLETED`. No agent reply is produced.                                                                      |
| `SendStreamingMessage` | The framework emits the task and a `statusUpdate (state=TASK_STATE_WORKING)`; the stub executor yields exactly one `statusUpdate (state=TASK_STATE_COMPLETED)`. No delta frames in between. |

These stubs are intentionally _free of LLM logic_. They demonstrate the protocol-level state machine without pulling in an LLM or toolbox.

For richer LLM-driven defaults, see:

- [`examples/ai-powered/`](../ai-powered/) - uses the `DefaultBackgroundTaskHandler` **class** directly (registered via `withBackgroundTaskHandler`) with an LLM client and toolbox.
- [`examples/ai-powered-streaming/`](../ai-powered-streaming/) - uses the `DefaultStreamingTaskHandler` **class** directly with streaming SSE frames including word-by-word deltas.

## `SendMessage` vs `SendStreamingMessage` - side by side

|                      | `SendMessage` (background)                                                                    | `SendStreamingMessage` (streaming)                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Response shape       | Single JSON-RPC envelope. Task starts `TASK_STATE_SUBMITTED`.                                 | `text/event-stream` (SSE) of A2A `StreamResponse` frames.                            |
| How the handler runs | A worker dequeues from `InMemoryTaskStorage` and runs the registered `BackgroundTaskHandler`. | The streaming executor runs **inline** in the request handler - no queue, no worker. |
| How the client reads | Poll `GetTask` until terminal.                                                                | Read SSE frames until the terminal status update.                                    |
| Cancellation         | `CancelTask` JSON-RPC method.                                                                 | Either `CancelTask`, or close the SSE stream (the executor's `signal` aborts).       |
| Best for             | Long-running jobs, batch processing, follow-up via `GetTask` or `SubscribeToTask`.            | Token-by-token UX, real-time progress, tool-call visibility.                         |

## Layout

```text
examples/default-handlers/
├── README.md
├── client.ts        # runs SendMessage (poll) and SendStreamingMessage (SSE) end-to-end
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2AServerBuilder.withDefaultTaskHandlers() + minimal worker
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-default-handlers start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-default-handlers start:client
```

`pnpm --filter @inference-gateway/adk-example-default-handlers start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                  | Description               |
| ----------------------- | ------------------------ | ------------------------- |
| `A2A_AGENT_NAME`        | `default-handlers-agent` | Agent card `name`.        |
| `A2A_AGENT_DESCRIPTION` | (see source)             | Agent card `description`. |
| `A2A_AGENT_VERSION`     | `0.0.0`                  | Agent card `version`.     |
| `A2A_SERVER_HOST`       | `127.0.0.1`              | Listen host.              |
| `A2A_SERVER_PORT`       | `8080`                   | Listen port.              |

Client (`client.ts`):

| Env var         | Default                                                                | Description                                      |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| `SERVER_URL`    | `http://127.0.0.1:8080`                                                | Base URL of the A2A server.                      |
| `SEND_PROMPT`   | `Hello via SendMessage - please walk this task to COMPLETED.`          | Text sent on the `SendMessage` request.          |
| `STREAM_PROMPT` | `Hello via SendStreamingMessage - please walk this task to COMPLETED.` | Text sent on the `SendStreamingMessage` request. |

## Expected output

Server:

```text
default-handlers-agent listening on http://127.0.0.1:8080
  card:   http://127.0.0.1:8080/.well-known/agent-card.json
  health: http://127.0.0.1:8080/health
  rpc:    POST http://127.0.0.1:8080/
  methods: SendMessage, SendStreamingMessage, CancelTask, GetTask, SubscribeToTask
task … dequeued (SendMessage path)
task … -> TASK_STATE_COMPLETED
```

Client (abbreviated - UUIDs differ between runs):

```text
=== SendMessage (background path) ===
POST http://127.0.0.1:8080/  SendMessage  "Hello via SendMessage - please walk this task to COMPLETED."
created task id=… state=TASK_STATE_SUBMITTED
final state: TASK_STATE_COMPLETED
final task:
{ "id": "…", "status": { "state": "TASK_STATE_COMPLETED", … }, … }

=== SendStreamingMessage (streaming path) ===
POST http://127.0.0.1:8080/  SendStreamingMessage  "Hello via SendStreamingMessage - please walk this task to COMPLETED."
[frame 1] task
[frame 2] statusUpdate state=TASK_STATE_WORKING
stream complete: 2 frame(s)
```

The streaming default stub yields a single terminal event, so the executor finishes within the same microtask the initial `TASK_STATE_WORKING` frame is enqueued in. Depending on the Node/HTTP buffering, the terminal `TASK_STATE_COMPLETED` frame may be coalesced with the stream close and not surface to the client. The unit tests for `createMessageStreamHandler` read the writer's `ReadableStream` directly (no HTTP round-trip) and observe every frame; see `tests/server/message-stream.test.ts`. For a realistic streaming flow with deltas that flush across the wire one at a time, see [`examples/streaming/`](../streaming/).

## How `SendMessage` is wired

`createMessageSendHandler` (registered by the builder when a background handler is configured) is itself synchronous: it creates a `PENDING` task, enqueues it in storage, and returns the wire-format task. **The default handler does not run inside the request** - it runs in a worker loop the example owns:

```ts
const builder = new A2AServerBuilder({ storage })
  .withAgentCard(card)
  .withDefaultTaskHandlers();
const server = builder.build();

const backgroundHandler = builder.getBackgroundTaskHandler();
// Pull tasks off storage and feed them to the builder-installed handler.
runWorker(abort.signal, backgroundHandler);
```

The worker dequeues from the same `InMemoryTaskStorage` that the builder was configured with, calls `handler({ task, message, signal })`, and stores the terminal task back via `storeDeadLetter` so `GetTask` can find it.

## How `SendStreamingMessage` is wired

`createMessageStreamHandler` (registered by the builder when a streaming handler is configured) runs the streaming executor **inline** as part of the HTTP request. There is no queue and no worker - the executor's events become SSE frames as they are yielded. For the default streaming stub, that means the task, a `TASK_STATE_WORKING` and a `TASK_STATE_COMPLETED` status update, and the stream closes.

## Why register `GetTask` manually?

`A2AServerBuilder.build()` registers the methods that depend on the configured task handlers (`SendMessage`, `SendStreamingMessage`, `SubscribeToTask`) plus the always-on `CancelTask`. It does **not** register `GetTask` - the client uses `GetTask` to poll the background path in this example, so the example registers it explicitly after `build()`:

```ts
server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
```

Once the broader server defaults align with the Go ADK, this manual step will likely go away.
