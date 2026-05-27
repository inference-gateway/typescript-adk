import { describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  TaskTransitionError,
  canTransition,
  createTask,
  isPaused,
  isTerminal,
  toWireTask,
  transitionTask,
  type ManagedTask,
  type ManagedTaskState,
} from '../../src/agent/task.js';
import type { Message } from '../../src/types/generated/a2a.js';

const ALL_STATES: readonly ManagedTaskState[] = [
  TASK_STATE.PENDING,
  TASK_STATE.IN_PROGRESS,
  TASK_STATE.INPUT_REQUIRED,
  TASK_STATE.COMPLETED,
  TASK_STATE.FAILED,
  TASK_STATE.CANCELLED,
];

const LEGAL_TRANSITIONS: ReadonlyArray<
  [from: ManagedTaskState, to: ManagedTaskState]
> = [
  [TASK_STATE.PENDING, TASK_STATE.IN_PROGRESS],
  [TASK_STATE.PENDING, TASK_STATE.CANCELLED],
  [TASK_STATE.IN_PROGRESS, TASK_STATE.INPUT_REQUIRED],
  [TASK_STATE.IN_PROGRESS, TASK_STATE.COMPLETED],
  [TASK_STATE.IN_PROGRESS, TASK_STATE.FAILED],
  [TASK_STATE.IN_PROGRESS, TASK_STATE.CANCELLED],
  [TASK_STATE.INPUT_REQUIRED, TASK_STATE.IN_PROGRESS],
  [TASK_STATE.INPUT_REQUIRED, TASK_STATE.CANCELLED],
];

function isLegal(from: ManagedTaskState, to: ManagedTaskState): boolean {
  return LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

const ILLEGAL_TRANSITIONS: ReadonlyArray<
  [from: ManagedTaskState, to: ManagedTaskState]
> = ALL_STATES.flatMap((from) =>
  ALL_STATES.filter((to) => !isLegal(from, to)).map(
    (to): [ManagedTaskState, ManagedTaskState] => [from, to]
  )
);

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

function fresh(state: ManagedTaskState = TASK_STATE.PENDING): ManagedTask {
  const base = createTask({
    id: 'task-1',
    contextId: 'ctx-1',
    now: fixedClock('2026-01-01T00:00:00.000Z'),
  });
  if (state === TASK_STATE.PENDING) return base;

  // Walk legal transitions to land on the requested state.
  const path: Record<
    Exclude<ManagedTaskState, typeof TASK_STATE.PENDING>,
    ManagedTaskState[]
  > = {
    [TASK_STATE.IN_PROGRESS]: [TASK_STATE.IN_PROGRESS],
    [TASK_STATE.INPUT_REQUIRED]: [
      TASK_STATE.IN_PROGRESS,
      TASK_STATE.INPUT_REQUIRED,
    ],
    [TASK_STATE.COMPLETED]: [TASK_STATE.IN_PROGRESS, TASK_STATE.COMPLETED],
    [TASK_STATE.FAILED]: [TASK_STATE.IN_PROGRESS, TASK_STATE.FAILED],
    [TASK_STATE.CANCELLED]: [TASK_STATE.IN_PROGRESS, TASK_STATE.CANCELLED],
  };
  return path[state].reduce(
    (t, next) =>
      transitionTask(t, next, {
        now: fixedClock('2026-01-01T00:00:01.000Z'),
      }),
    base
  );
}

describe('TASK_STATE', () => {
  it('maps friendly names to canonical A2A literals', () => {
    expect(TASK_STATE.PENDING).toBe('TASK_STATE_SUBMITTED');
    expect(TASK_STATE.IN_PROGRESS).toBe('TASK_STATE_WORKING');
    expect(TASK_STATE.INPUT_REQUIRED).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(TASK_STATE.COMPLETED).toBe('TASK_STATE_COMPLETED');
    expect(TASK_STATE.FAILED).toBe('TASK_STATE_FAILED');
    expect(TASK_STATE.CANCELLED).toBe('TASK_STATE_CANCELLED');
  });
});

describe('isTerminal', () => {
  it('reports COMPLETED, FAILED, and CANCELLED as terminal', () => {
    expect(isTerminal(TASK_STATE.COMPLETED)).toBe(true);
    expect(isTerminal(TASK_STATE.FAILED)).toBe(true);
    expect(isTerminal(TASK_STATE.CANCELLED)).toBe(true);
  });

  it('reports non-terminal states as non-terminal', () => {
    expect(isTerminal(TASK_STATE.PENDING)).toBe(false);
    expect(isTerminal(TASK_STATE.IN_PROGRESS)).toBe(false);
    expect(isTerminal(TASK_STATE.INPUT_REQUIRED)).toBe(false);
  });
});

describe('isPaused', () => {
  it('reports INPUT_REQUIRED as paused', () => {
    expect(isPaused(TASK_STATE.INPUT_REQUIRED)).toBe(true);
  });

  it('reports every non-paused state as not paused', () => {
    expect(isPaused(TASK_STATE.PENDING)).toBe(false);
    expect(isPaused(TASK_STATE.IN_PROGRESS)).toBe(false);
    expect(isPaused(TASK_STATE.COMPLETED)).toBe(false);
    expect(isPaused(TASK_STATE.FAILED)).toBe(false);
    expect(isPaused(TASK_STATE.CANCELLED)).toBe(false);
  });
});

describe('canTransition', () => {
  it.each(LEGAL_TRANSITIONS)('permits %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each(ILLEGAL_TRANSITIONS)('rejects %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });
});

describe('createTask', () => {
  it('returns a PENDING task with timestamps stamped from the clock', () => {
    const task = createTask({
      id: 'task-1',
      contextId: 'ctx-1',
      now: fixedClock('2026-01-01T00:00:00.000Z'),
    });
    expect(task.id).toBe('task-1');
    expect(task.contextId).toBe('ctx-1');
    expect(task.state).toBe(TASK_STATE.PENDING);
    expect(task.status.state).toBe(TASK_STATE.PENDING);
    expect(task.status.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(task.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(task.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(task.completedAt).toBeUndefined();
    expect(task.messages).toEqual([]);
    expect(task.artifacts).toEqual([]);
    expect(task.metadata).toBeUndefined();
  });

  it('copies input messages and artifacts (does not retain caller references)', () => {
    const messages: Message[] = [];
    const task = createTask({
      id: 'task-1',
      contextId: 'ctx-1',
      messages,
    });
    expect(task.messages).not.toBe(messages);
    expect(task.messages).toEqual([]);
  });

  it('omits metadata when none is supplied', () => {
    const task = createTask({ id: 'task-1', contextId: 'ctx-1' });
    expect('metadata' in task).toBe(false);
  });

  it('preserves provided metadata', () => {
    const metadata = { foo: 'bar' };
    const task = createTask({
      id: 'task-1',
      contextId: 'ctx-1',
      metadata,
    });
    expect(task.metadata).toEqual({ foo: 'bar' });
  });

  it('falls back to wall-clock time when `now` is not provided', () => {
    const before = Date.now();
    const task = createTask({ id: 'task-1', contextId: 'ctx-1' });
    const stamped = Date.parse(task.createdAt);
    const after = Date.now();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });
});

describe('transitionTask - legal transitions', () => {
  it.each(LEGAL_TRANSITIONS)('transitions %s -> %s', (from, to) => {
    const task = fresh(from);
    const next = transitionTask(task, to, {
      now: fixedClock('2026-02-02T00:00:00.000Z'),
    });
    expect(next.state).toBe(to);
    expect(next.status.state).toBe(to);
    expect(next.status.timestamp).toBe('2026-02-02T00:00:00.000Z');
    expect(next.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('stamps completedAt when entering COMPLETED', () => {
    const inProgress = fresh(TASK_STATE.IN_PROGRESS);
    const completed = transitionTask(inProgress, TASK_STATE.COMPLETED, {
      now: fixedClock('2026-03-03T00:00:00.000Z'),
    });
    expect(completed.completedAt).toBe('2026-03-03T00:00:00.000Z');
  });

  it('stamps completedAt when entering FAILED', () => {
    const inProgress = fresh(TASK_STATE.IN_PROGRESS);
    const failed = transitionTask(inProgress, TASK_STATE.FAILED, {
      now: fixedClock('2026-03-03T00:00:00.000Z'),
    });
    expect(failed.completedAt).toBe('2026-03-03T00:00:00.000Z');
  });

  it('stamps completedAt when entering CANCELLED', () => {
    const inProgress = fresh(TASK_STATE.IN_PROGRESS);
    const cancelled = transitionTask(inProgress, TASK_STATE.CANCELLED, {
      now: fixedClock('2026-03-03T00:00:00.000Z'),
    });
    expect(cancelled.completedAt).toBe('2026-03-03T00:00:00.000Z');
  });

  it('does not stamp completedAt for non-terminal transitions', () => {
    const pending = fresh(TASK_STATE.PENDING);
    const inProgress = transitionTask(pending, TASK_STATE.IN_PROGRESS);
    expect(inProgress.completedAt).toBeUndefined();
  });

  it('returns a new object and does not mutate the original task', () => {
    const task = fresh(TASK_STATE.PENDING);
    const next = transitionTask(task, TASK_STATE.IN_PROGRESS);
    expect(next).not.toBe(task);
    expect(task.state).toBe(TASK_STATE.PENDING);
    expect(task.status.state).toBe(TASK_STATE.PENDING);
  });

  it('preserves createdAt across transitions', () => {
    const task = fresh(TASK_STATE.PENDING);
    const next = transitionTask(task, TASK_STATE.IN_PROGRESS, {
      now: fixedClock('2026-04-04T00:00:00.000Z'),
    });
    expect(next.createdAt).toBe(task.createdAt);
    expect(next.updatedAt).not.toBe(task.updatedAt);
  });

  it('attaches the provided status message', () => {
    const message: Message = {
      messageId: 'msg-1',
      role: 'ROLE_AGENT',
      content: [],
    } as unknown as Message;
    const task = fresh(TASK_STATE.IN_PROGRESS);
    const next = transitionTask(task, TASK_STATE.INPUT_REQUIRED, { message });
    expect(next.status.message).toBe(message);
  });

  it('supports the INPUT_REQUIRED -> IN_PROGRESS resume path', () => {
    const paused = fresh(TASK_STATE.INPUT_REQUIRED);
    const resumed = transitionTask(paused, TASK_STATE.IN_PROGRESS);
    expect(resumed.state).toBe(TASK_STATE.IN_PROGRESS);
    expect(isPaused(paused.state)).toBe(true);
    expect(isPaused(resumed.state)).toBe(false);
  });
});

describe('transitionTask - illegal transitions', () => {
  it.each(ILLEGAL_TRANSITIONS)(
    'throws when attempting %s -> %s',
    (from, to) => {
      const task = fresh(from);
      expect(() => transitionTask(task, to)).toThrow(TaskTransitionError);
    }
  );

  it('error exposes from/to for structured handling', () => {
    const task = fresh(TASK_STATE.COMPLETED);
    try {
      transitionTask(task, TASK_STATE.IN_PROGRESS);
      expect.fail('expected TaskTransitionError');
    } catch (err) {
      expect(err).toBeInstanceOf(TaskTransitionError);
      const e = err as TaskTransitionError;
      expect(e.from).toBe(TASK_STATE.COMPLETED);
      expect(e.to).toBe(TASK_STATE.IN_PROGRESS);
      expect(e.name).toBe('TaskTransitionError');
      expect(e.message).toMatch(/Illegal task transition/);
    }
  });

  it('terminal states are sinks - no outbound transitions exist', () => {
    for (const terminal of [
      TASK_STATE.COMPLETED,
      TASK_STATE.FAILED,
      TASK_STATE.CANCELLED,
    ]) {
      for (const target of ALL_STATES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });
});

describe('toWireTask', () => {
  const baseMessages: Message[] = [
    { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: 'one' }] },
    { messageId: 'm-2', role: 'ROLE_AGENT', parts: [{ text: 'two' }] },
    { messageId: 'm-3', role: 'ROLE_USER', parts: [{ text: 'three' }] },
  ];

  function withMessages(messages: Message[]): ManagedTask {
    return createTask({
      id: 'task-1',
      contextId: 'ctx-1',
      messages,
      now: fixedClock('2026-01-01T00:00:00.000Z'),
    });
  }

  it('projects the ManagedTask into the wire-format Task with full history', () => {
    const task = withMessages(baseMessages);
    const wire = toWireTask(task);

    expect(wire.id).toBe('task-1');
    expect(wire.contextId).toBe('ctx-1');
    expect(wire.status.state).toBe(TASK_STATE.PENDING);
    expect(wire.status.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(wire.history).toEqual(baseMessages);
  });

  it('truncates history to the last N messages when historyLength is provided', () => {
    const task = withMessages(baseMessages);
    const wire = toWireTask(task, 2);

    expect(wire.history).toEqual([baseMessages[1], baseMessages[2]]);
  });

  it('returns an empty history when historyLength is 0', () => {
    const task = withMessages(baseMessages);
    const wire = toWireTask(task, 0);

    expect(wire.history).toEqual([]);
  });

  it('returns the full history when historyLength exceeds the message count', () => {
    const task = withMessages(baseMessages);
    const wire = toWireTask(task, 99);

    expect(wire.history).toEqual(baseMessages);
  });

  it('omits artifacts when the managed task has none', () => {
    const task = withMessages(baseMessages);
    const wire = toWireTask(task);

    expect(wire.artifacts).toBeUndefined();
  });

  it('returns a fresh copy of history so callers can mutate without affecting storage', () => {
    const task = withMessages(baseMessages);
    const wire = toWireTask(task);

    wire.history?.pop();
    expect(task.messages).toHaveLength(baseMessages.length);
  });
});
