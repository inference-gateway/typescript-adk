import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import {
  CLEANUP_INTERVAL_MS_ENV,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_MAX_RETAINED_COMPLETED_TASKS,
  DEFAULT_MAX_RETAINED_FAILED_TASKS,
  InMemoryTaskStorage,
  MAX_RETAINED_COMPLETED_TASKS_ENV,
  MAX_RETAINED_FAILED_TASKS_ENV,
  TaskCleanupScheduler,
  loadCleanupOptionsFromEnv,
} from '../../src/storage/index.js';

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);
let counter = 0;

function nextIso(): string {
  counter += 1;
  return new Date(EPOCH + counter * 1000).toISOString();
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function completed(id: string): ManagedTask {
  const t = createTask({
    id,
    contextId: 'ctx',
    now: fixedClock(nextIso()),
  });
  const working = transitionTask(t, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(nextIso()),
  });
  return transitionTask(working, TASK_STATE.COMPLETED, {
    now: fixedClock(nextIso()),
  });
}

describe('TaskCleanupScheduler', () => {
  beforeEach(() => {
    counter = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not run until start() is called', () => {
    const storage = new InMemoryTaskStorage();
    const spy = vi.spyOn(storage, 'cleanupTasksWithRetention');
    new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(5000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sweeps on the configured interval after start()', () => {
    const storage = new InMemoryTaskStorage();
    const spy = vi.spyOn(storage, 'cleanupTasksWithRetention');
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
    });
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(spy).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it('stop() cancels future sweeps', () => {
    const storage = new InMemoryTaskStorage();
    const spy = vi.spyOn(storage, 'cleanupTasksWithRetention');
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
    });
    scheduler.start();
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent (no duplicate timers)', () => {
    const storage = new InMemoryTaskStorage();
    const spy = vi.spyOn(storage, 'cleanupTasksWithRetention');
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
    });
    scheduler.start();
    scheduler.start();
    scheduler.start();
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('stop() is idempotent', () => {
    const storage = new InMemoryTaskStorage();
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
    });
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('start() is a no-op when interval is not positive', () => {
    const storage = new InMemoryTaskStorage();
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 0,
    });
    scheduler.start();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('runNow() triggers an immediate sweep independent of the timer', () => {
    const storage = new InMemoryTaskStorage();
    storage.storeDeadLetter(completed('c1'));
    storage.storeDeadLetter(completed('c2'));
    storage.storeDeadLetter(completed('c3'));

    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 60_000,
    });
    expect(scheduler.runNow()).toBe(2);
    expect(storage.getTask('c3')).toMatchObject({ id: 'c3' });
    expect(storage.getTask('c1')).toBeUndefined();
    expect(storage.getTask('c2')).toBeUndefined();
  });

  it('routes scheduled-sweep errors through onError', () => {
    const storage = new InMemoryTaskStorage();
    const boom = new Error('boom');
    vi.spyOn(storage, 'cleanupTasksWithRetention').mockImplementation(() => {
      throw boom;
    });
    const errors: Error[] = [];
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
      onError: (err) => errors.push(err),
    });
    scheduler.start();
    vi.advanceTimersByTime(2000);
    expect(errors).toEqual([boom, boom]);
    scheduler.stop();
  });

  it('runNow() lets caller errors propagate', () => {
    const storage = new InMemoryTaskStorage();
    vi.spyOn(storage, 'cleanupTasksWithRetention').mockImplementation(() => {
      throw new Error('manual-boom');
    });
    const scheduler = new TaskCleanupScheduler({
      storage,
      policy: { maxRetainedCompletedTasks: 1 },
      intervalMs: 1000,
    });
    expect(() => scheduler.runNow()).toThrow('manual-boom');
  });
});

describe('loadCleanupOptionsFromEnv', () => {
  it('returns defaults when nothing is set', () => {
    const opts = loadCleanupOptionsFromEnv({});
    expect(opts.policy.maxRetainedCompletedTasks).toBe(
      DEFAULT_MAX_RETAINED_COMPLETED_TASKS
    );
    expect(opts.policy.maxRetainedFailedTasks).toBe(
      DEFAULT_MAX_RETAINED_FAILED_TASKS
    );
    expect(opts.intervalMs).toBe(DEFAULT_CLEANUP_INTERVAL_MS);
  });

  it('reads numeric overrides from the environment', () => {
    const opts = loadCleanupOptionsFromEnv({
      [MAX_RETAINED_COMPLETED_TASKS_ENV]: '7',
      [MAX_RETAINED_FAILED_TASKS_ENV]: '3',
      [CLEANUP_INTERVAL_MS_ENV]: '12345',
    });
    expect(opts.policy.maxRetainedCompletedTasks).toBe(7);
    expect(opts.policy.maxRetainedFailedTasks).toBe(3);
    expect(opts.intervalMs).toBe(12345);
  });

  it('falls back to defaults on empty or non-numeric values', () => {
    const opts = loadCleanupOptionsFromEnv({
      [MAX_RETAINED_COMPLETED_TASKS_ENV]: '',
      [MAX_RETAINED_FAILED_TASKS_ENV]: 'nope',
      [CLEANUP_INTERVAL_MS_ENV]: '   ',
    });
    expect(opts.policy.maxRetainedCompletedTasks).toBe(
      DEFAULT_MAX_RETAINED_COMPLETED_TASKS
    );
    expect(opts.policy.maxRetainedFailedTasks).toBe(
      DEFAULT_MAX_RETAINED_FAILED_TASKS
    );
    expect(opts.intervalMs).toBe(DEFAULT_CLEANUP_INTERVAL_MS);
  });

  it('truncates fractional values to integers', () => {
    const opts = loadCleanupOptionsFromEnv({
      [MAX_RETAINED_COMPLETED_TASKS_ENV]: '7.9',
      [CLEANUP_INTERVAL_MS_ENV]: '500.4',
    });
    expect(opts.policy.maxRetainedCompletedTasks).toBe(7);
    expect(opts.intervalMs).toBe(500);
  });

  it('allows zero (prune-all) caps and zero interval', () => {
    const opts = loadCleanupOptionsFromEnv({
      [MAX_RETAINED_COMPLETED_TASKS_ENV]: '0',
      [MAX_RETAINED_FAILED_TASKS_ENV]: '0',
      [CLEANUP_INTERVAL_MS_ENV]: '0',
    });
    expect(opts.policy.maxRetainedCompletedTasks).toBe(0);
    expect(opts.policy.maxRetainedFailedTasks).toBe(0);
    expect(opts.intervalMs).toBe(0);
  });
});
