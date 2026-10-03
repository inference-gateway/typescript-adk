import { isTerminal, toWireTask } from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  A2AMethod,
  SubscribeToTaskRequest,
} from '../types/generated/a2a.js';
import type { CloudEvent } from './cloudevents.js';
import {
  JSONRPC_ERROR_CODES,
  JSONRPCError,
  createSuccessResponse,
} from './jsonrpc.js';
import {
  streamResponseFrame,
  type StreamingMethodHandler,
  type StreamingMethodResult,
} from './message-stream.js';
import type { MethodContext } from './method-registry.js';
import { SSEStreamWriter } from './sse.js';
import type { TaskEventBusRegistry } from './task-event-bus.js';

/**
 * Canonical JSON-RPC method name for the A2A `SubscribeToTask` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_RESUBSCRIBE_METHOD = 'SubscribeToTask' satisfies A2AMethod;

export interface TaskResubscribeHandlerOptions {
  /** Storage backend to look up tasks in (both active and dead-letter). */
  readonly storage: TaskStorage;
  /**
   * Shared per-task event bus registry. The `SendStreamingMessage` handler creates
   * a bus per running task; the resubscribe handler attaches an SSE
   * subscriber to it so the same stream is delivered to every caller. Without
   * a registry, resubscribers can only replay the current persisted state -
   * no live updates are possible.
   */
  readonly eventBusRegistry?: TaskEventBusRegistry;
  /**
   * Override the SSE heartbeat interval (ms) passed to the underlying
   * {@link SSEStreamWriter}. Defaults to the writer's own default (30 s); pass
   * `0` to disable heartbeats. Heartbeats are SSE comment frames; they keep
   * intermediate proxies from closing the connection but carry no payload.
   */
  readonly heartbeatMs?: number;
  /**
   * @deprecated No effect: the first frame is now the task itself, not a
   * synthesized status CloudEvent.
   */
  readonly eventSource?: string;
}

/**
 * Build a handler for the A2A `SubscribeToTask` JSON-RPC method.
 *
 * Behaviour:
 *  - Synchronous validation: `taskId` must be a non-empty string (`-32602`)
 *    and the task must exist in storage (`-32001` TaskNotFound). Failures
 *    throw {@link JSONRPCError}, which the server converts to a regular
 *    JSON-RPC error response without ever opening the SSE stream.
 *  - Task-then-live: the handler opens an SSE response whose first event is
 *    the task's current state (spec 3.1.6). When the task is still running,
 *    the handler attaches to the bus and forwards every subsequent event as
 *    a `StreamResponse` until the bus closes (typically when the producing
 *    `SendStreamingMessage` invocation reaches a terminal state).
 *  - Fan-out: multiple concurrent `SubscribeToTask` callers for the same
 *    task each receive their own independent SSE stream, all driven by the
 *    same per-task bus. Each subscriber sees the same sequence of frames
 *    from the moment it subscribes.
 *  - Terminal task: when the task is already in a terminal state by the
 *    time `SubscribeToTask` is called, the handler emits the task and closes
 *    the stream immediately.
 *
 * Mirrors the Go ADK's `HandleTaskResubscribe`
 * (`adk/server/task_handler.go`). There is no `[DONE]` sentinel; the SSE
 * stream simply closes after the last event.
 *
 * Register on an {@link import('./server.js').A2AServer} via
 * `server.registerStreamingMethod(TASK_RESUBSCRIBE_METHOD,
 * createTaskResubscribeHandler({ storage, eventBusRegistry }))`.
 */
export function createTaskResubscribeHandler(
  options: TaskResubscribeHandlerOptions
): StreamingMethodHandler {
  const { storage, eventBusRegistry } = options;

  return (params: unknown, context: MethodContext): StreamingMethodResult => {
    const validated = validateTaskResubscribeParams(params);
    const task = storage.getTask(validated.id);
    if (task === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.TASK_NOT_FOUND_ERROR,
        'task not found'
      );
    }

    const requestId = context.requestId ?? null;
    const writer = new SSEStreamWriter({
      signal: context.signal,
      frame: streamResponseFrame(requestId, task),
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
    });

    const bus = eventBusRegistry?.get(task.id);

    const done = (async (): Promise<void> => {
      try {
        writer.send(
          createSuccessResponse(requestId, { task: toWireTask(task) })
        );
        if (bus === undefined || bus.closed || isTerminal(task.state)) {
          return;
        }
        await new Promise<void>((resolve) => {
          const subscription = bus.subscribe(
            (event) => writer.emitCloudEvent(event),
            () => {
              subscription.unsubscribe();
              resolve();
            }
          );
          if (context.signal.aborted) {
            subscription.unsubscribe();
            resolve();
            return;
          }
          const onAbort = (): void => {
            subscription.unsubscribe();
            resolve();
          };
          context.signal.addEventListener('abort', onAbort, { once: true });
        });
      } finally {
        writer.close();
      }
    })();

    return { readable: writer.readable, done };
  };
}

function validateTaskResubscribeParams(
  params: unknown
): SubscribeToTaskRequest {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected SubscribeToTaskRequest object'
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

  return { id: taskId };
}

// Re-export `CloudEvent` so TS-DOC links from the handler are resolvable
// when the file is consumed via its standalone module path.
export type { CloudEvent };
