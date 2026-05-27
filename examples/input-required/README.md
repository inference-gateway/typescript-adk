# Input-Required A2A Example (no LLM)

End-to-end example of the **pause + client-driven resume** flow in `@inference-gateway/adk`: an A2A server that pauses a task to ask for a missing piece of information, and a client that detects the pause, sends a follow-up, and reads the completion.

Mirrors the Go ADK's [`examples/input-required/`](https://github.com/inference-gateway/adk/tree/main/examples/input-required) — specifically the non-streaming, no-LLM variant. No real weather data is fetched; the response text is canned.

## What this example shows

- Boot an `A2AServer` with a hand-written `AgentCard`.
- Register the `message/send` and `tasks/get` JSON-RPC handlers backed by `InMemoryTaskStorage`.
- A background worker walks each task through the lifecycle and **pauses** it in `INPUT_REQUIRED` when the user's question is missing information (here: a city for a weather query). `storage.updateActive` keeps the paused task discoverable so a follow-up `message/send` on the same `contextId` can resume it.
- The same `message/send` handler **resumes** the paused task transparently when the client sends a follow-up message carrying the original `contextId` — see `findResumableTask`/`appendAndResume` in `src/server/message-send.ts`.
- A client drives the loop end-to-end: `sendMessage` → poll `tasks/get` → detect `INPUT_REQUIRED` → `sendMessage` again with the same `contextId` → poll until `COMPLETED`.

> The reserved `input_required` tool (`INPUT_REQUIRED_TOOL` in `src/server/default-background-task-handler.ts`) drives the same pause/resume protocol on the LLM side: when an `OpenAICompatibleAgent` calls that tool, the handler transitions the task to `INPUT_REQUIRED` and the resume path described above takes over verbatim. This example exercises the server-side mechanics directly so it stays runnable without an LLM.

## Layout

```text
examples/input-required/
├── README.md
├── client.ts        # sendMessage -> poll -> detect pause -> resume -> poll to terminal
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + pause/resume worker
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-input-required start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-input-required start:client
```

`pnpm --filter @inference-gateway/adk-example-input-required start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                                                                                   | Description               |
| ----------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| `A2A_AGENT_NAME`        | `input-required-agent`                                                                    | Agent card `name`.        |
| `A2A_AGENT_DESCRIPTION` | `A demo agent that pauses to ask for a missing city before answering a weather question.` | Agent card `description`. |
| `A2A_AGENT_VERSION`     | `0.0.0`                                                                                   | Agent card `version`.     |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                                                               | Listen host.              |
| `A2A_SERVER_PORT`       | `8080`                                                                                    | Listen port.              |

Client (`client.ts`):

| Env var      | Default                 | Description                                                          |
| ------------ | ----------------------- | -------------------------------------------------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080` | Base URL of the A2A server.                                          |
| `PROMPT`     | `What's the weather?`   | Initial question. Defaults are crafted to trigger the pause.         |
| `FOLLOW_UP`  | `Berlin`                | Resume message sent once the server transitions to `INPUT_REQUIRED`. |

## Expected interaction trace

Server (UUIDs will differ):

```text
input-required-agent listening on http://127.0.0.1:8080
  card:   http://127.0.0.1:8080/.well-known/agent-card.json
  health: http://127.0.0.1:8080/health
  rpc:    POST http://127.0.0.1:8080/
task <task-id> paused for input: "I can check the weather for you. Which city would you like the forecast for?"
task <task-id> completed: "The weather in Berlin is sunny and 72°F. (demo response - no real weather data is fetched)"
```

Client (abbreviated):

```text
POST http://127.0.0.1:8080/  message/send  "What's the weather?"
created task id=<task-id> state=TASK_STATE_SUBMITTED
polled task state=TASK_STATE_INPUT_REQUIRED
agent asked: "I can check the weather for you. Which city would you like the forecast for?"
POST http://127.0.0.1:8080/  message/send  "Berlin" (resume, contextId=<context-id>)
resumed task id=<task-id> state=TASK_STATE_WORKING
{
  "id": "<task-id>",
  "contextId": "<context-id>",
  "status": {
    "state": "TASK_STATE_COMPLETED",
    "message": {
      "role": "ROLE_AGENT",
      "parts": [
        { "text": "The weather in Berlin is sunny and 72°F. (demo response - no real weather data is fetched)" }
      ]
    },
    "timestamp": "…"
  },
  "history": [
    { "role": "ROLE_USER",  "parts": [ { "text": "What's the weather?" } ] },
    { "role": "ROLE_AGENT", "parts": [ { "text": "I can check the weather for you. Which city would you like the forecast for?" } ] },
    { "role": "ROLE_USER",  "parts": [ { "text": "Berlin" } ] },
    { "role": "ROLE_AGENT", "parts": [ { "text": "The weather in Berlin is sunny and 72°F. (demo response - no real weather data is fetched)" } ] }
  ]
}
```

### Variations

- `PROMPT="What's the weather in Tokyo?" pnpm --filter @inference-gateway/adk-example-input-required start:client` — the message already names a city, so the server completes on the first turn and the client never enters the resume branch.
- `PROMPT="Hello" pnpm --filter @inference-gateway/adk-example-input-required start:client` — non-weather input falls through to the greeting branch and also completes on the first turn.

## How the worker decides to pause vs. complete

`runWorker` in `server.ts` dequeues every task and dispatches it to `handleWeatherTask`. The worker has two relevant lifecycle entry points:

1. **First dispatch (`task.state === TASK_STATE_SUBMITTED`).** A freshly created task arrives via `message/send` → `storage.enqueue`. The worker transitions it to `TASK_STATE_WORKING`, inspects the user's question, and either:
   - pauses to `TASK_STATE_INPUT_REQUIRED` with an agent message asking for the city (`storage.updateActive` keeps the task discoverable by the resume path), or
   - completes immediately when the question already mentions a location or isn't a weather query at all.
2. **Resume dispatch (`task.state === TASK_STATE_WORKING`).** The `message/send` handler has found the paused task via `findResumableTask`, appended the follow-up message, transitioned the task back to `TASK_STATE_WORKING`, and re-enqueued it. By the time the worker dequeues, the resume is already reflected in `task.messages` — the worker treats any task that arrives with more than one user message as the resume case and completes it with the canned response.

The pause/resume path is _driven entirely by the framework's `message/send` handler_ — the worker only ever calls `transitionTask` plus `storage.updateActive` / `storage.storeDeadLetter`. The same code path is what backs the LLM-driven flow when an agent calls the reserved `input_required` tool.
