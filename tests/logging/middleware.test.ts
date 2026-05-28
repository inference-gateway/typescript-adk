import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  REQUEST_ID_CONTEXT_KEY,
  REQUEST_ID_HEADER,
  REQUEST_LOGGER_CONTEXT_KEY,
  createRequestLoggerMiddleware,
  type Logger,
} from '../../src/logging/index.js';

interface RecordedCall {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  args: readonly unknown[];
  bindings: Readonly<Record<string, unknown>>;
}

function recordingLogger(
  initialBindings: Readonly<Record<string, unknown>> = {}
): {
  logger: Logger;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  function make(bindings: Readonly<Record<string, unknown>>): Logger {
    const push =
      (level: RecordedCall['level']) =>
      (message: string, ...args: readonly unknown[]): void => {
        calls.push({ level, message, args, bindings });
      };
    return {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
      child(extra) {
        return make({ ...bindings, ...extra });
      },
    };
  }

  return { logger: make(initialBindings), calls };
}

describe('createRequestLoggerMiddleware', () => {
  it('binds requestId on child logger and stores it on the Hono context', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/echo', (c) => {
      const reqLogger = (c.var as Record<string, unknown>)[
        REQUEST_LOGGER_CONTEXT_KEY
      ] as Logger;
      const requestId = (c.var as Record<string, unknown>)[
        REQUEST_ID_CONTEXT_KEY
      ] as string;
      reqLogger.info('handler ran');
      return c.json({ requestId });
    });

    const res = await app.request('/echo');
    expect(res.status).toBe(200);
    const requestId = res.headers.get(REQUEST_ID_HEADER);
    expect(requestId).toBeTypeOf('string');
    expect(requestId).toMatch(/[0-9a-f-]{36}/);

    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toBe(requestId);

    const handlerCall = calls.find((c) => c.message === 'handler ran');
    expect(handlerCall).toBeDefined();
    expect(handlerCall?.bindings).toMatchObject({ requestId });
  });

  it('honors an incoming x-request-id header', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/x', (c) => c.text('ok'));

    const res = await app.request('/x', {
      headers: { [REQUEST_ID_HEADER]: 'incoming-id' },
    });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('incoming-id');

    const received = calls.find((c) => c.message === 'request received');
    expect(received?.bindings).toMatchObject({ requestId: 'incoming-id' });
  });

  it('logs request received + completed with method/path/status/duration', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/widgets/42', (c) => c.json({ id: 42 }, 200));

    await app.request('/widgets/42');

    const received = calls.find((c) => c.message === 'request received');
    expect(received?.level).toBe('debug');
    expect(received?.args[0]).toMatchObject({
      method: 'GET',
      path: '/widgets/42',
    });

    const completed = calls.find((c) => c.message === 'request completed');
    expect(completed?.level).toBe('info');
    const fields = completed?.args[0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      method: 'GET',
      path: '/widgets/42',
      status: 200,
    });
    expect(typeof fields['durationMs']).toBe('number');
  });

  it('skips logging /health when SERVER_DISABLE_HEALTHCHECK_LOG defaults to true', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/health', (c) => c.json({ status: 'healthy' }));

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    // No request received / completed lines.
    expect(calls.find((c) => c.message === 'request received')).toBeUndefined();
    expect(
      calls.find((c) => c.message === 'request completed')
    ).toBeUndefined();
  });

  it('logs /health when SERVER_DISABLE_HEALTHCHECK_LOG=false', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use(
      '*',
      createRequestLoggerMiddleware({
        logger,
        env: { SERVER_DISABLE_HEALTHCHECK_LOG: 'false' },
      })
    );
    app.get('/health', (c) => c.json({ status: 'healthy' }));

    await app.request('/health');
    expect(calls.find((c) => c.message === 'request received')).toBeDefined();
    expect(calls.find((c) => c.message === 'request completed')).toBeDefined();
  });

  it('still installs the request-scoped logger on /health (for downstream handlers)', async () => {
    const { logger } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    let observed: unknown = null;
    app.get('/health', (c) => {
      observed = (c.var as Record<string, unknown>)[REQUEST_LOGGER_CONTEXT_KEY];
      return c.json({ status: 'healthy' });
    });

    await app.request('/health');
    expect(observed).not.toBeNull();
  });

  it('logs request failed at error level for 5xx responses', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/explode', () => {
      throw new Error('boom');
    });
    app.onError((err, c) => c.json({ error: err.message }, 500));

    const res = await app.request('/explode');
    expect(res.status).toBe(500);

    const failed = calls.find((c) => c.message === 'request failed');
    expect(failed?.level).toBe('error');
    const fields = failed?.args[0] as Record<string, unknown>;
    expect(fields['method']).toBe('GET');
    expect(fields['path']).toBe('/explode');
    expect(fields['status']).toBe(500);
  });

  it('logs at warn level for 4xx responses', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/missing', (c) => c.json({ error: 'not found' }, 404));

    await app.request('/missing');
    const completed = calls.find((c) => c.message === 'request completed');
    expect(completed?.level).toBe('warn');
    expect((completed?.args[0] as Record<string, unknown>)['status']).toBe(404);
  });

  it('uses a configurable healthPath', async () => {
    const { logger, calls } = recordingLogger();
    const app = new Hono();
    app.use(
      '*',
      createRequestLoggerMiddleware({
        logger,
        env: {},
        healthPath: '/healthz',
      })
    );
    app.get('/healthz', (c) => c.text('ok'));
    app.get('/health', (c) => c.text('ok'));

    await app.request('/healthz');
    await app.request('/health');

    // /healthz suppressed, /health logged
    const received = calls.filter((c) => c.message === 'request received');
    expect(received).toHaveLength(1);
    expect((received[0]?.args[0] as { path: string }).path).toBe('/health');
  });
});

describe('createRequestLoggerMiddleware - randomUUID', () => {
  it('generates an id when no header is present', async () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID');
    const { logger } = recordingLogger();
    const app = new Hono();
    app.use('*', createRequestLoggerMiddleware({ logger, env: {} }));
    app.get('/x', (c) => c.text('ok'));

    await app.request('/x');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
