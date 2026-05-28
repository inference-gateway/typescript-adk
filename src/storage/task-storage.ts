import type { ManagedTask, ManagedTaskState } from '../agent/task.js';
import type { PushNotificationConfig } from '../types/generated/a2a.js';

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
 * A {@link PushNotificationConfig} after it has been persisted - its `id` is
 * guaranteed to be set (storage assigns one when the caller omits it). Use
 * this rather than the wire `PushNotificationConfig` whenever the post-store
 * id is load-bearing (resource name encoding, return values to the caller).
 */
export type StoredPushNotificationConfig = PushNotificationConfig & {
  readonly id: string;
};

/**
 * Per-state caps for the dead-letter store. Passed to
 * {@link TaskStorage.cleanupTasksWithRetention} to prune the oldest terminal
 * tasks beyond each cap.
 *
 * `CANCELLED` tasks are counted alongside `FAILED` against
 * {@link maxRetainedFailedTasks} since both are non-success terminals.
 *
 * - A non-negative integer caps the bucket at that many tasks.
 * - A negative number (or omitted field) disables the cap for that bucket -
 *   no pruning happens there.
 * - Zero prunes the bucket entirely on the next sweep.
 */
export interface TaskRetentionPolicy {
  readonly maxRetainedCompletedTasks?: number;
  readonly maxRetainedFailedTasks?: number;
}

/**
 * Queue-centric task storage contract.
 *
 * Tasks flow through three locations:
 *   1. **Queue** - enqueued, waiting to be dequeued by a worker.
 *   2. **Active** - enqueued or in-flight (after `dequeue`, before terminal).
 *   3. **Dead letter** - terminal tasks (`COMPLETED`/`FAILED`/`CANCELLED`)
 *      kept for audit and lookup.
 *
 * An enqueued task lives in both the queue and the active map; once dequeued
 * it stays in active until `storeDeadLetter` moves it to the dead-letter map.
 *
 * Returned `ManagedTask` values are live references - implementations do not
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
   * to abort the wait - the promise then rejects with `signal.reason`.
   *
   * The dequeued task stays in active storage; the worker is expected to
   * eventually call {@link TaskStorage.storeDeadLetter} to release it.
   */
  dequeue(signal?: AbortSignal): Promise<ManagedTask>;

  /** Current number of tasks waiting in the FIFO queue. */
  queueLength(): number;

  /**
   * Remove a task from the FIFO queue by id without affecting active or
   * dead-letter storage. Returns `true` if the task was present in the queue
   * and removed, `false` if it was not queued (already dequeued, or never
   * enqueued under that id).
   *
   * Used by cancellation flows to drop a `PENDING` task before any worker
   * picks it up; the caller is still responsible for transitioning state and
   * moving the task to the dead-letter store.
   */
  removeFromQueue(taskId: string): boolean;

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
   * The result is a fresh array - callers can sort or slice it further
   * without affecting storage state.
   */
  listTasks(filter?: TaskListFilter): ManagedTask[];

  /**
   * All context ids that have at least one task in storage (active, queued,
   * or dead-letter). Order is unspecified.
   */
  getContexts(): string[];

  /**
   * Cascade-delete every task in `contextId` - from the queue, from active
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

  /**
   * Bound the dead-letter store by retaining at most `policy.maxRetainedCompletedTasks`
   * `COMPLETED` tasks and at most `policy.maxRetainedFailedTasks` `FAILED`/`CANCELLED`
   * tasks. The oldest tasks (by `completedAt`, falling back to `updatedAt`, then
   * `createdAt`) are pruned first. Active tasks are untouched.
   *
   * A cap of `0` prunes that bucket entirely; a negative cap is treated as
   * "no cap" (the bucket is left alone). Returns the number of tasks removed.
   */
  cleanupTasksWithRetention(policy: TaskRetentionPolicy): number;

  /** Snapshot of storage health. */
  getStats(): TaskStorageStats;

  /**
   * Persist a push-notification config for `taskId`. The stored value has
   * `config.id` populated - either with the caller-supplied id (when set) or
   * with a freshly minted UUID. The returned config is the value that was
   * persisted; callers that need the generated id should read it from the
   * return value.
   *
   * If a config with the same `id` already exists under `taskId`, it is
   * replaced. Multiple distinct configs may coexist under a single task.
   *
   * Storage does not validate that `taskId` corresponds to a known task -
   * this matches the Go ADK's behaviour and lets clients pre-register configs
   * before the task is materialised.
   */
  setPushConfig(
    taskId: string,
    config: PushNotificationConfig
  ): StoredPushNotificationConfig;

  /**
   * Look up a single push-notification config by `(taskId, configId)`. Returns
   * `undefined` if either the task has no configs or no config under that id.
   */
  getPushConfig(
    taskId: string,
    configId: string
  ): StoredPushNotificationConfig | undefined;

  /**
   * Return every push-notification config registered for `taskId`, in
   * insertion order. The returned array is a fresh snapshot - callers may
   * sort or mutate it without affecting storage. Returns `[]` when the task
   * has no configs.
   */
  listPushConfigs(taskId: string): StoredPushNotificationConfig[];

  /**
   * Remove a push-notification config by `(taskId, configId)`. Returns `true`
   * if a config was removed, `false` if no config existed under that key.
   */
  deletePushConfig(taskId: string, configId: string): boolean;
}

/**
 * Thrown by storage operations that fail invariant checks (e.g.,
 * `createActive` with a duplicate id, `updateActive` for an unknown id).
 */
export class TaskStorageError extends Error {
  override readonly name = 'TaskStorageError';
}
