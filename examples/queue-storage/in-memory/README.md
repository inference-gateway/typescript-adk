# Queue Storage Example - In-Memory

A2A echo agent wired to [`InMemoryTaskStorage`](../../../src/storage/in-memory.ts). Pair this with the sibling [`redis/`](../redis/) variant to see what changes when you swap storage backends; the two `server.ts` files differ only in the storage construction and the optional shutdown call.

Mirrors the Go ADK's [`examples/queue-storage/in-memory/`](https://github.com/inference-gateway/adk/tree/main/examples/queue-storage/in-memory).

## What this example shows

- Construct the simplest available `TaskStorage`: `new InMemoryTaskStorage()`.
- Plug it into the standard `message/send` + `tasks/get` handler pair.
- Drive a background echo worker via `storage.dequeue(signal)`.
- Demonstrate that **the rest of the agent does not care** which backend the storage is - the worker, the handlers, the dead-lettering call are identical to the Redis variant.

## When to use the in-memory backend

- Local development and unit / integration tests.
- Single-instance services where losing in-flight tasks on restart is acceptable.
- Demos and one-off scripts.

In-memory storage has zero dependencies beyond the ADK itself. It is the right default while you build out an agent; switch to `redis/` once you need persistence or multi-instance fan-out.

## Layout

```text
examples/queue-storage/in-memory/
├── README.md
├── client.ts        # sendMessage + poll tasks/get until terminal
├── package.json     # workspace package, depends only on @inference-gateway/adk
├── server.ts        # A2A server + echo worker, InMemoryTaskStorage
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

In one terminal, start the server:

```sh
pnpm --filter @inference-gateway/adk-example-queue-storage-in-memory start:server
```

In another terminal, run the client:

```sh
pnpm --filter @inference-gateway/adk-example-queue-storage-in-memory start:client
```

`pnpm --filter @inference-gateway/adk-example-queue-storage-in-memory start` is an alias for `start:server`.

### Configuration

Server (`server.ts`):

| Env var                 | Default                                                                    | Description               |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------- |
| `A2A_AGENT_NAME`        | `queue-storage-in-memory-agent`                                            | Agent card `name`.        |
| `A2A_AGENT_DESCRIPTION` | `A2A echo agent backed by InMemoryTaskStorage. Tasks are lost on restart.` | Agent card `description`. |
| `A2A_AGENT_VERSION`     | `0.0.0`                                                                    | Agent card `version`.     |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                                                | Listen host.              |
| `A2A_SERVER_PORT`       | `8080`                                                                     | Listen port.              |

There are **no storage-related env vars** for this variant - `InMemoryTaskStorage` takes no configuration. Compare to the [`redis/` variant](../redis/README.md#configuration), which honours `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB`, and `REDIS_KEY_PREFIX`.

Client (`client.ts`):

| Env var      | Default                                                                  | Description                 |
| ------------ | ------------------------------------------------------------------------ | --------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                                  | Base URL of the A2A server. |
| `PROMPT`     | `Hello from the in-memory queue-storage example. Please echo this back.` | Text to send.               |

## Expected output

Server:

```text
queue-storage-in-memory-agent listening on http://127.0.0.1:8080
  storage: in-memory (no persistence)
  card:    http://127.0.0.1:8080/.well-known/agent-card.json
  health:  http://127.0.0.1:8080/health
  rpc:     POST http://127.0.0.1:8080/
```

Client (abbreviated - UUIDs differ):

```text
POST http://127.0.0.1:8080/  message/send  "Hello from the in-memory queue-storage example. Please echo this back."
created task id=… state=TASK_STATE_SUBMITTED
{
  "id": "…",
  "status": {
    "state": "TASK_STATE_COMPLETED",
    "message": {
      "role": "ROLE_AGENT",
      "parts": [
        { "text": "Echo (in-memory): Hello from the in-memory queue-storage example. Please echo this back." }
      ]
    }
  },
  …
}
```

## Restart behavior

Stop the server with `Ctrl+C`, then start it again - any task you submitted before the restart is gone, including completed ones in the dead-letter store. That is exactly the trade-off this backend exists to make explicit: **no persistence, zero ops cost**. If that trade is unacceptable for your use case, see [`../redis/`](../redis/).
