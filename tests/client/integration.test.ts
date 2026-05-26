import { afterEach, describe, expect, it } from 'vitest';
import {
  A2AClient,
  A2AHTTPError,
  A2AJSONRPCError,
} from '../../src/client/index.js';
import {
  A2AServer,
  MESSAGE_SEND_METHOD,
  TASK_GET_METHOD,
  createA2AServer,
  createMessageSendHandler,
  createTaskGetHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type { AgentCard } from '../../src/types/index.js';

function makeCard(): AgentCard {
  return {
    name: 'integration-agent',
    description: 'real server for client integration tests',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echoes input.', tags: [] },
    ],
  };
}

async function startServer(server: A2AServer): Promise<string> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not bind');
  }
  return `http://127.0.0.1:${addr.port}`;
}

describe('A2AClient ↔ A2AServer integration', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('getAgentCard returns the served public card verbatim', async () => {
    const card = makeCard();
    const server = createA2AServer({ card });
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({ baseURL, retry: false });
    const fetched = await client.getAgentCard();
    expect(fetched).toEqual(card);
  });

  it('getHealth returns { status: "healthy" }', async () => {
    const server = createA2AServer({ card: makeCard() });
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({ baseURL, retry: false });
    const health = await client.getHealth();
    expect(health).toEqual({ status: 'healthy' });
  });

  it('sendMessage creates a task and returns its wire form', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({ storage })
    );
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({ baseURL, retry: false });
    const task = await client.sendMessage({
      message: {
        messageId: 'm-1',
        role: 'ROLE_USER',
        parts: [{ text: 'hello' }],
        contextId: 'ctx-1',
      },
    });

    expect(task.id).toBeTypeOf('string');
    expect(task.contextId).toBe('ctx-1');
    expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
    expect(task.history?.[0]?.messageId).toBe('m-1');
  });

  it('getTask round-trips a task created via sendMessage', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({ storage })
    );
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({ baseURL, retry: false });
    const created = await client.sendMessage({
      message: {
        messageId: 'm-1',
        role: 'ROLE_USER',
        parts: [{ text: 'hello' }],
        contextId: 'ctx-1',
      },
    });

    const fetched = await client.getTask(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.contextId).toBe(created.contextId);
    expect(fetched.status.state).toBe(created.status.state);
  });

  it('getTask truncates history when historyLength is supplied', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(
      MESSAGE_SEND_METHOD,
      createMessageSendHandler({ storage })
    );
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({ baseURL, retry: false });
    const created = await client.sendMessage({
      message: {
        messageId: 'm-only',
        role: 'ROLE_USER',
        parts: [{ text: 'only one' }],
        contextId: 'ctx-1',
      },
    });

    const fetched = await client.getTask(created.id, { historyLength: 0 });
    expect(fetched.history).toEqual([]);
  });

  it('surfaces JSON-RPC errors as A2AJSONRPCError', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({ baseURL, retry: false });
    try {
      await client.getTask('does-not-exist');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(A2AJSONRPCError);
      expect((err as A2AJSONRPCError).code).toBe(-32602);
      expect((err as A2AJSONRPCError).message).toBe('task not found');
    }
  });

  it('returns A2AHTTPError 404 when probing a non-existent path', async () => {
    const server = createA2AServer({ card: makeCard() });
    const baseURL = await startServer(server);
    close = () => server.close();

    const client = new A2AClient({
      baseURL,
      agentCardPath: '/does/not/exist',
      retry: false,
    });
    try {
      await client.getAgentCard();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(A2AHTTPError);
      expect((err as A2AHTTPError).status).toBe(404);
    }
  });
});
