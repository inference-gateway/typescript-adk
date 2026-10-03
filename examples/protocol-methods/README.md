# Protocol Methods Walkthrough

Comprehensive client walkthrough exercising every JSON-RPC method in the A2A protocol surface, using `@inference-gateway/adk`. Doubles as a smoke test for the whole protocol - every method call includes assertions on the response shape and fields.

Mirrors the Go ADK's [`examples/protocol-methods/`](https://github.com/inference-gateway/adk/tree/main/examples/protocol-methods).

## What this example shows

- A full-featured server with **all capabilities enabled** (streaming, push notifications, state transition history) and every handler registered.
- A client that walks through **14 protocol methods/steps** with assertions:
  1. `GET /.well-known/agent-card.json` - unauthenticated card discovery (GET)
  2. `GET /health` - liveness probe (GET)
  3. `GetExtendedAgentCard` - extended card via JSON-RPC
  4. `SendMessage` - create a task
  5. `GetTask` - retrieve the task immediately
  6. `GetTask` (poll until terminal) - wait for completion + verify response
  7. `GetTask` with `historyLength` - cap message history
  8. `ListTasks` - list all tasks with optional pagination
  9. `ListTasks` filtered by `status` - filter to COMPLETED tasks
  10. `CancelTask` - cancel a non-terminal task + verify via `GetTask`
  11. `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` - push notification config CRUD
  12. `SendStreamingMessage` - SSE streaming with word-by-word deltas
  13. `SubscribeToTask` - SSE resubscribe to a completed task's stream
  14. `GetTask` (non-existent id) - error path

## Layout

```text
examples/protocol-methods/
├── README.md        # this file - documents every method call with expected output
├── client.ts        # comprehensive walkthrough with assertions
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + mock streaming executor + background worker
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-protocol-methods start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-protocol-methods start:client
```

`pnpm --filter @inference-gateway/adk-example-protocol-methods start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                   | Description                                                                                                                         |
| ----------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `A2A_AGENT_NAME`        | `protocol-methods-agent`  | Agent card `name`.                                                                                                                  |
| `A2A_AGENT_DESCRIPTION` | `A full-featured A2A ...` | Agent card `description`.                                                                                                           |
| `A2A_AGENT_VERSION`     | `0.0.0`                   | Agent card `version`.                                                                                                               |
| `A2A_SERVER_HOST`       | `127.0.0.1`               | Listen host.                                                                                                                        |
| `A2A_SERVER_PORT`       | `8080`                    | Listen port.                                                                                                                        |
| `DELTA_DELAY_MS`        | `100`                     | Sleep between delta frames (0 disables).                                                                                            |
| `WORKER_DELAY_MS`       | `500`                     | Background worker sleep before completing a PENDING task. Keeps the task non-terminal long enough for `CancelTask` to intercept it. |

Client (`client.ts`):

| Env var      | Default                          | Description                 |
| ------------ | -------------------------------- | --------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`          | Base URL of the A2A server. |
| `PROMPT`     | `Hello, protocol-methods agent!` | Text to send.               |

## Method-by-method documentation

### 1. `GET /.well-known/agent-card.json` (unauthenticated agent card discovery)

The server exposes its public `AgentCard` at `GET /.well-known/agent-card.json`. Clients discover the agent's identity, capabilities, and skills before sending any JSON-RPC request.

**Request:** `GET http://localhost:8080/.well-known/agent-card.json`

**Response body (JSON):**

```json
{
  "name": "protocol-methods-agent",
  "description": "A full-featured A2A agent exercising every JSON-RPC method.",
  "version": "0.0.0",
  "supportedInterfaces": [
    {
      "url": "http://127.0.0.1:8080",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "url": "http://127.0.0.1:8080",
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "skills": [
    {
      "id": "echo",
      "name": "Echo",
      "description": "Echoes the user message back as a completed task. No LLM required.",
      "tags": ["echo", "demo"]
    }
  ]
}
```

**Client assertions:**

- `card.name` is a non-empty string
- `card.capabilities.streaming === true`
- `card.capabilities.pushNotifications === true`
- `card.capabilities.pushNotifications === true`

---

### 2. `GET /health` (liveness probe)

The server exposes a health endpoint at `GET /health`. Returns `{ status: "healthy" }` whenever the HTTP listener is running, independent of registered methods.

**Request:** `GET http://localhost:8080/health`

**Response body (JSON):**

```json
{
  "status": "healthy"
}
```

**Client assertions:**

- `health.status === "healthy"`

---

### 3. `GetExtendedAgentCard` (extended card via JSON-RPC)

The server exposes an extended agent card via the `GetExtendedAgentCard` JSON-RPC method. In production this is gated by authentication middleware; in this example the method is registered without auth enforcement so the walkthrough can demonstrate the response shape.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "GetExtendedAgentCard",
  "params": {}
}
```

**JSON-RPC result:**

```json
{
  "name": "protocol-methods-agent (extended)",
  "description": "A full-featured A2A agent exercising every JSON-RPC method. [authenticated view]",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  }
}
```

**Client assertions:**

- Extended card name includes "(extended)"
- Capabilities match the public card

---

### 4. `SendMessage` (create a task)

Creates a new task from a user message. The server enqueues it as `PENDING` and returns immediately with a task whose `status.state` is `TASK_STATE_SUBMITTED` (the wire form of `PENDING`). A background worker picks it up asynchronously after `WORKER_DELAY_MS`.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "<uuid>",
      "role": "ROLE_USER",
      "parts": [{ "text": "Hello, protocol-methods agent!" }]
    }
  }
}
```

**JSON-RPC result (abbreviated):**

```json
{
  "id": "<task-uuid>",
  "contextId": "<context-uuid>",
  "status": {
    "state": "TASK_STATE_SUBMITTED",
    "timestamp": "..."
  },
  "history": [
    {
      "messageId": "<uuid>",
      "role": "ROLE_USER",
      "parts": [{ "text": "Hello, protocol-methods agent!" }]
    }
  ]
}
```

**Client assertions:**

- `task.id` is a non-empty string
- `task.status.state === TASK_STATE.PENDING` (which is the string `"TASK_STATE_SUBMITTED"` on the wire)

---

### 5. `GetTask` (retrieve immediately after send)

Retrieves the task by id. Called immediately after `SendMessage`, the task may still be `PENDING` (`TASK_STATE_SUBMITTED` on the wire).

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "GetTask",
  "params": { "taskId": "<task-uuid>" }
}
```

**JSON-RPC result:**

```json
{
  "id": "<task-uuid>",
  "status": { "state": "TASK_STATE_SUBMITTED", "timestamp": "..." },
  "history": [ ... ]
}
```

**Client assertions:**

- `fetched.id === createdTask.id`

---

### 6. `GetTask` (poll until terminal)

The client polls `GetTask` every `POLL_INTERVAL_MS` until `isTerminal()` returns true. The background worker picks up the PENDING task and transitions it to `COMPLETED` with an echo response.

**JSON-RPC request (same shape as step 5):**

```json
{ "method": "GetTask", "params": { "taskId": "<task-uuid>" } }
```

**JSON-RPC result (terminal):**

```json
{
  "id": "<task-uuid>",
  "status": {
    "state": "COMPLETED",
    "timestamp": "...",
    "message": {
      "messageId": "<uuid>",
      "role": "ROLE_AGENT",
      "parts": [{ "text": "Echo: Hello, protocol-methods agent!" }]
    }
  },
  "history": [ ... ]
}
```

**Client assertions:**

- `task.status.state === "COMPLETED"`
- `task.status.message` is present with non-empty text

---

### 7. `GetTask` with `historyLength`

Retrieves the same task but caps the returned `history` to the most recent 1 message.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "GetTask",
  "params": { "taskId": "<task-uuid>", "historyLength": 1 }
}
```

**Client assertions:**

- `history.length <= 1`

---

### 8. `ListTasks` (list all tasks)

Lists tasks across the active and dead-letter stores. Results are FIFO-ordered by creation time. Keyset pagination via an opaque `pageToken` returned as `nextPageToken`.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "ListTasks",
  "params": {}
}
```

**JSON-RPC result (abbreviated):**

```json
{
  "tasks": [
    { "id": "<task-1>", "status": { "state": "COMPLETED" } },
    { "id": "<task-2>", "status": { "state": "CANCELLED" } },
    { "id": "<task-3>", "status": { "state": "COMPLETED" } }
  ],
  "pageSize": 100,
  "totalSize": 3,
  "nextPageToken": "<base64-encoded-cursor>"
}
```

**Client assertions:**

- `tasks` is a non-empty array
- `nextPageToken` is non-empty when there are more tasks than fit on a page

---

### 9. `ListTasks` filtered by state

Lists only tasks whose `status.state` equals `COMPLETED`.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "ListTasks",
  "params": { "state": "COMPLETED" }
}
```

**Client assertions:**

- At least one COMPLETED task returned
- Every returned task has `status.state === "COMPLETED"`

---

### 10. `CancelTask`

Cancels a non-terminal (`PENDING` / `IN_PROGRESS`) task. The handler moves the task to `CANCELLED` and stores it in the dead-letter store. Terminal tasks cannot be cancelled. The example server uses `WORKER_DELAY_MS=500` by default so a newly-submitted task stays `PENDING` long enough to be cancelled.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "CancelTask",
  "params": { "taskId": "<task-uuid>" }
}
```

**JSON-RPC result:**

```json
{
  "id": "<task-uuid>",
  "status": {
    "state": "CANCELLED",
    "timestamp": "..."
  }
}
```

**Client assertions:**

- `cancelled.status.state === "CANCELLED"`
- Verification via `GetTask` also returns `CANCELLED`

---

### 11. Push notification config CRUD

Four JSON-RPC methods for managing webhook push notification configs per task.

#### 11a. `CreateTaskPushNotificationConfig`

Registers a push notification config (webhook URL and optional bearer token) for a task.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "CreateTaskPushNotificationConfig",
  "params": {
    "taskId": "<task-uuid>",
    "pushNotificationConfig": {
      "url": "https://webhook.example.com/a2a-updates",
      "token": "test-webhook-token-abc123"
    }
  }
}
```

**JSON-RPC result:**

```json
{
  "name": "tasks/<task-uuid>/pushNotificationConfigs/<config-uuid>",
  "pushNotificationConfig": {
    "id": "<config-uuid>",
    "url": "https://webhook.example.com/a2a-updates",
    "token": "test-webhook-token-abc123"
  }
}
```

#### 11b. `GetTaskPushNotificationConfig`

Retrieves a specific config by task id + config id.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "GetTaskPushNotificationConfig",
  "params": {
    "taskId": "<task-uuid>",
    "id": "<config-uuid>"
  }
}
```

**Client assertions:**

- `pushNotificationConfig.url` matches the set value
- `pushNotificationConfig.token` matches the set value

#### 11c. `ListTaskPushNotificationConfigs`

Lists all configs registered for a task.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "ListTaskPushNotificationConfigs",
  "params": { "taskId": "<task-uuid>" }
}
```

**Client assertions:**

- `configs` is an array with at least 1 entry

#### 11d. `DeleteTaskPushNotificationConfig`

Deletes a config by task id + config id. Returns `null` on success.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "DeleteTaskPushNotificationConfig",
  "params": {
    "taskId": "<task-uuid>",
    "id": "<config-uuid>"
  }
}
```

**JSON-RPC result:** `null`

**Client assertions:**

- Returns `null`
- Subsequent `get` for the deleted config throws a "not found" error

---

### 12. `SendStreamingMessage` (SSE streaming)

Invokes the `SendStreamingMessage` method, which returns a Server-Sent Events stream instead of a single JSON-RPC response. The streaming executor yields word-by-word `delta` events, then a terminal `task.status.changed` event.

**JSON-RPC request (POST with SSE Accept header):**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "SendStreamingMessage",
  "params": {
    "message": {
      "messageId": "<uuid>",
      "role": "ROLE_USER",
      "parts": [{ "text": "Stream this for me!" }]
    }
  }
}
```

**SSE response (each frame is a CloudEvent):**

```
data: {"type":"adk.agent.task.status.changed","data":{"taskId":"<uuid>","contextId":"<uuid>","status":{"state":"TASK_STATE_WORKING","timestamp":"..."}},"subject":"<uuid>"}

data: {"type":"adk.agent.delta","data":{"messageId":"<uuid>","contextId":"<uuid>","taskId":"<uuid>","role":"ROLE_AGENT","parts":[{"text":"Hello"}]}}

data: {"type":"adk.agent.delta","data":{"messageId":"<uuid>","contextId":"<uuid>","taskId":"<uuid>","role":"ROLE_AGENT","parts":[{"text":" from"}]}}

...

data: {"type":"adk.agent.delta","data":{"messageId":"<uuid>","contextId":"<uuid>","taskId":"<uuid>","role":"ROLE_AGENT","parts":[{"text":" deltas."}]}}

data: {"type":"adk.agent.task.status.changed","data":{"taskId":"<uuid>","contextId":"<uuid>","status":{"state":"TASK_STATE_COMPLETED","timestamp":"...","message":{"messageId":"<uuid>","contextId":"<uuid>","taskId":"<uuid>","role":"ROLE_AGENT","parts":[{"text":"Hello from the protocol-methods agent. This is a streaming response with word-by-word deltas."}]}}},"subject":"<uuid>"}
```

**Client assertions:**

- HTTP 200 with `Content-Type: text/event-stream`
- At least one `delta` event received
- Terminal `task.status.changed` event received with `state: COMPLETED`

---

### 13. `SubscribeToTask` (SSE resubscribe)

Allows a client to re-subscribe to a completed (or in-progress) task's event stream. The server replays the current status as the first frame and closes the stream immediately for terminal tasks.

**JSON-RPC request (POST with SSE Accept header):**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "SubscribeToTask",
  "params": { "taskId": "<stream-task-uuid>" }
}
```

**SSE response:**

```
data: {"type":"adk.agent.task.status.changed","data":{"taskId":"<uuid>","contextId":"<uuid>","status":{"state":"TASK_STATE_COMPLETED","timestamp":"..."}},"subject":"<uuid>"}
```

**Client assertions:**

- HTTP 200 with `Content-Type: text/event-stream`
- At least one `task.status.changed` event received

---

### 14. Error path: `GetTask` with non-existent id

Calling `GetTask` with a task id that doesn't exist returns a JSON-RPC error response.

**JSON-RPC request:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "GetTask",
  "params": { "taskId": "non-existent-task-id" }
}
```

**JSON-RPC error response:**

```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "error": {
    "code": -32001,
    "message": "task not found",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "TASK_NOT_FOUND",
        "domain": "a2a-protocol.org"
      }
    ]
  }
}
```

**Client assertions:**

- Throws an error (either `A2AClientError` or an error with "not found" message)

## Expected output

Server (UUIDs and timestamps will differ):

```text
protocol-methods-agent listening on http://127.0.0.1:8080
  card:     http://127.0.0.1:8080/.well-known/agent-card.json
  health:   http://127.0.0.1:8080/health
  rpc:      POST http://127.0.0.1:8080/

Registered methods:
  - GetExtendedAgentCard
  - SendMessage
  - SendStreamingMessage
  - CancelTask
  - GetTask
  - ListTasks
  - DeleteTaskPushNotificationConfig
  - GetTaskPushNotificationConfig
  - ListTaskPushNotificationConfigs
  - CreateTaskPushNotificationConfig
  - SubscribeToTask
background: task <task-id> dequeued
background: task <task-id> -> COMPLETED
```

Client (abbreviated - UUIDs and timestamps will differ):

```text
══════════════════════════════════════════════════════════
  A2A Protocol Methods Walkthrough
  Server: http://127.0.0.1:8080
══════════════════════════════════════════════════════════

── 1. GET /.well-known/agent-card.json ────────────────────────────────
  ✓ card.name is a string
  ✓ card.capabilities.streaming === true
  ✓ card.capabilities.pushNotifications === true
  ... (fields printed)

── 2. GET /health ────────────────────────────────────
  ✓ health.status is a string
  ✓ health.status === "healthy"

── 3. GetExtendedAgentCard ─────────────────
  ✓ extended card name is a string
  ✓ extended card name includes "(extended)"

── 4. SendMessage ───────────────────────────────────────
  ✓ task.id is a string
  ✓ task.id is non-empty
  ✓ task.status.state === PENDING (got TASK_STATE_SUBMITTED)

── 5. GetTask (immediately after send) ────────────────
  ✓ returned task id matches

── 6. GetTask (poll until terminal) ───────────────────
  ... (dots for polling)
  ✓ task reached COMPLETED
  ✓ terminal task has a status.message
  ✓ terminal message has text content

── 7. GetTask (with historyLength=1) ──────────────────
  ✓ task id matches
  ✓ history has at most 1 message

── 8. ListTasks ─────────────────────────────────────────
  ✓ result.tasks is an array
  ✓ at least one task is listed

── 9. ListTasks (filtered by state=COMPLETED) ──────────
  ✓ at least one COMPLETED task

── 10. CancelTask ──────────────────────────────────────
  ✓ cancel-task created (PENDING; got TASK_STATE_SUBMITTED)
  ✓ returned task id matches
  ✓ task state is CANCELLED (got TASK_STATE_CANCELED)
  ✓ verify cancelled via GetTask

── 11. push notification config CRUD ─────────────────────
  ✓ set: returned resource name
  ✓ set: url matches
  ✓ set: config id assigned
  ✓ get: url matches
  ✓ get: token matches
  ✓ list: configs is array
  ✓ list: at least 1 config
  ✓ delete: returns null
  ✓ get after delete throws (config not found)

── 12. SendStreamingMessage ────────────────────────────────────
Hello from the protocol-methods agent. This is a streaming response with word-by-word deltas.
  ✓ stream: HTTP 200
  ✓ stream: Content-Type is text/event-stream
  ✓ stream: response has body
  ✓ stream: received 13 delta(s)
  ✓ stream: received terminal status event
  ✓ stream: final state is COMPLETED

── 13. SubscribeToTask ─────────────────────────────────
  ✓ resubscribe: HTTP 200
  ✓ resubscribe: Content-Type is text/event-stream
  ✓ resubscribe: received 1 event(s)

── 14. GetTask (non-existent id – error path) ─────────
  ✓ getTask(non-existent) throws expected error

══════════════════════════════════════════════════════════
  Walkthrough complete: 48 passed, 0 failed
══════════════════════════════════════════════════════════
```

All assertions pass (✓), zero failures (✗).

## How it works

### Server (`server.ts`)

The server is built using the raw `A2AServer` constructor (not the `A2AServerBuilder`) for maximum explicitness - every handler is registered individually so the example doubles as documentation for what each method needs.

Key components:

1. **Agent card** - Declares `streaming: true` and `pushNotifications: true` so every capability is visible to clients.

2. **Handlers** - 11 handlers registered via `registerMethod()` / `registerStreamingMethod()`:
   - `SendMessage` → `createMessageSendHandler`
   - `GetTask` → `createTaskGetHandler`
   - `ListTasks` → `createTaskListHandler`
   - `CancelTask` → `createTaskCancelHandler`
   - `SendStreamingMessage` → `createMessageStreamHandler` with a mock streaming executor
   - `SubscribeToTask` → `createTaskResubscribeHandler`
   - `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig` → respective CRUD handlers
   - `GetExtendedAgentCard` → `createGetAuthenticatedExtendedCardHandler`

3. **Extended card** - A second `AgentCard` with `(extended)` in its name, served via the `GetExtendedAgentCard` method. In production this would be decorated with OIDC auth schemes; here it demonstrates the mechanism without requiring an identity provider.

4. **Background worker** - A simple loop that dequeues `PENDING` tasks (created by `SendMessage`), waits `WORKER_DELAY_MS`, and then transitions them to `COMPLETED` with an echo response. The worker rechecks the task's state after the sleep and skips anything that is no longer `PENDING` so it doesn't race with `CancelTask` or the streaming handler (which shares the same storage).

5. **Mock streaming executor** - An `async function*` that yields word-by-word `delta` events followed by a final `statusChanged` event with `state: COMPLETED`. Simulates an LLM token stream without any external dependency.

### Client (`client.ts`)

The client walks through each method sequentially, printing pass/fail for every assertion.

- Uses `A2AClient` (the library's convenience wrapper) for `getAgentCard`, `getHealth`, `sendMessage`, and `getTask`.
- Uses raw `fetch` for methods not yet exposed by `A2AClient`: `ListTasks`, `CancelTask`, push notification config CRUD, and `GetExtendedAgentCard`.
- Uses raw `fetch` with SSE parsing for `SendStreamingMessage` and `SubscribeToTask` (streaming methods return `Content-Type: text/event-stream` rather than a single JSON envelope).

## Next steps

- Try [`examples/minimal/`](../minimal/) for the smallest end-to-end A2A loop.
- Try [`examples/ai-powered/`](../ai-powered/) for an LLM-backed agent with tools.
- Try [`examples/streaming/`](../streaming/) for a focused streaming example with no background worker.
