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
  TASK_GET_METHOD,
  createA2AServer,
  createTaskGetHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { Message, Task, TaskState } from '../../src/types/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'task-get-agent',
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

function seedActiveTask(
  storage: InMemoryTaskStorage,
  overrides: { id?: string; messages?: Message[] } = {}
): ManagedTask {
  const id = overrides.id ?? 'task-1';
  const messages = overrides.messages ?? [makeMessage('m-1', 'hello')];
  const task = createTask({
    id,
    contextId: 'ctx-1',
    messages,
    now: fixedNow('2026-05-26T12:00:00.000Z'),
  });
  storage.enqueue(task);
  return task;
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

describe('createTaskGetHandler', () => {
  const ctx = { signal: new AbortController().signal };

  it('returns the wire-format Task for an active task id', () => {
    const storage = new InMemoryTaskStorage();
    seedActiveTask(storage);
    const handler = createTaskGetHandler({ storage });

    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(result.id).toBe('task-1');
    expect(result.contextId).toBe('ctx-1');
    expect(result.status.state).toBe(
      'TASK_STATE_SUBMITTED' satisfies TaskState
    );
    expect(result.status.timestamp).toBe('2026-05-26T12:00:00.000Z');
    expect(result.history).toEqual([makeMessage('m-1', 'hello')]);
  });

  it('finds a task that has already been moved to the dead-letter store', () => {
    const storage = new InMemoryTaskStorage();
    const task = seedActiveTask(storage);
    const inProgress = transitionTask(task, TASK_STATE.IN_PROGRESS, {
      now: fixedNow('2026-05-26T12:01:00.000Z'),
    });
    storage.updateActive(inProgress);
    const completed = transitionTask(inProgress, TASK_STATE.COMPLETED, {
      now: fixedNow('2026-05-26T12:02:00.000Z'),
    });
    storage.storeDeadLetter(completed);

    const handler = createTaskGetHandler({ storage });
    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(result.id).toBe('task-1');
    expect(result.status.state).toBe(
      'TASK_STATE_COMPLETED' satisfies TaskState
    );
  });

  it('returns the full history when historyLength is omitted', () => {
    const storage = new InMemoryTaskStorage();
    const messages = [
      makeMessage('m-1', 'one'),
      makeMessage('m-2', 'two'),
      makeMessage('m-3', 'three'),
    ];
    seedActiveTask(storage, { messages });
    const handler = createTaskGetHandler({ storage });

    const result = handler({ taskId: 'task-1' }, ctx) as Task;

    expect(result.history).toEqual(messages);
  });

  it('truncates history to the last N messages when historyLength is set', () => {
    const storage = new InMemoryTaskStorage();
    const messages = [
      makeMessage('m-1', 'one'),
      makeMessage('m-2', 'two'),
      makeMessage('m-3', 'three'),
      makeMessage('m-4', 'four'),
    ];
    seedActiveTask(storage, { messages });
    const handler = createTaskGetHandler({ storage });

    const result = handler({ taskId: 'task-1', historyLength: 2 }, ctx) as Task;

    expect(result.history).toEqual([
      makeMessage('m-3', 'three'),
      makeMessage('m-4', 'four'),
    ]);
  });

  it('returns an empty history when historyLength is 0', () => {
    const storage = new InMemoryTaskStorage();
    seedActiveTask(storage, {
      messages: [makeMessage('m-1', 'hi'), makeMessage('m-2', 'there')],
    });
    const handler = createTaskGetHandler({ storage });

    const result = handler({ taskId: 'task-1', historyLength: 0 }, ctx) as Task;

    expect(result.history).toEqual([]);
  });

  it('returns the full history when historyLength exceeds the message count', () => {
    const storage = new InMemoryTaskStorage();
    const messages = [makeMessage('m-1', 'one'), makeMessage('m-2', 'two')];
    seedActiveTask(storage, { messages });
    const handler = createTaskGetHandler({ storage });

    const result = handler(
      { taskId: 'task-1', historyLength: 99 },
      ctx
    ) as Task;

    expect(result.history).toEqual(messages);
  });

  describe('invalid params', () => {
    const storage = new InMemoryTaskStorage();
    seedActiveTask(storage);
    const handler = createTaskGetHandler({ storage });

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

    it('throws -32602 when historyLength is negative', () => {
      try {
        handler({ taskId: 'task-1', historyLength: -1 } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toContain('historyLength');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when historyLength is not an integer', () => {
      try {
        handler({ taskId: 'task-1', historyLength: 1.5 } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when the task id is unknown', () => {
      try {
        handler({ taskId: 'does-not-exist' } as unknown, ctx);
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
});

describe('tasks/get JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('dispatches a happy-path tasks/get request and returns the Task', async () => {
    const storage = new InMemoryTaskStorage();
    seedActiveTask(storage);
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: TASK_GET_METHOD,
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
    expect(body.result.contextId).toBe('ctx-1');
    expect(body.result.status.state).toBe(
      'TASK_STATE_SUBMITTED' satisfies TaskState
    );
    expect(body.result.history).toEqual([makeMessage('m-1', 'hello')]);
  });

  it('returns -32602 with "task not found" when the task id is unknown', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: TASK_GET_METHOD,
      params: { taskId: 'missing' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(2);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toBe('task not found');
  });

  it('truncates history when historyLength is provided', async () => {
    const storage = new InMemoryTaskStorage();
    const messages = [
      makeMessage('m-1', 'one'),
      makeMessage('m-2', 'two'),
      makeMessage('m-3', 'three'),
    ];
    seedActiveTask(storage, { messages });
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: TASK_GET_METHOD,
      params: { taskId: 'task-1', historyLength: 1 },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { result: Task };
    expect(body.result.history).toEqual([makeMessage('m-3', 'three')]);
  });

  it('returns -32602 when taskId is missing from params', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: TASK_GET_METHOD,
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
