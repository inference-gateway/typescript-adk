# Minimal A2A Example (no LLM)

The smallest end-to-end example of `@inference-gateway/adk`: an A2A server that echoes any message it receives, plus a client that sends one message and prints the resulting task.

Mirrors the Go ADK's [`examples/minimal/`](https://github.com/inference-gateway/adk/tree/main/examples/minimal).

## What this example shows

- Boot an `A2AServer` with a hand-written `AgentCard`.
- Register the `message/send` and `tasks/get` JSON-RPC handlers backed by `InMemoryTaskStorage`.
- Run a background worker that dequeues each new task and walks it through `PENDING → IN_PROGRESS → COMPLETED`, attaching an `Echo: <input>` response message.
- Drive it all with `A2AClient` from the same package - no third-party HTTP code, no LLM.

## Layout

```text
examples/minimal/
├── README.md
├── client.ts        # sendMessage + poll tasks/get until terminal
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + echo worker
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-minimal start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-minimal start:client
```

`pnpm --filter @inference-gateway/adk-example-minimal start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                                     | Description               |
| ----------------------- | ------------------------------------------- | ------------------------- |
| `A2A_AGENT_NAME`        | `minimal-agent`                             | Agent card `name`.        |
| `A2A_AGENT_DESCRIPTION` | `A minimal A2A server that echoes messages` | Agent card `description`. |
| `A2A_AGENT_VERSION`     | `0.0.0`                                     | Agent card `version`.     |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                 | Listen host.              |
| `A2A_SERVER_PORT`       | `8080`                                      | Listen port.              |

Client (`client.ts`):

| Env var      | Default                                                          | Description                 |
| ------------ | ---------------------------------------------------------------- | --------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                          | Base URL of the A2A server. |
| `PROMPT`     | `Hello, this is a test message. Please respond with a greeting.` | Text to send.               |

## Expected output

Server:

```text
minimal-agent listening on http://127.0.0.1:8080
  card:   http://127.0.0.1:8080/.well-known/agent-card.json
  health: http://127.0.0.1:8080/health
  rpc:    POST http://127.0.0.1:8080/
```

Client (abbreviated - UUIDs and timestamps will differ):

```text
POST http://127.0.0.1:8080/  message/send  "Hello, this is a test message. Please respond with a greeting."
created task id=… state=TASK_STATE_SUBMITTED
{
  "id": "…",
  "contextId": "…",
  "status": {
    "state": "TASK_STATE_COMPLETED",
    "message": {
      "messageId": "…",
      "contextId": "…",
      "taskId": "…",
      "role": "ROLE_AGENT",
      "parts": [
        { "text": "Echo: Hello, this is a test message. Please respond with a greeting." }
      ]
    },
    "timestamp": "…"
  },
  "history": [
    { "role": "ROLE_USER",  "parts": [ { "text": "Hello, this is a test message. Please respond with a greeting." } ], … },
    { "role": "ROLE_AGENT", "parts": [ { "text": "Echo: Hello, this is a test message. Please respond with a greeting." } ], … }
  ]
}
```

## How the echo worker works

`message/send` is synchronous from the caller's perspective: the handler creates a `PENDING` task, enqueues it, and immediately returns. The actual work happens in `runEchoWorker` (see `server.ts`):

1. `await storage.dequeue(signal)` blocks until a new task arrives.
2. `transitionTask(task, TASK_STATE.IN_PROGRESS)` + `storage.updateActive(...)` records that work has started.
3. The worker extracts the latest user-authored text part, builds `Echo: <input>`, appends it to the task's message history, and transitions to `TASK_STATE.COMPLETED` with the response attached as `status.message`.
4. `storage.storeDeadLetter(completed)` moves the task out of active storage so `tasks/get` can still serve it, but it no longer occupies the queue.

If anything throws inside step 2-4, the worker transitions the task to `TASK_STATE.FAILED` and dead-letters it instead of crashing.
