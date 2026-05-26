import { afterEach, describe, expect, it } from 'vitest';
import {
  A2AServer,
  HEALTH_PATH,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  createA2AServer,
} from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeCard(): AgentCard {
  return {
    name: 'rpc-agent',
    description: 'Agent under test',
    version: '0.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [
      {
        id: 'noop',
        name: 'Noop',
        description: 'Does nothing.',
        tags: [],
      },
    ],
  };
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
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('A2AServer JSON-RPC conformance', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('serves GET /health with { status: "healthy" }', async () => {
    const server = createA2AServer({ card: makeCard() });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { status: string };
    expect(body).toEqual({ status: 'healthy' });
  });

  it('returns a parse error for malformed JSON bodies', async () => {
    const server = createA2AServer({ card: makeCard() });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, 'not json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe(JSONRPC_VERSION);
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.PARSE_ERROR);
  });

  it('returns invalid request for a structurally malformed payload', async () => {
    const server = createA2AServer({ card: makeCard() });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, { foo: 'bar' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
  });

  it('returns method not found for unregistered methods', async () => {
    const server = createA2AServer({ card: makeCard() });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tasks/get',
      params: { name: 'tasks/abc' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(99);
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('dispatches a registered method and returns its result', async () => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod<{ value: number }, { doubled: number }>(
      'demo/double',
      (params) => ({ doubled: params.value * 2 })
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'demo/double',
      params: { value: 21 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: string;
      result: { doubled: number };
    };
    expect(body).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 'req-1',
      result: { doubled: 42 },
    });
  });

  it('maps a thrown JSONRPCError onto the JSON-RPC error envelope', async () => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod('demo/fail', () => {
      throw new JSONRPCError(JSONRPC_ERROR_CODES.INVALID_PARAMS, 'bad input', {
        field: 'x',
      });
    });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'demo/fail',
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; message: string; data: { field: string } };
    };
    expect(body.error).toEqual({
      code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
      message: 'bad input',
      data: { field: 'x' },
    });
  });

  it('maps a generic thrown error to internal error without leaking the message', async () => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod('demo/oops', () => {
      throw new Error('internal stack trace');
    });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'demo/oops',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INTERNAL_ERROR);
    expect(body.error.message).not.toContain('stack trace');
  });

  it('returns 204 with no body for a single notification', async () => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod('demo/ping', () => undefined);
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, {
      jsonrpc: '2.0',
      method: 'demo/ping',
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('handles a batch of requests and returns an ordered array', async () => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod<{ v: number }, number>(
      'demo/inc',
      (params) => params.v + 1
    );
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, [
      { jsonrpc: '2.0', id: 1, method: 'demo/inc', params: { v: 1 } },
      { jsonrpc: '2.0', id: 2, method: 'demo/inc', params: { v: 2 } },
      { jsonrpc: '2.0', id: 3, method: 'demo/inc', params: { v: 3 } },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: number; result: number }>;
    expect(body).toHaveLength(3);
    const byId = new Map(body.map((entry) => [entry.id, entry.result]));
    expect(byId.get(1)).toBe(2);
    expect(byId.get(2)).toBe(3);
    expect(byId.get(3)).toBe(4);
  });

  it('returns invalid request for an empty batch', async () => {
    const server = createA2AServer({ card: makeCard() });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, []);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: unknown;
      error: { code: number };
    };
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.INVALID_REQUEST);
  });

  it('returns 204 for a batch made up entirely of notifications', async () => {
    const server = createA2AServer({ card: makeCard() });
    server.registerMethod('demo/ping', () => undefined);
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await postJSON(baseUrl, [
      { jsonrpc: '2.0', method: 'demo/ping' },
      { jsonrpc: '2.0', method: 'demo/ping' },
    ]);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns 404 for GET on the JSON-RPC path (only POST is supported)', async () => {
    const server = createA2AServer({ card: makeCard() });
    close = () => server.close();
    const baseUrl = await start(server);

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);
  });

  it('honors a custom JSON-RPC path', async () => {
    const server = createA2AServer({
      card: makeCard(),
      jsonRpcPath: '/rpc',
    });
    server.registerMethod('ping', () => 'pong');
    close = () => server.close();
    const baseUrl = await start(server);

    const ok = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { result: string };
    expect(body.result).toBe('pong');

    const miss = await fetch(`${baseUrl}/`, { method: 'POST' });
    expect(miss.status).toBe(404);
  });
});

describe('A2AServer method registry surface', () => {
  it('exposes registration / introspection on the server', () => {
    const server = createA2AServer({ card: makeCard() });
    expect(server.hasMethod('demo/x')).toBe(false);

    server.registerMethod('demo/x', () => 1);
    expect(server.hasMethod('demo/x')).toBe(true);
    expect(server.registeredMethods()).toContain('demo/x');

    expect(server.unregisterMethod('demo/x')).toBe(true);
    expect(server.hasMethod('demo/x')).toBe(false);
  });
});
