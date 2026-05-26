import { isTerminal, type ManagedTask } from '../agent/task.js';
import {
  TaskStorageError,
  type TaskListFilter,
  type TaskStorage,
  type TaskStorageStats,
} from './task-storage.js';

interface DequeueWaiter {
  resolve(task: ManagedTask): void;
  reject(reason: unknown): void;
  cleanup(): void;
}

/**
 * In-memory {@link TaskStorage} implementation.
 *
 * Concurrency model: JavaScript is single-threaded, so operations that don't
 * `await` are already atomic. The only awaiting operation is {@link dequeue},
 * which uses a FIFO waiter list rather than a lock — handoffs from `enqueue`
 * to the oldest waiting `dequeue` are O(1) and preserve queue ordering.
 *
 * Memory model: tasks are stored by reference. `ManagedTask` is fully
 * `readonly`, so callers cannot mutate; state changes go through
 * {@link updateActive}.
 */
export class InMemoryTaskStorage implements TaskStorage {
  private readonly activeTasks = new Map<string, ManagedTask>();
  private readonly deadLetterTasks = new Map<string, ManagedTask>();
  private readonly contextIndex = new Map<string, Set<string>>();
  private readonly queue: ManagedTask[] = [];
  private readonly waiters: DequeueWaiter[] = [];

  enqueue(task: ManagedTask): void {
    this.activeTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.cleanup();
      waiter.resolve(task);
      return;
    }
    this.queue.push(task);
  }

  dequeue(signal?: AbortSignal): Promise<ManagedTask> {
    if (signal?.aborted === true) {
      return Promise.reject(this.abortReason(signal));
    }

    const head = this.queue.shift();
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

      if (signal === undefined) {
        return;
      }
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(this.abortReason(signal));
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

  createActive(task: ManagedTask): void {
    if (this.activeTasks.has(task.id)) {
      throw new TaskStorageError(`active task already exists: ${task.id}`);
    }
    this.activeTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);
  }

  getActive(taskId: string): ManagedTask | undefined {
    return this.activeTasks.get(taskId);
  }

  updateActive(task: ManagedTask): void {
    if (!this.activeTasks.has(task.id)) {
      throw new TaskStorageError(`active task not found: ${task.id}`);
    }
    this.activeTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);
  }

  storeDeadLetter(task: ManagedTask): void {
    this.deadLetterTasks.set(task.id, task);
    this.indexContext(task.contextId, task.id);
    this.activeTasks.delete(task.id);
  }

  getTask(taskId: string): ManagedTask | undefined {
    return this.activeTasks.get(taskId) ?? this.deadLetterTasks.get(taskId);
  }

  listTasks(filter: TaskListFilter = {}): ManagedTask[] {
    const seen = new Set<string>();
    const collected: ManagedTask[] = [];

    const consider = (task: ManagedTask): void => {
      if (seen.has(task.id)) {
        return;
      }
      if (filter.state !== undefined && task.state !== filter.state) {
        return;
      }
      if (
        filter.contextId !== undefined &&
        task.contextId !== filter.contextId
      ) {
        return;
      }
      seen.add(task.id);
      collected.push(task);
    };

    for (const task of this.activeTasks.values()) {
      consider(task);
    }
    for (const task of this.deadLetterTasks.values()) {
      consider(task);
    }

    collected.sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }
      return a.createdAt < b.createdAt ? -1 : 1;
    });

    const offset = filter.offset !== undefined ? Math.max(0, filter.offset) : 0;
    if (offset >= collected.length) {
      return [];
    }
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
    if (taskIds === undefined) {
      return 0;
    }

    let removed = 0;
    for (const id of taskIds) {
      if (this.activeTasks.delete(id)) {
        removed++;
      }
      if (this.deadLetterTasks.delete(id)) {
        removed++;
      }
    }

    for (let i = this.queue.length - 1; i >= 0; i--) {
      const queued = this.queue[i];
      if (queued !== undefined && queued.contextId === contextId) {
        this.queue.splice(i, 1);
      }
    }

    this.contextIndex.delete(contextId);
    return removed;
  }

  cleanupCompleted(): number {
    let removed = 0;
    for (const [id, task] of this.deadLetterTasks) {
      if (isTerminal(task.state)) {
        this.deadLetterTasks.delete(id);
        this.unindexContext(task.contextId, id);
        removed++;
      }
    }
    return removed;
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

  private indexContext(contextId: string, taskId: string): void {
    let set = this.contextIndex.get(contextId);
    if (set === undefined) {
      set = new Set();
      this.contextIndex.set(contextId, set);
    }
    set.add(taskId);
  }

  private unindexContext(contextId: string, taskId: string): void {
    const set = this.contextIndex.get(contextId);
    if (set === undefined) {
      return;
    }
    set.delete(taskId);
    if (set.size === 0) {
      this.contextIndex.delete(contextId);
    }
  }

  private abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('Aborted', 'AbortError');
  }
}
