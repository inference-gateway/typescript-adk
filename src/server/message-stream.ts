import {
  TASK_STATE,
  createTask,
  isTerminal,
  transitionTask,
  type ManagedTask,
  type ManagedTaskState,
  type ManagedTaskStatus,
} from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  Message,
  SendMessageConfiguration,
  Struct,
  TaskStatus,
  TaskStatusUpdateEvent,
} from '../types/generated/a2a.js';
import {
  AGENT_EVENT_TYPE,
  type AgentEventType,
  type AgentIterationCompletedEventData,
  type AgentToolEventData,
  type AgentToolFailedEventData,
  type AgentToolResultEventData,
  type CloudEvent,
} from './cloudevents.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodContext } from './method-registry.js';
import { SSEStreamWriter } from './sse.js';

/**
 * Canonical JSON-RPC method name for the A2A `message/stream` operation.
 *
 * Use this constant rather than a string literal when registering the handler so
 * the spelling stays in lockstep with conformance tests and other consumers.
 */
export const MESSAGE_STREAM_METHOD = 'message/stream';

/**
 * Name of the environment variable that controls how often a periodic
 * `task.status.changed` event is re-emitted while a streaming task is in
 * progress. Must parse as a positive integer number of milliseconds, or as a
 * Go-style duration with a trailing `ms` / `s` / `m` unit (e.g. `500ms`, `1s`,
 * `2m`). `0` disables periodic status updates entirely.
 */
export const STREAMING_STATUS_UPDATE_INTERVAL_ENV =
  'STREAMING_STATUS_UPDATE_INTERVAL';

/**
 * Default interval (ms) between periodic `task.status.changed` re-emits while a
 * streaming task is in progress. Matches the Go ADK default of `1s` in
 * `server/config/config.go`.
 */
export const DEFAULT_STREAMING_STATUS_UPDATE_INTERVAL_MS = 1000;

/**
 * JSON-RPC params accepted by the A2A `message/stream` method. Structurally
 * identical to {@link import('./message-send.js').MessageSendParams} - the only
 * difference between `message/send` and `message/stream` is the response shape
 * (single JSON-RPC result vs. SSE event stream).
 */
export interface MessageStreamParams {
  readonly configuration?: SendMessageConfiguration;
  readonly message: Message;
  readonly metadata?: Struct;
}

/**
 * Single event yielded by a {@link StreamingTaskExecutor}.
 *
 * The handler interprets the discriminated `type` field:
 *  - `delta`: emit an `adk.agent.delta` SSE frame carrying the partial message.
 *    Does not change task state.
 *  - `statusChanged`: transition the task to the requested state, persist it,
 *    and emit an `adk.agent.task.status.changed` SSE frame. Terminal states
 *    (`COMPLETED`/`FAILED`/`CANCELLED`) end the stream.
 *  - `inputRequired`: transition to `INPUT_REQUIRED`, emit the status event,
 *    and end the stream. Equivalent to `{ type: 'statusChanged', state:
 *    INPUT_REQUIRED, message }`, kept separate for ergonomics since this is a
 *    common case in tool-use loops.
 *  - `inputRequiredNotice`: emit an `adk.agent.input.required` SSE frame
 *    carrying the prompt message. Does not change task state - typically
 *    followed by an `inputRequired` event from the same executor that performs
 *    the actual transition.
 *  - `iterationCompleted`: emit an `adk.agent.iteration.completed` SSE frame
 *    marking the end of one LLM iteration in an agentic loop. Carries the
 *    assistant message returned by the iteration when present.
 *  - `toolStarted` / `toolCompleted` / `toolFailed` / `toolResult`: emit the
 *    corresponding `adk.agent.tool.*` SSE frames around a tool dispatch. None
 *    of these change task state.
 *  - `rawCloudEvent`: forward a pre-built CloudEvents envelope to the SSE
 *    stream verbatim. Does not change task state. Used by the
 *    {@link import('./task-handler.js').StreamableTaskHandler} adapter so
 *    handlers that yield raw CloudEvents can plug into this pipeline.
 */
export type StreamingTaskEvent =
  | { readonly type: 'delta'; readonly message: Message }
  | {
      readonly type: 'statusChanged';
      readonly state: ManagedTaskState;
      readonly message?: Message;
    }
  | { readonly type: 'inputRequired'; readonly message: Message }
  | { readonly type: 'inputRequiredNotice'; readonly message: Message }
  | {
      readonly type: 'iterationCompleted';
      readonly iteration: number;
      readonly message?: Message;
    }
  | {
      readonly type: 'toolStarted';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments?: string;
    }
  | {
      readonly type: 'toolCompleted';
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: 'toolFailed';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly error: string;
    }
  | {
      readonly type: 'toolResult';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: string;
      readonly isError: boolean;
    }
  | { readonly type: 'rawCloudEvent'; readonly event: CloudEvent };

/**
 * Context handed to a {@link StreamingTaskExecutor} on each invocation.
 *
 * `signal` aborts when the originating HTTP request is cancelled (client
 * disconnect, timeout) or when the handler tears down for any reason; long-
 * running executor work should propagate it to downstream calls so cancellation
 * actually unwinds.
 */
export interface StreamingExecutorContext {
  readonly task: ManagedTask;
  readonly message: Message;
  readonly signal: AbortSignal;
}

/**
 * User-provided producer that drives a streaming task. Yields
 * {@link StreamingTaskEvent}s; the handler turns each one into the
 * corresponding SSE frame and persists task-state transitions.
 *
 * Lifecycle contract:
 *  - Natural completion (iterable exhausts without throwing and without
 *    emitting a terminal status) → task transitions to `COMPLETED`.
 *  - Thrown error → task transitions to `FAILED`; the error message is
 *    embedded in the final status event's `message`.
 *  - `signal` aborted → task transitions to `CANCELLED`; the executor is
 *    expected to stop yielding promptly once it observes the abort.
 *
 * The executor MUST NOT emit `PENDING` or attempt to re-enter terminal states.
 */
export type StreamingTaskExecutor = (
  context: StreamingExecutorContext
) => AsyncIterable<StreamingTaskEvent>;

export interface MessageStreamHandlerOptions {
  /** Storage backend used to persist task lifecycle transitions. */
  readonly storage: TaskStorage;
  /** Producer that runs the task; see {@link StreamingTaskExecutor}. */
  readonly executor: StreamingTaskExecutor;
  /**
   * UUID generator used for the new task id, the context id (when the incoming
   * message omits one), and the message id (when the incoming message omits
   * one). Defaults to {@link crypto.randomUUID}.
   */
  readonly idGenerator?: () => string;
  /** Clock injection point; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /**
   * Interval (ms) between periodic `task.status.changed` re-emits while the
   * task is `IN_PROGRESS`. Defaults to the value parsed from the
   * `STREAMING_STATUS_UPDATE_INTERVAL` env var, or
   * {@link DEFAULT_STREAMING_STATUS_UPDATE_INTERVAL_MS} when unset. Pass `0` to
   * disable periodic status updates (state-transition events still fire).
   */
  readonly statusUpdateIntervalMs?: number;
  /**
   * Override the SSE heartbeat interval (ms) passed to the underlying
   * {@link SSEStreamWriter}. Defaults to the writer's own default (30 s); pass
   * `0` to disable heartbeats. Heartbeats are SSE comment frames; they keep
   * intermediate proxies from closing the connection but carry no payload.
   */
  readonly heartbeatMs?: number;
  /**
   * Override the `source` attribute of every emitted CloudEvents envelope.
   * Defaults to the value baked into {@link createCloudEvent}
   * (`'adk/agent'`); supply a stable URI-reference here when running multiple
   * agents and consumers need to disambiguate.
   */
  readonly eventSource?: string;
  /**
   * Read environment variables from this object instead of `process.env`.
   * Mainly a test seam.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Handle returned by a {@link StreamingMethodHandler}. The framework hands
 * `readable` to the HTTP response body and awaits `done` for diagnostics (e.g.,
 * logging when the stream finishes) - awaiting `done` is not required to make
 * the response work.
 */
export interface StreamingMethodResult {
  /** SSE-encoded body stream. Hand to a `Response` constructor verbatim. */
  readonly readable: ReadableStream<Uint8Array>;
  /**
   * Resolves once the executor has finished (naturally, via error, or via
   * cancel) and the stream has been closed. Never rejects - executor errors
   * are converted into a final `task.status.changed` (state=`FAILED`) frame.
   */
  readonly done: Promise<void>;
}

/**
 * Handler for a JSON-RPC method whose response is an SSE event stream rather
 * than a single JSON-RPC result envelope. Register on
 * {@link import('./server.js').A2AServer} via `registerStreamingMethod`.
 *
 * Throw {@link JSONRPCError} for synchronous validation failures - the server
 * converts those into a regular JSON-RPC error response and never opens an SSE
 * stream. Errors that surface mid-stream are reported as a final `FAILED`
 * status event instead, since the headers have already been flushed.
 */
export type StreamingMethodHandler = (
  params: unknown,
  context: MethodContext
) => StreamingMethodResult;

/**
 * Build a handler for the A2A `message/stream` JSON-RPC method.
 *
 * The handler performs synchronous validation up front (so malformed params
 * surface as a regular JSON-RPC `-32602` rather than as a half-opened SSE
 * stream), then opens an SSE response and drives the user-supplied
 * {@link StreamingTaskExecutor} through the task lifecycle.
 *
 * Event sequence emitted on the stream (all wrapped in CloudEvents v1.0
 * envelopes; see {@link createCloudEvent}):
 *
 *   1. `adk.agent.task.status.changed` - state=`TASK_STATE_WORKING`, marking
 *      the transition from `PENDING`.
 *   2. Zero or more `adk.agent.delta` frames - partial assistant messages, in
 *      the order the executor yields them.
 *   3. Optional periodic `adk.agent.task.status.changed` frames - re-emitted
 *      every {@link MessageStreamHandlerOptions.statusUpdateIntervalMs}
 *      milliseconds while the task is `IN_PROGRESS`, with `final: false`.
 *   4. Optional `adk.agent.task.status.changed` for `INPUT_REQUIRED` -
 *      `final: false`, stream ends.
 *   5. Terminal `adk.agent.task.status.changed` - `final: true`, state is
 *      `COMPLETED` / `FAILED` / `CANCELLED`. Stream then closes.
 *
 * Cancellation: when the request's `AbortSignal` aborts (client disconnect or
 * server shutdown), the executor's signal aborts in turn, the task is
 * transitioned to `CANCELLED`, and a final status event is emitted before the
 * stream closes.
 */
export function createMessageStreamHandler(
  options: MessageStreamHandlerOptions
): StreamingMethodHandler {
  const { storage, executor } = options;
  const newId = options.idGenerator ?? (() => crypto.randomUUID());
  const clock = options.now ?? defaultNow;
  const env = options.env ?? process.env;
  const statusUpdateIntervalMs = resolveStatusUpdateInterval(
    options.statusUpdateIntervalMs,
    env
  );

  return (params: unknown, context: MethodContext): StreamingMethodResult => {
    const validated = validateMessageStreamParams(params);
    const taskId = newId();
    const enrichedMessage = enrichMessage(validated.message, newId);

    let task = createTask({
      id: taskId,
      contextId: enrichedMessage.contextId as string,
      messages: [enrichedMessage],
      now: clock,
    });
    storage.enqueue(task);

    const executorAbort = new AbortController();
    const onParentAbort = (): void => {
      executorAbort.abort(context.signal.reason);
    };
    if (context.signal.aborted) {
      executorAbort.abort(context.signal.reason);
    } else {
      context.signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const writer = new SSEStreamWriter({
      signal: context.signal,
      ...(options.heartbeatMs !== undefined
        ? { heartbeatMs: options.heartbeatMs }
        : {}),
    });

    const emitOptions = pickEmitOptions(options);

    const done = (async (): Promise<void> => {
      let periodicTimer: ReturnType<typeof setInterval> | null = null;
      try {
        task = transitionAndPersist(task, TASK_STATE.IN_PROGRESS, storage, {
          now: clock,
        });
        emitStatusEvent(writer, task, false, emitOptions);

        if (statusUpdateIntervalMs > 0) {
          periodicTimer = setInterval(() => {
            if (task.state !== TASK_STATE.IN_PROGRESS) {
              return;
            }
            emitStatusEvent(writer, task, false, emitOptions);
          }, statusUpdateIntervalMs);
          const t = periodicTimer as { unref?: () => void };
          if (typeof t.unref === 'function') {
            t.unref();
          }
        }

        const iterable = executor({
          task,
          message: enrichedMessage,
          signal: executorAbort.signal,
        });

        for await (const event of iterable) {
          if (executorAbort.signal.aborted) {
            break;
          }
          if (isTerminal(task.state)) {
            break;
          }
          task = handleExecutorEvent(
            event,
            task,
            storage,
            writer,
            clock,
            emitOptions
          );
          if (isTerminal(task.state)) {
            break;
          }
        }

        if (executorAbort.signal.aborted && !isTerminal(task.state)) {
          task = transitionAndPersist(task, TASK_STATE.CANCELLED, storage, {
            now: clock,
          });
          emitStatusEvent(writer, task, true, emitOptions);
        } else if (!isTerminal(task.state)) {
          task = transitionAndPersist(task, TASK_STATE.COMPLETED, storage, {
            now: clock,
          });
          emitStatusEvent(writer, task, true, emitOptions);
        }
      } catch (err) {
        if (!isTerminal(task.state)) {
          const errorMessage = buildErrorMessage(err, newId);
          try {
            task = transitionAndPersist(
              task,
              executorAbort.signal.aborted
                ? TASK_STATE.CANCELLED
                : TASK_STATE.FAILED,
              storage,
              { now: clock, message: errorMessage }
            );
            emitStatusEvent(writer, task, true, emitOptions);
          } catch {
            // Task was already in a terminal state via a concurrent path; the
            // previously-emitted final status event is sufficient.
          }
        }
      } finally {
        if (periodicTimer !== null) {
          clearInterval(periodicTimer);
        }
        context.signal.removeEventListener('abort', onParentAbort);
        storage.storeDeadLetter(task);
        writer.close();
      }
    })();

    return { readable: writer.readable, done };
  };
}

interface EmitOptions {
  readonly source: string | undefined;
}

function pickEmitOptions(options: MessageStreamHandlerOptions): EmitOptions {
  return { source: options.eventSource };
}

function handleExecutorEvent(
  event: StreamingTaskEvent,
  task: ManagedTask,
  storage: TaskStorage,
  writer: SSEStreamWriter,
  clock: () => Date,
  emitOptions: EmitOptions
): ManagedTask {
  switch (event.type) {
    case 'delta': {
      emitDeltaEvent(writer, task, event.message, emitOptions);
      return task;
    }
    case 'statusChanged': {
      const next = transitionAndPersist(task, event.state, storage, {
        now: clock,
        ...(event.message !== undefined ? { message: event.message } : {}),
      });
      emitStatusEvent(writer, next, isTerminal(next.state), emitOptions);
      return next;
    }
    case 'inputRequired': {
      const next = transitionAndPersist(
        task,
        TASK_STATE.INPUT_REQUIRED,
        storage,
        { now: clock, message: event.message }
      );
      emitStatusEvent(writer, next, false, emitOptions);
      return next;
    }
    case 'inputRequiredNotice': {
      emitInputRequiredEvent(writer, task, event.message, emitOptions);
      return task;
    }
    case 'iterationCompleted': {
      emitIterationCompletedEvent(writer, task, event, emitOptions);
      return task;
    }
    case 'toolStarted': {
      emitToolStartedEvent(writer, task, event, emitOptions);
      return task;
    }
    case 'toolCompleted': {
      emitToolCompletedEvent(writer, task, event, emitOptions);
      return task;
    }
    case 'toolFailed': {
      emitToolFailedEvent(writer, task, event, emitOptions);
      return task;
    }
    case 'toolResult': {
      emitToolResultEvent(writer, task, event, emitOptions);
      return task;
    }
    case 'rawCloudEvent': {
      writer.emitCloudEvent(event.event);
      return task;
    }
  }
}

function emitStatusEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  final: boolean,
  emitOptions: EmitOptions
): CloudEvent<TaskStatusUpdateEvent> | undefined {
  const status: TaskStatus = toWireStatus(task.status);
  const data: TaskStatusUpdateEvent = {
    taskId: task.id,
    contextId: task.contextId,
    status,
    final,
  };
  return writer.emit({
    type: AGENT_EVENT_TYPE.TASK_STATUS_CHANGED satisfies AgentEventType,
    data,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitDeltaEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  message: Message,
  emitOptions: EmitOptions
): CloudEvent<Message> | undefined {
  return writer.emit({
    type: AGENT_EVENT_TYPE.DELTA satisfies AgentEventType,
    data: message,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitInputRequiredEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  message: Message,
  emitOptions: EmitOptions
): CloudEvent<Message> | undefined {
  return writer.emit({
    type: AGENT_EVENT_TYPE.INPUT_REQUIRED satisfies AgentEventType,
    data: message,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitIterationCompletedEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  event: { readonly iteration: number; readonly message?: Message },
  emitOptions: EmitOptions
): CloudEvent<AgentIterationCompletedEventData> | undefined {
  const data: AgentIterationCompletedEventData = {
    iteration: event.iteration,
    taskId: task.id,
    contextId: task.contextId,
    ...(event.message !== undefined ? { message: event.message } : {}),
  };
  return writer.emit({
    type: AGENT_EVENT_TYPE.ITERATION_COMPLETED satisfies AgentEventType,
    data,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitToolStartedEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments?: string;
  },
  emitOptions: EmitOptions
): CloudEvent<AgentToolEventData> | undefined {
  const data: AgentToolEventData = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    taskId: task.id,
    contextId: task.contextId,
    ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
  };
  return writer.emit({
    type: AGENT_EVENT_TYPE.TOOL_STARTED satisfies AgentEventType,
    data,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitToolCompletedEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  event: { readonly toolCallId: string; readonly toolName: string },
  emitOptions: EmitOptions
): CloudEvent<AgentToolEventData> | undefined {
  const data: AgentToolEventData = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    taskId: task.id,
    contextId: task.contextId,
  };
  return writer.emit({
    type: AGENT_EVENT_TYPE.TOOL_COMPLETED satisfies AgentEventType,
    data,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitToolFailedEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly error: string;
  },
  emitOptions: EmitOptions
): CloudEvent<AgentToolFailedEventData> | undefined {
  const data: AgentToolFailedEventData = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    taskId: task.id,
    contextId: task.contextId,
    error: event.error,
  };
  return writer.emit({
    type: AGENT_EVENT_TYPE.TOOL_FAILED satisfies AgentEventType,
    data,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function emitToolResultEvent(
  writer: SSEStreamWriter,
  task: ManagedTask,
  event: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly result: string;
    readonly isError: boolean;
  },
  emitOptions: EmitOptions
): CloudEvent<AgentToolResultEventData> | undefined {
  const data: AgentToolResultEventData = {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    taskId: task.id,
    contextId: task.contextId,
    result: event.result,
    isError: event.isError,
  };
  return writer.emit({
    type: AGENT_EVENT_TYPE.TOOL_RESULT satisfies AgentEventType,
    data,
    subject: task.id,
    ...(emitOptions.source !== undefined ? { source: emitOptions.source } : {}),
  });
}

function toWireStatus(status: ManagedTaskStatus): TaskStatus {
  return {
    state: status.state,
    ...(status.message !== undefined ? { message: status.message } : {}),
    ...(status.timestamp !== undefined ? { timestamp: status.timestamp } : {}),
  };
}

function transitionAndPersist(
  task: ManagedTask,
  next: ManagedTaskState,
  storage: TaskStorage,
  options: { now: () => Date; message?: Message }
): ManagedTask {
  const transitionOpts =
    options.message !== undefined
      ? { now: options.now, message: options.message }
      : { now: options.now };
  const transitioned = transitionTask(task, next, transitionOpts);
  storage.updateActive(transitioned);
  return transitioned;
}

function buildErrorMessage(err: unknown, newId: () => string): Message {
  const text = err instanceof Error ? err.message : String(err);
  return {
    messageId: newId(),
    role: 'ROLE_AGENT',
    parts: [{ text }],
  };
}

function validateMessageStreamParams(params: unknown): MessageStreamParams {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected MessageStreamParams object'
    );
  }
  const obj = params as Record<string, unknown>;
  const rawMessage = obj['message'];
  if (
    rawMessage === null ||
    rawMessage === undefined ||
    typeof rawMessage !== 'object' ||
    Array.isArray(rawMessage)
  ) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: message is required and must be an object'
    );
  }
  const parts = (rawMessage as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: message.parts must be a non-empty array'
    );
  }
  return params as MessageStreamParams;
}

function enrichMessage(input: Message, newId: () => string): Message {
  const messageId =
    typeof input.messageId === 'string' && input.messageId.length > 0
      ? input.messageId
      : newId();
  const contextId =
    typeof input.contextId === 'string' && input.contextId.length > 0
      ? input.contextId
      : newId();
  return {
    ...input,
    messageId,
    contextId,
  };
}

function resolveStatusUpdateInterval(
  explicit: number | undefined,
  env: Readonly<Record<string, string | undefined>>
): number {
  if (explicit !== undefined) {
    if (
      !Number.isFinite(explicit) ||
      !Number.isInteger(explicit) ||
      explicit < 0
    ) {
      throw new TypeError(
        'statusUpdateIntervalMs must be a non-negative integer (0 disables periodic status updates)'
      );
    }
    return explicit;
  }
  const raw = env[STREAMING_STATUS_UPDATE_INTERVAL_ENV];
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_STREAMING_STATUS_UPDATE_INTERVAL_MS;
  }
  const parsed = parseDurationMs(raw);
  if (parsed === undefined) {
    throw new TypeError(
      `${STREAMING_STATUS_UPDATE_INTERVAL_ENV} must be a non-negative integer (ms) or a duration with a ms/s/m suffix (got ${JSON.stringify(raw)})`
    );
  }
  return parsed;
}

function parseDurationMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  const match =
    /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m)?$/.exec(trimmed) ?? null;
  if (match === null || match.groups === undefined) {
    return undefined;
  }
  const value = Number(match.groups['value']);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const unit = match.groups['unit'] ?? 'ms';
  const ms =
    unit === 'ms'
      ? value
      : unit === 's'
        ? value * 1000
        : /* unit === 'm' */ value * 60 * 1000;
  if (!Number.isInteger(ms)) {
    return undefined;
  }
  return ms;
}

function defaultNow(): Date {
  return new Date();
}
