import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_STATE,
  createTask,
  transitionTask,
  type ManagedTask,
} from '../../src/agent/task.js';
import {
  A2AServer,
  DEFAULT_TASK_LIST_LIMIT,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  MAX_TASK_LIST_LIMIT,
  TASK_LIST_METHOD,
  createA2AServer,
  createTaskListHandler,
  type TaskListResult,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { Task, TaskState } from '../../src/types/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'task-list-agent',
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

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeTask(
  storage: InMemoryTaskStorage,
  index: number,
  overrides: { id?: string; contextId?: string } = {}
): ManagedTask {
  const id = overrides.id ?? `t-${String(index).padStart(3, '0')}`;
  const contextId = overrides.contextId ?? 'ctx-1';
  const iso = new Date(EPOCH + index * 1000).toISOString();
  const task = createTask({
    id,
    contextId,
    now: fixedClock(iso),
  });
  storage.createActive(task);
  return task;
}

function complete(
  storage: InMemoryTaskStorage,
  task: ManagedTask,
  bumpIndex: number
): ManagedTask {
  const iso1 = new Date(EPOCH + bumpIndex * 1000 + 100).toISOString();
  const iso2 = new Date(EPOCH + bumpIndex * 1000 + 200).toISOString();
  const working = transitionTask(task, TASK_STATE.IN_PROGRESS, {
    now: fixedClock(iso1),
  });
  const done = transitionTask(working, TASK_STATE.COMPLETED, {
    now: fixedClock(iso2),
  });
  storage.storeDeadLetter(done);
  return done;
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

describe('createTaskListHandler', () => {
  const ctx = { signal: new AbortController().signal };

  it('returns empty tasks with no nextCursor when storage is empty', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskListHandler({ storage });

    const result = handler({}, ctx) as TaskListResult;

    expect(result.tasks).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('accepts undefined params and returns all tasks (within default limit)', () => {
    const storage = new InMemoryTaskStorage();
    makeTask(storage, 1);
    makeTask(storage, 2);
    const handler = createTaskListHandler({ storage });

    const result = handler(undefined, ctx) as TaskListResult;

    expect(result.tasks.map((t) => t.id)).toEqual(['t-001', 't-002']);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns tasks ordered by createdAt (FIFO), spanning active and dead-letter stores', () => {
    const storage = new InMemoryTaskStorage();
    const a = makeTask(storage, 1, { id: 'a' });
    makeTask(storage, 2, { id: 'b' });
    makeTask(storage, 3, { id: 'c' });
    complete(storage, a, 4);
    const handler = createTaskListHandler({ storage });

    const result = handler({}, ctx) as TaskListResult;

    expect(result.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters by state', () => {
    const storage = new InMemoryTaskStorage();
    const a = makeTask(storage, 1, { id: 'a' });
    makeTask(storage, 2, { id: 'b' });
    complete(storage, a, 3);
    const handler = createTaskListHandler({ storage });

    const result = handler(
      { state: 'TASK_STATE_COMPLETED' satisfies TaskState },
      ctx
    ) as TaskListResult;

    expect(result.tasks.map((t) => t.id)).toEqual(['a']);
    expect(result.tasks[0]?.status.state).toBe(
      'TASK_STATE_COMPLETED' satisfies TaskState
    );
  });

  it('filters by contextId', () => {
    const storage = new InMemoryTaskStorage();
    makeTask(storage, 1, { id: 'a', contextId: 'ctx-A' });
    makeTask(storage, 2, { id: 'b', contextId: 'ctx-B' });
    makeTask(storage, 3, { id: 'c', contextId: 'ctx-A' });
    const handler = createTaskListHandler({ storage });

    const result = handler({ contextId: 'ctx-A' }, ctx) as TaskListResult;

    expect(result.tasks.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('combines state and contextId filters', () => {
    const storage = new InMemoryTaskStorage();
    const a = makeTask(storage, 1, { id: 'a', contextId: 'x' });
    makeTask(storage, 2, { id: 'b', contextId: 'x' });
    makeTask(storage, 3, { id: 'c', contextId: 'y' });
    complete(storage, a, 4);
    const handler = createTaskListHandler({ storage });

    const result = handler(
      {
        contextId: 'x',
        state: 'TASK_STATE_COMPLETED' satisfies TaskState,
      },
      ctx
    ) as TaskListResult;

    expect(result.tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('returns empty when state matches no tasks', () => {
    const storage = new InMemoryTaskStorage();
    makeTask(storage, 1, { id: 'a' });
    const handler = createTaskListHandler({ storage });

    const result = handler(
      { state: 'TASK_STATE_CANCELLED' satisfies TaskState },
      ctx
    ) as TaskListResult;

    expect(result.tasks).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('returns empty when state is a non-managed wire value (e.g., UNSPECIFIED)', () => {
    const storage = new InMemoryTaskStorage();
    makeTask(storage, 1, { id: 'a' });
    const handler = createTaskListHandler({ storage });

    const result = handler(
      { state: 'TASK_STATE_UNSPECIFIED' satisfies TaskState },
      ctx
    ) as TaskListResult;

    expect(result.tasks).toEqual([]);
  });

  describe('pagination', () => {
    function seed(storage: InMemoryTaskStorage, count: number): void {
      for (let i = 1; i <= count; i++) {
        makeTask(storage, i);
      }
    }

    it('returns a nextCursor when more results remain', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 5);
      const handler = createTaskListHandler({ storage });

      const result = handler({ limit: 2 }, ctx) as TaskListResult;

      expect(result.tasks.map((t) => t.id)).toEqual(['t-001', 't-002']);
      expect(result.nextCursor).toBeDefined();
      expect(typeof result.nextCursor).toBe('string');
    });

    it('omits nextCursor on the final page', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 4);
      const handler = createTaskListHandler({ storage });

      const page1 = handler({ limit: 2 }, ctx) as TaskListResult;
      const page2 = handler(
        { limit: 2, cursor: page1.nextCursor },
        ctx
      ) as TaskListResult;

      expect(page2.tasks.map((t) => t.id)).toEqual(['t-003', 't-004']);
      expect(page2.nextCursor).toBeUndefined();
    });

    it('paginates the full set deterministically', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 6);
      const handler = createTaskListHandler({ storage });

      const collected: string[] = [];
      let cursor: string | undefined;
      let safety = 0;
      while (safety++ < 100) {
        const args: Record<string, unknown> = { limit: 2 };
        if (cursor !== undefined) args['cursor'] = cursor;
        const page = handler(args, ctx) as TaskListResult;
        collected.push(...page.tasks.map((t) => t.id));
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }

      expect(collected).toEqual([
        't-001',
        't-002',
        't-003',
        't-004',
        't-005',
        't-006',
      ]);
    });

    it('pagination is stable when a task is inserted after the cursor is taken', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 4);
      const handler = createTaskListHandler({ storage });

      const page1 = handler({ limit: 2 }, ctx) as TaskListResult;
      expect(page1.tasks.map((t) => t.id)).toEqual(['t-001', 't-002']);

      // Insert a new task whose createdAt is AFTER the cursor - should show
      // up on the next page since (createdAt, id) > cursor.
      makeTask(storage, 99, { id: 't-099' });

      const page2 = handler(
        { limit: 10, cursor: page1.nextCursor },
        ctx
      ) as TaskListResult;
      expect(page2.tasks.map((t) => t.id)).toEqual(['t-003', 't-004', 't-099']);
    });

    it('pagination is stable when the task referenced by the cursor is deleted', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 5);
      const handler = createTaskListHandler({ storage });

      const page1 = handler({ limit: 2 }, ctx) as TaskListResult;
      // Cursor encodes (createdAt, id) of t-002. Cascade-delete its context
      // so t-002 disappears from storage entirely.
      storage.deleteContext('ctx-1');

      // Re-seed with a different context so subsequent listing has content.
      for (let i = 10; i <= 12; i++) {
        makeTask(storage, i, { contextId: 'ctx-2' });
      }

      const page2 = handler(
        { limit: 10, cursor: page1.nextCursor },
        ctx
      ) as TaskListResult;
      // All tasks created after the cursor's (createdAt, id) come through.
      expect(page2.tasks.map((t) => t.id)).toEqual(['t-010', 't-011', 't-012']);
    });

    it('clamps limit to the configured maxLimit silently', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 5);
      const handler = createTaskListHandler({ storage, maxLimit: 3 });

      const result = handler({ limit: 1000 }, ctx) as TaskListResult;

      expect(result.tasks).toHaveLength(3);
      expect(result.nextCursor).toBeDefined();
    });

    it('uses defaultLimit when limit is omitted', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 5);
      const handler = createTaskListHandler({
        storage,
        defaultLimit: 2,
      });

      const result = handler({}, ctx) as TaskListResult;

      expect(result.tasks).toHaveLength(2);
      expect(result.nextCursor).toBeDefined();
    });

    it('clamps defaultLimit to maxLimit when defaultLimit exceeds it', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 10);
      const handler = createTaskListHandler({
        storage,
        defaultLimit: 100,
        maxLimit: 3,
      });

      const result = handler({}, ctx) as TaskListResult;

      expect(result.tasks).toHaveLength(3);
    });

    it('exposes DEFAULT_TASK_LIST_LIMIT and MAX_TASK_LIST_LIMIT as 100', () => {
      expect(DEFAULT_TASK_LIST_LIMIT).toBe(100);
      expect(MAX_TASK_LIST_LIMIT).toBe(100);
    });

    it('cursors are opaque base64url-encoded strings', () => {
      const storage = new InMemoryTaskStorage();
      seed(storage, 3);
      const handler = createTaskListHandler({ storage });

      const result = handler({ limit: 1 }, ctx) as TaskListResult;

      expect(result.nextCursor).toBeDefined();
      const cursor = result.nextCursor as string;
      // base64url alphabet only.
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      expect(typeof parsed['createdAt']).toBe('string');
      expect(typeof parsed['id']).toBe('string');
    });
  });

  describe('invalid params', () => {
    function getHandler(): ReturnType<typeof createTaskListHandler> {
      const storage = new InMemoryTaskStorage();
      makeTask(storage, 1);
      return createTaskListHandler({ storage });
    }

    function expectInvalidParams(
      run: () => unknown,
      messageFragment?: string
    ): void {
      try {
        run();
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        if (messageFragment !== undefined) {
          expect((err as JSONRPCError).message).toContain(messageFragment);
        }
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    }

    it('throws -32602 when params is null', () => {
      const handler = getHandler();
      expectInvalidParams(() => handler(null as unknown, ctx));
    });

    it('throws -32602 when params is an array', () => {
      const handler = getHandler();
      expectInvalidParams(() => handler([] as unknown, ctx));
    });

    it('throws -32602 when state is not a string', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ state: 42 } as unknown, ctx),
        'state'
      );
    });

    it('throws -32602 when state is the empty string', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ state: '' } as unknown, ctx),
        'state'
      );
    });

    it('throws -32602 when contextId is not a string', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ contextId: 42 } as unknown, ctx),
        'contextId'
      );
    });

    it('throws -32602 when limit is zero', () => {
      const handler = getHandler();
      expectInvalidParams(() => handler({ limit: 0 } as unknown, ctx), 'limit');
    });

    it('throws -32602 when limit is negative', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ limit: -1 } as unknown, ctx),
        'limit'
      );
    });

    it('throws -32602 when limit is a float', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ limit: 1.5 } as unknown, ctx),
        'limit'
      );
    });

    it('throws -32602 when cursor is not a string', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ cursor: 42 } as unknown, ctx),
        'cursor'
      );
    });

    it('throws -32602 when cursor is not valid JSON inside base64', () => {
      const handler = getHandler();
      const bogus = Buffer.from('not-json', 'utf8').toString('base64url');
      expectInvalidParams(() => handler({ cursor: bogus } as unknown, ctx));
    });

    it('throws -32602 when cursor JSON is missing required fields', () => {
      const handler = getHandler();
      const bogus = Buffer.from(JSON.stringify({ wrong: 'shape' })).toString(
        'base64url'
      );
      expectInvalidParams(() => handler({ cursor: bogus } as unknown, ctx));
    });

    it('throws -32602 when metadata is not an object', () => {
      const handler = getHandler();
      expectInvalidParams(
        () => handler({ metadata: 'oops' } as unknown, ctx),
        'metadata'
      );
    });
  });

  describe('configuration', () => {
    it('rejects non-positive maxLimit at construction time', () => {
      const storage = new InMemoryTaskStorage();
      expect(() =>
        createTaskListHandler({ storage, maxLimit: 0 })
      ).toThrowError(/maxLimit/);
    });

    it('rejects non-positive defaultLimit at construction time', () => {
      const storage = new InMemoryTaskStorage();
      expect(() =>
        createTaskListHandler({ storage, defaultLimit: -1 })
      ).toThrowError(/defaultLimit/);
    });

    it('rejects non-integer maxLimit at construction time', () => {
      const storage = new InMemoryTaskStorage();
      expect(() =>
        createTaskListHandler({ storage, maxLimit: 1.5 })
      ).toThrowError(/maxLimit/);
    });
  });
});

describe('tasks/list JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('dispatches a happy-path tasks/list request and returns the tasks', async () => {
    const storage = new InMemoryTaskStorage();
    makeTask(storage, 1, { id: 'a' });
    makeTask(storage, 2, { id: 'b' });
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: TASK_LIST_METHOD,
      params: {},
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { tasks: Task[]; nextCursor?: string };
    };
    expect(body.jsonrpc).toBe(JSONRPC_VERSION);
    expect(body.id).toBe(1);
    expect(body.result.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(body.result.nextCursor).toBeUndefined();
  });

  it('round-trips pagination over HTTP', async () => {
    const storage = new InMemoryTaskStorage();
    for (let i = 1; i <= 5; i++) {
      makeTask(storage, i);
    }
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res1 = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: TASK_LIST_METHOD,
      params: { limit: 2 },
    });
    const body1 = (await res1.json()) as {
      result: { tasks: Task[]; nextCursor?: string };
    };
    expect(body1.result.tasks.map((t) => t.id)).toEqual(['t-001', 't-002']);
    expect(body1.result.nextCursor).toBeDefined();

    const res2 = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: TASK_LIST_METHOD,
      params: { limit: 2, cursor: body1.result.nextCursor },
    });
    const body2 = (await res2.json()) as {
      result: { tasks: Task[]; nextCursor?: string };
    };
    expect(body2.result.tasks.map((t) => t.id)).toEqual(['t-003', 't-004']);
    expect(body2.result.nextCursor).toBeDefined();

    const res3 = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: TASK_LIST_METHOD,
      params: { limit: 2, cursor: body2.result.nextCursor },
    });
    const body3 = (await res3.json()) as {
      result: { tasks: Task[]; nextCursor?: string };
    };
    expect(body3.result.tasks.map((t) => t.id)).toEqual(['t-005']);
    expect(body3.result.nextCursor).toBeUndefined();
  });

  it('returns -32602 when the cursor cannot be decoded', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: TASK_LIST_METHOD,
      params: { cursor: 'not-a-valid-cursor!!' },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(4);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
  });

  it('returns -32602 when limit is invalid', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 5,
      method: TASK_LIST_METHOD,
      params: { limit: 0 },
    });
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toContain('limit');
  });
});
