import { toWireTask } from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type { Struct, Task } from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A `tasks/get` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_GET_METHOD = 'tasks/get';

/**
 * JSON-RPC params accepted by the A2A `tasks/get` method.
 *
 * Mirrors `types.TaskQueryParams` in the Go ADK (see
 * https://github.com/inference-gateway/adk/blob/main/types/types.go), but uses
 * `taskId` instead of `id` to match the field name used elsewhere in the A2A
 * schema (e.g., `Message.taskId`).
 *
 * `historyLength`, when provided, caps the returned `history` to that many
 * most-recent messages. Omitting it returns the full history.
 */
export interface TaskGetParams {
  readonly taskId: string;
  readonly historyLength?: number;
  readonly metadata?: Struct;
}

export interface TaskGetHandlerOptions {
  /** Storage backend to look up tasks in (both active and dead-letter). */
  readonly storage: TaskStorage;
}

/**
 * Build a handler for the A2A `tasks/get` JSON-RPC method.
 *
 * Looks up the task by id via {@link TaskStorage.getTask} - which searches
 * both the active map and the dead-letter store - and returns the wire-format
 * `Task`. When `historyLength` is supplied, the returned `history` is sliced
 * to the last N messages.
 *
 * Errors surface as JSON-RPC `-32602` (Invalid Params) via {@link JSONRPCError}:
 *  - missing/non-string `taskId`
 *  - `historyLength` present but not a non-negative integer
 *  - task not found
 *
 * The "not found" case using `-32602` (rather than a custom code) mirrors the
 * Go ADK's choice in `adk/server/task_handler.go:HandleTaskGet`.
 *
 * Register on an {@link A2AServer} via
 * `server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }))`.
 */
export function createTaskGetHandler(
  options: TaskGetHandlerOptions
): MethodHandler<unknown, Task> {
  const { storage } = options;

  return (params: unknown): Task => {
    const validated = validateTaskGetParams(params);
    const task = storage.getTask(validated.taskId);
    if (task === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'task not found'
      );
    }
    return toWireTask(task, validated.historyLength);
  };
}

function validateTaskGetParams(params: unknown): TaskGetParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected TaskGetParams object'
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

  return historyLength === undefined ? { taskId } : { taskId, historyLength };
}
