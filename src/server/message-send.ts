import {
  TASK_STATE,
  createTask,
  isPaused,
  isTerminal,
  transitionTask,
  toWireTask,
  type ManagedTask,
  type ManagedTaskState,
} from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  A2AMethod,
  Message,
  SendMessageConfiguration,
  SendMessageRequest,
  SendMessageResponse,
} from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodContext, MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A `SendMessage` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const MESSAGE_SEND_METHOD = 'SendMessage' satisfies A2AMethod;

const TASK_POLL_INTERVAL_MS = 50;

/**
 * Answers a message directly. Returning a message makes `SendMessage` reply
 * with it and create no task; returning `undefined` continues with the task
 * flow.
 */
export type MessageResponder = (
  message: Message,
  signal: AbortSignal
) => Promise<Message | undefined> | Message | undefined;

export interface MessageSendHandlerOptions {
  /** Storage backend used to persist and enqueue the created task. */
  readonly storage: TaskStorage;
  /**
   * UUID generator used for the new task id, the context id (when the
   * incoming message omits one), and the message id (when the incoming
   * message omits one). Defaults to {@link crypto.randomUUID}. Injectable for
   * deterministic tests.
   */
  readonly idGenerator?: () => string;
  /** Clock injection point; defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Optional direct-reply hook; see {@link MessageResponder}. */
  readonly respondToMessage?: MessageResponder;
}

/**
 * Build a handler for the A2A `SendMessage` JSON-RPC method.
 *
 * The handler creates a `PENDING` task (or resumes the paused task the
 * message continues), persists and enqueues it, then waits until a worker
 * moves it to a terminal or interrupted state before returning it as a
 * `SendMessageResponse` (`{ task }`, spec 3.2.2). With
 * `configuration.returnImmediately` it returns the enqueued task right away.
 *
 * Validation failures surface as JSON-RPC `-32602` (Invalid Params) via
 * {@link JSONRPCError} so the dispatcher emits a structured error envelope.
 *
 * Register on an {@link A2AServer} via
 * `server.registerMethod(MESSAGE_SEND_METHOD, createMessageSendHandler({ storage }))`.
 */
export function createMessageSendHandler(
  options: MessageSendHandlerOptions
): MethodHandler<unknown, SendMessageResponse> {
  const { storage } = options;
  const newId = options.idGenerator ?? (() => crypto.randomUUID());
  const clock = options.now ?? defaultNow;

  return async (
    params: unknown,
    context: MethodContext
  ): Promise<SendMessageResponse> => {
    const validated = validateMessageSendParams(params);
    const reply = await options.respondToMessage?.(
      validated.message,
      context.signal
    );
    if (reply !== undefined) {
      return { message: reply };
    }
    assertReferencedTaskAcceptsMessage(storage, validated.message);

    const config = validated.configuration;
    const task = startTask(storage, validated.message, newId, clock);
    registerPushConfig(storage, config, task.id);
    storage.enqueue(task);

    const settled =
      config?.returnImmediately === true
        ? task
        : await pollTask(
            storage,
            task,
            isTerminalOrInterrupted,
            context.signal
          );
    return { task: toWireTask(settled, config?.historyLength) };
  };
}

/**
 * Resume the paused task the message continues, or create a new `PENDING`
 * task for it. The caller persists the result.
 */
function startTask(
  storage: TaskStorage,
  message: Message,
  newId: () => string,
  clock: () => Date
): ManagedTask {
  const paused = findResumableTask(storage, message);
  if (paused !== undefined) {
    return appendAndResume(
      paused,
      enrichMessage(message, newId, paused.contextId),
      clock
    );
  }
  const taskId = newId();
  const enrichedMessage = enrichMessage(message, newId);
  return createTask({
    id: taskId,
    contextId: enrichedMessage.contextId as string,
    messages: [enrichedMessage],
    now: clock,
  });
}

/**
 * Store the push notification config sent inline in the message
 * configuration, if any, for the task (spec 3.2.2).
 */
function registerPushConfig(
  storage: TaskStorage,
  config: SendMessageConfiguration | undefined,
  taskId: string
): void {
  if (config?.taskPushNotificationConfig !== undefined) {
    storage.setPushConfig(taskId, {
      ...config.taskPushNotificationConfig,
      taskId,
    });
  }
}

/** True once a blocking `SendMessage` may return (spec 3.2.2). */
function isTerminalOrInterrupted(state: ManagedTaskState): boolean {
  return isTerminal(state) || isPaused(state);
}

/**
 * Re-read the task from storage until `done` holds for its state or `signal`
 * aborts, calling `onChange` on every state change, and return the latest
 * snapshot.
 * ponytail: polling works with every storage backend and remote workers;
 * replace with storage change notifications if the polling load shows up.
 */
async function pollTask(
  storage: TaskStorage,
  task: ManagedTask,
  done: (state: ManagedTaskState) => boolean,
  signal: AbortSignal,
  onChange?: (task: ManagedTask) => void
): Promise<ManagedTask> {
  let latest = task;
  while (!done(latest.state) && !signal.aborted) {
    await delay(TASK_POLL_INTERVAL_MS, signal);
    const current = storage.getTask(latest.id);
    if (current !== undefined && current.state !== latest.state) {
      latest = current;
      onChange?.(latest);
    }
  }
  return latest;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Locate the paused (`INPUT_REQUIRED`) task a message continues: the task it
 * names by `taskId`, otherwise the most recently updated paused task on its
 * `contextId`. Returns `undefined` when there is none.
 */
function findResumableTask(
  storage: TaskStorage,
  message: Message
): ManagedTask | undefined {
  if (message.taskId !== undefined) {
    const task = storage.getTask(message.taskId);
    return task !== undefined && isPaused(task.state) ? task : undefined;
  }
  const contextId =
    typeof message.contextId === 'string' && message.contextId.length > 0
      ? message.contextId
      : undefined;
  if (contextId === undefined) {
    return undefined;
  }
  const matches = storage.listTasks({
    contextId,
    state: TASK_STATE.INPUT_REQUIRED,
  });
  let best: ManagedTask | undefined;
  for (const candidate of matches) {
    if (best === undefined || candidate.updatedAt > best.updatedAt) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Append the resume message to the paused task and transition it from
 * `INPUT_REQUIRED` to `IN_PROGRESS`. The caller is responsible for persisting
 * (via `storage.enqueue` for the background flow, or `storage.updateActive`
 * for the streaming flow).
 */
function appendAndResume(
  paused: ManagedTask,
  message: Message,
  clock: () => Date
): ManagedTask {
  const withMessage: ManagedTask = {
    ...paused,
    messages: [...paused.messages, message],
  };
  return transitionTask(withMessage, TASK_STATE.IN_PROGRESS, { now: clock });
}

/**
 * Reject a message whose `taskId` the storage does not know (TaskNotFound,
 * `-32001`), names a terminal task (UnsupportedOperation, `-32004`, spec
 * 3.1.1), or belongs to a different `contextId` (InvalidParams, `-32602`).
 */
function assertReferencedTaskAcceptsMessage(
  storage: TaskStorage,
  message: Message
): void {
  const { taskId, contextId } = message;
  if (taskId === undefined) {
    return;
  }
  const task = storage.getTask(taskId);
  if (task === undefined) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.TASK_NOT_FOUND_ERROR,
      'task not found'
    );
  }
  if (isTerminal(task.state)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.UNSUPPORTED_OPERATION_ERROR,
      'task is in a terminal state and cannot accept messages'
    );
  }
  if (contextId !== undefined && contextId !== task.contextId) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: message contextId does not match the task'
    );
  }
}

export {
  appendAndResume,
  assertReferencedTaskAcceptsMessage,
  enrichMessage,
  findResumableTask,
  pollTask,
  registerPushConfig,
  validateMessageSendParams,
};

function validateMessageSendParams(params: unknown): SendMessageRequest {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.INVALID_PARAMS,
      'invalid params: expected SendMessageRequest object'
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
  return params as SendMessageRequest;
}

function enrichMessage(
  input: Message,
  newId: () => string,
  resumeContextId?: string
): Message {
  const messageId =
    typeof input.messageId === 'string' && input.messageId.length > 0
      ? input.messageId
      : newId();
  const contextId =
    resumeContextId ??
    (typeof input.contextId === 'string' && input.contextId.length > 0
      ? input.contextId
      : newId());
  return {
    ...input,
    messageId,
    contextId,
  };
}

function defaultNow(): Date {
  return new Date();
}
