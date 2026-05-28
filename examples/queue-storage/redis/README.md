# Queue Storage Example - Redis

A2A echo agent wired to [`RedisTaskStorage`](../../../src/storage/redis.ts). Pair this with the sibling [`in-memory/`](../in-memory/) variant to see what changes when you swap storage backends; the two `server.ts` files differ only in the storage construction and the shutdown call.

Mirrors the Go ADK's [`examples/queue-storage/redis/`](https://github.com/inference-gateway/adk/tree/main/examples/queue-storage/redis).

## What this example shows

- Construct `RedisTaskStorage` via the async factory `RedisTaskStorage.connect({ url, keyPrefix, onError })`, which:
  1. Opens two `ioredis` connections (one for commands, one for the blocking `BRPOP` loop).
  2. PINGs the server and throws `TaskStorageError` if it cannot reach Redis.
  3. Hydrates the in-memory mirror from any pre-existing keys under `keyPrefix`.
- Reuse the **same** `message/send` + `tasks/get` handler pair and the **same** background echo worker as the [`in-memory/`](../in-memory/) variant.
- Disconnect cleanly on `SIGINT` / `SIGTERM` with `await storage.disconnect()`.

## When to use the Redis backend

- You want the queue and dead-letter store to **survive process restarts**.
- You run **multiple agent replicas** that need to share a queue (each replica `BRPOP`s the same Redis list).
- You want an out-of-process operator (a CLI, a UI) to peek at queue state without going through your HTTP API.

Per the [`RedisTaskStorage` class docs](../../../src/storage/redis.ts), the shared Redis queue is strongly consistent across replicas via `BRPOP`. The active and dead-letter mirrors are eventually consistent (each replica hydrates from Redis at startup); for a single-replica deployment this is functionally indistinguishable from `InMemoryTaskStorage`, with the bonus of restart persistence.

## Layout

```text
examples/queue-storage/redis/
├── README.md
├── .env.example       # template environment file
├── client.ts          # sendMessage + poll tasks/get until terminal
├── docker-compose.yml # local Redis 7 with persistence enabled
├── package.json       # workspace package, depends on @inference-gateway/adk + ioredis
├── server.ts          # A2A server + echo worker, RedisTaskStorage
└── tsconfig.json
```

## Running it

You need Docker (or any reachable Redis 5+) to run this example. From the repo root:

```sh
pnpm install
```

Start Redis in the background (uses the `docker-compose.yml` in this directory):

```sh
pnpm --filter @inference-gateway/adk-example-queue-storage-redis redis:up
```

Start the server (in one terminal):

```sh
pnpm --filter @inference-gateway/adk-example-queue-storage-redis start:server
```

Run the client (in another terminal):

```sh
pnpm --filter @inference-gateway/adk-example-queue-storage-redis start:client
```

When you are done, tear down the container **and** its volume:

```sh
pnpm --filter @inference-gateway/adk-example-queue-storage-redis redis:down
```

### Configuration

Server (`server.ts`):

| Env var                 | Default                                                                                        | Description                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`             | `redis://127.0.0.1:6379/0` (only when no other `REDIS_*` vars are set)                         | Full Redis connection URL. Takes precedence over `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_DB` if set. |
| `REDIS_HOST`            | unset                                                                                          | Redis host; used when `REDIS_URL` is not set.                                                                        |
| `REDIS_PORT`            | unset                                                                                          | Redis port; used when `REDIS_URL` is not set.                                                                        |
| `REDIS_PASSWORD`        | unset                                                                                          | Redis password; used when `REDIS_URL` is not set.                                                                    |
| `REDIS_DB`              | unset                                                                                          | Redis database index; used when `REDIS_URL` is not set.                                                              |
| `REDIS_KEY_PREFIX`      | `a2a:`                                                                                         | Prefix applied to every Redis key. Override when multiple ADK deployments share a single Redis instance.             |
| `A2A_AGENT_NAME`        | `queue-storage-redis-agent`                                                                    | Agent card `name`.                                                                                                   |
| `A2A_AGENT_DESCRIPTION` | `A2A echo agent backed by RedisTaskStorage. The queue and dead-letter store survive restarts.` | Agent card `description`.                                                                                            |
| `A2A_AGENT_VERSION`     | `0.0.0`                                                                                        | Agent card `version`.                                                                                                |
| `A2A_SERVER_HOST`       | `127.0.0.1`                                                                                    | Listen host.                                                                                                         |
| `A2A_SERVER_PORT`       | `8080`                                                                                         | Listen port.                                                                                                         |

The `REDIS_*` parsing is provided by [`redisConnectOptionsFromEnv`](../../../src/storage/redis.ts) and is identical to the helper used by other ADK consumers - you do not need to reinvent it in your own service.

Client (`client.ts`):

| Env var      | Default                                                              | Description                 |
| ------------ | -------------------------------------------------------------------- | --------------------------- |
| `SERVER_URL` | `http://127.0.0.1:8080`                                              | Base URL of the A2A server. |
| `PROMPT`     | `Hello from the redis queue-storage example. Please echo this back.` | Text to send.               |

## Expected output

Server:

```text
queue-storage-redis-agent listening on http://127.0.0.1:8080
  storage:    redis (prefix=a2a:)
  card:       http://127.0.0.1:8080/.well-known/agent-card.json
  health:     http://127.0.0.1:8080/health
  rpc:        POST http://127.0.0.1:8080/
```

Client (abbreviated - UUIDs differ):

```text
POST http://127.0.0.1:8080/  message/send  "Hello from the redis queue-storage example. Please echo this back."
created task id=… state=TASK_STATE_SUBMITTED
{
  "id": "…",
  "status": {
    "state": "TASK_STATE_COMPLETED",
    "message": {
      "role": "ROLE_AGENT",
      "parts": [
        { "text": "Echo (redis): Hello from the redis queue-storage example. Please echo this back." }
      ]
    }
  },
  …
}
```

## Restart behavior

Unlike the [`in-memory/`](../in-memory/) variant, tasks persist across restarts:

1. Submit a message with the client.
2. Stop the server with `Ctrl+C`.
3. Restart the server.
4. Call `tasks/get` for the original task id - the dead-letter record is still there because `RedisTaskStorage.connect` hydrates the in-memory mirror from the persisted Redis keys.

Tear down the docker-compose volume (`pnpm --filter ... redis:down`) to wipe state and start fresh.

## Inspecting state with `redis-cli`

While the agent runs, you can peek at the queue layout described in the [`RedisTaskStorage` docs](../../../src/storage/redis.ts):

```sh
docker exec -it adk-queue-storage-redis redis-cli
> KEYS "a2a:*"
1) "a2a:active:<task-id>"        # active-task JSON
2) "a2a:deadletter:<task-id>"    # terminal-task JSON
3) "a2a:context:<context-id>"    # set of task ids in that context
4) "a2a:queue:order"             # list of task ids (FIFO via LPUSH/BRPOP)
5) "a2a:queue:items"             # hash of task-id -> queued-task JSON
> LLEN "a2a:queue:order"         # number of tasks currently waiting
```

For multi-instance deployments, every replica that reads from the same `REDIS_URL` and `REDIS_KEY_PREFIX` will share the queue.

## Notes

- `ioredis` is declared as a hard `dependency` in this example's `package.json` because `RedisTaskStorage.connect` dynamically imports it. In the main `@inference-gateway/adk` package, `ioredis` is an **optional peer dependency** - consumers that only use `InMemoryTaskStorage` do not have to install it.
- The `docker-compose.yml` enables AOF persistence (`--appendonly yes`) so a `docker compose restart redis` will not wipe in-flight tasks. Use `redis:down` (which passes `-v`) when you actually want to start clean.
