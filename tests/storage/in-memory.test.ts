import { describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
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
  overrides: { id?: string; contextId?: string } = {}
): ManagedTask {
  const id = overrides.id ?? `task-${counter + 1}`;
  const contextId = overrides.contextId ?? 'ctx-1';
  return createTask({
    id,
    contextId,
    now: fixedClock(nextTimestamp()),
  });
}

function inProgress(task: ManagedTask): ManagedTask {
  return transitionTask(task, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(nextTimestamp()),
  });
}

describe('InMemoryTaskStorage - implementation details', () => {
  it('returns the same reference on read (no deep clone)', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'ref' });
    storage.createActive(task);
    expect(storage.getActive('ref')).toBe(task);
    expect(storage.getTask('ref')).toBe(task);
  });

  it('enqueue registers the same reference under getActive', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'tracked' });
    storage.enqueue(task);
    expect(storage.getActive('tracked')).toBe(task);
  });

  it('updateActive stores the new reference', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'upd' });
    storage.createActive(task);
    const next = inProgress(task);
    storage.updateActive(next);
    expect(storage.getActive('upd')).toBe(next);
  });

  it('throws TaskStorageError on createActive duplicate', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'dup' });
    storage.createActive(task);
    expect(() => storage.createActive(task)).toThrow(TaskStorageError);
  });

  it('throws TaskStorageError on updateActive for unknown id', () => {
    const storage = new InMemoryTaskStorage();
    const task = makeTask({ id: 'missing' });
    expect(() => storage.updateActive(task)).toThrow(TaskStorageError);
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
