# Streaming A2A Example (no LLM)

End-to-end example of `message/stream` over Server-Sent Events using `@inference-gateway/adk`: a server with a custom streaming handler that emits word-by-word `delta` events plus a final `task.status.changed` (state `COMPLETED`), and a client that consumes the SSE stream and prints each event as it arrives.

Mirrors the Go ADK's [`examples/streaming/`](https://github.com/inference-gateway/adk/tree/main/examples/streaming).

## What this example shows

- Boot an `A2AServer` with `capabilities.streaming = true` in its `AgentCard`.
- Register the `message/stream` JSON-RPC method via `createMessageStreamHandler`.
- Provide a `StreamingTaskExecutor` (an `async function*`) that yields `delta` events for each word and a final `statusChanged` event carrying the full assembled message.
- Drive it all from a plain `fetch`-based client that decodes the SSE frames and CloudEvents v1.0 envelopes inline — no third-party HTTP code, no LLM. Deltas are pure mock output, simulated with a small sleep between words.

## Layout

```text
examples/streaming/
├── README.md
├── client.ts        # POST message/stream + read SSE + print deltas live
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + mock streaming executor
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-streaming start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-streaming start:client
```

`pnpm --filter @inference-gateway/adk-example-streaming start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                                                 | Description                              |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------- |
| `A2A_AGENT_NAME`        | `streaming-agent`                                       | Agent card `name`.                       |
| `A2A_AGENT_DESCRIPTION` | `A streaming A2A server that emits word-by-word deltas` | Agent card `description`.                |
| `A2A_AGENT_VERSION`     | `0.0.0`                                                 | Agent card `version`.                    |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                             | Listen host.                             |
| `A2A_SERVER_PORT`       | `8080`                                                  | Listen port.                             |
| `DELTA_DELAY_MS`        | `150`                                                   | Sleep between delta frames (0 disables). |

Client (`client.ts`):

| Env var      | Default                                                            | Description                 |
| ------------ | ------------------------------------------------------------------ | --------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                            | Base URL of the A2A server. |
| `PROMPT`     | `Please write a short paragraph and stream it to me word by word.` | Text to send.               |

## Expected output

Server:

```text
streaming-agent listening on http://127.0.0.1:8080
  card:   http://127.0.0.1:8080/.well-known/agent-card.json
  health: http://127.0.0.1:8080/health
  rpc:    POST http://127.0.0.1:8080/  method=message/stream
```

Client (abbreviated — UUIDs and timestamps will differ, and the response text streams in word-by-word):

```text
POST http://127.0.0.1:8080/  message/stream  "Please write a short paragraph and stream it to me word by word."
[task …] status=IN_PROGRESS final=false
---
This is a mock streaming response. Each word appears with a small delay to simulate real-time token streaming without any LLM dependency.
---
[task …] status=TASK_STATE_COMPLETED final=true
stream complete: 22 delta event(s)
assembled text: "This is a mock streaming response. Each word appears with a small delay to simulate real-time token streaming without any LLM dependency."
final status: {
  "taskId": "…",
  "contextId": "…",
  "status": {
    "state": "TASK_STATE_COMPLETED",
    "message": {
      "messageId": "…",
      "contextId": "…",
      "taskId": "…",
      "role": "ROLE_AGENT",
      "parts": [
        { "text": "This is a mock streaming response. …" }
      ]
    },
    "timestamp": "…"
  },
  "final": true
}
```

## How the streaming executor works

`message/stream` is fundamentally different from `message/send`: the handler does not return a single JSON-RPC envelope, it opens an SSE stream and emits CloudEvents v1.0 frames until the task reaches a terminal state. The lifecycle implemented by `createMessageStreamHandler` is:

1. Validate params and create a `PENDING` task; enqueue it in `InMemoryTaskStorage`.
2. Transition the task to `IN_PROGRESS` and emit a `adk.agent.task.status.changed` frame (`final: false`).
3. Iterate the user-supplied executor. For each event:
   - `delta` → emit a `adk.agent.delta` frame carrying the partial message; no state change.
   - `statusChanged` → transition the task and emit `adk.agent.task.status.changed`. A terminal state ends the stream.
4. If the executor exhausts without yielding a terminal status, the handler transitions the task to `COMPLETED` and emits a final status frame automatically.
5. If the request is cancelled (client disconnect, server shutdown), the executor's `signal` aborts, the task transitions to `CANCELLED`, and a final status frame is emitted before the stream closes.
6. Any error thrown by the executor transitions the task to `FAILED` and embeds the error message in the final status frame.

In this example the executor (`mockStreamingExecutor` in `server.ts`) walks a hard-coded array of words. For each word it builds a `delta` message whose only `part` is the new token (with a leading space for every word after the first) and yields it. Between words it sleeps for `DELTA_DELAY_MS`, observing `context.signal` so cancellation unwinds promptly. After the last word, it explicitly yields a `statusChanged` event with `state: COMPLETED` and the full assembled text as the final assistant message — this makes the final `status.message` on the stored task non-empty, which matches what an LLM-backed executor would produce.

## How the client reads the stream

`A2AClient` does not yet expose a `streamMessage` helper (deferred to a later release), so this example drives the wire directly:

1. `POST <SERVER_URL>/` with a JSON-RPC envelope (`method: "message/stream"`).
2. Confirm the response is `Content-Type: text/event-stream`.
3. Read the body as a Web `ReadableStream<Uint8Array>`, decode UTF-8, and split on `\n\n` to recover individual SSE frames.
4. For every `data: …` frame, parse the payload as a CloudEvents v1.0 envelope and dispatch on its `type` attribute (`adk.agent.delta`, `adk.agent.task.status.changed`).
5. For each delta frame, write the text parts straight to `stdout` so the response appears progressively. For the terminal status frame, log the final task summary.
