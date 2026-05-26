import { afterEach, describe, expect, it } from 'vitest';
import { TASK_STATE } from '../../src/agent/task.js';
import {
  A2AServer,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  MESSAGE_SEND_METHOD,
  createA2AServer,
  createMessageSendHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { Message, Task, TaskState } from '../../src/types/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'message-send-agent',
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

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'msg-1',
    role: 'ROLE_USER',
    parts: [{ text: 'hello' }],
    ...overrides,
  };
}

function sequentialIdGenerator(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `id-${counter}`;
  };
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
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

describe('createMessageSendHandler', () => {
  it('creates a PENDING task, enqueues it, and returns the wire-format Task', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
      now: fixedNow('2026-05-26T12:00:00.000Z'),
    });

    const result = handler(
      {
        message: makeMessage({ contextId: 'ctx-existing', messageId: 'm-1' }),
      },
      { signal: new AbortController().signal }
    ) as Task;

    expect(result.id).toBe('id-1');
    expect(result.contextId).toBe('ctx-existing');
    expect(result.status.state).toBe(
      'TASK_STATE_SUBMITTED' satisfies TaskState
    );
    expect(result.status.timestamp).toBe('2026-05-26T12:00:00.000Z');
    expect(result.history).toEqual([
      {
        messageId: 'm-1',
        role: 'ROLE_USER',
        parts: [{ text: 'hello' }],
        contextId: 'ctx-existing',
      },
    ]);

    expect(storage.queueLength()).toBe(1);
    const stored = storage.getActive('id-1');
    expect(stored).toBeDefined();
    expect(stored?.state).toBe(TASK_STATE.PENDING);
    expect(stored?.contextId).toBe('ctx-existing');
  });

  it('reuses the provided contextId when present on the inbound message', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });

    const result = handler(
      { message: makeMessage({ contextId: 'ctx-from-client' }) },
      { signal: new AbortController().signal }
    ) as Task;

    expect(result.contextId).toBe('ctx-from-client');
    expect(result.id).toBe('id-1');
  });

  it('mints a fresh contextId when the inbound message omits one', () => {
    const storage = new InMemoryTaskStorage();
    const ids = ['task-uuid', 'ctx-uuid'];
    const handler = createMessageSendHandler({
      storage,
      idGenerator: () => {
        const next = ids.shift();
        if (next === undefined) {
          throw new Error('ran out of test ids');
        }
        return next;
      },
    });

    const result = handler(
      { message: makeMessage() },
      { signal: new AbortController().signal }
    ) as Task;

    expect(result.id).toBe('task-uuid');
    expect(result.contextId).toBe('ctx-uuid');
    expect(result.history?.[0]?.contextId).toBe('ctx-uuid');
  });

  it('mints a messageId when the inbound message omits one', () => {
    const storage = new InMemoryTaskStorage();
    const ids = ['task-uuid', 'msg-uuid'];
    const handler = createMessageSendHandler({
      storage,
      idGenerator: () => {
        const next = ids.shift();
        if (next === undefined) {
          throw new Error('ran out of test ids');
        }
        return next;
      },
    });

    const message = makeMessage({ contextId: 'ctx-keep' });
    const looseMessage = { ...message, messageId: '' };
    const result = handler(
      { message: looseMessage as unknown as Message },
      { signal: new AbortController().signal }
    ) as Task;

    expect(result.history?.[0]?.messageId).toBe('msg-uuid');
  });

  it('preserves a non-empty inbound messageId verbatim', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });

    const result = handler(
      {
        message: makeMessage({
          messageId: 'client-msg-id',
          contextId: 'ctx-1',
        }),
      },
      { signal: new AbortController().signal }
    ) as Task;

    expect(result.history?.[0]?.messageId).toBe('client-msg-id');
  });

  it('uses crypto.randomUUID by default when no idGenerator is supplied', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageSendHandler({ storage });

    const result = handler(
      { message: makeMessage() },
      { signal: new AbortController().signal }
    ) as Task;

    // UUID v4 format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(result.id).toMatch(uuidRegex);
    expect(result.contextId).toMatch(uuidRegex);
  });

  describe('invalid params', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createMessageSendHandler({
      storage,
      idGenerator: sequentialIdGenerator(),
    });
    const ctx = { signal: new AbortController().signal };

    it('throws -32602 when params is null', () => {
      expect(() => handler(null as unknown, ctx)).toThrow(JSONRPCError);
      try {
        handler(null as unknown, ctx);
      } catch (err) {
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
      }
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

    it('throws -32602 when params.message is missing', () => {
      try {
        handler({} as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toContain('message');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when params.message is not an object', () => {
      try {
        handler({ message: 'string' } as unknown, ctx);
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when message.parts is missing', () => {
      try {
        handler(
          { message: { messageId: 'm', role: 'ROLE_USER' } } as unknown,
          ctx
        );
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        expect((err as JSONRPCError).message).toContain('parts');
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when message.parts is an empty array', () => {
      try {
        handler(
          {
            message: { messageId: 'm', role: 'ROLE_USER', parts: [] },
          } as unknown,
          ctx
        );
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('throws -32602 when message.parts is not an array', () => {
      try {
        handler(
          {
            message: { messageId: 'm', role: 'ROLE_USER', parts: 'oops' },
          } as unknown,
          ctx
        );
      } catch (err) {
        expect(err).toBeInstanceOf(JSONRPCError);
        expect((err as JSONRPCError).code).toBe(
          JSONRPC_ERROR_CODES.INVALID_PARAMS
        );
        return;
      }
      throw new Error('expected JSONRPCError to be thrown');
    });

    it('does not enqueue a task when validation fails', () => {
      const localStorage = new InMemoryTaskStorage();
      const localHandler = createMessageSendHandler({
        storage: localStorage,
        idGenerator: sequentialIdGenerator(),
      });
      try {
        localHandler({} as unknown, ctx);
      } catch {
        // expected
      }
      expect(localStorage.queueLength()).toBe(0);
      expect(localStorage.getStats().totalTasks).toBe(0);
    });
  });
});

describe('message/send JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('dispatches a happy-path message/send request and returns the Task', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({
        storage,
        idGenerator: sequentialIdGenerator(),
        now: fixedNow('2026-05-26T12:00:00.000Z'),
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: MESSAGE_SEND_METHOD,
      params: {
        message: {
          messageId: 'client-msg',
          role: 'ROLE_USER',
          contextId: 'ctx-1',
          parts: [{ text: 'hello agent' }],
        },
      },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: Task;
    };
    expect(body.jsonrpc).toBe(JSONRPC_VERSION);
    expect(body.id).toBe(1);
    expect(body.result.id).toBe('id-1');
    expect(body.result.contextId).toBe('ctx-1');
    expect(body.result.status.state).toBe(
      'TASK_STATE_SUBMITTED' satisfies TaskState
    );
    expect(body.result.history).toEqual([
      {
        messageId: 'client-msg',
        role: 'ROLE_USER',
        contextId: 'ctx-1',
        parts: [{ text: 'hello agent' }],
      },
    ]);

    expect(storage.queueLength()).toBe(1);
  });

  it('returns -32602 on malformed params (message missing)', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: MESSAGE_SEND_METHOD,
      params: {},
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(2);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toContain('message');

    expect(storage.queueLength()).toBe(0);
  });

  it('returns -32602 on missing parts', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 3,
      method: MESSAGE_SEND_METHOD,
      params: {
        message: { messageId: 'm', role: 'ROLE_USER' },
      },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toContain('parts');
  });

  it('returns -32602 on empty parts array', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 4,
      method: MESSAGE_SEND_METHOD,
      params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [] } },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
  });

  it('mints a contextId when the inbound message omits it', async () => {
    const storage = new InMemoryTaskStorage();
    const ids = ['task-id-x', 'ctx-id-y'];
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({
        storage,
        idGenerator: () => {
          const next = ids.shift();
          if (next === undefined) {
            throw new Error('ran out of ids');
          }
          return next;
        },
      })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 'req-5',
      method: MESSAGE_SEND_METHOD,
      params: {
        message: {
          messageId: 'm',
          role: 'ROLE_USER',
          parts: [{ text: 'no ctx' }],
        },
      },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { result: Task };
    expect(body.result.id).toBe('task-id-x');
    expect(body.result.contextId).toBe('ctx-id-y');
  });
});
