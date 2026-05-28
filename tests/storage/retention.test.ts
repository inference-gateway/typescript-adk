import { describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import { selectTasksForEviction } from '../../src/storage/retention.js';

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function completedAt(id: string, iso: string): ManagedTask {
  const t = createTask({
    id,
    contextId: 'ctx',
    now: fixedClock(iso),
  });
  const working = transitionTask(t, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(iso),
  });
  return transitionTask(working, TASK_STATE.COMPLETED, {
    now: fixedClock(iso),
  });
}

function failedAt(id: string, iso: string): ManagedTask {
  const t = createTask({
    id,
    contextId: 'ctx',
    now: fixedClock(iso),
  });
  const working = transitionTask(t, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(iso),
  });
  return transitionTask(working, TASK_STATE.FAILED, {
    now: fixedClock(iso),
  });
}

describe('selectTasksForEviction', () => {
  it('returns empty array when neither cap is set', () => {
    const tasks = [
      completedAt('a', '2026-01-01T00:00:00.000Z'),
      completedAt('b', '2026-01-02T00:00:00.000Z'),
    ];
    expect(selectTasksForEviction(tasks, {})).toEqual([]);
  });

  it('returns empty array when both caps are negative', () => {
    const tasks = [
      completedAt('a', '2026-01-01T00:00:00.000Z'),
      completedAt('b', '2026-01-02T00:00:00.000Z'),
    ];
    expect(
      selectTasksForEviction(tasks, {
        maxRetainedCompletedTasks: -1,
        maxRetainedFailedTasks: -1,
      })
    ).toEqual([]);
  });

  it('evicts oldest by completedAt first', () => {
    const tasks = [
      completedAt('newest', '2026-01-03T00:00:00.000Z'),
      completedAt('oldest', '2026-01-01T00:00:00.000Z'),
      completedAt('middle', '2026-01-02T00:00:00.000Z'),
    ];
    const evict = selectTasksForEviction(tasks, {
      maxRetainedCompletedTasks: 1,
    });
    expect(evict.map((t) => t.id)).toEqual(['oldest', 'middle']);
  });

  it('breaks ties on id when timestamps match', () => {
    const tasks = [
      completedAt('c', '2026-01-01T00:00:00.000Z'),
      completedAt('a', '2026-01-01T00:00:00.000Z'),
      completedAt('b', '2026-01-01T00:00:00.000Z'),
    ];
    const evict = selectTasksForEviction(tasks, {
      maxRetainedCompletedTasks: 1,
    });
    expect(evict.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('caps completed and failed buckets independently', () => {
    const tasks = [
      completedAt('c1', '2026-01-01T00:00:00.000Z'),
      completedAt('c2', '2026-01-02T00:00:00.000Z'),
      failedAt('f1', '2026-01-01T00:00:00.000Z'),
      failedAt('f2', '2026-01-02T00:00:00.000Z'),
    ];
    const evict = selectTasksForEviction(tasks, {
      maxRetainedCompletedTasks: 1,
      maxRetainedFailedTasks: 1,
    });
    expect(evict.map((t) => t.id).sort()).toEqual(['c1', 'f1']);
  });

  it('ignores tasks in non-terminal states', () => {
    const t = createTask({
      id: 'live',
      contextId: 'ctx',
      now: fixedClock('2026-01-01T00:00:00.000Z'),
    });
    const evict = selectTasksForEviction([t], {
      maxRetainedCompletedTasks: 0,
      maxRetainedFailedTasks: 0,
    });
    expect(evict).toEqual([]);
  });
});
