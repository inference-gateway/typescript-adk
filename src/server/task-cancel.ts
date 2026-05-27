import {
  TASK_STATE,
  isTerminal,
  toWireTask,
  transitionTask,
} from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type { Struct, Task } from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';
import type { TaskCancellationRegistry } from './task-cancellation.js';

/**
 * Canonical JSON-RPC method name for the A2A `tasks/cancel` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_CANCEL_METHOD = 'tasks/cancel';

/**
 * JSON-RPC params accepted by the A2A `tasks/cancel` method.
 *
 * Mirrors `types.TaskIdParams` in the Go ADK (see
 * https://github.com/inference-gateway/adk/blob/main/types/types.go) but uses
 * the field name `taskId` rather than `id`, matching {@link
 * import('./task-get.js').TaskGetParams} for consistency across the
 * `tasks/*` family.
 */
export interface TaskCancelParams {
  readonly taskId: string;
  readonly metadata?: Struct;
}

export interface TaskCancelHandlerOptions {
  /** Storage backend to look up and mutate tasks in. */
  readonly storage: TaskStorage;
  /**
   * Shared cancellation registry. When a task is `IN_PROGRESS` or
   * `INPUT_REQUIRED`, the handler aborts the controller registered here so
   * the running task handler exits cleanly. May be omitted when the server
   * has no long-running handlers (cancellation still works for `PENDING`
   * tasks since they're dropped from the queue directly).
   */
  readonly registry?: TaskCancellationRegistry;
  /** Clock injection point; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Build a handler for the A2A `tasks/cancel` JSON-RPC method.
 *
 * Behaviour by current task state (mirrors the Go ADK's `CancelTask` in
 * `adk/server/task_manager.go`):
 *
 *  - `PENDING`: drop the task from the FIFO queue (so no worker dequeues
 *    it), transition to `CANCELLED`, move to the dead-letter store.
 *  - `IN_PROGRESS` or `INPUT_REQUIRED`: abort the `AbortController`
 *    registered in {@link TaskCancellationRegistry} (so the running handler
 *    observes the cancellation and exits), transition the task to
 *    `CANCELLED`, move it to the dead-letter store.
 *  - terminal (`COMPLETED` / `FAILED` / `CANCELLED`): return a JSON-RPC
 *    `-32602` error - terminal tasks cannot be cancelled.
 *  - unknown task id: return a JSON-RPC `-32602` "task not found".
 *
 * On success the handler returns the wire-format `Task` reflecting the
 * post-cancellation state. The state transition is synchronous - the call
 * does not wait for the aborted handler to fully unwind, only signals it.
 *
 * Register on an {@link import('./server.js').A2AServer} via
 * `server.registerMethod(TASK_CANCEL_METHOD, createTaskCancelHandler({ storage, registry }))`.
 */
export function createTaskCancelHandler(
  options: TaskCancelHandlerOptions
): MethodHandler<unknown, Task> {
  const { storage, registry } = options;
  const clock = options.now ?? defaultNow;

  return (params: unknown): Task => {
    const validated = validateTaskCancelParams(params);
    const task = storage.getTask(validated.taskId);
    if (task === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'task not found'
      );
    }
    if (isTerminal(task.state)) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        `task cannot be cancelled in state ${task.state}`
      );
    }

    const wasPending = task.state === TASK_STATE.PENDING;
    if (wasPending) {
      storage.removeFromQueue(task.id);
    }

    registry?.cancel(
      task.id,
      new DOMException('Task cancelled via tasks/cancel', 'AbortError')
    );

    const cancelled = transitionTask(task, TASK_STATE.CANCELLED, {
      now: clock,
    });
    storage.storeDeadLetter(cancelled);

    return toWireTask(cancelled);
  };
}

function validateTaskCancelParams(params: unknown): TaskCancelParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected TaskCancelParams object'
    );
  }
  const obj = params as Record<string, unknown>;

  const taskId = obj['taskId'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: taskId is required and must be a non-empty string'
    );
  }

  const rawMetadata = obj['metadata'];
  if (rawMetadata !== undefined) {
    if (
      rawMetadata === null ||
      typeof rawMetadata !== 'object' ||
      Array.isArray(rawMetadata)
    ) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: metadata must be an object'
      );
    }
    return { taskId, metadata: rawMetadata as Struct };
  }

  return { taskId };
}

function defaultNow(): Date {
  return new Date();
}
