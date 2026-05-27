import { toWireTask, type ManagedTask } from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type { Struct, Task, TaskState } from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A `tasks/list` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_LIST_METHOD = 'tasks/list';

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

/**
 * JSON-RPC params accepted by the A2A `tasks/list` method.
 *
 * Mirrors the Go ADK's `types.TaskListParams` in spirit but swaps offset+limit
 * for keyset pagination - `cursor` is the opaque continuation token returned
 * as `nextCursor` on the previous page. Stable under inserts/deletes because
 * the cursor encodes the `(createdAt, id)` of the last item on the previous
 * page; subsequent pages start at the first task strictly after that point.
 *
 * Field names are deliberately simpler than the A2A wire schema
 * (`ListTasksRequest`) - `limit`/`cursor` rather than `pageSize`/`pageToken` -
 * to match the issue's stated API shape and stay terse for callers.
 */
export interface TaskListParams {
  /** Filter to tasks whose `status.state` equals this value. */
  readonly state?: TaskState;
  /** Filter to tasks whose `contextId` equals this value. */
  readonly contextId?: string;
  /**
   * Maximum number of tasks to return. Clamped to `[1, maxLimit]`; defaults
   * to {@link TaskListHandlerOptions.defaultLimit} when omitted.
   */
  readonly limit?: number;
  /**
   * Opaque continuation token from the `nextCursor` field of a previous
   * response. Treat it as a black box on the client side - the encoding is an
   * implementation detail and may change.
   */
  readonly cursor?: string;
  readonly metadata?: Struct;
}

/**
 * JSON-RPC result returned by the A2A `tasks/list` method.
 *
 * `nextCursor` is omitted when the returned page is the last page; clients
 * should stop paginating once they receive a response without it.
 */
export interface TaskListResult {
  readonly tasks: Task[];
  readonly nextCursor?: string;
}

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
 * Build a handler for the A2A `tasks/list` JSON-RPC method.
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
): MethodHandler<unknown, TaskListResult> {
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

  return (params: unknown): TaskListResult => {
    const validated = validateTaskListParams(params);

    const limit =
      validated.limit !== undefined
        ? Math.min(validated.limit, maxLimit)
        : defaultLimit;

    // `state` from A2A `TaskState` is a superset of `ManagedTaskState`. Pass
    // it through verbatim - non-managed values just yield zero matches against
    // tasks created by this server, which is the right behaviour.
    const filter = {
      ...(validated.contextId !== undefined
        ? { contextId: validated.contextId }
        : {}),
      ...(validated.state !== undefined ? { state: validated.state } : {}),
    } as Parameters<TaskStorage['listTasks']>[0];

    const all = storage.listTasks(filter);
    const startIndex =
      validated.cursor !== undefined
        ? findCursorStartIndex(all, decodeCursor(validated.cursor))
        : 0;

    const page = all.slice(startIndex, startIndex + limit);
    const wireTasks = page.map((task) => toWireTask(task));

    const hasMore = startIndex + limit < all.length;
    if (!hasMore || page.length === 0) {
      return { tasks: wireTasks };
    }
    const last = page[page.length - 1];
    if (last === undefined) {
      return { tasks: wireTasks };
    }
    return {
      tasks: wireTasks,
      nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }),
    };
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

function validateTaskListParams(params: unknown): TaskListParams {
  if (params === undefined) {
    return {};
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected TaskListParams object'
    );
  }
  const obj = params as Record<string, unknown>;

  const out: { -readonly [K in keyof TaskListParams]: TaskListParams[K] } = {};

  const rawState = obj['state'];
  if (rawState !== undefined) {
    if (typeof rawState !== 'string' || rawState.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: state must be a non-empty string'
      );
    }
    out.state = rawState as TaskState;
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

  const rawLimit = obj['limit'];
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit <= 0
    ) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: limit must be a positive integer'
      );
    }
    out.limit = rawLimit;
  }

  const rawCursor = obj['cursor'];
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string' || rawCursor.length === 0) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'invalid params: cursor must be a non-empty string'
      );
    }
    out.cursor = rawCursor;
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
    out.metadata = rawMetadata as Struct;
  }

  return out;
}
