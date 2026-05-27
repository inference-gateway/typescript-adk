import { describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
  type ManagedTaskState,
} from '../../src/agent/task.js';
import {
  InMemoryTaskStorage,
  TaskStorageError,
} from '../../src/storage/index.js';

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
let counter = 0;

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function nextTimestamp(): string {
  counter += 1;
  return new Date(EPOCH + counter * 1000).toISOString();
}

function makeTask(
  overrides: { id?: string; contextId?: string; createdAt?: string } = {}
): ManagedTask {
  const id = overrides.id ?? `task-${counter + 1}`;
  const contextId = overrides.contextId ?? 'ctx-1';
  const createdAt = overrides.createdAt ?? nextTimestamp();
  return createTask({
    id,
    contextId,
    now: fixedClock(createdAt),
  });
}

function inProgress(task: ManagedTask): ManagedTask {
  return transitionTask(task, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(nextTimestamp()),
  });
}

function complete(task: ManagedTask): ManagedTask {
  const working =
    task.state === TASK_STATE.IN_PROGRESS ? task : inProgress(task);
  return transitionTask(working, TASK_STATE.COMPLETED, {
    now: fixedClock(nextTimestamp()),
  });
}

describe('InMemoryTaskStorage - queue', () => {
  it('enqueue + dequeue preserves FIFO order', async () => {
    const storage = new InMemoryTaskStorage();
    const a = makeTask({ id: 'a' });
    const b = makeTask({ id: 'b' });
    const c = makeTask({ id: 'c' });

    storage.enqueue(a);
    storage.enqueue(b);
    storage.enqueue(c);

    expect(storage.queueLength()).toBe(3);
    expect((await storage.dequeue()).id).toBe('a');
    expect((await storage.dequeue()).id).toBe('b');
    expect((await storage.dequeue()).id).toBe('c');
    expect(storage.queueLength()).toBe(0);
  });

  it('dequeue resolves when a task is enqueued later', async () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'late' });

    const pending = storage.dequeue();
    storage.enqueue(task);

    await expect(pending).resolves.toMatchObject({ id: 'late' });
  });

  it('hands off to the oldest waiter in arrival order', async () => {
    const storage = new InMemoryTaskStorage();
    const order: string[] = [];

    const w1 = storage.dequeue().then((t) => order.push(`w1:${t.id}`));
    const w2 = storage.dequeue().then((t) => order.push(`w2:${t.id}`));
    const w3 = storage.dequeue().then((t) => order.push(`w3:${t.id}`));

    storage.enqueue(makeTask({ id: 'a' }));
    storage.enqueue(makeTask({ id: 'b' }));
    storage.enqueue(makeTask({ id: 'c' }));

    await Promise.all([w1, w2, w3]);
    expect(order).toEqual(['w1:a', 'w2:b', 'w3:c']);
  });

  it('skips the queue when a waiter is already parked', async () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'direct' });
    const pending = storage.dequeue();
    storage.enqueue(task);

    expect(storage.queueLength()).toBe(0);
    await expect(pending).resolves.toMatchObject({ id: 'direct' });
  });

  it('rejects pending dequeue when the AbortSignal fires', async () => {
    const storage = new InMemoryTaskStorage();
    const controller = new AbortController();
    const pending = storage.dequeue(controller.signal);

    controller.abort(new Error('shutdown'));

    await expect(pending).rejects.toThrow('shutdown');
  });

  it('rejects immediately when the AbortSignal is already aborted', async () => {
    const storage = new InMemoryTaskStorage();
    const controller = new AbortController();
    controller.abort(new Error('already-stopped'));

    await expect(storage.dequeue(controller.signal)).rejects.toThrow(
      'already-stopped'
    );
  });

  it('aborted waiter does not consume the next enqueued task', async () => {
    const storage = new InMemoryTaskStorage();
    const controller = new AbortController();
    const aborted = storage.dequeue(controller.signal);
    controller.abort(new Error('gone'));
    await expect(aborted).rejects.toThrow('gone');

    storage.enqueue(makeTask({ id: 'survivor' }));
    await expect(storage.dequeue()).resolves.toMatchObject({ id: 'survivor' });
  });

  it('enqueued task is also registered as active', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'tracked' });
    storage.enqueue(task);
    expect(storage.getActive('tracked')).toBe(task);
  });

  it('removes the abort listener once a waiter resolves', async () => {
    const storage = new InMemoryTaskStorage();
    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const realAdd = controller.signal.addEventListener.bind(controller.signal);
    const realRemove = controller.signal.removeEventListener.bind(
      controller.signal
    );
    controller.signal.addEventListener = ((
      type: string,
      listener: EventListener
    ): void => {
      added.push(listener);
      realAdd(type, listener);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((
      type: string,
      listener: EventListener
    ): void => {
      removed.push(listener);
      realRemove(type, listener);
    }) as typeof controller.signal.removeEventListener;

    const pending = storage.dequeue(controller.signal);
    storage.enqueue(makeTask({ id: 'resolves' }));
    await pending;

    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });
});

describe('InMemoryTaskStorage - active lifecycle', () => {
  it('createActive registers a task that was not enqueued', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'created' });
    storage.createActive(task);
    expect(storage.getActive('created')).toBe(task);
    expect(storage.queueLength()).toBe(0);
  });

  it('createActive throws on duplicate id', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'dup' });
    storage.createActive(task);
    expect(() => storage.createActive(task)).toThrow(TaskStorageError);
  });

  it('updateActive replaces the stored reference', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'upd' });
    storage.createActive(task);
    const next = inProgress(task);
    storage.updateActive(next);
    expect(storage.getActive('upd')).toBe(next);
    expect(storage.getActive('upd')?.state).toBe(TASK_STATE.IN_PROGRESS);
  });

  it('updateActive throws when no active task exists', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'missing' });
    expect(() => storage.updateActive(task)).toThrow(TaskStorageError);
  });

  it('storeDeadLetter moves a task out of active', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'done' });
    storage.createActive(task);
    const terminal = complete(task);
    storage.storeDeadLetter(terminal);
    expect(storage.getActive('done')).toBeUndefined();
    expect(storage.getTask('done')).toBe(terminal);
  });

  it('returns reference-equal task on read - no deep clone', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'ref' });
    storage.createActive(task);
    expect(storage.getActive('ref')).toBe(task);
    expect(storage.getTask('ref')).toBe(task);
  });
});

describe('InMemoryTaskStorage - listTasks filtering & pagination', () => {
  it('lists tasks in createdAt order, not insertion order', () => {
    const storage = new InMemoryTaskStorage();
    const first = makeTask({ id: 'first' });
    const second = makeTask({ id: 'second' });
    const third = makeTask({ id: 'third' });

    // Insert out of chronological order.
    storage.createActive(second);
    storage.createActive(first);
    storage.createActive(third);

    const ids = storage.listTasks().map((t) => t.id);
    expect(ids).toEqual(['first', 'second', 'third']);
  });

  it('filters by state across active and dead-letter stores', () => {
    const storage = new InMemoryTaskStorage();
    const active1 = makeTask({ id: 'active-1' });
    const active2 = makeTask({ id: 'active-2' });
    const finished = complete(makeTask({ id: 'done-1' }));

    storage.createActive(active1);
    storage.createActive(inProgress(active2));
    storage.storeDeadLetter(finished);

    const completed = storage
      .listTasks({ state: TASK_STATE.COMPLETED })
      .map((t) => t.id);
    expect(completed).toEqual(['done-1']);

    const working = storage
      .listTasks({ state: TASK_STATE.IN_PROGRESS })
      .map((t) => t.id);
    expect(working).toEqual(['active-2']);
  });

  it('filters by contextId', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'a', contextId: 'ctx-A' }));
    storage.createActive(makeTask({ id: 'b', contextId: 'ctx-B' }));
    storage.createActive(makeTask({ id: 'c', contextId: 'ctx-A' }));

    const ids = storage.listTasks({ contextId: 'ctx-A' }).map((t) => t.id);
    expect(ids).toEqual(['a', 'c']);
  });

  it('combines state and contextId filters', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'a', contextId: 'x' }));
    storage.createActive(inProgress(makeTask({ id: 'b', contextId: 'x' })));
    storage.createActive(inProgress(makeTask({ id: 'c', contextId: 'y' })));

    const ids = storage
      .listTasks({ contextId: 'x', state: TASK_STATE.IN_PROGRESS })
      .map((t) => t.id);
    expect(ids).toEqual(['b']);
  });

  it('paginates with offset + limit', () => {
    const storage = new InMemoryTaskStorage();
    const ids = ['t-01', 't-02', 't-03', 't-04', 't-05', 't-06'];
    for (const id of ids) {
      storage.createActive(makeTask({ id }));
    }

    const page1 = storage.listTasks({ offset: 0, limit: 2 }).map((t) => t.id);
    const page2 = storage.listTasks({ offset: 2, limit: 2 }).map((t) => t.id);
    const page3 = storage.listTasks({ offset: 4, limit: 2 }).map((t) => t.id);
    const page4 = storage.listTasks({ offset: 6, limit: 2 }).map((t) => t.id);

    expect(page1).toEqual(['t-01', 't-02']);
    expect(page2).toEqual(['t-03', 't-04']);
    expect(page3).toEqual(['t-05', 't-06']);
    expect(page4).toEqual([]);
  });

  it('omitting limit returns every match after offset', () => {
    const storage = new InMemoryTaskStorage();
    for (let i = 0; i < 5; i++) {
      storage.createActive(makeTask({ id: `t-${i}` }));
    }
    const tail = storage.listTasks({ offset: 2 }).map((t) => t.id);
    expect(tail).toEqual(['t-2', 't-3', 't-4']);
  });

  it('returns empty array for out-of-range offset', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'only' }));
    expect(storage.listTasks({ offset: 99 })).toEqual([]);
  });

  it('returns empty array when no filter matches', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'a' }));
    const noMatch: ManagedTaskState = TASK_STATE.CANCELLED;
    expect(storage.listTasks({ state: noMatch })).toEqual([]);
  });
});

describe('InMemoryTaskStorage - context management', () => {
  it('getContexts spans active, queued, and dead-letter tasks', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'a', contextId: 'ctx-A' }));
    storage.enqueue(makeTask({ id: 'b', contextId: 'ctx-B' }));
    storage.storeDeadLetter(
      complete(makeTask({ id: 'c', contextId: 'ctx-C' }))
    );

    expect(new Set(storage.getContexts())).toEqual(
      new Set(['ctx-A', 'ctx-B', 'ctx-C'])
    );
  });

  it('cascade-deletes queued, active, and dead-letter tasks for a context', () => {
    const storage = new InMemoryTaskStorage();
    storage.enqueue(makeTask({ id: 'queued', contextId: 'doomed' }));
    storage.createActive(makeTask({ id: 'active', contextId: 'doomed' }));
    storage.storeDeadLetter(
      complete(makeTask({ id: 'done', contextId: 'doomed' }))
    );
    storage.createActive(makeTask({ id: 'survivor', contextId: 'keep' }));

    const removed = storage.deleteContext('doomed');

    expect(removed).toBe(3);
    expect(storage.getTask('queued')).toBeUndefined();
    expect(storage.getTask('active')).toBeUndefined();
    expect(storage.getTask('done')).toBeUndefined();
    expect(storage.queueLength()).toBe(0);
    expect(storage.getContexts()).toEqual(['keep']);
    expect(storage.getTask('survivor')).toBeDefined();
  });

  it('deleteContext is a no-op for unknown contextId', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'a', contextId: 'ctx-A' }));
    expect(storage.deleteContext('ctx-missing')).toBe(0);
    expect(storage.getTask('a')).toBeDefined();
  });

  it('removes the context entry when its last task is dead-lettered then cleaned', () => {
    const storage = new InMemoryTaskStorage();
    storage.storeDeadLetter(
      complete(makeTask({ id: 'only', contextId: 'tmp' }))
    );
    expect(storage.getContexts()).toEqual(['tmp']);
    storage.cleanupCompleted();
    expect(storage.getContexts()).toEqual([]);
  });
});

describe('InMemoryTaskStorage - cleanupCompleted', () => {
  it('removes terminal dead-letter tasks and returns the count', () => {
    const storage = new InMemoryTaskStorage();
    storage.storeDeadLetter(complete(makeTask({ id: 'done-1' })));
    storage.storeDeadLetter(complete(makeTask({ id: 'done-2' })));
    storage.createActive(makeTask({ id: 'still-active' }));

    expect(storage.cleanupCompleted()).toBe(2);
    expect(storage.getTask('done-1')).toBeUndefined();
    expect(storage.getTask('done-2')).toBeUndefined();
    expect(storage.getTask('still-active')).toBeDefined();
  });

  it('returns 0 when there is nothing to clean', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'a' }));
    expect(storage.cleanupCompleted()).toBe(0);
  });
});

describe('InMemoryTaskStorage - removeFromQueue', () => {
  it('removes a queued task and returns true', () => {
    const storage = new InMemoryTaskStorage();
    storage.enqueue(makeTask({ id: 'a' }));
    storage.enqueue(makeTask({ id: 'b' }));
    storage.enqueue(makeTask({ id: 'c' }));

    expect(storage.removeFromQueue('b')).toBe(true);
    expect(storage.queueLength()).toBe(2);
  });

  it('preserves FIFO order of the remaining queued tasks', async () => {
    const storage = new InMemoryTaskStorage();
    storage.enqueue(makeTask({ id: 'a' }));
    storage.enqueue(makeTask({ id: 'b' }));
    storage.enqueue(makeTask({ id: 'c' }));

    storage.removeFromQueue('b');

    expect((await storage.dequeue()).id).toBe('a');
    expect((await storage.dequeue()).id).toBe('c');
  });

  it('returns false for an unknown task id', () => {
    const storage = new InMemoryTaskStorage();
    storage.enqueue(makeTask({ id: 'a' }));
    expect(storage.removeFromQueue('missing')).toBe(false);
    expect(storage.queueLength()).toBe(1);
  });

  it('does not touch active or dead-letter storage when removing a queued task', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'queued' });
    storage.enqueue(task);

    storage.removeFromQueue('queued');

    // `enqueue` registers as active too — removing from the queue should not
    // unregister the active entry; callers handle that separately via
    // storeDeadLetter.
    expect(storage.getActive('queued')).toBe(task);
  });

  it('returns false after a task is dequeued (queue no longer holds it)', async () => {
    const storage = new InMemoryTaskStorage();
    storage.enqueue(makeTask({ id: 'a' }));
    await storage.dequeue();
    expect(storage.removeFromQueue('a')).toBe(false);
  });
});

describe('InMemoryTaskStorage - getStats', () => {
  it('reports counts grouped by state', () => {
    const storage = new InMemoryTaskStorage();
    storage.createActive(makeTask({ id: 'p' }));
    storage.createActive(inProgress(makeTask({ id: 'w-1' })));
    storage.createActive(inProgress(makeTask({ id: 'w-2' })));
    storage.storeDeadLetter(complete(makeTask({ id: 'd' })));

    const stats = storage.getStats();
    expect(stats.totalTasks).toBe(4);
    expect(stats.tasksByState[TASK_STATE.PENDING]).toBe(1);
    expect(stats.tasksByState[TASK_STATE.IN_PROGRESS]).toBe(2);
    expect(stats.tasksByState[TASK_STATE.COMPLETED]).toBe(1);
  });

  it('reports queueLength and average tasks per context', () => {
    const storage = new InMemoryTaskStorage();
    storage.enqueue(makeTask({ id: 'q1', contextId: 'A' }));
    storage.enqueue(makeTask({ id: 'q2', contextId: 'A' }));
    storage.createActive(makeTask({ id: 'a1', contextId: 'B' }));

    const stats = storage.getStats();
    expect(stats.queueLength).toBe(2);
    expect(stats.totalContexts).toBe(2);
    expect(stats.contextsWithTasks).toBe(2);
    expect(stats.averageTasksPerContext).toBeCloseTo(1.5);
  });

  it('handles the empty case without dividing by zero', () => {
    const storage = new InMemoryTaskStorage();
    const stats = storage.getStats();
    expect(stats.totalTasks).toBe(0);
    expect(stats.totalContexts).toBe(0);
    expect(stats.averageTasksPerContext).toBe(0);
    expect(stats.queueLength).toBe(0);
    expect(stats.tasksByState).toEqual({});
  });
});
