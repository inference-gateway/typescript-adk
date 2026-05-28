import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
  type ManagedTaskState,
} from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';

/**
 * Options accepted by {@link runTaskStorageConformance}.
 *
 * The contract is intentionally minimal:
 *  - `createStorage` is called before every test, so each test gets a clean
 *    storage with no shared state. The factory may be async to allow backends
 *    that need to open a connection (Redis, Postgres) before being usable.
 *  - `cleanup` is called after every test, so backends that hold external
 *    resources (a Redis client, a Postgres pool) can release them. It is also
 *    a good place to flush an underlying database if the backend reuses one
 *    across tests.
 */
export interface TaskStorageConformanceOptions {
  /**
   * Produce a fresh, empty {@link TaskStorage} for the next test. Called from
   * `beforeEach`, so any setup needed to reach a clean state (connecting,
   * flushing, dropping keys) belongs here.
   */
  readonly createStorage: () => TaskStorage | Promise<TaskStorage>;

  /**
   * Optional teardown for the storage instance returned by the most recent
   * `createStorage` call. Called from `afterEach`. Use this to close
   * connections or release any other test-scoped resources.
   */
  readonly cleanup?: (storage: TaskStorage) => void | Promise<void>;
}

/**
 * Drive any {@link TaskStorage} implementation through the full behavioural
 * contract. Call this from inside a `describe` block (or at the top level of
 * a test file) - it registers nested `describe` blocks per concern (queue,
 * active lifecycle, listTasks, contexts, cleanup, removeFromQueue, getStats,
 * push notification configs) and uses the provided factory to obtain a fresh
 * storage instance per test.
 *
 * Assertions use structural equality (`toMatchObject` / field comparisons)
 * rather than reference equality, so backends that serialise across a network
 * boundary (Redis, Postgres) pass without modification.
 *
 * @example
 * ```ts
 * import { describe } from 'vitest';
 * import { InMemoryTaskStorage } from '@inference-gateway/adk';
 * import { runTaskStorageConformance } from '@inference-gateway/adk/testing';
 *
 * describe('InMemoryTaskStorage - conformance', () => {
 *   runTaskStorageConformance({
 *     createStorage: () => new InMemoryTaskStorage(),
 *   });
 * });
 * ```
 */
export function runTaskStorageConformance(
  options: TaskStorageConformanceOptions
): void {
  const ctx: Context = {
    storage: undefined as unknown as TaskStorage,
    counter: 0,
  };

  beforeEach(async () => {
    ctx.storage = await options.createStorage();
    ctx.counter = 0;
  });

  afterEach(async () => {
    if (options.cleanup !== undefined) {
      await options.cleanup(ctx.storage);
    }
  });

  registerQueueTests(ctx);
  registerActiveLifecycleTests(ctx);
  registerListTasksTests(ctx);
  registerContextTests(ctx);
  registerCleanupCompletedTests(ctx);
  registerRetentionTests(ctx);
  registerRemoveFromQueueTests(ctx);
  registerGetStatsTests(ctx);
  registerPushConfigTests(ctx);
}

interface Context {
  storage: TaskStorage;
  counter: number;
}

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

function nextIso(ctx: Context): string {
  ctx.counter += 1;
  return new Date(EPOCH + ctx.counter * 1000).toISOString();
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function makeTask(
  ctx: Context,
  overrides: { id?: string; contextId?: string } = {}
): ManagedTask {
  const id = overrides.id ?? `task-${ctx.counter + 1}`;
  const contextId = overrides.contextId ?? 'ctx-1';
  return createTask({
    id,
    contextId,
    now: fixedClock(nextIso(ctx)),
  });
}

function inProgress(ctx: Context, task: ManagedTask): ManagedTask {
  return transitionTask(task, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(nextIso(ctx)),
  });
}

function complete(ctx: Context, task: ManagedTask): ManagedTask {
  const working =
    task.state === TASK_STATE.IN_PROGRESS ? task : inProgress(ctx, task);
  return transitionTask(working, TASK_STATE.COMPLETED, {
    now: fixedClock(nextIso(ctx)),
  });
}

function fail(ctx: Context, task: ManagedTask): ManagedTask {
  const working =
    task.state === TASK_STATE.IN_PROGRESS ? task : inProgress(ctx, task);
  return transitionTask(working, TASK_STATE.FAILED, {
    now: fixedClock(nextIso(ctx)),
  });
}

function cancel(ctx: Context, task: ManagedTask): ManagedTask {
  return transitionTask(task, TASK_STATE.CANCELLED, {
    now: fixedClock(nextIso(ctx)),
  });
}

function registerQueueTests(ctx: Context): void {
  describe('queue', () => {
    it('queueLength reflects enqueued tasks', () => {
      expect(ctx.storage.queueLength()).toBe(0);
      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'b' }));
      expect(ctx.storage.queueLength()).toBe(2);
    });

    it('enqueue + dequeue preserves FIFO order', async () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'b' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'c' }));

      expect((await ctx.storage.dequeue()).id).toBe('a');
      expect((await ctx.storage.dequeue()).id).toBe('b');
      expect((await ctx.storage.dequeue()).id).toBe('c');
      expect(ctx.storage.queueLength()).toBe(0);
    });

    it('dequeue resolves when a task is enqueued later', async () => {
      const pending = ctx.storage.dequeue();
      ctx.storage.enqueue(makeTask(ctx, { id: 'late' }));
      await expect(pending).resolves.toMatchObject({ id: 'late' });
    });

    it('hands off to the oldest waiter in arrival order', async () => {
      const order: string[] = [];
      const w1 = ctx.storage.dequeue().then((t) => order.push(`w1:${t.id}`));
      const w2 = ctx.storage.dequeue().then((t) => order.push(`w2:${t.id}`));
      const w3 = ctx.storage.dequeue().then((t) => order.push(`w3:${t.id}`));

      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'b' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'c' }));

      await Promise.all([w1, w2, w3]);
      expect(order).toEqual(['w1:a', 'w2:b', 'w3:c']);
    });

    it('skips the queue when a waiter is already parked', async () => {
      const pending = ctx.storage.dequeue();
      ctx.storage.enqueue(makeTask(ctx, { id: 'direct' }));

      expect(ctx.storage.queueLength()).toBe(0);
      await expect(pending).resolves.toMatchObject({ id: 'direct' });
    });

    it('rejects pending dequeue when AbortSignal fires', async () => {
      const controller = new AbortController();
      const pending = ctx.storage.dequeue(controller.signal);
      controller.abort(new Error('shutdown'));
      await expect(pending).rejects.toThrow('shutdown');
    });

    it('rejects immediately when AbortSignal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('already-stopped'));
      await expect(ctx.storage.dequeue(controller.signal)).rejects.toThrow(
        'already-stopped'
      );
    });

    it('aborted waiter does not consume the next enqueued task', async () => {
      const controller = new AbortController();
      const aborted = ctx.storage.dequeue(controller.signal);
      controller.abort(new Error('gone'));
      await expect(aborted).rejects.toThrow('gone');

      ctx.storage.enqueue(makeTask(ctx, { id: 'survivor' }));
      await expect(ctx.storage.dequeue()).resolves.toMatchObject({
        id: 'survivor',
      });
    });

    it('enqueued task is also registered as active', () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'tracked' }));
      expect(ctx.storage.getActive('tracked')).toMatchObject({ id: 'tracked' });
    });
  });
}

function registerActiveLifecycleTests(ctx: Context): void {
  describe('active lifecycle', () => {
    it('createActive registers a task that was not enqueued', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'created' }));
      expect(ctx.storage.getActive('created')).toMatchObject({ id: 'created' });
      expect(ctx.storage.queueLength()).toBe(0);
    });

    it('createActive throws on duplicate id', () => {
      const task = makeTask(ctx, { id: 'dup' });
      ctx.storage.createActive(task);
      expect(() => ctx.storage.createActive(task)).toThrow();
    });

    it('updateActive replaces the stored task state', () => {
      const task = makeTask(ctx, { id: 'upd' });
      ctx.storage.createActive(task);
      const next = inProgress(ctx, task);
      ctx.storage.updateActive(next);
      expect(ctx.storage.getActive('upd')?.state).toBe(TASK_STATE.IN_PROGRESS);
    });

    it('updateActive throws when no active task exists', () => {
      const task = makeTask(ctx, { id: 'missing' });
      expect(() => ctx.storage.updateActive(task)).toThrow();
    });

    it('storeDeadLetter moves a task out of active', () => {
      const task = makeTask(ctx, { id: 'done' });
      ctx.storage.createActive(task);
      ctx.storage.storeDeadLetter(complete(ctx, task));
      expect(ctx.storage.getActive('done')).toBeUndefined();
      expect(ctx.storage.getTask('done')).toMatchObject({
        id: 'done',
        state: TASK_STATE.COMPLETED,
      });
    });

    it('getTask spans active and dead-letter stores', () => {
      const a = makeTask(ctx, { id: 'a' });
      ctx.storage.createActive(a);
      const b = makeTask(ctx, { id: 'b' });
      ctx.storage.storeDeadLetter(complete(ctx, b));
      expect(ctx.storage.getTask('a')).toMatchObject({ id: 'a' });
      expect(ctx.storage.getTask('b')).toMatchObject({ id: 'b' });
      expect(ctx.storage.getTask('missing')).toBeUndefined();
    });
  });
}

function registerListTasksTests(ctx: Context): void {
  describe('listTasks', () => {
    it('lists tasks in createdAt order, not insertion order', () => {
      const first = makeTask(ctx, { id: 'first' });
      const second = makeTask(ctx, { id: 'second' });
      const third = makeTask(ctx, { id: 'third' });

      // Insert out of chronological order.
      ctx.storage.createActive(second);
      ctx.storage.createActive(first);
      ctx.storage.createActive(third);

      const ids = ctx.storage.listTasks().map((t) => t.id);
      expect(ids).toEqual(['first', 'second', 'third']);
    });

    it('filters by state across active and dead-letter stores', () => {
      const a1 = makeTask(ctx, { id: 'active-1' });
      const a2 = makeTask(ctx, { id: 'active-2' });
      const d1 = complete(ctx, makeTask(ctx, { id: 'done-1' }));

      ctx.storage.createActive(a1);
      ctx.storage.createActive(inProgress(ctx, a2));
      ctx.storage.storeDeadLetter(d1);

      expect(
        ctx.storage.listTasks({ state: TASK_STATE.COMPLETED }).map((t) => t.id)
      ).toEqual(['done-1']);
      expect(
        ctx.storage
          .listTasks({ state: TASK_STATE.IN_PROGRESS })
          .map((t) => t.id)
      ).toEqual(['active-2']);
    });

    it('filters by contextId', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'a', contextId: 'ctx-A' }));
      ctx.storage.createActive(makeTask(ctx, { id: 'b', contextId: 'ctx-B' }));
      ctx.storage.createActive(makeTask(ctx, { id: 'c', contextId: 'ctx-A' }));

      const ids = ctx.storage
        .listTasks({ contextId: 'ctx-A' })
        .map((t) => t.id);
      expect(ids).toEqual(['a', 'c']);
    });

    it('combines state and contextId filters', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'a', contextId: 'x' }));
      ctx.storage.createActive(
        inProgress(ctx, makeTask(ctx, { id: 'b', contextId: 'x' }))
      );
      ctx.storage.createActive(
        inProgress(ctx, makeTask(ctx, { id: 'c', contextId: 'y' }))
      );

      const ids = ctx.storage
        .listTasks({ contextId: 'x', state: TASK_STATE.IN_PROGRESS })
        .map((t) => t.id);
      expect(ids).toEqual(['b']);
    });

    it('paginates with offset + limit', () => {
      const ids = ['t-01', 't-02', 't-03', 't-04', 't-05', 't-06'];
      for (const id of ids) {
        ctx.storage.createActive(makeTask(ctx, { id }));
      }

      expect(
        ctx.storage.listTasks({ offset: 0, limit: 2 }).map((t) => t.id)
      ).toEqual(['t-01', 't-02']);
      expect(
        ctx.storage.listTasks({ offset: 2, limit: 2 }).map((t) => t.id)
      ).toEqual(['t-03', 't-04']);
      expect(
        ctx.storage.listTasks({ offset: 4, limit: 2 }).map((t) => t.id)
      ).toEqual(['t-05', 't-06']);
      expect(
        ctx.storage.listTasks({ offset: 6, limit: 2 }).map((t) => t.id)
      ).toEqual([]);
    });

    it('omitting limit returns every match after offset', () => {
      for (let i = 0; i < 5; i++) {
        ctx.storage.createActive(makeTask(ctx, { id: `t-${i}` }));
      }
      expect(ctx.storage.listTasks({ offset: 2 }).map((t) => t.id)).toEqual([
        't-2',
        't-3',
        't-4',
      ]);
    });

    it('returns empty array for out-of-range offset', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'only' }));
      expect(ctx.storage.listTasks({ offset: 99 })).toEqual([]);
    });

    it('returns empty array when no filter matches', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'a' }));
      const noMatch: ManagedTaskState = TASK_STATE.CANCELLED;
      expect(ctx.storage.listTasks({ state: noMatch })).toEqual([]);
    });
  });
}

function registerContextTests(ctx: Context): void {
  describe('contexts', () => {
    it('getContexts spans active, queued, and dead-letter tasks', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'a', contextId: 'ctx-A' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'b', contextId: 'ctx-B' }));
      ctx.storage.storeDeadLetter(
        complete(ctx, makeTask(ctx, { id: 'c', contextId: 'ctx-C' }))
      );

      expect(new Set(ctx.storage.getContexts())).toEqual(
        new Set(['ctx-A', 'ctx-B', 'ctx-C'])
      );
    });

    it('cascade-deletes queued, active, and dead-letter tasks for a context', () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'queued', contextId: 'doomed' }));
      ctx.storage.createActive(
        makeTask(ctx, { id: 'active', contextId: 'doomed' })
      );
      ctx.storage.storeDeadLetter(
        complete(ctx, makeTask(ctx, { id: 'done', contextId: 'doomed' }))
      );
      ctx.storage.createActive(
        makeTask(ctx, { id: 'survivor', contextId: 'keep' })
      );

      const removed = ctx.storage.deleteContext('doomed');

      expect(removed).toBe(3);
      expect(ctx.storage.getTask('queued')).toBeUndefined();
      expect(ctx.storage.getTask('active')).toBeUndefined();
      expect(ctx.storage.getTask('done')).toBeUndefined();
      expect(ctx.storage.queueLength()).toBe(0);
      expect(ctx.storage.getContexts()).toEqual(['keep']);
      expect(ctx.storage.getTask('survivor')).toMatchObject({ id: 'survivor' });
    });

    it('deleteContext is a no-op for unknown contextId', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'a', contextId: 'ctx-A' }));
      expect(ctx.storage.deleteContext('ctx-missing')).toBe(0);
      expect(ctx.storage.getTask('a')).toMatchObject({ id: 'a' });
    });

    it('removes the context entry when its last task is cleaned up', () => {
      ctx.storage.storeDeadLetter(
        complete(ctx, makeTask(ctx, { id: 'only', contextId: 'tmp' }))
      );
      expect(ctx.storage.getContexts()).toEqual(['tmp']);
      ctx.storage.cleanupCompleted();
      expect(ctx.storage.getContexts()).toEqual([]);
    });
  });
}

function registerCleanupCompletedTests(ctx: Context): void {
  describe('cleanupCompleted', () => {
    it('removes terminal dead-letter tasks and returns the count', () => {
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'd1' })));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'd2' })));
      ctx.storage.createActive(makeTask(ctx, { id: 'still-active' }));

      expect(ctx.storage.cleanupCompleted()).toBe(2);
      expect(ctx.storage.getTask('d1')).toBeUndefined();
      expect(ctx.storage.getTask('d2')).toBeUndefined();
      expect(ctx.storage.getTask('still-active')).toMatchObject({
        id: 'still-active',
      });
    });

    it('returns 0 when there is nothing to clean', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'a' }));
      expect(ctx.storage.cleanupCompleted()).toBe(0);
    });
  });
}

function registerRetentionTests(ctx: Context): void {
  describe('cleanupTasksWithRetention', () => {
    it('keeps the newest N COMPLETED tasks and prunes the rest', () => {
      for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) {
        ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id })));
      }
      const removed = ctx.storage.cleanupTasksWithRetention({
        maxRetainedCompletedTasks: 2,
      });
      expect(removed).toBe(3);
      expect(ctx.storage.getTask('c1')).toBeUndefined();
      expect(ctx.storage.getTask('c2')).toBeUndefined();
      expect(ctx.storage.getTask('c3')).toBeUndefined();
      expect(ctx.storage.getTask('c4')).toMatchObject({ id: 'c4' });
      expect(ctx.storage.getTask('c5')).toMatchObject({ id: 'c5' });
    });

    it('counts FAILED and CANCELLED against the failed cap', () => {
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f1' })));
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f2' })));
      ctx.storage.storeDeadLetter(cancel(ctx, makeTask(ctx, { id: 'x1' })));
      ctx.storage.storeDeadLetter(cancel(ctx, makeTask(ctx, { id: 'x2' })));

      const removed = ctx.storage.cleanupTasksWithRetention({
        maxRetainedFailedTasks: 1,
      });
      expect(removed).toBe(3);
      expect(ctx.storage.getTask('f1')).toBeUndefined();
      expect(ctx.storage.getTask('f2')).toBeUndefined();
      expect(ctx.storage.getTask('x1')).toBeUndefined();
      expect(ctx.storage.getTask('x2')).toMatchObject({ id: 'x2' });
    });

    it('treats buckets independently', () => {
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c1' })));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c2' })));
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f1' })));
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f2' })));

      const removed = ctx.storage.cleanupTasksWithRetention({
        maxRetainedCompletedTasks: 1,
        maxRetainedFailedTasks: 1,
      });
      expect(removed).toBe(2);
      expect(ctx.storage.getTask('c1')).toBeUndefined();
      expect(ctx.storage.getTask('c2')).toMatchObject({ id: 'c2' });
      expect(ctx.storage.getTask('f1')).toBeUndefined();
      expect(ctx.storage.getTask('f2')).toMatchObject({ id: 'f2' });
    });

    it('never touches active tasks', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'live-1' }));
      ctx.storage.createActive(makeTask(ctx, { id: 'live-2' }));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'd1' })));

      ctx.storage.cleanupTasksWithRetention({
        maxRetainedCompletedTasks: 0,
        maxRetainedFailedTasks: 0,
      });
      expect(ctx.storage.getActive('live-1')).toMatchObject({ id: 'live-1' });
      expect(ctx.storage.getActive('live-2')).toMatchObject({ id: 'live-2' });
      expect(ctx.storage.getTask('d1')).toBeUndefined();
    });

    it('treats negative caps as "no cap" for that bucket', () => {
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c1' })));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c2' })));
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f1' })));
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f2' })));

      const removed = ctx.storage.cleanupTasksWithRetention({
        maxRetainedCompletedTasks: -1,
        maxRetainedFailedTasks: 1,
      });
      expect(removed).toBe(1);
      expect(ctx.storage.getTask('c1')).toMatchObject({ id: 'c1' });
      expect(ctx.storage.getTask('c2')).toMatchObject({ id: 'c2' });
      expect(ctx.storage.getTask('f1')).toBeUndefined();
    });

    it('is a no-op when the policy has neither cap set', () => {
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c1' })));
      ctx.storage.storeDeadLetter(fail(ctx, makeTask(ctx, { id: 'f1' })));
      expect(ctx.storage.cleanupTasksWithRetention({})).toBe(0);
      expect(ctx.storage.getTask('c1')).toMatchObject({ id: 'c1' });
      expect(ctx.storage.getTask('f1')).toMatchObject({ id: 'f1' });
    });

    it('returns 0 when bucket size is within its cap', () => {
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c1' })));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c2' })));
      expect(
        ctx.storage.cleanupTasksWithRetention({
          maxRetainedCompletedTasks: 10,
        })
      ).toBe(0);
      expect(ctx.storage.getTask('c1')).toMatchObject({ id: 'c1' });
      expect(ctx.storage.getTask('c2')).toMatchObject({ id: 'c2' });
    });

    it('cap of 0 prunes the entire bucket', () => {
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c1' })));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'c2' })));
      const removed = ctx.storage.cleanupTasksWithRetention({
        maxRetainedCompletedTasks: 0,
      });
      expect(removed).toBe(2);
      expect(ctx.storage.getTask('c1')).toBeUndefined();
      expect(ctx.storage.getTask('c2')).toBeUndefined();
    });
  });
}

function registerRemoveFromQueueTests(ctx: Context): void {
  describe('removeFromQueue', () => {
    it('removes a queued task and returns true', () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'b' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'c' }));

      expect(ctx.storage.removeFromQueue('b')).toBe(true);
      expect(ctx.storage.queueLength()).toBe(2);
    });

    it('preserves FIFO order of the remaining queued tasks', async () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'b' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'c' }));

      ctx.storage.removeFromQueue('b');

      expect((await ctx.storage.dequeue()).id).toBe('a');
      expect((await ctx.storage.dequeue()).id).toBe('c');
    });

    it('returns false for an unknown task id', () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      expect(ctx.storage.removeFromQueue('missing')).toBe(false);
      expect(ctx.storage.queueLength()).toBe(1);
    });

    it('does not touch active storage when removing a queued task', () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'queued' }));
      ctx.storage.removeFromQueue('queued');
      expect(ctx.storage.getActive('queued')).toMatchObject({ id: 'queued' });
    });

    it('returns false after a task is dequeued (queue no longer holds it)', async () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'a' }));
      await ctx.storage.dequeue();
      expect(ctx.storage.removeFromQueue('a')).toBe(false);
    });
  });
}

function registerGetStatsTests(ctx: Context): void {
  describe('getStats', () => {
    it('reports counts grouped by state', () => {
      ctx.storage.createActive(makeTask(ctx, { id: 'p' }));
      ctx.storage.createActive(inProgress(ctx, makeTask(ctx, { id: 'w-1' })));
      ctx.storage.createActive(inProgress(ctx, makeTask(ctx, { id: 'w-2' })));
      ctx.storage.storeDeadLetter(complete(ctx, makeTask(ctx, { id: 'd' })));

      const stats = ctx.storage.getStats();
      expect(stats.totalTasks).toBe(4);
      expect(stats.tasksByState[TASK_STATE.PENDING]).toBe(1);
      expect(stats.tasksByState[TASK_STATE.IN_PROGRESS]).toBe(2);
      expect(stats.tasksByState[TASK_STATE.COMPLETED]).toBe(1);
    });

    it('reports queueLength and average tasks per context', () => {
      ctx.storage.enqueue(makeTask(ctx, { id: 'q1', contextId: 'A' }));
      ctx.storage.enqueue(makeTask(ctx, { id: 'q2', contextId: 'A' }));
      ctx.storage.createActive(makeTask(ctx, { id: 'a1', contextId: 'B' }));

      const stats = ctx.storage.getStats();
      expect(stats.queueLength).toBe(2);
      expect(stats.totalContexts).toBe(2);
      expect(stats.contextsWithTasks).toBe(2);
      expect(stats.averageTasksPerContext).toBeCloseTo(1.5);
    });

    it('handles the empty case without dividing by zero', () => {
      const stats = ctx.storage.getStats();
      expect(stats.totalTasks).toBe(0);
      expect(stats.totalContexts).toBe(0);
      expect(stats.averageTasksPerContext).toBe(0);
      expect(stats.queueLength).toBe(0);
      expect(stats.tasksByState).toEqual({});
    });
  });
}

function registerPushConfigTests(ctx: Context): void {
  describe('push notification configs', () => {
    describe('setPushConfig', () => {
      it('stores a config with the supplied id', () => {
        const stored = ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com/webhook',
        });

        expect(stored.id).toBe('cfg-1');
        expect(stored.url).toBe('https://example.com/webhook');
        expect(ctx.storage.getPushConfig('task-1', 'cfg-1')).toEqual(stored);
      });

      it('assigns a UUID when id is missing', () => {
        const stored = ctx.storage.setPushConfig('task-1', {
          url: 'https://example.com/webhook',
        });

        expect(stored.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
        );
        expect(ctx.storage.getPushConfig('task-1', stored.id)).toEqual(stored);
      });

      it('assigns a UUID when id is the empty string', () => {
        const stored = ctx.storage.setPushConfig('task-1', {
          id: '',
          url: 'https://example.com/webhook',
        });
        expect(stored.id.length).toBeGreaterThan(0);
        expect(stored.id).not.toBe('');
      });

      it('replaces an existing config with the same id', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com/v1',
        });
        const replaced = ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com/v2',
          token: 'secret',
        });

        expect(replaced.url).toBe('https://example.com/v2');
        expect(replaced.token).toBe('secret');
        expect(ctx.storage.listPushConfigs('task-1')).toEqual([replaced]);
      });

      it('keeps configs for different tasks isolated', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://a.example.com',
        });
        ctx.storage.setPushConfig('task-2', {
          id: 'cfg-1',
          url: 'https://b.example.com',
        });

        expect(ctx.storage.getPushConfig('task-1', 'cfg-1')?.url).toBe(
          'https://a.example.com'
        );
        expect(ctx.storage.getPushConfig('task-2', 'cfg-1')?.url).toBe(
          'https://b.example.com'
        );
      });

      it('round-trips token and authentication fields', () => {
        const stored = ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com/webhook',
          token: 'bearer-xyz',
          authentication: {
            schemes: ['Bearer'],
            credentials: 'secret-credentials',
          },
        });

        expect(stored.token).toBe('bearer-xyz');
        expect(stored.authentication).toEqual({
          schemes: ['Bearer'],
          credentials: 'secret-credentials',
        });
      });
    });

    describe('getPushConfig', () => {
      it('returns undefined for an unknown task', () => {
        expect(
          ctx.storage.getPushConfig('missing-task', 'cfg-1')
        ).toBeUndefined();
      });

      it('returns undefined for an unknown config id under a known task', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com',
        });
        expect(
          ctx.storage.getPushConfig('task-1', 'cfg-other')
        ).toBeUndefined();
      });
    });

    describe('listPushConfigs', () => {
      it('returns an empty array for an unknown task', () => {
        expect(ctx.storage.listPushConfigs('missing-task')).toEqual([]);
      });

      it('returns every config registered under the task', () => {
        const a = ctx.storage.setPushConfig('task-1', {
          id: 'cfg-a',
          url: 'https://a.example.com',
        });
        const b = ctx.storage.setPushConfig('task-1', {
          id: 'cfg-b',
          url: 'https://b.example.com',
        });

        const listed = ctx.storage.listPushConfigs('task-1');
        expect(listed).toHaveLength(2);
        expect(listed).toContainEqual(a);
        expect(listed).toContainEqual(b);
      });

      it('returns a fresh array that does not alias storage state', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com',
        });
        const listed = ctx.storage.listPushConfigs('task-1');
        listed.pop();
        expect(ctx.storage.listPushConfigs('task-1')).toHaveLength(1);
      });
    });

    describe('deletePushConfig', () => {
      it('returns true and removes the config when it exists', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com',
        });
        expect(ctx.storage.deletePushConfig('task-1', 'cfg-1')).toBe(true);
        expect(ctx.storage.getPushConfig('task-1', 'cfg-1')).toBeUndefined();
        expect(ctx.storage.listPushConfigs('task-1')).toEqual([]);
      });

      it('returns false for an unknown task', () => {
        expect(ctx.storage.deletePushConfig('missing-task', 'cfg-1')).toBe(
          false
        );
      });

      it('returns false for an unknown config id under a known task', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com',
        });
        expect(ctx.storage.deletePushConfig('task-1', 'cfg-other')).toBe(false);
        expect(ctx.storage.getPushConfig('task-1', 'cfg-1')).toBeDefined();
      });

      it('leaves other configs intact when deleting one of several', () => {
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-a',
          url: 'https://a.example.com',
        });
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-b',
          url: 'https://b.example.com',
        });

        expect(ctx.storage.deletePushConfig('task-1', 'cfg-a')).toBe(true);
        expect(ctx.storage.listPushConfigs('task-1').map((c) => c.id)).toEqual([
          'cfg-b',
        ]);
      });
    });

    describe('deleteContext cascade', () => {
      it('removes push configs for every task in the deleted context', () => {
        const task = makeTask(ctx, { id: 'task-1', contextId: 'ctx-1' });
        ctx.storage.enqueue(task);
        ctx.storage.setPushConfig('task-1', {
          id: 'cfg-1',
          url: 'https://example.com',
        });

        ctx.storage.deleteContext('ctx-1');

        expect(ctx.storage.listPushConfigs('task-1')).toEqual([]);
        expect(ctx.storage.getPushConfig('task-1', 'cfg-1')).toBeUndefined();
      });
    });
  });
}
