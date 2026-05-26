import { describe, expect, it } from 'vitest';
import {
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  createErrorResponse,
  createSuccessResponse,
  dispatch,
  type JSONRPCResponse,
} from '../../src/server/jsonrpc.js';
import { MethodRegistry } from '../../src/server/method-registry.js';

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}

function makeRegistry(
  init: (registry: MethodRegistry) => void = () => undefined
): MethodRegistry {
  const registry = new MethodRegistry();
  init(registry);
  return registry;
}

describe('JSON-RPC envelope builders', () => {
  it('createSuccessResponse wraps the result with the canonical envelope', () => {
    expect(createSuccessResponse(7, { ok: true })).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 7,
      result: { ok: true },
    });
  });

  it('createErrorResponse omits data when not provided', () => {
    const res = createErrorResponse(
      'abc',
      JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
      'method not found'
    );
    expect(res).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 'abc',
      error: {
        code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
        message: 'method not found',
      },
    });
    expect('data' in res.error).toBe(false);
  });

  it('createErrorResponse includes data when provided', () => {
    const res = createErrorResponse(1, -32000, 'application error', {
      cause: 'boom',
    });
    expect(res.error.data).toEqual({ cause: 'boom' });
  });
});

describe('dispatch parse + envelope validation', () => {
  it('returns a parse error for malformed JSON', async () => {
    const out = await dispatch('not json', makeRegistry(), neverAbort());
    expect(out).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.PARSE_ERROR,
        message: 'parse error',
      },
    });
  });

  it('returns an invalid request error for an empty batch', async () => {
    const out = await dispatch('[]', makeRegistry(), neverAbort());
    expect(out).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: {
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: 'invalid request',
      },
    });
  });

  it('returns an invalid request error when the body is a primitive', async () => {
    const out = await dispatch('42', makeRegistry(), neverAbort());
    expect(out).toMatchObject({
      id: null,
      error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST },
    });
  });

  it('returns invalid request when jsonrpc version is wrong', async () => {
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: 1,
      method: 'ping',
    });
    const out = await dispatch(body, makeRegistry(), neverAbort());
    expect(out).toMatchObject({
      id: 1,
      error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST },
    });
  });

  it('returns invalid request when method is missing', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1 });
    const out = await dispatch(body, makeRegistry(), neverAbort());
    expect(out).toMatchObject({
      id: 1,
      error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST },
    });
  });

  it('returns invalid request when params is a primitive', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: 'oops',
    });
    const out = await dispatch(body, makeRegistry(), neverAbort());
    expect(out).toMatchObject({
      id: 1,
      error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST },
    });
  });

  it('returns invalid request with id null when the id type is unsupported', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: { not: 'allowed' },
      method: 'ping',
    });
    const out = await dispatch(body, makeRegistry(), neverAbort());
    expect(out).toMatchObject({
      id: null,
      error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST },
    });
  });
});

describe('dispatch method routing', () => {
  it('dispatches to the registered handler and wraps the result', async () => {
    const registry = makeRegistry((r) =>
      r.register<{ a: number; b: number }, number>(
        'add',
        (params) => params.a + params.b
      )
    );
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'add',
      params: { a: 2, b: 3 },
    });
    const out = (await dispatch(
      body,
      registry,
      neverAbort()
    )) as JSONRPCResponse;
    expect(out).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      result: 5,
    });
  });

  it('awaits async handlers before responding', async () => {
    const registry = makeRegistry((r) =>
      r.register('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'done';
      })
    );
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'x',
      method: 'slow',
    });
    const out = (await dispatch(
      body,
      registry,
      neverAbort()
    )) as JSONRPCResponse;
    expect(out).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 'x',
      result: 'done',
    });
  });

  it('returns method not found for unknown methods', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'nope',
    });
    const out = await dispatch(body, makeRegistry(), neverAbort());
    expect(out).toMatchObject({
      id: 1,
      error: { code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND },
    });
  });

  it('maps a thrown JSONRPCError to its code', async () => {
    const registry = makeRegistry((r) =>
      r.register('boom', () => {
        throw new JSONRPCError(
          JSONRPC_ERROR_CODES.INVALID_PARAMS,
          'bad params',
          { which: 'a' }
        );
      })
    );
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'boom',
      params: {},
    });
    const out = await dispatch(body, registry, neverAbort());
    expect(out).toEqual({
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      error: {
        code: JSONRPC_ERROR_CODES.INVALID_PARAMS,
        message: 'bad params',
        data: { which: 'a' },
      },
    });
  });

  it('maps a generic thrown error to internal error', async () => {
    const registry = makeRegistry((r) =>
      r.register('boom', () => {
        throw new Error('details that should not leak');
      })
    );
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'boom',
    });
    const out = (await dispatch(
      body,
      registry,
      neverAbort()
    )) as JSONRPCResponse;
    expect(out).toMatchObject({
      id: 1,
      error: {
        code: JSONRPC_ERROR_CODES.INTERNAL_ERROR,
        message: 'internal error',
      },
    });
    if ('error' in out) {
      expect(out.error.message).not.toContain('details');
    }
  });

  it('passes the AbortSignal through to the handler context', async () => {
    let captured: AbortSignal | undefined;
    const registry = makeRegistry((r) =>
      r.register('echoSignal', (_params, ctx) => {
        captured = ctx.signal;
        return null;
      })
    );
    const controller = new AbortController();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'echoSignal',
    });
    await dispatch(body, registry, controller.signal);
    expect(captured).toBe(controller.signal);
  });
});

describe('dispatch notification handling', () => {
  it('does not respond to a valid notification', async () => {
    let called = false;
    const registry = makeRegistry((r) =>
      r.register('notify', () => {
        called = true;
      })
    );
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify',
      params: [1, 2],
    });
    const out = await dispatch(body, registry, neverAbort());
    expect(out).toBeNull();
    expect(called).toBe(true);
  });

  it('does not respond when a notification targets an unknown method', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'missing' });
    const out = await dispatch(body, makeRegistry(), neverAbort());
    expect(out).toBeNull();
  });

  it('does not respond when a notification handler throws', async () => {
    const registry = makeRegistry((r) =>
      r.register('notify', () => {
        throw new Error('boom');
      })
    );
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notify' });
    const out = await dispatch(body, registry, neverAbort());
    expect(out).toBeNull();
  });
});

describe('dispatch batch handling', () => {
  it('returns a response array preserving order for all-request batches', async () => {
    const registry = makeRegistry((r) => {
      r.register('add1', (params: unknown) => {
        const value = (params as { v: number }).v;
        return value + 1;
      });
    });
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'add1', params: { v: 10 } },
      { jsonrpc: '2.0', id: 2, method: 'add1', params: { v: 20 } },
      { jsonrpc: '2.0', id: 3, method: 'add1', params: { v: 30 } },
    ]);
    const out = (await dispatch(
      body,
      registry,
      neverAbort()
    )) as JSONRPCResponse[];
    expect(out).toHaveLength(3);
    expect(out.map((r) => 'result' in r && r.result)).toEqual([11, 21, 31]);
    expect(out.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('omits notification responses from the batch reply', async () => {
    const registry = makeRegistry((r) => {
      r.register('echo', (params: unknown) => params);
      r.register('notify', () => undefined);
    });
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } },
      { jsonrpc: '2.0', method: 'notify' },
      { jsonrpc: '2.0', id: 2, method: 'echo', params: { a: 2 } },
    ]);
    const out = (await dispatch(
      body,
      registry,
      neverAbort()
    )) as JSONRPCResponse[];
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });

  it('returns null when every batch entry is a notification', async () => {
    const registry = makeRegistry((r) => r.register('notify', () => undefined));
    const body = JSON.stringify([
      { jsonrpc: '2.0', method: 'notify' },
      { jsonrpc: '2.0', method: 'notify' },
    ]);
    const out = await dispatch(body, registry, neverAbort());
    expect(out).toBeNull();
  });

  it('mixes per-entry errors and successes in a single batch reply', async () => {
    const registry = makeRegistry((r) =>
      r.register('echo', (params: unknown) => params)
    );
    const body = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'echo', params: { a: 1 } },
      'not an object',
      { jsonrpc: '2.0', id: 2, method: 'unknown' },
    ]);
    const out = (await dispatch(
      body,
      registry,
      neverAbort()
    )) as JSONRPCResponse[];
    expect(out).toHaveLength(3);
    const byId = new Map(out.map((r) => [r.id, r]));
    expect(byId.get(1)).toMatchObject({ result: { a: 1 } });
    expect(byId.get(null)).toMatchObject({
      error: { code: JSONRPC_ERROR_CODES.INVALID_REQUEST },
    });
    expect(byId.get(2)).toMatchObject({
      error: { code: JSONRPC_ERROR_CODES.METHOD_NOT_FOUND },
    });
  });
});
