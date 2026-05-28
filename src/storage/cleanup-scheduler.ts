import type { TaskRetentionPolicy, TaskStorage } from './task-storage.js';

/**
 * Env var read by {@link loadCleanupOptionsFromEnv}. Caps the number of
 * `COMPLETED` tasks kept in the dead-letter store. Defaults to
 * {@link DEFAULT_MAX_RETAINED_COMPLETED_TASKS} when unset.
 */
export const MAX_RETAINED_COMPLETED_TASKS_ENV = 'MAX_RETAINED_COMPLETED_TASKS';
/**
 * Env var read by {@link loadCleanupOptionsFromEnv}. Caps the combined number
 * of `FAILED` and `CANCELLED` tasks kept in the dead-letter store. Defaults to
 * {@link DEFAULT_MAX_RETAINED_FAILED_TASKS} when unset.
 */
export const MAX_RETAINED_FAILED_TASKS_ENV = 'MAX_RETAINED_FAILED_TASKS';
/**
 * Env var read by {@link loadCleanupOptionsFromEnv}. How often (ms) the
 * background sweep runs. Defaults to {@link DEFAULT_CLEANUP_INTERVAL_MS} when
 * unset.
 */
export const CLEANUP_INTERVAL_MS_ENV = 'CLEANUP_INTERVAL_MS';

/** Default cap on retained `COMPLETED` tasks. */
export const DEFAULT_MAX_RETAINED_COMPLETED_TASKS = 100;
/** Default cap on retained `FAILED`/`CANCELLED` tasks. */
export const DEFAULT_MAX_RETAINED_FAILED_TASKS = 50;
/** Default interval (ms) between background sweeps - 5 minutes. */
export const DEFAULT_CLEANUP_INTERVAL_MS = 300_000;

/**
 * Construction-time options for {@link TaskCleanupScheduler}. `storage` is the
 * backend whose dead-letter store is pruned; `policy` controls how much is
 * kept; `intervalMs` sets the sweep cadence.
 *
 * `onError` is invoked when a scheduled sweep throws (so a flaky backend
 * doesn't crash the process). Defaults to a no-op; pass a logger sink if you
 * want visibility.
 */
export interface TaskCleanupSchedulerOptions {
  readonly storage: TaskStorage;
  readonly policy: TaskRetentionPolicy;
  readonly intervalMs: number;
  readonly onError?: (error: Error) => void;
}

/**
 * Background sweeper that periodically calls
 * {@link TaskStorage.cleanupTasksWithRetention} against a fixed policy.
 *
 * Lifecycle:
 *  - Construct with the storage, policy, and interval.
 *  - Call {@link start} to schedule the sweep (no-op if already running).
 *  - Call {@link stop} on shutdown to clear the timer (no-op if not running).
 *  - Call {@link runNow} for an immediate ad-hoc sweep, independent of the
 *    scheduled cadence.
 *
 * The underlying `setInterval` handle is `unref()`-ed when supported, so a
 * running scheduler does not block the process from exiting - matching how the
 * SSE heartbeat timer behaves.
 */
export class TaskCleanupScheduler {
  private readonly storage: TaskStorage;
  private readonly policy: TaskRetentionPolicy;
  private readonly intervalMs: number;
  private readonly onError: (error: Error) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TaskCleanupSchedulerOptions) {
    this.storage = options.storage;
    this.policy = options.policy;
    this.intervalMs = options.intervalMs;
    this.onError = options.onError ?? noop;
  }

  /** `true` while the background timer is scheduled. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Schedule the background sweep. Safe to call multiple times - additional
   * calls are no-ops while the timer is already running.
   */
  start(): void {
    if (this.timer !== null) return;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) return;

    this.timer = setInterval(() => {
      this.safeRun();
    }, this.intervalMs);
    const t = this.timer as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  /**
   * Cancel the background sweep. Safe to call multiple times - additional
   * calls are no-ops once stopped.
   */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Trigger one sweep right now and return the number of tasks evicted. Errors
   * propagate to the caller - unlike the scheduled sweep, which routes errors
   * through `onError` so the timer can keep firing.
   */
  runNow(): number {
    return this.storage.cleanupTasksWithRetention(this.policy);
  }

  private safeRun(): void {
    try {
      this.storage.cleanupTasksWithRetention(this.policy);
    } catch (error) {
      this.onError(error as Error);
    }
  }
}

/**
 * Shape returned by {@link loadCleanupOptionsFromEnv}. Mirrors the
 * `TaskCleanupScheduler` constructor's inputs minus `storage` and `onError`,
 * which the caller wires in.
 */
export interface CleanupOptionsFromEnv {
  readonly policy: TaskRetentionPolicy;
  readonly intervalMs: number;
}

/**
 * Read retention caps and the sweep interval from `env` (defaults to
 * `process.env`). Falls back to {@link DEFAULT_MAX_RETAINED_COMPLETED_TASKS},
 * {@link DEFAULT_MAX_RETAINED_FAILED_TASKS}, and
 * {@link DEFAULT_CLEANUP_INTERVAL_MS} when the corresponding env var is
 * unset, empty, or non-numeric.
 */
export function loadCleanupOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CleanupOptionsFromEnv {
  return {
    policy: {
      maxRetainedCompletedTasks: readInt(
        env[MAX_RETAINED_COMPLETED_TASKS_ENV],
        DEFAULT_MAX_RETAINED_COMPLETED_TASKS
      ),
      maxRetainedFailedTasks: readInt(
        env[MAX_RETAINED_FAILED_TASKS_ENV],
        DEFAULT_MAX_RETAINED_FAILED_TASKS
      ),
    },
    intervalMs: readInt(
      env[CLEANUP_INTERVAL_MS_ENV],
      DEFAULT_CLEANUP_INTERVAL_MS
    ),
  };
}

function readInt(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function noop(): void {}
