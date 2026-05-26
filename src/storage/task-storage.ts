import type { ManagedTask, ManagedTaskState } from '../agent/task.js';

/**
 * Filter passed to {@link TaskStorage.listTasks}. All fields are optional:
 * omitting `state` or `contextId` matches every task; omitting `limit` returns
 * every match after `offset`.
 *
 * Pagination is offset+limit. Listings are FIFO-ordered by `createdAt`, so
 * the same `offset`/`limit` window on an unchanged store yields the same page.
 */
export interface TaskListFilter {
  readonly state?: ManagedTaskState;
  readonly contextId?: string;
  readonly offset?: number;
  readonly limit?: number;
}

/**
 * Snapshot of storage health returned by {@link TaskStorage.getStats}. The
 * union of active and dead-letter tasks is counted; `queueLength` is the
 * number of tasks currently waiting to be dequeued (a subset of active).
 */
export interface TaskStorageStats {
  readonly totalTasks: number;
  readonly tasksByState: Readonly<Record<string, number>>;
  readonly totalContexts: number;
  readonly contextsWithTasks: number;
  readonly averageTasksPerContext: number;
  readonly queueLength: number;
}

/**
 * Queue-centric task storage contract.
 *
 * Tasks flow through three locations:
 *   1. **Queue** — enqueued, waiting to be dequeued by a worker.
 *   2. **Active** — enqueued or in-flight (after `dequeue`, before terminal).
 *   3. **Dead letter** — terminal tasks (`COMPLETED`/`FAILED`/`CANCELLED`)
 *      kept for audit and lookup.
 *
 * An enqueued task lives in both the queue and the active map; once dequeued
 * it stays in active until `storeDeadLetter` moves it to the dead-letter map.
 *
 * Returned `ManagedTask` values are live references — implementations do not
 * deep-clone on read. Because `ManagedTask` is fully `readonly`, callers
 * cannot mutate; state changes must be produced via `transitionTask` and
 * persisted with {@link TaskStorage.updateActive}.
 */
export interface TaskStorage {
  /**
   * Append `task` to the FIFO queue and register it as active. If a
   * {@link TaskStorage.dequeue} caller is currently waiting, the task is
   * handed off to the oldest waiter instead of sitting in the queue.
   */
  enqueue(task: ManagedTask): void;

  /**
   * Remove and return the head of the FIFO queue. If the queue is empty, the
   * returned promise resolves when the next task is enqueued. Pass `signal`
   * to abort the wait — the promise then rejects with `signal.reason`.
   *
   * The dequeued task stays in active storage; the worker is expected to
   * eventually call {@link TaskStorage.storeDeadLetter} to release it.
   */
  dequeue(signal?: AbortSignal): Promise<ManagedTask>;

  /** Current number of tasks waiting in the FIFO queue. */
  queueLength(): number;

  /**
   * Register `task` as active without enqueueing it. Useful when a task is
   * recreated from a checkpoint or resumed out-of-band. Throws if a task
   * with the same id is already active.
   */
  createActive(task: ManagedTask): void;

  /**
   * Look up an active task by id. Returns `undefined` if the id is unknown
   * or the task has already been moved to the dead-letter store.
   */
  getActive(taskId: string): ManagedTask | undefined;

  /**
   * Replace the active task with the same id. Throws if no task is currently
   * active under that id. Use this after `transitionTask` to persist a new
   * state without enqueueing again.
   */
  updateActive(task: ManagedTask): void;

  /**
   * Move `task` out of active storage and into the dead-letter store. Safe
   * to call even if the task was never in the active map (e.g., it was
   * dequeued by a different process and you want to record its terminal
   * state for audit).
   */
  storeDeadLetter(task: ManagedTask): void;

  /**
   * Look up a task by id across both active and dead-letter stores. Returns
   * `undefined` if no task with that id has been seen.
   */
  getTask(taskId: string): ManagedTask | undefined;

  /**
   * Return tasks matching `filter`, FIFO-ordered by `createdAt` and sliced
   * by `offset`/`limit`. Includes both active and dead-letter tasks.
   *
   * The result is a fresh array — callers can sort or slice it further
   * without affecting storage state.
   */
  listTasks(filter?: TaskListFilter): ManagedTask[];

  /**
   * All context ids that have at least one task in storage (active, queued,
   * or dead-letter). Order is unspecified.
   */
  getContexts(): string[];

  /**
   * Cascade-delete every task in `contextId` — from the queue, from active
   * storage, and from the dead-letter store. No-op if `contextId` is unknown.
   *
   * Returns the number of tasks deleted.
   */
  deleteContext(contextId: string): number;

  /**
   * Remove every terminal task (`COMPLETED`/`FAILED`/`CANCELLED`) from the
   * dead-letter store. Active tasks are untouched. Returns the number of
   * tasks removed.
   */
  cleanupCompleted(): number;

  /** Snapshot of storage health. */
  getStats(): TaskStorageStats;
}

/**
 * Thrown by storage operations that fail invariant checks (e.g.,
 * `createActive` with a duplicate id, `updateActive` for an unknown id).
 */
export class TaskStorageError extends Error {
  override readonly name = 'TaskStorageError';
}
