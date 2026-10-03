import {
  TASK_STATE,
  createTask,
  transitionTask,
  toWireTask,
  type ManagedTask,
} from '../agent/task.js';
import type { TaskStorage } from '../storage/task-storage.js';
import type {
  A2AMethod,
  Message,
  SendMessageRequest,
  SendMessageResponse,
} from '../types/generated/a2a.js';
import { JSONRPC_ERROR_CODES, JSONRPCError } from './jsonrpc.js';
import type { MethodHandler } from './method-registry.js';

/**
 * Canonical JSON-RPC method name for the A2A `SendMessage` operation.
 *
 * Use this rather than a string literal when registering the handler so the
 * spelling stays in lockstep with conformance tests and other consumers.
 */
export const MESSAGE_SEND_METHOD = 'SendMessage' satisfies A2AMethod;

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
}

/**
 * Build a handler for the A2A `SendMessage` JSON-RPC method.
 *
 * The handler is synchronous from the caller's perspective: it creates a
 * `PENDING` task, persists and enqueues it, then returns it as a
 * `SendMessageResponse` (`{ task }`, spec 9.4.1) without waiting for any
 * background worker to pick it up.
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

  return (params: unknown): SendMessageResponse => {
    const validated = validateMessageSendParams(params);
    assertReferencedTaskExists(storage, validated.message);
    const inboundContextId =
      typeof validated.message.contextId === 'string' &&
      validated.message.contextId.length > 0
        ? validated.message.contextId
        : undefined;

    if (inboundContextId !== undefined) {
      const paused = findResumableTask(storage, inboundContextId);
      if (paused !== undefined) {
        const enrichedMessage = enrichMessage(
          validated.message,
          newId,
          paused.contextId
        );
        const resumed = appendAndResume(paused, enrichedMessage, clock);
        storage.enqueue(resumed);
        return { task: toWireTask(resumed) };
      }
    }

    const taskId = newId();
    const enrichedMessage = enrichMessage(validated.message, newId);

    const task = createTask({
      id: taskId,
      contextId: enrichedMessage.contextId as string,
      messages: [enrichedMessage],
      now: clock,
    });

    storage.enqueue(task);

    return { task: toWireTask(task) };
  };
}

/**
 * Locate an active task in `INPUT_REQUIRED` state on the given `contextId`,
 * or `undefined` when no such task exists. When more than one paused task
 * matches (a malformed state on the caller's side - the framework only ever
 * pauses one task per context at a time), the most recently updated one wins
 * so a stray older paused task can't permanently block resume.
 */
function findResumableTask(
  storage: TaskStorage,
  contextId: string
): ManagedTask | undefined {
  const matches = storage.listTasks({
    contextId,
    state: TASK_STATE.INPUT_REQUIRED,
  });
  if (matches.length === 0) {
    return undefined;
  }
  let best = matches[0] as ManagedTask;
  for (let i = 1; i < matches.length; i++) {
    const candidate = matches[i] as ManagedTask;
    if (candidate.updatedAt > best.updatedAt) {
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
 * Reject a message that names a `taskId` the storage does not know with
 * TaskNotFound (`-32001`), instead of silently starting a new task.
 */
function assertReferencedTaskExists(
  storage: TaskStorage,
  message: Message
): void {
  const { taskId } = message;
  if (taskId !== undefined && storage.getTask(taskId) === undefined) {
    throw new JSONRPCError(
      JSONRPC_ERROR_CODES.TASK_NOT_FOUND_ERROR,
      'task not found'
    );
  }
}

export { appendAndResume, assertReferencedTaskExists, findResumableTask };

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
