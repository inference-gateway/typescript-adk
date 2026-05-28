import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_NOTIFICATION_CONCURRENCY,
  DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG,
  HTTPPushNotificationSender,
  PushNotificationSendError,
  type DeliveryResult,
  type PushNotificationFetchLike,
  type TaskUpdateNotification,
} from '../../src/server/index.js';
import type {
  PushNotificationConfig,
  Task,
} from '../../src/types/generated/a2a.js';

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface FakeFetchResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly throw?: unknown;
  readonly delayMs?: number;
}

function fakeFetch(spec: FakeFetchResponse | FakeFetchResponse[]): {
  fetch: PushNotificationFetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const responses = Array.isArray(spec) ? spec : [spec];
  let i = 0;
  const fetchImpl: PushNotificationFetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const signal = init.signal;
    if (signal?.aborted === true) {
      throw signalReasonAsError(signal);
    }
    if (r.delayMs !== undefined && r.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(signalReasonAsError(signal));
          },
          { once: true }
        );
      });
    }
    if (r.throw !== undefined) {
      throw r.throw;
    }
    const status = r.status ?? 200;
    // 204/205/304 responses must not carry a body per the Fetch spec.
    const noBody = status === 204 || status === 205 || status === 304;
    const bodyText = noBody
      ? null
      : typeof r.body === 'string'
        ? r.body
        : r.body !== undefined
          ? JSON.stringify(r.body)
          : '';
    return new Response(bodyText, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch: fetchImpl, calls };
}

function signalReasonAsError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'aborted');
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-123',
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_COMPLETED' },
    ...overrides,
  };
}

function captureLogger(): {
  logger: {
    debug: (msg: string, ...args: unknown[]) => void;
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
  };
  records: { level: string; msg: string; meta: unknown }[];
} {
  const records: { level: string; msg: string; meta: unknown }[] = [];
  const push =
    (level: string) =>
    (msg: string, ...args: unknown[]) => {
      records.push({ level, msg, meta: args[0] });
    };
  return {
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
    records,
  };
}

const noRetry = { retry: false as const };
const fastRetry = {
  retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 },
};

describe('HTTPPushNotificationSender.sendTaskUpdate', () => {
  it('POSTs the task_update payload to the webhook URL', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    const config: PushNotificationConfig = {
      url: 'https://example.com/hook',
    };
    const task = makeTask();

    await sender.sendTaskUpdate(config, task);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://example.com/hook');
    expect(call.init.method).toBe('POST');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/@inference-gateway\/adk\//);
    expect(headers['Authorization']).toBeUndefined();

    const body = JSON.parse(call.init.body as string) as TaskUpdateNotification;
    expect(body.type).toBe('task_update');
    expect(body.taskId).toBe('task-123');
    expect(body.state).toBe('TASK_STATE_COMPLETED');
    expect(body.task).toEqual(task);
    expect(Date.parse(body.timestamp)).not.toBeNaN();
  });

  it('attaches Authorization: Bearer header when config.token is set', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    await sender.sendTaskUpdate(
      { url: 'https://example.com/hook', token: 'tok-abc' },
      makeTask()
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-abc');
  });

  it('prefers authentication.schemes over the bare token field', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    await sender.sendTaskUpdate(
      {
        url: 'https://example.com/hook',
        token: 'tok-old',
        authentication: { schemes: ['bearer'], credentials: 'tok-new' },
      },
      makeTask()
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-new');
  });

  it('supports the basic auth scheme', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    await sender.sendTaskUpdate(
      {
        url: 'https://example.com/hook',
        authentication: {
          schemes: ['basic'],
          credentials: Buffer.from('user:pass').toString('base64'),
        },
      },
      makeTask()
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`
    );
  });

  it('skips Authorization when no auth is configured', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    await sender.sendTaskUpdate(
      { url: 'https://example.com/hook' },
      makeTask()
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('uses a custom user-agent when configured', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({
      fetch,
      userAgent: 'my-agent/1.0',
      ...noRetry,
    });
    await sender.sendTaskUpdate(
      { url: 'https://example.com/hook' },
      makeTask()
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('my-agent/1.0');
  });

  it('accepts 2xx beyond 200 as success', async () => {
    const { fetch } = fakeFetch({ status: 204 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    await expect(
      sender.sendTaskUpdate({ url: 'https://example.com/hook' }, makeTask())
    ).resolves.toBeUndefined();
  });

  it('retries on 5xx and eventually succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 503 },
      { status: 500 },
      { status: 200 },
    ]);
    const sender = new HTTPPushNotificationSender({ fetch, ...fastRetry });
    await sender.sendTaskUpdate(
      { url: 'https://example.com/hook' },
      makeTask()
    );
    expect(calls).toHaveLength(3);
  });

  it('retries on HTTP 429', async () => {
    const { fetch, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const sender = new HTTPPushNotificationSender({ fetch, ...fastRetry });
    await sender.sendTaskUpdate(
      { url: 'https://example.com/hook' },
      makeTask()
    );
    expect(calls).toHaveLength(2);
  });

  it('does not retry on non-retryable 4xx', async () => {
    const { fetch, calls } = fakeFetch({ status: 400 });
    const sender = new HTTPPushNotificationSender({ fetch, ...fastRetry });
    await expect(
      sender.sendTaskUpdate({ url: 'https://example.com/hook' }, makeTask())
    ).rejects.toBeInstanceOf(PushNotificationSendError);
    expect(calls).toHaveLength(1);
  });

  it('retries on network errors', async () => {
    const netError = new TypeError('fetch failed');
    const { fetch, calls } = fakeFetch([
      { throw: netError },
      { throw: netError },
      { status: 200 },
    ]);
    const sender = new HTTPPushNotificationSender({ fetch, ...fastRetry });
    await sender.sendTaskUpdate(
      { url: 'https://example.com/hook' },
      makeTask()
    );
    expect(calls).toHaveLength(3);
  });

  it('throws after exhausting retries on persistent 5xx', async () => {
    const { fetch, calls } = fakeFetch({ status: 503 });
    const sender = new HTTPPushNotificationSender({ fetch, ...fastRetry });
    const err = await sender
      .sendTaskUpdate({ url: 'https://example.com/hook' }, makeTask())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushNotificationSendError);
    const pnErr = err as PushNotificationSendError;
    expect(pnErr.url).toBe('https://example.com/hook');
    expect(pnErr.status).toBe(503);
    // 1 initial + 2 retries = 3 attempts.
    expect(calls).toHaveLength(3);
    expect(pnErr.attempts).toBe(3);
  });

  it('respects retry: false to disable retries', async () => {
    const { fetch, calls } = fakeFetch({ status: 503 });
    const sender = new HTTPPushNotificationSender({ fetch, retry: false });
    await expect(
      sender.sendTaskUpdate({ url: 'https://example.com/hook' }, makeTask())
    ).rejects.toBeInstanceOf(PushNotificationSendError);
    expect(calls).toHaveLength(1);
  });

  it('honours the caller AbortSignal', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, delayMs: 50 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    const controller = new AbortController();
    const promise = sender.sendTaskUpdate(
      { url: 'https://example.com/hook' },
      makeTask(),
      { signal: controller.signal }
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(PushNotificationSendError);
    // The single attempt was started before abort, so one call was recorded.
    expect(calls).toHaveLength(1);
  });

  it('applies a per-attempt timeout', async () => {
    const { fetch, calls } = fakeFetch({ status: 200, delayMs: 50 });
    const sender = new HTTPPushNotificationSender({
      fetch,
      timeoutMs: 5,
      retry: { maxRetries: 0, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(
      sender.sendTaskUpdate({ url: 'https://example.com/hook' }, makeTask())
    ).rejects.toBeInstanceOf(PushNotificationSendError);
    expect(calls).toHaveLength(1);
  });

  it('exposes DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG with the documented values', () => {
    expect(DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG.initialDelayMs).toBe(500);
    expect(DEFAULT_PUSH_NOTIFICATION_RETRY_CONFIG.maxDelayMs).toBe(30_000);
  });
});

describe('HTTPPushNotificationSender.deliverTaskUpdate', () => {
  it('returns an empty array for an empty config list', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    const results = await sender.deliverTaskUpdate([], makeTask());
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('delivers to every config and returns ok results', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    const configs: PushNotificationConfig[] = [
      { id: 'a', url: 'https://example.com/a' },
      { id: 'b', url: 'https://example.com/b' },
      { id: 'c', url: 'https://example.com/c' },
    ];
    const results = await sender.deliverTaskUpdate(configs, makeTask());
    expect(calls).toHaveLength(3);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.url).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ]);
  });

  it('logs and surfaces per-config failures without throwing', async () => {
    // First two URLs fail with non-retryable 4xx; third succeeds.
    const { fetch } = mixedFakeFetch([
      ['https://example.com/a', { status: 400 }],
      ['https://example.com/b', { status: 200 }],
      ['https://example.com/c', { throw: new TypeError('boom') }],
    ]);
    const { logger, records } = captureLogger();
    const sender = new HTTPPushNotificationSender({
      fetch,
      logger,
      ...noRetry,
    });
    const configs: PushNotificationConfig[] = [
      { id: 'a', url: 'https://example.com/a' },
      { id: 'b', url: 'https://example.com/b' },
      { id: 'c', url: 'https://example.com/c' },
    ];

    const results = await sender.deliverTaskUpdate(configs, makeTask());
    const byUrl = indexByUrl(results);
    expect(byUrl['https://example.com/a']!.ok).toBe(false);
    expect(byUrl['https://example.com/b']!.ok).toBe(true);
    expect(byUrl['https://example.com/c']!.ok).toBe(false);

    const failureLogs = records.filter(
      (r) => r.level === 'warn' && r.msg === 'push notification delivery failed'
    );
    expect(failureLogs).toHaveLength(2);
  });

  it('caps in-flight POSTs at the configured concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: PushNotificationFetchLike = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('', { status: 200 });
    };
    const sender = new HTTPPushNotificationSender({
      fetch: fetchImpl,
      ...noRetry,
    });
    const configs: PushNotificationConfig[] = Array.from(
      { length: 10 },
      (_, i) => ({ id: `c-${i}`, url: `https://example.com/${i}` })
    );

    await sender.deliverTaskUpdate(configs, makeTask(), { concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('runs all requests in parallel when configs <= concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: PushNotificationFetchLike = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('', { status: 200 });
    };
    const sender = new HTTPPushNotificationSender({
      fetch: fetchImpl,
      ...noRetry,
    });
    const configs: PushNotificationConfig[] = [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
    ];
    await sender.deliverTaskUpdate(configs, makeTask());
    expect(maxInFlight).toBe(2);
  });

  it('exposes the default concurrency constant', () => {
    expect(DEFAULT_PUSH_NOTIFICATION_CONCURRENCY).toBeGreaterThan(0);
  });

  it('treats invalid concurrency (0, negative) as 1', async () => {
    const { fetch, calls } = fakeFetch({ status: 200 });
    const sender = new HTTPPushNotificationSender({ fetch, ...noRetry });
    const configs: PushNotificationConfig[] = [
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' },
    ];
    await sender.deliverTaskUpdate(configs, makeTask(), { concurrency: 0 });
    expect(calls).toHaveLength(2);
  });
});

interface MixedFakeFetchResult {
  fetch: PushNotificationFetchLike;
  calls: RecordedCall[];
}

function mixedFakeFetch(
  entries: readonly [string, FakeFetchResponse][]
): MixedFakeFetchResult {
  const calls: RecordedCall[] = [];
  const byUrl = new Map<string, FakeFetchResponse>(entries);
  const fetchImpl: PushNotificationFetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const spec = byUrl.get(url);
    if (spec === undefined) {
      return new Response('not configured', { status: 404 });
    }
    if (spec.throw !== undefined) {
      throw spec.throw;
    }
    const status = spec.status ?? 200;
    return new Response('', { status });
  };
  return { fetch: fetchImpl, calls };
}

function indexByUrl(results: DeliveryResult[]): Record<string, DeliveryResult> {
  const out: Record<string, DeliveryResult> = {};
  for (const r of results) {
    out[r.url] = r;
  }
  return out;
}

describe('HTTPPushNotificationSender against a real localhost webhook', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let receivedAuth: string | null = null;
  let receivedBody = '';
  let receivedContentType = '';
  let invocations = 0;
  let nextStatus = 200;

  beforeEach(async () => {
    receivedAuth = null;
    receivedBody = '';
    receivedContentType = '';
    invocations = 0;
    nextStatus = 200;

    const app = new Hono();
    app.post('/hook', async (c) => {
      invocations++;
      receivedAuth = c.req.header('authorization') ?? null;
      receivedContentType = c.req.header('content-type') ?? '';
      receivedBody = await c.req.text();
      return c.body(null, nextStatus as 200);
    });

    const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.once('listening', () => resolve());
      httpServer.listen(0, '127.0.0.1');
    });
    const addr = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    server = httpServer;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
  });

  it('delivers a real POST with auth header and JSON body', async () => {
    const sender = new HTTPPushNotificationSender({ ...noRetry });
    await sender.sendTaskUpdate(
      { url: `${baseUrl}/hook`, token: 'secret' },
      makeTask({ status: { state: 'TASK_STATE_WORKING' } })
    );
    expect(invocations).toBe(1);
    expect(receivedAuth).toBe('Bearer secret');
    expect(receivedContentType).toContain('application/json');
    const parsed = JSON.parse(receivedBody) as TaskUpdateNotification;
    expect(parsed.type).toBe('task_update');
    expect(parsed.state).toBe('TASK_STATE_WORKING');
  });

  it('retries against a flaky localhost server', async () => {
    const sender = new HTTPPushNotificationSender({
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 5 },
    });
    let attempts = 0;
    const app = new Hono();
    app.post('/hook', (c) => {
      attempts++;
      if (attempts < 3) {
        return c.body(null, 503);
      }
      return c.body(null, 204);
    });
    // Tear down the original beforeEach server and stand a fresh one up.
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.once('listening', () => resolve());
      httpServer.listen(0, '127.0.0.1');
    });
    const addr = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/hook`;
    server = httpServer;

    await sender.sendTaskUpdate({ url }, makeTask());
    expect(attempts).toBe(3);
  });
});
