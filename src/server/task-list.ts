import { toWireTask, type ManagedTask } from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  A2AMethod,
  ListTasksRequest,
  ListTasksResponse,
  TaskState,
} from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A `ListTasks` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_LIST_METHOD = 'ListTasks' satisfies A2AMethod;

/**
 * Default cap on `limit` when the caller omits it. Mirrors the upper bound
 * suggested in the A2A `ListTasksRequest.pageSize` doc comment ("between 1 and
 * 100"). Configurable via {@link TaskListHandlerOptions.defaultLimit}.
 */
export const DEFAULT_TASK_LIST_LIMIT = 100;

/**
 * Maximum value the handler will accept for `limit`. Requests with `limit`
 * above this are clamped down silently (consistent with the way Go ADK clamps
 * its pagination caps). Configurable via {@link TaskListHandlerOptions.maxLimit}.
 */
export const MAX_TASK_LIST_LIMIT = 100;

export interface TaskListHandlerOptions {
  /** Storage backend to list tasks from. */
  readonly storage: TaskStorage;
  /**
   * Page size used when the caller omits `limit`. Defaults to
   * {@link DEFAULT_TASK_LIST_LIMIT}. Clamped at construction time to
   * `[1, maxLimit]` so a misconfiguration can't silently exceed the cap.
   */
  readonly defaultLimit?: number;
  /**
   * Hard cap on the page size. Defaults to {@link MAX_TASK_LIST_LIMIT}.
   * Requests with `limit` above this are clamped down without error.
   */
  readonly maxLimit?: number;
}

/**
 * Build a handler for the A2A `ListTasks` JSON-RPC method.
 *
 * Lists tasks via {@link TaskStorage.listTasks} (which spans both active and
 * dead-letter stores in FIFO `createdAt` order), filters by the optional
 * `state` and `contextId`, and paginates by an opaque base64 cursor that
 * encodes the `(createdAt, id)` of the last task on the previous page.
 *
 * Keyset pagination is stable under concurrent inserts and deletes:
 *  - Tasks inserted before the cursor are never returned (already past).
 *  - Tasks inserted after the cursor appear on subsequent pages.
 *  - If the task referenced by the cursor is deleted, pagination resumes from
 *    the first task strictly after that `(createdAt, id)`.
 *
 * Errors surface as JSON-RPC `-32602` (Invalid Params) via {@link JSONRPCError}:
 *  - `params` not an object, or `state` / `contextId` / `cursor` of the wrong type
 *  - `limit` not a positive integer (`0`, negatives, and non-integers are rejected)
 *  - `cursor` not decodable as the expected `{ createdAt, id }` envelope
 *
 * Register on an {@link A2AServer} via
 * `server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }))`.
 */
export function createTaskListHandler(
  options: TaskListHandlerOptions
): MethodHandler<unknown, ListTasksResponse> {
  const { storage } = options;
  const maxLimit = options.maxLimit ?? MAX_TASK_LIST_LIMIT;
  if (!Number.isInteger(maxLimit) || maxLimit <= 0) {
    throw new Error('maxLimit must be a positive integer');
  }
  const rawDefault = options.defaultLimit ?? DEFAULT_TASK_LIST_LIMIT;
  if (!Number.isInteger(rawDefault) || rawDefault <= 0) {
    throw new Error('defaultLimit must be a positive integer');
  }
  const defaultLimit = Math.min(rawDefault, maxLimit);

  return (params: unknown): ListTasksResponse => {
    const validated = validateTaskListParams(params);

    const limit =
      validated.pageSize !== undefined
        ? Math.min(validated.pageSize, maxLimit)
        : defaultLimit;

    // `state` from A2A `TaskState` is a superset of `ManagedTaskState`. Pass
    // it through verbatim - non-managed values just yield zero matches against
    // tasks created by this server, which is the right behaviour.
    const filter = {
      ...(validated.contextId !== undefined
        ? { contextId: validated.contextId }
        : {}),
      ...(validated.status !== undefined ? { state: validated.status } : {}),
    } as Parameters<TaskStorage['listTasks']>[0];

    const all = storage.listTasks(filter);
    const startIndex =
      validated.pageToken !== undefined
        ? findCursorStartIndex(all, decodeCursor(validated.pageToken))
        : 0;

    const page = all.slice(startIndex, startIndex + limit);
    const wireTasks = page.map((task) => toWireTask(task));

    const result = {
      tasks: wireTasks,
      pageSize: limit,
      totalSize: all.length,
      nextPageToken: '',
    };
    const last = page[page.length - 1];
    const hasMore = startIndex + limit < all.length;
    if (hasMore && last !== undefined) {
      result.nextPageToken = encodeCursor({
        createdAt: last.createdAt,
        id: last.id,
      });
    }
    return result;
  };
}

interface CursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): CursorPayload {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: cursor is not a valid base64url string'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: cursor payload is not valid JSON'
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: cursor payload is malformed'
    );
  }
  const obj = parsed as Record<string, unknown>;
  const createdAt = obj['createdAt'];
  const id = obj['id'];
  if (typeof createdAt !== 'string' || typeof id !== 'string') {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: cursor payload is missing required fields'
    );
  }
  return { createdAt, id };
}

/**
 * Locate the first index in `tasks` strictly greater than `cursor`'s
 * `(createdAt, id)` keypair. Mirrors the comparator used by
 * {@link InMemoryTaskStorage.listTasks} so subsequent pages start at the right
 * boundary regardless of inserts/deletes.
 */
function findCursorStartIndex(
  tasks: readonly ManagedTask[],
  cursor: CursorPayload
): number {
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (task === undefined) {
      continue;
    }
    if (compareKey(task.createdAt, task.id, cursor.createdAt, cursor.id) > 0) {
      return i;
    }
  }
  return tasks.length;
}

function compareKey(
  aCreatedAt: string,
  aId: string,
  bCreatedAt: string,
  bId: string
): number {
  if (aCreatedAt < bCreatedAt) return -1;
  if (aCreatedAt > bCreatedAt) return 1;
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

function validateTaskListParams(params: unknown): ListTasksRequest {
  if (params === undefined) {
    return {};
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected ListTasksRequest object'
    );
  }
  const obj = params as Record<string, unknown>;

  const out: { -readonly [K in keyof ListTasksRequest]: ListTasksRequest[K] } =
    {};

  const rawState = obj['status'];
  if (rawState !== undefined) {
    if (typeof rawState !== 'string' || rawState.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: status must be a non-empty string'
      );
    }
    out.status = rawState as TaskState;
  }

  const rawContextId = obj['contextId'];
  if (rawContextId !== undefined) {
    if (typeof rawContextId !== 'string' || rawContextId.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: contextId must be a non-empty string'
      );
    }
    out.contextId = rawContextId;
  }

  const rawLimit = obj['pageSize'];
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit <= 0
    ) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: pageSize must be a positive integer'
      );
    }
    out.pageSize = rawLimit;
  }

  const rawCursor = obj['pageToken'];
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string' || rawCursor.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: pageToken must be a non-empty string'
      );
    }
    out.pageToken = rawCursor;
  }

  return out;
}
