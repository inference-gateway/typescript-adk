import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A2AServer,
  A2AServerBuilder,
  JSONRPC_ERROR_CODES,
  TASK_GET_METHOD,
  TASK_LIST_METHOD,
  createTaskGetHandler,
  createTaskListHandler,
} from '../../src/server/index.js';
import { InMemoryTaskStorage } from '../../src/storage/in-memory.js';
import type { A2AMethod, AgentCard } from '../../src/types/generated/a2a.js';

const V1_METHODS: A2AMethod[] = [
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'ListTasks',
  'CancelTask',
  'SubscribeToTask',
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
  'GetExtendedAgentCard',
];

const V0_METHODS = [
  'message/send',
  'message/stream',
  'tasks/get',
  'tasks/list',
  'tasks/cancel',
  'tasks/resubscribe',
  'tasks/pushNotificationConfig/set',
  'tasks/pushNotificationConfig/get',
  'tasks/pushNotificationConfig/list',
  'tasks/pushNotificationConfig/delete',
  'agent/getAuthenticatedExtendedCard',
];

const card: AgentCard = {
  name: 'method-names-agent',
  description: 'Agent under test',
  version: '0.0.0',
  supportedInterfaces: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  capabilities: { streaming: true, pushNotifications: true },
  skills: [],
};

async function rpcErrorCode(
  baseUrl: string,
  method: string
): Promise<number | undefined> {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });
  const body = (await res.json()) as { error?: { code: number } };
  return body.error?.code;
}

describe('A2A v1.0.1 JSON-RPC method names', () => {
  const storage = new InMemoryTaskStorage();
  let server: A2AServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new A2AServerBuilder({ storage })
      .withAgentCard(card)
      .withDefaultTaskHandlers()
      .build();
    server.registerMethod(TASK_GET_METHOD, createTaskGetHandler({ storage }));
    server.registerMethod(TASK_LIST_METHOD, createTaskListHandler({ storage }));
    await server.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${server.address()?.port ?? 0}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('registers exactly the v1.0.1 method names', () => {
    expect(server.registeredMethods().sort()).toEqual([...V1_METHODS].sort());
  });

  it('dispatches a v1.0.1 method name', async () => {
    expect(await rpcErrorCode(baseUrl, 'GetTask')).not.toBe(
      JSONRPC_ERROR_CODES.METHOD_NOT_FOUND
    );
  });

  it.each(V0_METHODS)('returns method not found for %s', async (method) => {
    expect(await rpcErrorCode(baseUrl, method)).toBe(
      JSONRPC_ERROR_CODES.METHOD_NOT_FOUND
    );
  });
});
