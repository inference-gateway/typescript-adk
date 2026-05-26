import type {
  Artifact,
  Message,
  Struct,
  Task,
  TaskState,
  TaskStatus,
  Timestamp,
} from '../types/generated/a2a.js';

/**
 * Friendly lifecycle aliases for the subset of A2A `TaskState` values that
 * the managed task lifecycle recognises.
 *
 * Keys are the names used in the lifecycle diagram
 * (`PENDING -> IN_PROGRESS -> {INPUT_REQUIRED | COMPLETED | FAILED | CANCELLED}`,
 * with `INPUT_REQUIRED -> IN_PROGRESS` for resume); values are the canonical
 * A2A string literals so a `ManagedTask` can be serialised to the wire
 * without translation.
 */
export const TASK_STATE = {
  PENDING: 'TASK_STATE_SUBMITTED',
  IN_PROGRESS: 'TASK_STATE_WORKING',
  INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED',
  COMPLETED: 'TASK_STATE_COMPLETED',
  FAILED: 'TASK_STATE_FAILED',
  CANCELLED: 'TASK_STATE_CANCELLED',
} as const satisfies Record<string, TaskState>;

/**
 * The subset of `TaskState` reachable through the managed lifecycle. Excludes
 * `TASK_STATE_UNSPECIFIED`, `TASK_STATE_REJECTED`, and `TASK_STATE_AUTH_REQUIRED`,
 * which aren't part of the state machine modelled here.
 */
export type ManagedTaskState = (typeof TASK_STATE)[keyof typeof TASK_STATE];

/**
 * Status block mirroring A2A `TaskStatus` but narrowed to the managed state set.
 */
export interface ManagedTaskStatus {
  readonly state: ManagedTaskState;
  readonly message?: Message;
  readonly timestamp?: Timestamp;
}

/**
 * The lifecycle-managed task entity.
 *
 * Wraps the data carried by an A2A `Task` (id, contextId, artifacts, status,
 * metadata) with lifecycle bookkeeping fields (createdAt, updatedAt,
 * completedAt) and a top-level `state` mirror of `status.state` for ergonomic
 * pattern-matching.
 *
 * All fields are `readonly`: state changes must go through `transitionTask`,
 * which returns a new task rather than mutating in place.
 */
export interface ManagedTask {
  readonly id: string;
  readonly contextId: string;
  readonly state: ManagedTaskState;
  readonly status: ManagedTaskStatus;
  readonly messages: readonly Message[];
  readonly artifacts: readonly Artifact[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly metadata?: Struct;
}

/**
 * Thrown by `transitionTask` when the requested transition is not part of the
 * state machine. Exposes `from` and `to` so callers can build structured
 * error responses.
 */
export class TaskTransitionError extends Error {
  override readonly name = 'TaskTransitionError';
  readonly from: ManagedTaskState;
  readonly to: ManagedTaskState;

  constructor(from: ManagedTaskState, to: ManagedTaskState) {
    super(`Illegal task transition from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}

const TERMINAL_STATES: ReadonlySet<ManagedTaskState> = new Set([
  TASK_STATE.COMPLETED,
  TASK_STATE.FAILED,
  TASK_STATE.CANCELLED,
]);

const PAUSED_STATES: ReadonlySet<ManagedTaskState> = new Set([
  TASK_STATE.INPUT_REQUIRED,
]);

const VALID_TRANSITIONS: Readonly<
  Record<ManagedTaskState, ReadonlySet<ManagedTaskState>>
> = {
  [TASK_STATE.PENDING]: new Set<ManagedTaskState>([TASK_STATE.IN_PROGRESS]),
  [TASK_STATE.IN_PROGRESS]: new Set<ManagedTaskState>([
    TASK_STATE.INPUT_REQUIRED,
    TASK_STATE.COMPLETED,
    TASK_STATE.FAILED,
    TASK_STATE.CANCELLED,
  ]),
  [TASK_STATE.INPUT_REQUIRED]: new Set<ManagedTaskState>([
    TASK_STATE.IN_PROGRESS,
  ]),
  [TASK_STATE.COMPLETED]: new Set<ManagedTaskState>(),
  [TASK_STATE.FAILED]: new Set<ManagedTaskState>(),
  [TASK_STATE.CANCELLED]: new Set<ManagedTaskState>(),
};

/** True when `state` is one of `COMPLETED`, `FAILED`, `CANCELLED`. */
export function isTerminal(state: ManagedTaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/** True when the task is paused awaiting external input (`INPUT_REQUIRED`). */
export function isPaused(state: ManagedTaskState): boolean {
  return PAUSED_STATES.has(state);
}

/** Pure predicate: does the state machine permit `from -> to`? */
export function canTransition(
  from: ManagedTaskState,
  to: ManagedTaskState
): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

export interface CreateTaskInput {
  readonly id: string;
  readonly contextId: string;
  readonly messages?: readonly Message[];
  readonly artifacts?: readonly Artifact[];
  readonly metadata?: Struct;
  /** Clock injection point; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Construct a fresh task in the `PENDING` state. `createdAt` and `updatedAt`
 * are stamped from `now()` (or `new Date()`).
 */
export function createTask(input: CreateTaskInput): ManagedTask {
  const timestamp = (input.now ?? defaultNow)().toISOString();
  return {
    id: input.id,
    contextId: input.contextId,
    state: TASK_STATE.PENDING,
    status: { state: TASK_STATE.PENDING, timestamp },
    messages: input.messages ? [...input.messages] : [],
    artifacts: input.artifacts ? [...input.artifacts] : [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

export interface TransitionOptions {
  /** Optional status message to attach to the new `TaskStatus`. */
  readonly message?: Message;
  /** Clock injection point; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Move `task` to `nextState`, returning a new task. Throws
 * `TaskTransitionError` if the transition is not part of the lifecycle.
 *
 * Side effects on the returned task:
 *  - `state` and `status.state` set to `nextState`.
 *  - `updatedAt` (and `status.timestamp`) stamped with `now()`.
 *  - `completedAt` stamped when entering a terminal state.
 *  - `status.message` set when `options.message` is provided.
 */
export function transitionTask(
  task: ManagedTask,
  nextState: ManagedTaskState,
  options: TransitionOptions = {}
): ManagedTask {
  if (!canTransition(task.state, nextState)) {
    throw new TaskTransitionError(task.state, nextState);
  }

  const timestamp = (options.now ?? defaultNow)().toISOString();
  const status: ManagedTaskStatus = {
    state: nextState,
    timestamp,
    ...(options.message !== undefined ? { message: options.message } : {}),
  };

  return {
    ...task,
    state: nextState,
    status,
    updatedAt: timestamp,
    ...(isTerminal(nextState) ? { completedAt: timestamp } : {}),
  };
}

/**
 * Project a {@link ManagedTask} into the wire-format A2A `Task`.
 *
 * The returned object drops lifecycle bookkeeping fields (`createdAt`,
 * `updatedAt`, `completedAt`, `state` mirror) that are internal to the
 * managed lifecycle, and copies `messages` into `history` since that's the
 * field name on the wire.
 *
 * Optional fields (`status.message`, `status.timestamp`, `artifacts`,
 * `metadata`) are only included when present, to satisfy
 * `exactOptionalPropertyTypes`.
 *
 * If `historyLength` is supplied (and >= 0), the returned `history` is
 * truncated to the last `historyLength` messages. Negative values are
 * treated as a programming error and rejected upstream; this helper
 * intentionally clamps at 0 rather than throwing.
 */
export function toWireTask(task: ManagedTask, historyLength?: number): Task {
  const status: TaskStatus = {
    state: task.status.state,
    ...(task.status.message !== undefined
      ? { message: task.status.message }
      : {}),
    ...(task.status.timestamp !== undefined
      ? { timestamp: task.status.timestamp }
      : {}),
  };

  const history = truncateHistory(task.messages, historyLength);

  return {
    id: task.id,
    contextId: task.contextId,
    status,
    history,
    ...(task.artifacts.length > 0 ? { artifacts: [...task.artifacts] } : {}),
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
  };
}

function truncateHistory(
  messages: readonly Message[],
  historyLength: number | undefined
): Message[] {
  if (historyLength === undefined) {
    return [...messages];
  }
  const clamped = Math.max(0, historyLength);
  if (clamped >= messages.length) {
    return [...messages];
  }
  return messages.slice(messages.length - clamped);
}

function defaultNow(): Date {
  return new Date();
}
