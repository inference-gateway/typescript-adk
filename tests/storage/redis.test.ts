import RedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import {
  RedisTaskStorage,
  TaskStorageError,
  redisConnectOptionsFromEnv,
} from '../../src/storage/index.js';
import { runTaskStorageConformance } from '../../src/testing/index.js';

interface MockPair {
  command: InstanceType<typeof RedisMock>;
  blocking: InstanceType<typeof RedisMock>;
}

function newMockPair(): MockPair {
  // ioredis-mock's `duplicate()` returns a second instance that shares the
  // server-side data store with the original, mirroring how two real ioredis
  // connections see the same Redis server. We need two because the BRPOP
  // loop monopolises its client.
  const command = new RedisMock();
  const blocking = command.duplicate();
  // ioredis-mock 8 doesn't implement BRPOP (https://github.com/stipsan/ioredis-mock/blob/main/compat.md).
  // The shim below polls RPOP at a tight interval so the dequeue loop sees
  // values written by the command client; real Redis BRPOP is push-based
  // but the production storage class only relies on the public contract.
  attachBrpopShim(blocking, command);
  return { command, blocking };
}

function attachBrpopShim(
  target: InstanceType<typeof RedisMock>,
  data: InstanceType<typeof RedisMock>
): void {
  let stopped = false;
  // Stopping the polling on disconnect / quit prevents a torn-down shim from
  // outliving its test and consuming setTimeout slots that would otherwise
  // serve the next test's polling loop.
  const stopper = <T extends (...args: never[]) => unknown>(orig: T): T =>
    ((...args: Parameters<T>) => {
      stopped = true;
      return orig(...args);
    }) as T;
  target.disconnect = stopper(target.disconnect.bind(target));
  target.quit = stopper(target.quit.bind(target));

  (target as unknown as { brpop: unknown }).brpop = async (
    key: string,
    timeoutSeconds: number
  ): Promise<[string, string] | null> => {
    const deadline =
      timeoutSeconds <= 0 ? Infinity : Date.now() + timeoutSeconds * 1000;
    while (!stopped && Date.now() < deadline) {
      const popped = (await data.rpop(key)) as string | null;
      if (popped !== null) return [key, popped];
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
}

async function newStorage(pair: MockPair): Promise<RedisTaskStorage> {
  return RedisTaskStorage.create({
    commandClient: pair.command as unknown as import('ioredis').Redis,
    blockingClient: pair.blocking as unknown as import('ioredis').Redis,
  });
}

describe('RedisTaskStorage - conformance', () => {
  let pair: MockPair;
  runTaskStorageConformance({
    createStorage: async () => {
      pair = newMockPair();
      return newStorage(pair);
    },
    cleanup: async (storage) => {
      await (storage as RedisTaskStorage).disconnect();
      await pair.command.flushall();
      pair.command.disconnect();
      pair.blocking.disconnect();
    },
  });
});

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
let timestampCounter = 0;

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function nextTimestamp(): string {
  timestampCounter += 1;
  return new Date(EPOCH + timestampCounter * 1000).toISOString();
}

function makeTask(
  overrides: { id?: string; contextId?: string } = {}
): ManagedTask {
  const id = overrides.id ?? `task-${timestampCounter + 1}`;
  const contextId = overrides.contextId ?? 'ctx-1';
  return createTask({ id, contextId, now: fixedClock(nextTimestamp()) });
}

describe('RedisTaskStorage - Redis-specific behaviour', () => {
  let pair: MockPair;
  let storage: RedisTaskStorage;

  beforeEach(async () => {
    pair = newMockPair();
    storage = await newStorage(pair);
    timestampCounter = 0;
  });

  afterEach(async () => {
    await storage.disconnect();
    await pair.command.flushall();
    pair.command.disconnect();
    pair.blocking.disconnect();
  });

  it('throws when commandClient and blockingClient are the same instance', () => {
    const single = new RedisMock();
    expect(
      () =>
        new RedisTaskStorage({
          commandClient: single as unknown as import('ioredis').Redis,
          blockingClient: single as unknown as import('ioredis').Redis,
        })
    ).toThrow(TaskStorageError);
    single.disconnect();
  });

  it('writes enqueued tasks to the order list and items hash', async () => {
    storage.enqueue(makeTask({ id: 'persisted' }));
    // Allow the fire-and-forget multi() to flush.
    await new Promise((resolve) => setImmediate(resolve));

    const queued = await pair.command.lrange('a2a:queue:order', 0, -1);
    expect(queued).toEqual(['persisted']);
    const item = await pair.command.hget('a2a:queue:items', 'persisted');
    expect(item).not.toBeNull();
    const parsed = JSON.parse(item as string) as ManagedTask;
    expect(parsed.id).toBe('persisted');
  });

  it('persists active tasks to Redis under the active: prefix', async () => {
    storage.createActive(makeTask({ id: 'active-1', contextId: 'ctx-x' }));
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await pair.command.get('a2a:active:active-1');
    expect(stored).not.toBeNull();
    const members = await pair.command.smembers('a2a:context:ctx-x');
    expect(members).toEqual(['active-1']);
  });

  it('moves tasks to the dead-letter prefix on storeDeadLetter', async () => {
    const task = makeTask({ id: 'term', contextId: 'ctx-y' });
    storage.createActive(task);
    const completed = transitionTask(
      transitionTask(task, TASK_STATE.IN_PROGRESS, {
        now: fixedClock(nextTimestamp()),
      }),
      TASK_STATE.COMPLETED,
      { now: fixedClock(nextTimestamp()) }
    );
    storage.storeDeadLetter(completed);
    await new Promise((resolve) => setImmediate(resolve));

    expect(await pair.command.get('a2a:active:term')).toBeNull();
    const deadStored = await pair.command.get('a2a:deadletter:term');
    expect(deadStored).not.toBeNull();
  });

  it('hydrates state from Redis on connect', async () => {
    storage.createActive(makeTask({ id: 'preexisting', contextId: 'ctx-h' }));
    storage.setPushConfig('preexisting', {
      id: 'cfg-h',
      url: 'https://example.com',
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Build a second storage against the same backing Redis. The mock's
    // createConnectedClient gives us extra "connections" that share state.
    const command2 = pair.command.duplicate();
    const blocking2 = pair.command.duplicate();
    const hydrated = await RedisTaskStorage.create({
      commandClient: command2 as unknown as import('ioredis').Redis,
      blockingClient: blocking2 as unknown as import('ioredis').Redis,
    });

    try {
      expect(hydrated.getActive('preexisting')).toMatchObject({
        id: 'preexisting',
        contextId: 'ctx-h',
      });
      expect(hydrated.getContexts()).toContain('ctx-h');
      expect(hydrated.getPushConfig('preexisting', 'cfg-h')).toMatchObject({
        id: 'cfg-h',
        url: 'https://example.com',
      });
    } finally {
      await hydrated.disconnect();
      command2.disconnect();
      blocking2.disconnect();
    }
  });

  it('honours a custom keyPrefix', async () => {
    const isolatedPair = newMockPair();
    const prefixed = await RedisTaskStorage.create({
      commandClient: isolatedPair.command as unknown as import('ioredis').Redis,
      blockingClient:
        isolatedPair.blocking as unknown as import('ioredis').Redis,
      keyPrefix: 'tenant-a:',
    });

    try {
      prefixed.createActive(makeTask({ id: 'p', contextId: 'ctx-p' }));
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        await isolatedPair.command.get('tenant-a:active:p')
      ).not.toBeNull();
      expect(await isolatedPair.command.get('a2a:active:p')).toBeNull();
    } finally {
      await prefixed.disconnect();
      isolatedPair.command.disconnect();
      isolatedPair.blocking.disconnect();
    }
  });

  it('rejects pending dequeue after disconnect', async () => {
    const pending = storage.dequeue();
    await storage.disconnect();
    await expect(pending).rejects.toThrow(TaskStorageError);
  });

  it('rejects writes after disconnect', async () => {
    await storage.disconnect();
    expect(() => storage.enqueue(makeTask({ id: 'too-late' }))).toThrow(
      TaskStorageError
    );
  });
});

describe('redisConnectOptionsFromEnv', () => {
  it('prefers REDIS_URL when set', () => {
    expect(
      redisConnectOptionsFromEnv({ REDIS_URL: 'redis://localhost:6380/2' })
    ).toEqual({ url: 'redis://localhost:6380/2' });
  });

  it('falls back to host/port/password/db when URL is absent', () => {
    expect(
      redisConnectOptionsFromEnv({
        REDIS_HOST: 'cache.example.com',
        REDIS_PORT: '6380',
        REDIS_PASSWORD: 'shh',
        REDIS_DB: '3',
      })
    ).toEqual({
      options: {
        host: 'cache.example.com',
        port: 6380,
        password: 'shh',
        db: 3,
      },
    });
  });

  it('returns empty options when nothing is set', () => {
    expect(redisConnectOptionsFromEnv({})).toEqual({});
  });

  it('ignores non-numeric port and db values', () => {
    expect(
      redisConnectOptionsFromEnv({
        REDIS_HOST: 'h',
        REDIS_PORT: 'not-a-number',
        REDIS_DB: 'also-not',
      })
    ).toEqual({ options: { host: 'h' } });
  });
});
