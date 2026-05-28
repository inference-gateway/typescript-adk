import { TASK_STATE, type ManagedTask } from '../agent/task.js';
import type { TaskRetentionPolicy } from './task-storage.js';

/**
 * Given the contents of a dead-letter store and a retention policy, return the
 * tasks that should be evicted to bring each bucket back under its cap. The
 * oldest tasks are evicted first - ordered by `completedAt`, then `updatedAt`,
 * then `createdAt`, then `id` (lexicographic) as a tiebreaker for tasks
 * stamped at the same instant.
 *
 * A negative or `undefined` cap means "no cap" for that bucket - no tasks are
 * evicted from it. A cap of `0` evicts every task in that bucket.
 *
 * Only tasks in a terminal state are considered. Tasks in non-terminal states
 * (which shouldn't normally appear in dead-letter storage) are skipped.
 */
export function selectTasksForEviction(
  tasks: Iterable<ManagedTask>,
  policy: TaskRetentionPolicy
): ManagedTask[] {
  const completedCap = policy.maxRetainedCompletedTasks;
  const failedCap = policy.maxRetainedFailedTasks;

  const completedCapped = typeof completedCap === 'number' && completedCap >= 0;
  const failedCapped = typeof failedCap === 'number' && failedCap >= 0;
  if (!completedCapped && !failedCapped) {
    return [];
  }

  const completed: ManagedTask[] = [];
  const failed: ManagedTask[] = [];
  for (const task of tasks) {
    if (task.state === TASK_STATE.COMPLETED) {
      if (completedCapped) completed.push(task);
    } else if (
      task.state === TASK_STATE.FAILED ||
      task.state === TASK_STATE.CANCELLED
    ) {
      if (failedCapped) failed.push(task);
    }
  }

  const evict: ManagedTask[] = [];
  if (completedCapped && completed.length > (completedCap as number)) {
    completed.sort(compareTasksOldestFirst);
    const overflow = completed.length - (completedCap as number);
    for (let i = 0; i < overflow; i++) {
      const t = completed[i];
      if (t !== undefined) evict.push(t);
    }
  }
  if (failedCapped && failed.length > (failedCap as number)) {
    failed.sort(compareTasksOldestFirst);
    const overflow = failed.length - (failedCap as number);
    for (let i = 0; i < overflow; i++) {
      const t = failed[i];
      if (t !== undefined) evict.push(t);
    }
  }
  return evict;
}

function compareTasksOldestFirst(a: ManagedTask, b: ManagedTask): number {
  const aKey = a.completedAt ?? a.updatedAt ?? a.createdAt;
  const bKey = b.completedAt ?? b.updatedAt ?? b.createdAt;
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
