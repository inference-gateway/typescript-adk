import type { Redis, RedisOptions } from 'ioredis';
import { isTerminal, type ManagedTask } from '../agent/task.js';
import type { PushNotificationConfig } from '../types/generated/a2a.js';
import { selectTasksForEviction } from './retention.js';
import {
  TaskStorageError,
  type StoredPushNotificationConfig,
  type TaskListFilter,
  type TaskRetentionPolicy,
  type TaskStorage,
  type TaskStorageStats,
} from './task-storage.js';

const DEFAULT_KEY_PREFIX = 'a2a:';

const QUEUE_LIST_SUFFIX = 'queue:order';
const QUEUE_ITEMS_SUFFIX = 'queue:items';
const ACTIVE_KEY_PREFIX = 'active:';
const DEAD_LETTER_KEY_PREFIX = 'deadletter:';
const CONTEXT_KEY_PREFIX = 'context:';
const PUSH_CONFIG_KEY_PREFIX = 'push:';

const BRPOP_TIMEOUT_SECONDS = 1;
const SCAN_BATCH = 200;

interface QueueEntry {
  readonly id: string;
  readonly task: ManagedTask;
}

interface DequeueWaiter {
  resolve(task: ManagedTask): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

/**
 * Construction-time configuration for {@link RedisTaskStorage}.
 *
 * Callers are responsible for creating the underlying `ioredis` clients; the
 * storage takes ownership only for the duration of its lifetime and exposes a
 * {@link RedisTaskStorage.disconnect} method that quits both clients. Two
 * clients are required because the blocking `BRPOP` loop monopolises its
 * connection - issuing any other command on the same client while a `BRPOP`
 * is in flight queues that command behind the block.
 *
 * @example
 * ```ts
 * import { Redis } from 'ioredis';
 * import { RedisTaskStorage } from '@inference-gateway/adk';
 *
 * const commandClient = new Redis(process.env.REDIS_URL!);
 * const blockingClient = new Redis(process.env.REDIS_URL!);
 * const storage = await RedisTaskStorage.create({ commandClient, blockingClient });
 * ```
 */
export interface RedisTaskStorageOptions {
  /**
   * The client used for all non-blocking commands (read/write of hashes,
   * sets, strings; pipeline transactions).
   */
  readonly commandClient: Redis;

  /**
   * A dedicated client used exclusively for the blocking `BRPOP` loop that
   * powers {@link RedisTaskStorage.dequeue}. Must be a separate `ioredis`
   * instance from `commandClient`.
   */
  readonly blockingClient: Redis;

  /**
   * Optional prefix applied to every Redis key. Defaults to `"a2a:"` to
   * match the Go ADK; override when running multiple ADK deployments
   * against a shared Redis instance.
   */
  readonly keyPrefix?: string;

  /**
   * Optional callback invoked when the background `BRPOP` loop encounters
   * an unrecoverable error (the loop reschedules on the next `dequeue`).
   * Default is a no-op; pass a logger sink if you want visibility.
   */
  readonly onError?: (error: Error) => void;
}

/**
 * Convenience options for {@link RedisTaskStorage.connect}. Either provide
 * a `url` (parsed by ioredis), an `options` object handed to `new Redis(...)`,
 * or both - `url` takes precedence and `options` augments the parsed config.
 */
export interface RedisConnectOptions {
  /** Redis connection URL (e.g. `redis://localhost:6379/0`). */
  readonly url?: string;

  /** ioredis options applied on top of the URL (or used standalone). */
  readonly options?: RedisOptions;

  /** Optional key prefix; defaults to `"a2a:"`. */
  readonly keyPrefix?: string;

  /** Optional background-error callback; defaults to a no-op. */
  readonly onError?: (error: Error) => void;
}

/**
 * Read connection settings from the environment. Recognises:
 * `REDIS_URL` (full URL) and falls back to `REDIS_HOST` / `REDIS_PORT` /
 * `REDIS_PASSWORD` / `REDIS_DB`. Returns `undefined` for fields that aren't set
 * so {@link RedisTaskStorage.connect} can pass them through to ioredis defaults.
 */
export function redisConnectOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RedisConnectOptions {
  const url = env['REDIS_URL'];
  if (url !== undefined && url.length > 0) {
    return { url };
  }

  const host = env['REDIS_HOST'];
  const portRaw = env['REDIS_PORT'];
  const password = env['REDIS_PASSWORD'];
  const dbRaw = env['REDIS_DB'];

  const options: RedisOptions = {};
  if (host !== undefined && host.length > 0) options.host = host;
  if (portRaw !== undefined && portRaw.length > 0) {
    const port = Number(portRaw);
    if (Number.isFinite(port)) options.port = port;
  }
  if (password !== undefined && password.length > 0)
    options.password = password;
  if (dbRaw !== undefined && dbRaw.length > 0) {
    const db = Number(dbRaw);
    if (Number.isFinite(db)) options.db = db;
  }

  return Object.keys(options).length > 0 ? { options } : {};
}

/**
 * Redis-backed {@link TaskStorage}.
 *
 * ## Layout
 *
 * Keys live under `keyPrefix` (default `"a2a:"`):
 *
 * - `queue:order` - Redis list of task IDs (LPUSH on enqueue, BRPOP on dequeue).
 * - `queue:items` - Redis hash `taskId -> JSON(task)` for queued payloads.
 * - `active:<taskId>` - Redis string with the active task JSON.
 * - `deadletter:<taskId>` - Redis string with the terminal task JSON.
 * - `context:<contextId>` - Redis set of task IDs in that context.
 * - `push:<taskId>` - Redis hash `configId -> JSON(config)` for push notifications.
 *
 * ## Sync interface tension
 *
 * {@link TaskStorage} is intentionally synchronous (only `dequeue` returns a
 * promise), but Redis I/O is asynchronous. To honour the contract this backend
 * keeps a **write-through in-memory mirror**:
 *
 * - Sync reads (`getTask`, `listTasks`, `getStats`, ...) hit local memory.
 * - Sync writes update memory immediately and fire-and-forget the matching
 *   Redis transaction. Background failures are surfaced via `onError`.
 * - The blocking `BRPOP` loop is the only operation that always crosses the
 *   wire, so the shared queue is the one part of state that is **strongly**
 *   cross-instance consistent.
 *
 * For a single-instance deployment this is functionally indistinguishable
 * from {@link import('./in-memory.js').InMemoryTaskStorage} with the bonus
 * of persistence across restarts (via {@link create} hydration).
 *
 * For multi-instance deployments the queue is shared, but the other in-memory
 * mirrors are eventually consistent - each instance learns about another's
 * state changes the next time it hydrates or via cross-instance pub/sub (not
 * yet implemented; see [issue #40](https://github.com/inference-gateway/typescript-adk/issues/40)).
 *
 * ## Requires Redis 6+
 *
 * The implementation uses only standard commands (HSET, LPUSH, BRPOP, SADD,
 * LREM, SCAN, etc.) supported back to Redis 5.0, but Redis 6+ is recommended
 * for ACLs and resharding stability.
 */
export class RedisTaskStorage implements TaskStorage {
  private readonly commandClient: Redis;
  private readonly blockingClient: Redis;
  private readonly keyPrefix: string;
  private readonly onError: (error: Error) => void;

  private readonly activeTasks = new Map<string, ManagedTask>();
  private readonly deadLetterTasks = new Map<string, ManagedTask>();
  private readonly contextIndex = new Map<string, Set<string>>();
  private readonly queue: QueueEntry[] = [];
  private readonly waiters: DequeueWaiter[] = [];
  private readonly intake: ManagedTask[] = [];
  private readonly pushConfigs = new Map<
    string,
    Map<string, StoredPushNotificationConfig>
  >();

  private brpopActive = false;
  private closed = false;

  constructor(options: RedisTaskStorageOptions) {
    if (options.commandClient === options.blockingClient) {
      throw new TaskStorageError(
        'commandClient and blockingClient must be distinct ioredis instances'
      );
    }
    this.commandClient = options.commandClient;
    this.blockingClient = options.blockingClient;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.onError = options.onError ?? noop;
  }

  /**
   * Async factory: connect to Redis, hydrate the in-memory mirror from any
   * pre-existing keys under `keyPrefix`, and return a ready-to-use instance.
   *
   * Performs a `PING` against the command client; throws if the server is
   * unreachable. Creates the underlying ioredis clients if they aren't
   * supplied, in which case the storage owns and will `quit()` them on
   * {@link disconnect}.
   *
   * @example
   * ```ts
   * const storage = await RedisTaskStorage.connect({
   *   url: process.env.REDIS_URL,
   *   keyPrefix: 'svc-a:',
   * });
   * ```
   */
  static async connect(
    options: RedisConnectOptions = {}
  ): Promise<RedisTaskStorage> {
    const { Redis: RedisCtor } = await import('ioredis');
    const commandClient = createClient(RedisCtor, options);
    const blockingClient = createClient(RedisCtor, options);

    try {
      await commandClient.ping();
    } catch (error) {
      await Promise.allSettled([commandClient.quit(), blockingClient.quit()]);
      throw new TaskStorageError(
        `failed to connect to Redis: ${(error as Error).message}`
      );
    }

    const storageOptions: RedisTaskStorageOptions = {
      commandClient,
      blockingClient,
      ...(options.keyPrefix !== undefined
        ? { keyPrefix: options.keyPrefix }
        : {}),
      ...(options.onError !== undefined ? { onError: options.onError } : {}),
    };
    const storage = new RedisTaskStorage(storageOptions);
    await storage.hydrate();
    return storage;
  }

  /**
   * Build a storage instance around already-connected ioredis clients and
   * hydrate its in-memory mirror from Redis. Use this when you want to share
   * an ioredis client (e.g. with pub/sub elsewhere in your process) or use a
   * mock client for tests; otherwise prefer {@link connect}.
   */
  static async create(
    options: RedisTaskStorageOptions
  ): Promise<RedisTaskStorage> {
    const storage = new RedisTaskStorage(options);
    await storage.hydrate();
    return storage;
  }

  /**
   * Stop the BRPOP loop, mark the storage as closed, and quit both Redis
   * clients. Pending {@link dequeue} promises reject. Idempotent.
   */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter.cleanup();
        waiter.reject(new TaskStorageError('storage disconnected'));
      }
    }

    await Promise.allSettled([
      this.commandClient.quit().catch(() => undefined),
      this.blockingClient.quit().catch(() => undefined),
    ]);
  }

  enqueue(task: ManagedTask): void {
    this.assertOpen();
    const serialized = serializeTask(task);

    this.activeTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);

    const multi = this.commandClient.multi();
    multi.sadd(this.contextKey(task.contextId), task.id);
    multi.set(this.activeKey(task.id), serialized);

    // If a local waiter is already parked, hand the task to it directly and
    // skip the Redis queue entirely - this preserves the in-memory storage's
    // semantics that `queueLength()` stays at 0 when waiters are present, and
    // avoids a Redis round-trip for the common single-instance fast path.
    // Cross-instance distribution is unaffected: a new dequeue call would
    // restart the BRPOP loop and pick up tasks pushed by other instances.
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.cleanup();
      waiter.resolve(task);
      this.execAsync(multi.exec(), 'enqueue');
      return;
    }

    this.queue.push({ id: task.id, task });
    multi.hset(this.itemsKey(), task.id, serialized);
    multi.lpush(this.orderKey(), task.id);
    this.execAsync(multi.exec(), 'enqueue');
  }

  dequeue(signal?: AbortSignal): Promise<ManagedTask> {
    if (signal?.aborted === true) {
      return Promise.reject(abortReason(signal));
    }
    if (this.closed) {
      return Promise.reject(new TaskStorageError('storage disconnected'));
    }

    const head = this.intake.shift();
    if (head !== undefined) {
      return Promise.resolve(head);
    }

    return new Promise<ManagedTask>((resolve, reject) => {
      const waiter: DequeueWaiter = {
        resolve,
        reject,
        cleanup: () => {},
      };
      this.waiters.push(waiter);
      this.startDequeueLoop();

      if (signal === undefined) {
        return;
      }
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
    });
  }

  queueLength(): number {
    return this.queue.length;
  }

  removeFromQueue(taskId: string): boolean {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (entry !== undefined && entry.id === taskId) {
        this.queue.splice(i, 1);
        const multi = this.commandClient.multi();
        multi.lrem(this.orderKey(), 0, taskId);
        multi.hdel(this.itemsKey(), taskId);
        this.execAsync(multi.exec(), 'removeFromQueue');
        return true;
      }
    }
    return false;
  }

  createActive(task: ManagedTask): void {
    this.assertOpen();
    if (this.activeTasks.has(task.id)) {
      throw new TaskStorageError(`active task already exists: ${task.id}`);
    }
    this.activeTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);

    const multi = this.commandClient.multi();
    multi.set(this.activeKey(task.id), serializeTask(task));
    multi.sadd(this.contextKey(task.contextId), task.id);
    this.execAsync(multi.exec(), 'createActive');
  }

  getActive(taskId: string): ManagedTask | undefined {
    return this.activeTasks.get(taskId);
  }

  updateActive(task: ManagedTask): void {
    this.assertOpen();
    if (!this.activeTasks.has(task.id)) {
      throw new TaskStorageError(`active task not found: ${task.id}`);
    }
    this.activeTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);

    const multi = this.commandClient.multi();
    multi.set(this.activeKey(task.id), serializeTask(task));
    multi.sadd(this.contextKey(task.contextId), task.id);
    this.execAsync(multi.exec(), 'updateActive');
  }

  storeDeadLetter(task: ManagedTask): void {
    this.assertOpen();
    this.deadLetterTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);
    this.activeTasks.delete(task.id);

    const multi = this.commandClient.multi();
    multi.set(this.deadLetterKey(task.id), serializeTask(task));
    multi.sadd(this.contextKey(task.contextId), task.id);
    multi.del(this.activeKey(task.id));
    this.execAsync(multi.exec(), 'storeDeadLetter');
  }

  getTask(taskId: string): ManagedTask | undefined {
    return this.activeTasks.get(taskId) ?? this.deadLetterTasks.get(taskId);
  }

  listTasks(filter: TaskListFilter = {}): ManagedTask[] {
    const seen = new Set<string>();
    const collected: ManagedTask[] = [];

    const consider = (task: ManagedTask): void => {
      if (seen.has(task.id)) return;
      if (filter.state !== undefined && task.state !== filter.state) return;
      if (
        filter.contextId !== undefined &&
        task.contextId !== filter.contextId
      ) {
        return;
      }
      seen.add(task.id);
      collected.push(task);
    };

    for (const task of this.activeTasks.values()) consider(task);
    for (const task of this.deadLetterTasks.values()) consider(task);

    collected.sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }
      return a.createdAt < b.createdAt ? -1 : 1;
    });

    const offset = filter.offset !== undefined ? Math.max(0, filter.offset) : 0;
    if (offset >= collected.length) return [];
    const end =
      filter.limit !== undefined && filter.limit >= 0
        ? Math.min(collected.length, offset + filter.limit)
        : collected.length;
    return collected.slice(offset, end);
  }

  getContexts(): string[] {
    return [...this.contextIndex.keys()];
  }

  deleteContext(contextId: string): number {
    const taskIds = this.contextIndex.get(contextId);
    if (taskIds === undefined) return 0;

    let removed = 0;
    const multi = this.commandClient.multi();
    for (const id of taskIds) {
      if (this.activeTasks.delete(id)) removed++;
      if (this.deadLetterTasks.delete(id)) removed++;
      this.pushConfigs.delete(id);
      multi.del(this.activeKey(id));
      multi.del(this.deadLetterKey(id));
      multi.del(this.pushKey(id));
      multi.hdel(this.itemsKey(), id);
      multi.lrem(this.orderKey(), 0, id);
    }
    multi.del(this.contextKey(contextId));
    this.execAsync(multi.exec(), 'deleteContext');

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (entry !== undefined && entry.task.contextId === contextId) {
        this.queue.splice(i, 1);
      }
    }

    this.contextIndex.delete(contextId);
    return removed;
  }

  cleanupCompleted(): number {
    let removed = 0;
    const multi = this.commandClient.multi();
    for (const [id, task] of this.deadLetterTasks) {
      if (isTerminal(task.state)) {
        this.deadLetterTasks.delete(id);
        this.unindexContext(task.contextId, id, multi);
        multi.del(this.deadLetterKey(id));
        removed++;
      }
    }
    this.execAsync(multi.exec(), 'cleanupCompleted');
    return removed;
  }

  cleanupTasksWithRetention(policy: TaskRetentionPolicy): number {
    const evict = selectTasksForEviction(this.deadLetterTasks.values(), policy);
    if (evict.length === 0) return 0;
    const multi = this.commandClient.multi();
    for (const task of evict) {
      this.deadLetterTasks.delete(task.id);
      this.unindexContext(task.contextId, task.id, multi);
      multi.del(this.deadLetterKey(task.id));
    }
    this.execAsync(multi.exec(), 'cleanupTasksWithRetention');
    return evict.length;
  }

  getStats(): TaskStorageStats {
    const tasksByState: Record<string, number> = {};
    for (const task of this.activeTasks.values()) {
      tasksByState[task.state] = (tasksByState[task.state] ?? 0) + 1;
    }
    for (const task of this.deadLetterTasks.values()) {
      tasksByState[task.state] = (tasksByState[task.state] ?? 0) + 1;
    }

    const totalTasks = this.activeTasks.size + this.deadLetterTasks.size;
    const totalContexts = this.contextIndex.size;
    const averageTasksPerContext =
      totalContexts > 0 ? totalTasks / totalContexts : 0;

    return {
      totalTasks,
      tasksByState,
      totalContexts,
      contextsWithTasks: totalContexts,
      averageTasksPerContext,
      queueLength: this.queue.length,
    };
  }

  setPushConfig(
    taskId: string,
    config: PushNotificationConfig
  ): StoredPushNotificationConfig {
    let bucket = this.pushConfigs.get(taskId);
    if (bucket === undefined) {
      bucket = new Map();
      this.pushConfigs.set(taskId, bucket);
    }
    const id =
      typeof config.id === 'string' && config.id.length > 0
        ? config.id
        : crypto.randomUUID();
    const stored: StoredPushNotificationConfig = { ...config, id };
    bucket.set(id, stored);

    this.execAsync(
      this.commandClient.hset(this.pushKey(taskId), id, JSON.stringify(stored)),
      'setPushConfig'
    );
    return stored;
  }

  getPushConfig(
    taskId: string,
    configId: string
  ): StoredPushNotificationConfig | undefined {
    return this.pushConfigs.get(taskId)?.get(configId);
  }

  listPushConfigs(taskId: string): StoredPushNotificationConfig[] {
    const bucket = this.pushConfigs.get(taskId);
    if (bucket === undefined) return [];
    return [...bucket.values()];
  }

  deletePushConfig(taskId: string, configId: string): boolean {
    const bucket = this.pushConfigs.get(taskId);
    if (bucket === undefined) return false;
    const removed = bucket.delete(configId);
    if (removed && bucket.size === 0) {
      this.pushConfigs.delete(taskId);
    }
    if (removed) {
      this.execAsync(
        this.commandClient.hdel(this.pushKey(taskId), configId),
        'deletePushConfig'
      );
    }
    return removed;
  }

  private async hydrate(): Promise<void> {
    const activeKeys = await this.scanPattern(
      `${this.keyPrefix}${ACTIVE_KEY_PREFIX}*`
    );
    for (const key of activeKeys) {
      const raw = await this.commandClient.get(key);
      if (raw === null) continue;
      const task = deserializeTask(raw);
      this.activeTasks.set(task.id, task);
      this.indexContext(task.contextId, task.id);
    }

    const deadKeys = await this.scanPattern(
      `${this.keyPrefix}${DEAD_LETTER_KEY_PREFIX}*`
    );
    for (const key of deadKeys) {
      const raw = await this.commandClient.get(key);
      if (raw === null) continue;
      const task = deserializeTask(raw);
      this.deadLetterTasks.set(task.id, task);
      this.indexContext(task.contextId, task.id);
    }

    const pushKeys = await this.scanPattern(
      `${this.keyPrefix}${PUSH_CONFIG_KEY_PREFIX}*`
    );
    for (const key of pushKeys) {
      const taskId = key.slice(
        this.keyPrefix.length + PUSH_CONFIG_KEY_PREFIX.length
      );
      const entries = await this.commandClient.hgetall(key);
      const bucket = new Map<string, StoredPushNotificationConfig>();
      for (const [configId, raw] of Object.entries(entries)) {
        bucket.set(configId, JSON.parse(raw) as StoredPushNotificationConfig);
      }
      if (bucket.size > 0) this.pushConfigs.set(taskId, bucket);
    }

    const queuedIds = await this.commandClient.lrange(this.orderKey(), 0, -1);
    if (queuedIds.length > 0) {
      const items = await this.commandClient.hmget(
        this.itemsKey(),
        ...queuedIds
      );
      // Redis lists are right-end-popped (BRPOP), so the FIFO head is at the
      // tail. We push entries in reverse to preserve dequeue order.
      for (let i = items.length - 1; i >= 0; i--) {
        const raw = items[i];
        const id = queuedIds[i];
        if (typeof raw !== 'string' || id === undefined) continue;
        const task = deserializeTask(raw);
        this.queue.push({ id, task });
      }
    }
  }

  private startDequeueLoop(): void {
    if (this.brpopActive || this.closed) return;
    if (this.waiters.length === 0) return;
    this.brpopActive = true;
    void this.runDequeueLoop();
  }

  private async runDequeueLoop(): Promise<void> {
    try {
      while (!this.closed && this.waiters.length > 0) {
        const result = await this.blockingClient.brpop(
          this.orderKey(),
          BRPOP_TIMEOUT_SECONDS
        );
        if (this.closed) break;
        if (result === null) continue;

        const [, taskId] = result;
        const serialized = await this.commandClient.hget(
          this.itemsKey(),
          taskId
        );
        if (serialized === null) {
          // Items hash missed (race with deleteContext or external mutation).
          continue;
        }
        await this.commandClient.hdel(this.itemsKey(), taskId);

        const task = deserializeTask(serialized);
        this.dropFromLocalQueue(taskId);

        const waiter = this.waiters.shift();
        if (waiter !== undefined) {
          waiter.cleanup();
          waiter.resolve(task);
          continue;
        }

        // All waiters aborted while BRPOP was in flight. Return the task to
        // Redis so the next dequeue (here or on another instance) can pick
        // it up, and exit the loop until a new waiter triggers us again.
        const restore = this.commandClient.multi();
        restore.hset(this.itemsKey(), taskId, serialized);
        restore.lpush(this.orderKey(), taskId);
        await restore.exec();
        break;
      }
    } catch (error) {
      if (!this.closed) {
        this.onError(error as Error);
      }
    } finally {
      this.brpopActive = false;
      if (!this.closed && this.waiters.length > 0) {
        this.startDequeueLoop();
      }
    }
  }

  private dropFromLocalQueue(taskId: string): void {
    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (entry !== undefined && entry.id === taskId) {
        this.queue.splice(i, 1);
        return;
      }
    }
  }

  private async scanPattern(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.commandClient.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        SCAN_BATCH
      );
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }

  private indexContext(contextId: string, taskId: string): void {
    let set = this.contextIndex.get(contextId);
    if (set === undefined) {
      set = new Set();
      this.contextIndex.set(contextId, set);
    }
    set.add(taskId);
  }

  private unindexContext(
    contextId: string,
    taskId: string,
    multi: ReturnType<Redis['multi']>
  ): void {
    const set = this.contextIndex.get(contextId);
    if (set === undefined) return;
    set.delete(taskId);
    multi.srem(this.contextKey(contextId), taskId);
    if (set.size === 0) {
      this.contextIndex.delete(contextId);
      multi.del(this.contextKey(contextId));
    }
  }

  private execAsync(promise: Promise<unknown>, op: string): void {
    promise.catch((error: unknown) => {
      this.onError(
        new TaskStorageError(`Redis ${op} failed: ${(error as Error).message}`)
      );
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new TaskStorageError('storage is closed');
    }
  }

  private orderKey(): string {
    return `${this.keyPrefix}${QUEUE_LIST_SUFFIX}`;
  }
  private itemsKey(): string {
    return `${this.keyPrefix}${QUEUE_ITEMS_SUFFIX}`;
  }
  private activeKey(taskId: string): string {
    return `${this.keyPrefix}${ACTIVE_KEY_PREFIX}${taskId}`;
  }
  private deadLetterKey(taskId: string): string {
    return `${this.keyPrefix}${DEAD_LETTER_KEY_PREFIX}${taskId}`;
  }
  private contextKey(contextId: string): string {
    return `${this.keyPrefix}${CONTEXT_KEY_PREFIX}${contextId}`;
  }
  private pushKey(taskId: string): string {
    return `${this.keyPrefix}${PUSH_CONFIG_KEY_PREFIX}${taskId}`;
  }
}

function serializeTask(task: ManagedTask): string {
  return JSON.stringify(task);
}

function deserializeTask(raw: string): ManagedTask {
  return JSON.parse(raw) as ManagedTask;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function noop(): void {}

type RedisCtor = new (...args: unknown[]) => Redis;

function createClient(
  RedisCtor: RedisCtor,
  options: RedisConnectOptions
): Redis {
  if (options.url !== undefined) {
    if (options.options !== undefined) {
      return new RedisCtor(options.url, options.options);
    }
    return new RedisCtor(options.url);
  }
  if (options.options !== undefined) {
    return new RedisCtor(options.options);
  }
  return new RedisCtor();
}
