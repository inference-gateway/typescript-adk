import { afterEach, describe, expect, it } from 'vitest';
import {
  A2AServer,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
  TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD,
  createA2AServer,
  createTaskPushNotificationConfigDeleteHandler,
  createTaskPushNotificationConfigGetHandler,
  createTaskPushNotificationConfigListHandler,
  createTaskPushNotificationConfigSetHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/index.js';
import type {
  AgentCard,
  TaskPushNotificationConfig,
} from '../../src/types/generated/a2a.js';

function makeCard(pushNotifications = false): AgentCard {
  return {
    name: 'push-config-agent',
    description: 'Agent under test',
    version: '0.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false, pushNotifications },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo input.', tags: [] },
    ],
  };
}

const ctx = { signal: new AbortController().signal };

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

describe('createTaskPushNotificationConfigSetHandler', () => {
  it('persists a config and returns the wire-format resource', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigSetHandler({ storage });

    const result = handler(
      {
        taskId: 'task-1',
        pushNotificationConfig: {
          id: 'cfg-1',
          url: 'https://example.com/webhook',
          token: 'bearer-xyz',
        },
      },
      ctx
    ) as TaskPushNotificationConfig;

    expect(result.name).toBe('tasks/task-1/pushNotificationConfigs/cfg-1');
    expect(result.pushNotificationConfig.id).toBe('cfg-1');
    expect(result.pushNotificationConfig.url).toBe(
      'https://example.com/webhook'
    );
    expect(result.pushNotificationConfig.token).toBe('bearer-xyz');
    expect(storage.getPushConfig('task-1', 'cfg-1')).toBeDefined();
  });

  it('assigns a UUID when the inbound config has no id', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigSetHandler({ storage });

    const result = handler(
      {
        taskId: 'task-1',
        pushNotificationConfig: { url: 'https://example.com/webhook' },
      },
      ctx
    ) as TaskPushNotificationConfig;

    expect(result.pushNotificationConfig.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(result.name).toBe(
      `tasks/task-1/pushNotificationConfigs/${result.pushNotificationConfig.id}`
    );
  });

  it('persists authentication info verbatim', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigSetHandler({ storage });

    handler(
      {
        taskId: 'task-1',
        pushNotificationConfig: {
          id: 'cfg-1',
          url: 'https://example.com/webhook',
          authentication: {
            schemes: ['Bearer'],
            credentials: 'opaque-token',
          },
        },
      },
      ctx
    );

    const stored = storage.getPushConfig('task-1', 'cfg-1');
    expect(stored?.authentication).toEqual({
      schemes: ['Bearer'],
      credentials: 'opaque-token',
    });
  });

  describe('invalid params', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigSetHandler({ storage });

    function expectInvalidParams(
      input: unknown,
      messageFragment?: string
    ): void {
      try {
        handler(input, ctx);
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

    it('throws when params is null', () => {
      expectInvalidParams(null);
    });

    it('throws when params is an array', () => {
      expectInvalidParams([]);
    });

    it('throws when taskId is missing', () => {
      expectInvalidParams(
        { pushNotificationConfig: { url: 'https://example.com' } },
        'taskId'
      );
    });

    it('throws when pushNotificationConfig is missing', () => {
      expectInvalidParams({ taskId: 'task-1' }, 'pushNotificationConfig');
    });

    it('throws when pushNotificationConfig.url is missing', () => {
      expectInvalidParams(
        { taskId: 'task-1', pushNotificationConfig: {} },
        'url'
      );
    });

    it('throws when pushNotificationConfig.id is the empty string', () => {
      expectInvalidParams(
        {
          taskId: 'task-1',
          pushNotificationConfig: { id: '', url: 'https://example.com' },
        },
        'pushNotificationConfig.id'
      );
    });

    it('throws when pushNotificationConfig.token is non-string', () => {
      expectInvalidParams(
        {
          taskId: 'task-1',
          pushNotificationConfig: {
            url: 'https://example.com',
            token: 123,
          },
        },
        'token'
      );
    });

    it('throws when authentication.schemes is missing', () => {
      expectInvalidParams(
        {
          taskId: 'task-1',
          pushNotificationConfig: {
            url: 'https://example.com',
            authentication: {},
          },
        },
        'schemes'
      );
    });
  });
});

describe('createTaskPushNotificationConfigGetHandler', () => {
  it('returns the wire resource for a known (taskId, configId)', () => {
    const storage = new InMemoryTaskStorage();
    storage.setPushConfig('task-1', {
      id: 'cfg-1',
      url: 'https://example.com/webhook',
    });
    const handler = createTaskPushNotificationConfigGetHandler({ storage });

    const result = handler(
      { taskId: 'task-1', pushNotificationConfigId: 'cfg-1' },
      ctx
    ) as TaskPushNotificationConfig;

    expect(result.name).toBe('tasks/task-1/pushNotificationConfigs/cfg-1');
    expect(result.pushNotificationConfig.url).toBe(
      'https://example.com/webhook'
    );
  });

  it('throws -32602 with "not found" message for an unknown config', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigGetHandler({ storage });

    try {
      handler({ taskId: 'task-1', pushNotificationConfigId: 'cfg-1' }, ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(JSONRPCError);
      expect((err as JSONRPCError).code).toBe(
        JSONRPC_ERROR_CODES.INVALID_PARAMS
      );
      expect((err as JSONRPCError).message).toBe(
        'push notification config not found'
      );
      return;
    }
    throw new Error('expected JSONRPCError to be thrown');
  });

  it('throws -32602 when pushNotificationConfigId is missing', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigGetHandler({ storage });

    try {
      handler({ taskId: 'task-1' } as unknown, ctx);
    } catch (err) {
      expect((err as JSONRPCError).message).toContain(
        'pushNotificationConfigId'
      );
      return;
    }
    throw new Error('expected JSONRPCError to be thrown');
  });
});

describe('createTaskPushNotificationConfigListHandler', () => {
  it('returns every config under the task', () => {
    const storage = new InMemoryTaskStorage();
    const a = storage.setPushConfig('task-1', {
      id: 'cfg-a',
      url: 'https://a.example.com',
    });
    const b = storage.setPushConfig('task-1', {
      id: 'cfg-b',
      url: 'https://b.example.com',
    });
    const handler = createTaskPushNotificationConfigListHandler({ storage });

    const result = handler({ taskId: 'task-1' }, ctx) as { configs: unknown[] };

    expect(result.configs).toHaveLength(2);
    expect(result.configs).toContainEqual(a);
    expect(result.configs).toContainEqual(b);
  });

  it('returns an empty configs array for a task with no configs', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigListHandler({ storage });
    expect(handler({ taskId: 'task-1' }, ctx)).toEqual({ configs: [] });
  });

  it('throws -32602 when taskId is missing', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigListHandler({ storage });
    try {
      handler({} as unknown, ctx);
    } catch (err) {
      expect((err as JSONRPCError).code).toBe(
        JSONRPC_ERROR_CODES.INVALID_PARAMS
      );
      return;
    }
    throw new Error('expected JSONRPCError to be thrown');
  });
});

describe('createTaskPushNotificationConfigDeleteHandler', () => {
  it('removes a known config and returns null', () => {
    const storage = new InMemoryTaskStorage();
    storage.setPushConfig('task-1', {
      id: 'cfg-1',
      url: 'https://example.com',
    });
    const handler = createTaskPushNotificationConfigDeleteHandler({ storage });

    const result = handler(
      { taskId: 'task-1', pushNotificationConfigId: 'cfg-1' },
      ctx
    );

    expect(result).toBeNull();
    expect(storage.getPushConfig('task-1', 'cfg-1')).toBeUndefined();
  });

  it('throws -32602 with "not found" message for an unknown config', () => {
    const storage = new InMemoryTaskStorage();
    const handler = createTaskPushNotificationConfigDeleteHandler({ storage });

    try {
      handler({ taskId: 'task-1', pushNotificationConfigId: 'cfg-1' }, ctx);
    } catch (err) {
      expect((err as JSONRPCError).message).toBe(
        'push notification config not found'
      );
      return;
    }
    throw new Error('expected JSONRPCError to be thrown');
  });
});

describe('push notification config JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('dispatches set → get → list → delete over JSON-RPC', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard(true) });
    server.registerMethod(
      TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD,
      createTaskPushNotificationConfigSetHandler({ storage })
    );
    server.registerMethod(
      TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
      createTaskPushNotificationConfigGetHandler({ storage })
    );
    server.registerMethod(
      TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
      createTaskPushNotificationConfigListHandler({ storage })
    );
    server.registerMethod(
      TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
      createTaskPushNotificationConfigDeleteHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const setRes = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: TASK_PUSH_NOTIFICATION_CONFIG_SET_METHOD,
      params: {
        taskId: 'task-1',
        pushNotificationConfig: {
          id: 'cfg-1',
          url: 'https://example.com/webhook',
          token: 'bearer-xyz',
        },
      },
    });
    const setBody = (await setRes.json()) as {
      result: TaskPushNotificationConfig;
    };
    expect(setBody.result.pushNotificationConfig.id).toBe('cfg-1');
    expect(setBody.result.pushNotificationConfig.token).toBe('bearer-xyz');

    const getRes = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 2,
      method: TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
      params: { taskId: 'task-1', pushNotificationConfigId: 'cfg-1' },
    });
    const getBody = (await getRes.json()) as {
      result: TaskPushNotificationConfig;
    };
    expect(getBody.result.pushNotificationConfig.url).toBe(
      'https://example.com/webhook'
    );

    const listRes = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 3,
      method: TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
      params: { taskId: 'task-1' },
    });
    const listBody = (await listRes.json()) as {
      result: { configs: unknown[] };
    };
    expect(listBody.result.configs).toHaveLength(1);

    const delRes = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 4,
      method: TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
      params: { taskId: 'task-1', pushNotificationConfigId: 'cfg-1' },
    });
    const delBody = (await delRes.json()) as { result: null };
    expect(delBody.result).toBeNull();

    const listAfter = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 5,
      method: TASK_PUSH_NOTIFICATION_CONFIG_LIST_METHOD,
      params: { taskId: 'task-1' },
    });
    const listAfterBody = (await listAfter.json()) as {
      result: { configs: unknown[] };
    };
    expect(listAfterBody.result.configs).toEqual([]);
  });

  it('returns -32602 not-found for get on an unknown config', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard(true) });
    server.registerMethod(
      TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
      createTaskPushNotificationConfigGetHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 6,
      method: TASK_PUSH_NOTIFICATION_CONFIG_GET_METHOD,
      params: { taskId: 'task-1', pushNotificationConfigId: 'cfg-1' },
    });
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toBe('push notification config not found');
  });

  it('returns -32602 not-found for delete on an unknown config', async () => {
    const storage = new InMemoryTaskStorage();
    const server = createA2AServer({ card: makeCard(true) });
    server.registerMethod(
      TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
      createTaskPushNotificationConfigDeleteHandler({ storage })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      id: 7,
      method: TASK_PUSH_NOTIFICATION_CONFIG_DELETE_METHOD,
      params: { taskId: 'task-1', pushNotificationConfigId: 'missing' },
    });
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_PARAMS);
    expect(body.error.message).toBe('push notification config not found');
  });
});
