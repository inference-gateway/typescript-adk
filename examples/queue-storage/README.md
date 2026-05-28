# Queue Storage Examples

Two end-to-end variants of the same A2A echo agent, differing only in which `TaskStorage` backend is wired in. Use this pair to see exactly what changes when you swap a storage implementation.

Mirrors the Go ADK's [`examples/queue-storage/`](https://github.com/inference-gateway/adk/tree/main/examples/queue-storage).

## What this pair shows

`TaskStorage` is the pluggable interface that holds the FIFO queue, the active-task map, the dead-letter store, and the push-notification configs. The ADK ships two production-grade implementations:

| Backend                                                                           | Best for                                        | Persistence                | Cross-instance fan-out                               |
| --------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| [`in-memory/`](./in-memory/) - `InMemoryTaskStorage`                              | dev, tests, single-instance services            | none (lost on restart)     | n/a (in-process only)                                |
| [`redis/`](./redis/) - `RedisTaskStorage.connect({ url: process.env.REDIS_URL })` | multi-instance deployments, restart-safe queues | tasks survive process exit | queue is shared via `BRPOP`; other state is mirrored |

Apart from the storage construction and shutdown call, **the two `server.ts` files are byte-for-byte identical**. That's the whole point of the example: the rest of the agent code never needs to know which backend it is talking to.

## The only difference

`in-memory/server.ts`:

```ts
import { InMemoryTaskStorage, type TaskStorage } from '@inference-gateway/adk';

const storage: TaskStorage = new InMemoryTaskStorage();
// ...nothing to dispose on shutdown.
```

`redis/server.ts`:

```ts
import { RedisTaskStorage, type TaskStorage } from '@inference-gateway/adk';

const storage = await RedisTaskStorage.connect({
  url: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379/0',
  keyPrefix: process.env['REDIS_KEY_PREFIX'] ?? 'a2a:',
  onError: (err) => console.error('redis storage error:', err),
});
// On shutdown: await storage.disconnect();
```

Both values satisfy the `TaskStorage` interface, so the rest of the program (`createMessageSendHandler({ storage })`, the dequeue worker, dead-lettering, ...) is unchanged.

## When to pick which

- **Pick in-memory when** you are iterating locally, writing tests, or running a single-instance agent where losing in-flight tasks on restart is acceptable. Zero ops cost, zero dependencies beyond the ADK itself.
- **Pick Redis when** you want at least one of: (a) the queue to survive a process crash, (b) multiple agent replicas dequeuing from a shared queue, or (c) an out-of-process operator (a CLI, a UI) to peek at queue state without hitting your HTTP API. Requires a reachable Redis 5+ (6+ recommended).

Per the Redis backend docs, only the shared queue itself is strongly consistent across replicas - the active and dead-letter mirrors are eventually consistent and hydrate at startup. For a single-replica deployment this is functionally indistinguishable from in-memory, with the bonus of restart persistence.

## Running the examples

From the repo root:

```sh
pnpm install
```

Then follow the per-example README:

- [`in-memory/README.md`](./in-memory/README.md)
- [`redis/README.md`](./redis/README.md) (ships a `docker-compose.yml` for local Redis)
