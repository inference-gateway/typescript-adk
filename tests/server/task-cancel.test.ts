import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import {
  A2AServer,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  TASK_CANCEL_METHOD,
  TaskCancellationRegistry,
  createA2AServer,
  createTaskCancelHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { Message, Task, TaskState } from '../../src/types/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'task-cancel-agent',
    description: 'Agent under test',
    version: '0.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo input.', tags: [] },
    ],
  };
}

function makeMessage(id: string, text: string): Message {
  return {
    messageId: id,
    role: 'ROLE_USER',
    parts: [{ text }],
    contextId: 'ctx-1',
  };
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function seedPendingTask(
  storage: InMemoryTaskStorage,
  id = 'task-1'
): ManagedTask {
  const task = createTask({
    id,
    contextId: 'ctx-1',
    messages: [makeMessage('m-1', 'hello')],
    now: fixedNow('2026-05-26T12:00:00.000Z'),
  });
  storage.enqueue(task);
  return task;
}

function seedInProgressTask(
  storage: InMemoryTaskStorage,
  id = 'task-1'
): ManagedTask {
  const pending = createTask({
    id,
    contextId: 'ctx-1',
    messages: [makeMessage('m-1', 'hello')],
    now: fixedNow('2026-05-26T12:00:00.000Z'),
  });
  storage.createActive(pending);
  const working = transitionTask(pending, TASK_STATE.IN_PROGRESS, {
    now: fixedNow('2026-05-26T12:01:00.000Z'),
  });
  storage.updateActive(working);
  return working;
}

function seedTerminalTask(
  storage: InMemoryTaskStorage,
  finalState:
    | typeof TASK_STATE.COMPLETED
    | typeof TASK_STATE.FAILED
    | typeof TASK_STATE.CANCELLED = TASK_STATE.COMPLETED,
  id = 'task-1'
): ManagedTask {
  const pending = createTask({
    id,
    contextId: 'ctx-1',
    messages: [makeMessage('m-1', 'hello')],
    now: fixedNow('2026-05-26T12:00:00.000Z'),
  });
  storage.createActive(pending);
  const working = transitionTask(pending, TASK_STATE.IN_PROGRESS, {
    now: fixedNow('2026-05-26T12:01:00.000Z'),
  });
  storage.updateActive(working);
  const terminal = transitionTask(working, finalState, {
    now: fixedNow('2026-05-26T12:02:00.000Z'),
  });
  storage.storeDeadLetter(terminal);
  return terminal;
}

async function start(server: A2AServer): Promise<string> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report a listening address');
  }
  return `http://127.0.0.1:${addr.port}`;
}

async function postJSON(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('createTaskCancelHandler', () => {
  const ctx = { signal: new AbortController().signal };

  it('drops a PENDING task from the queue and marks it CANCELLED', () => {
    const storage = new InMemoryTaskStorage();
    seedPendingTask(storage);
    expect(storage.queueLength()).toBe(1);

    const handler = createTaskCancelHandler({
      storage,
      now: fixedNow('2026-05-26T12:03:00.000Z'),
    });
    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(result.id).toBe('task-1');
    expect(result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
    expect(result.status.timestamp).toBe('2026-05-26T12:03:00.000Z');
    expect(storage.queueLength()).toBe(0);
    expect(storage.getActive('task-1')).toBeUndefined();
    expect(storage.getTask('task-1')?.state).toBe(TASK_STATE.CANCELLED);
  });

  it('aborts the registered controller and CANCELS an IN_PROGRESS task', () => {
    const storage = new InMemoryTaskStorage();
    seedInProgressTask(storage);

    const registry = new TaskCancellationRegistry();
    const controller = new AbortController();
    registry.register('task-1', controller);

    const handler = createTaskCancelHandler({
      storage,
      registry,
      now: fixedNow('2026-05-26T12:03:00.000Z'),
    });
    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(DOMException);
    expect((controller.signal.reason as DOMException).name).toBe('AbortError');
    expect(registry.has('task-1')).toBe(false);
    expect(result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
    expect(storage.getActive('task-1')).toBeUndefined();
    expect(storage.getTask('task-1')?.state).toBe(TASK_STATE.CANCELLED);
  });

  it('cancels an IN_PROGRESS task even when no controller is registered', () => {
    const storage = new InMemoryTaskStorage();
    seedInProgressTask(storage);
    const registry = new TaskCancellationRegistry();

    const handler = createTaskCancelHandler({
      storage,
      registry,
      now: fixedNow('2026-05-26T12:03:00.000Z'),
    });
    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
    expect(storage.getTask('task-1')?.state).toBe(TASK_STATE.CANCELLED);
  });

  it('cancels an INPUT_REQUIRED task', () => {
    const storage = new InMemoryTaskStorage();
    const pending = createTask({
      id: 'task-input',
      contextId: 'ctx-1',
      messages: [makeMessage('m-1', 'hello')],
      now: fixedNow('2026-05-26T12:00:00.000Z'),
    });
    storage.createActive(pending);
    const working = transitionTask(pending, TASK_STATE.IN_PROGRESS, {
      now: fixedNow('2026-05-26T12:01:00.000Z'),
    });
    storage.updateActive(working);
    const awaitingInput = transitionTask(working, TASK_STATE.INPUT_REQUIRED, {
      now: fixedNow('2026-05-26T12:02:00.000Z'),
    });
    storage.updateActive(awaitingInput);

    const handler = createTaskCancelHandler({
      storage,
      now: fixedNow('2026-05-26T12:03:00.000Z'),
    });
    const result = handler({ taskId: 'task-input' }, ctx) as Task;

    expect(result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
    expect(storage.getTask('task-input')?.state).toBe(TASK_STATE.CANCELLED);
  });

  it('works without a registry for a PENDING task', () => {
    const storage = new InMemoryTaskStorage();
    seedPendingTask(storage);

    const handler = createTaskCancelHandler({ storage });
    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
  });

  it('does not invoke other registered controllers when cancelling one task', () => {
    const storage = new InMemoryTaskStorage();
    seedInProgressTask(storage, 'task-1');
    seedInProgressTask(storage, 'task-2');

    const registry = new TaskCancellationRegistry();
    const a = new AbortController();
    const b = new AbortController();
    registry.register('task-1', a);
    registry.register('task-2', b);

    const handler = createTaskCancelHandler({ storage, registry });
    handler({ taskId: 'task-1' }, ctx);

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(registry.has('task-2')).toBe(true);
  });

  describe('invalid params', () => {
    const storage = new InMemoryTaskStorage();
    seedInProgressTask(storage);
    const handler = createTaskCancelHandler({ storage });

    it('throws -32602 when params is null', () => {
      try {
        handler(null as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when params is an array', () => {
      try {
        handler([] as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when taskId is missing', () => {
      try {
        handler({} as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toContain('taskId');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when taskId is the empty string', () => {
      try {
        handler({ taskId: '' } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when taskId is not a string', () => {
      try {
        handler({ taskId: 42 } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when metadata is not an object', () => {
      try {
        handler({ taskId: 'task-1', metadata: 'bad' } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toContain('metadata');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 with "task not found" for an unknown task id', () => {
      try {
        handler({ taskId: 'unknown' } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toBe('task not found');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });
  });

  describe('terminal-state rejection', () => {
    const finalStates = [
      TASK_STATE.COMPLETED,
      TASK_STATE.FAILED,
      TASK_STATE.CANCELLED,
    ] as const;

    for (const finalState of finalStates) {
      it(`throws -32602 when the task is already in ${finalState}`, () => {
        const storage = new InMemoryTaskStorage();
        seedTerminalTask(storage, finalState);
        const handler = createTaskCancelHandler({ storage });

        try {
          handler({ taskId: 'task-1' }, ctx);
        } catch (err) {
          expect(err).toBeInstanceOf(JSONRPCError);
          expect((err as JSONRPCError).code).toBe(
            JSONRPC_ERROR_CODES.INVALID_PARAMS
          );
          expect((err as JSONRPCError).message).toContain(
            'cannot be cancelled'
          );
          expect((err as JSONRPCError).message).toContain(finalState);
          return;
        }
        throw new Error('expected JSONRPCError to be thrown');
      });
    }
  });
});

describe('tasks/cancel JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('cancels a PENDING task end-to-end over JSON-RPC', async () => {
    const storage = new InMemoryTaskStorage();
    seedPendingTask(storage);

    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      TASK_CANCEL_METHOD,
      createTaskCancelHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: TASK_CANCEL_METHOD,
      params: { taskId: 'task-1' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: Task;
    };
    expect(body.jsonrpc).toBe(JSONRPC_VERSION);
    expect(body.id).toBe(1);
    expect(body.result.id).toBe('task-1');
    expect(body.result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
    expect(storage.queueLength()).toBe(0);
  });

  it('cancels an IN_PROGRESS task and aborts the registered controller', async () => {
    const storage = new InMemoryTaskStorage();
    seedInProgressTask(storage);
    const registry = new TaskCancellationRegistry();
    const controller = new AbortController();
    registry.register('task-1', controller);

    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      TASK_CANCEL_METHOD,
      createTaskCancelHandler({ storage, registry })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: TASK_CANCEL_METHOD,
      params: { taskId: 'task-1' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { result: Task };
    expect(body.result.status.state).toBe(
      'TASK_STATE_CANCELLED' satisfies TaskState
    );
    expect(controller.signal.aborted).toBe(true);
    expect(registry.has('task-1')).toBe(false);
  });

  it('returns -32602 "task not found" for an unknown task id', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      TASK_CANCEL_METHOD,
      createTaskCancelHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: TASK_CANCEL_METHOD,
      params: { taskId: 'missing' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(3);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toBe('task not found');
  });

  it('returns -32602 when the task is already in a terminal state', async () => {
    const storage = new InMemoryTaskStorage();
    seedTerminalTask(storage, TASK_STATE.COMPLETED);
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      TASK_CANCEL_METHOD,
      createTaskCancelHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: TASK_CANCEL_METHOD,
      params: { taskId: 'task-1' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toContain('cannot be cancelled');
  });

  it('returns -32602 when taskId is missing from params', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      TASK_CANCEL_METHOD,
      createTaskCancelHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 5,
      method: TASK_CANCEL_METHOD,
      params: {},
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toContain('taskId');
  });
});
