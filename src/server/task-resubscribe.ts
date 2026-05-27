import { isTerminal } from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  Struct,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '../types/generated/a2a.js';
import {
  AGENT_EVENT_TYPE,
  type AgentEventType,
  type CloudEvent,
} from './cloudevents.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { StreamingMethodHandler } from './message-stream.js';
import type { MethodContext } from './method-registry.js';
import { SSEStreamWriter } from './sse.js';
import type { StreamingMethodResult } from './message-stream.js';
import type { TaskEventBusRegistry } from './task-event-bus.js';

/**
 * Canonical JSON-RPC method name for the A2A `tasks/resubscribe` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const TASK_RESUBSCRIBE_METHOD = 'tasks/resubscribe';

/**
 * JSON-RPC params accepted by the A2A `tasks/resubscribe` method.
 *
 * Uses the field name `taskId` to match {@link
 * import('./task-cancel.js').TaskCancelParams} and {@link
 * import('./task-get.js').TaskGetParams} across the `tasks/*` family. The Go
 * ADK currently uses `name` here for historical reasons; the TS ADK is
 * deliberately consistent with its other `tasks/*` shapes.
 */
export interface TaskResubscribeParams {
  readonly taskId: string;
  readonly metadata?: Struct;
}

export interface TaskResubscribeHandlerOptions {
  /** Storage backend to look up tasks in (both active and dead-letter). */
  readonly storage: TaskStorage;
  /**
   * Shared per-task event bus registry. The `message/stream` handler creates
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
   * Override the `source` attribute of synthesized status CloudEvents (the
   * replay frame emitted when no live bus event is available). Defaults to
   * the value baked into {@link createCloudEvent} (`'adk/agent'`).
   */
  readonly eventSource?: string;
}

/**
 * Build a handler for the A2A `tasks/resubscribe` JSON-RPC method.
 *
 * Behaviour:
 *  - Synchronous validation: `taskId` must be a non-empty string and the
 *    task must exist in storage. Failures throw {@link JSONRPCError}
 *    (`-32602`) which the server converts to a regular JSON-RPC error
 *    response without ever opening the SSE stream.
 *  - Replay-then-live: the handler opens an SSE response and emits the most
 *    recent `task.status.changed` CloudEvent as the first frame - taken from
 *    the per-task bus's replay buffer when available, otherwise synthesized
 *    from the task's persisted state. When the task is still running, the
 *    handler attaches to the bus and forwards every subsequent CloudEvent
 *    verbatim until the bus closes (typically when the producing
 *    `message/stream` invocation reaches a terminal state).
 *  - Fan-out: multiple concurrent `tasks/resubscribe` callers for the same
 *    task each receive their own independent SSE stream, all driven by the
 *    same per-task bus. Each subscriber sees the same sequence of frames
 *    from the moment it subscribes.
 *  - Terminal task: when the task is already in a terminal state by the
 *    time `tasks/resubscribe` is called, the handler emits a single
 *    `task.status.changed` frame with `final: true` (reflecting the
 *    persisted state) and closes the stream immediately.
 *
 * Mirrors the Go ADK's `HandleTaskResubscribe`
 * (`adk/server/task_handler.go`), adapted for the TS ADK's CloudEvents-based
 * SSE wire format - we do not emit a `[DONE]` sentinel, the SSE stream simply
 * closes after the terminal status frame.
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
    const task = storage.getTask(validated.taskId);
    if (task === undefined) {
      throw new JSONRPCError(
        JSONRPC_ERROR_CODES.INVALID_PARAMS,
        'task not found'
      );
    }

    const writer = new SSEStreamWriter({
      signal: context.signal,
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
    });

    const bus = eventBusRegistry?.get(task.id);
    const taskIsTerminal = isTerminal(task.state);

    const done = (async (): Promise<void> => {
      try {
        if (bus !== undefined && !bus.closed && !taskIsTerminal) {
          // Live producer is still running. Subscribe first so we don't miss
          // any event published between the replay frame and the subscribe()
          // call; then emit the replay frame.
          const completion = new Promise<void>((resolve) => {
            const subscription = bus.subscribe(
              (event) => writer.emitCloudEvent(event),
              () => {
                subscription.unsubscribe();
                resolve();
              }
            );
            const lastStatus = subscription.lastStatus;
            if (lastStatus !== undefined) {
              writer.emitCloudEvent(lastStatus);
            } else {
              // Bus exists but hasn't published a status yet - the producer
              // is between task creation and the first WORKING transition.
              // Synthesize the current state so the subscriber still sees a
              // first frame immediately.
              writer.emit(
                buildStatusEvent(task.id, task.contextId, task.status, false, {
                  source: options.eventSource,
                })
              );
            }
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
          await completion;
          return;
        }

        // No live producer (terminal task, or bus already closed). Emit the
        // current persisted state as the replay frame and close.
        const lastStatus = bus?.lastStatus;
        if (lastStatus !== undefined) {
          writer.emitCloudEvent(lastStatus);
        } else {
          writer.emit(
            buildStatusEvent(
              task.id,
              task.contextId,
              task.status,
              taskIsTerminal,
              { source: options.eventSource }
            )
          );
        }
      } finally {
        writer.close();
      }
    })();

    return { readable: writer.readable, done };
  };
}

interface BuildStatusEventOptions {
  readonly source: string | undefined;
}

function buildStatusEvent(
  taskId: string,
  contextId: string,
  status: TaskStatus,
  final: boolean,
  options: BuildStatusEventOptions
): {
  readonly type: AgentEventType;
  readonly data: TaskStatusUpdateEvent;
  readonly subject: string;
  readonly source?: string;
} {
  const data: TaskStatusUpdateEvent = {
    taskId,
    contextId,
    status,
    final,
  };
  return {
    type: AGENT_EVENT_TYPE.TASK_STATUS_CHANGED satisfies AgentEventType,
    data,
    subject: taskId,
    ...(options.source !== undefined ? { source: options.source } : {}),
  };
}

function validateTaskResubscribeParams(params: unknown): TaskResubscribeParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected TaskResubscribeParams object'
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

// Re-export `CloudEvent` so TS-DOC links from the handler are resolvable
// when the file is consumed via its standalone module path.
export type { CloudEvent };
