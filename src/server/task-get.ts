import { toWireTask } from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  A2AMethod,
  GetTaskRequest,
  Task,
} from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import {
  withoutInactiveExtensions,
  type MethodHandler,
} from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A `GetTask` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_GET_METHOD = 'GetTask' satisfies A2AMethod;

export interface TaskGetHandlerOptions {
  /** Storage backend to look up tasks in (both active and dead-letter). */
  readonly storage: TaskStorage;
}

/**
 * Build a handler for the A2A `GetTask` JSON-RPC method.
 *
 * Looks up the task by id via {@link TaskStorage.getTask} - which searches
 * both the active map and the dead-letter store - and returns the wire-format
 * `Task`. When `historyLength` is supplied, the returned `history` is sliced
 * to the last N messages.
 *
 * Errors surface via {@link JSONRPCError}: `-32602` (Invalid Params) for a
 * missing/non-string `taskId` or a `historyLength` that is not a non-negative
 * integer, and `-32001` (TaskNotFound) for an unknown task.
 *
 * Register on an {@link A2AServer} via
 * `server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }))`.
 */
export function createTaskGetHandler(
  options: TaskGetHandlerOptions
): MethodHandler<unknown, Task> {
  const { storage } = options;

  return (params, context): Task => {
    const validated = validateTaskGetParams(params);
    const task = storage.getTask(validated.id);
    if (task === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.TASK_NOT_FOUND_ERROR,
        'task not found'
      );
    }
    return withoutInactiveExtensions(
      toWireTask(task, validated.historyLength),
      context
    );
  };
}

function validateTaskGetParams(params: unknown): GetTaskRequest {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected GetTaskRequest object'
    );
  }
  const obj = params as Record<string, unknown>;

  const taskId = obj['id'];
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: id is required and must be a non-empty string'
    );
  }

  const rawHistoryLength = obj['historyLength'];
  let historyLength: number | undefined;
  if (rawHistoryLength !== undefined) {
    if (
      typeof rawHistoryLength !== 'number' ||
      !Number.isInteger(rawHistoryLength) ||
      rawHistoryLength < 0
    ) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: historyLength must be a non-negative integer'
      );
    }
    historyLength = rawHistoryLength;
  }

  return historyLength === undefined
    ? { id: taskId }
    : { id: taskId, historyLength };
}
