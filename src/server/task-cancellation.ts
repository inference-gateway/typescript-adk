/**
 * Process-wide map of `taskId -> AbortController`, shared between the server
 * core and any handler (background or streaming) that drives a long-running
 * task. The {@link import('./task-cancel.js').createTaskCancelHandler}
 * `tasks/cancel` handler consults this registry to abort the in-flight handler
 * that owns a task; the handler is responsible for registering its controller
 * before work starts and unregistering it once the task reaches a terminal
 * state, so the registry never leaks past task completion.
 *
 * Mirrors the Go ADK's `RegisterTaskCancelFunc` / `UnregisterTaskCancelFunc` /
 * runningTasks map on `DefaultTaskManager` (`adk/server/task_manager.go`). The
 * TS variant exposes a structural class rather than methods on the task
 * manager because the TS server core does not yet have a unified task-manager
 * abstraction - the registry is the shared piece.
 *
 * Single-threaded by virtue of JavaScript's execution model: registry mutation
 * is atomic between awaits, so no internal locking is needed. Methods are
 * idempotent where it makes sense (`unregister` on an unknown id, `cancel` on
 * an unknown id) so callers don't have to coordinate.
 */
export class TaskCancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Register `controller` as the abort controller for `taskId`. Replaces any
   * previously registered controller for the same id; callers that need to
   * coordinate multiple concurrent handlers for the same task should
   * deduplicate upstream.
   */
  register(taskId: string, controller: AbortController): void {
    this.controllers.set(taskId, controller);
  }

  /**
   * Drop the controller registered for `taskId` without aborting it. Returns
   * `true` if a controller was registered (and is now gone), `false`
   * otherwise. Safe to call unconditionally from a `finally` block.
   */
  unregister(taskId: string): boolean {
    return this.controllers.delete(taskId);
  }

  /**
   * Abort the controller registered for `taskId` and drop it from the
   * registry. Returns `true` if a controller was registered (and was
   * aborted), `false` if no controller was registered for that id (e.g., the
   * task is PENDING in the queue with no handler running yet).
   *
   * `reason` is forwarded to {@link AbortController.abort} verbatim; pass an
   * `Error` instance (or a string the caller is happy to see appear in
   * `signal.reason`) so downstream `AbortSignal` consumers can surface a
   * meaningful diagnostic.
   */
  cancel(taskId: string, reason?: unknown): boolean {
    const controller = this.controllers.get(taskId);
    if (controller === undefined) {
      return false;
    }
    this.controllers.delete(taskId);
    controller.abort(reason);
    return true;
  }

  /** True when a controller is registered for `taskId`. */
  has(taskId: string): boolean {
    return this.controllers.has(taskId);
  }

  /** Number of currently registered controllers. Useful for diagnostics. */
  size(): number {
    return this.controllers.size;
  }

  /**
   * Drop every registered controller without aborting them. Intended for
   * tests that share a registry across cases - production code should rely on
   * per-task `unregister` calls so cancellation reasons stay scoped.
   */
  clear(): void {
    this.controllers.clear();
  }
}
