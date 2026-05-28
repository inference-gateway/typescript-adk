import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_METRICS_HOST,
  DEFAULT_METRICS_PORT,
  METRICS_ENABLE_ENV,
  METRICS_HEALTH_PATH,
  MetricsRegistry,
  MetricsServer,
  createMetricsServer,
} from '../../src/metrics/index.js';

async function startServer(server: MetricsServer): Promise<string> {
  await server.start();
  const addr = server.address();
  if (addr === null) {
    throw new Error('metrics server did not report a listening address');
  }
  return `http://127.0.0.1:${addr.port}`;
}

describe('MetricsServer lifecycle (disabled mode)', () => {
  it('defaults to disabled and start() is a no-op', async () => {
    const server = createMetricsServer({ env: {} });
    expect(server.isEnabled()).toBe(false);
    await server.start();
    expect(server.isStarted()).toBe(false);
    expect(server.address()).toBeNull();
  });

  it('close() is a no-op when never started', async () => {
    const server = createMetricsServer({ env: {} });
    await expect(server.close()).resolves.toBeUndefined();
  });

  it('config reflects the default port/host even when disabled', () => {
    const server = createMetricsServer({ env: {} });
    expect(server.getConfig().port).toBe(DEFAULT_METRICS_PORT);
    expect(server.getConfig().host).toBe(DEFAULT_METRICS_HOST);
  });
});

describe('MetricsServer HTTP behaviour (enabled mode)', () => {
  let server: MetricsServer | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('serves /metrics with the prom-text content type', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.incrementTasksCompleted(3);

    server = new MetricsServer({
      env: { [METRICS_ENABLE_ENV]: 'true' },
      config: {
        enable: true,
        port: 0,
        host: '127.0.0.1',
        path: '/metrics',
        readTimeoutMs: 5_000,
        writeTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        collectDefaultMetrics: false,
      },
      registry,
    });

    const base = await startServer(server);
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).toContain('a2a_tasks_completed_total 3');
  });

  it('serves /health independently of /metrics', async () => {
    server = new MetricsServer({
      env: { [METRICS_ENABLE_ENV]: 'true' },
      config: {
        enable: true,
        port: 0,
        host: '127.0.0.1',
        path: '/metrics',
        readTimeoutMs: 5_000,
        writeTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        collectDefaultMetrics: false,
      },
    });
    const base = await startServer(server);
    const res = await fetch(`${base}${METRICS_HEALTH_PATH}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'healthy' });
  });

  it('mounts the configured metrics path', async () => {
    server = new MetricsServer({
      config: {
        enable: true,
        port: 0,
        host: '127.0.0.1',
        path: '/custom-metrics',
        readTimeoutMs: 5_000,
        writeTimeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        collectDefaultMetrics: false,
      },
    });
    const base = await startServer(server);
    const fallback = await fetch(`${base}/metrics`);
    expect(fallback.status).toBe(404);
    const ok = await fetch(`${base}/custom-metrics`);
    expect(ok.status).toBe(200);
  });

  it('applies the configured read/write/idle timeouts to the HTTP server', () => {
    server = new MetricsServer({
      config: {
        enable: true,
        port: 0,
        host: '127.0.0.1',
        path: '/metrics',
        readTimeoutMs: 1_111,
        writeTimeoutMs: 2_222,
        idleTimeoutMs: 3_333,
        collectDefaultMetrics: false,
      },
    });
    // The constructor sets these synchronously, so we can inspect even before
    // start(). Duck-typing through the private `httpServer` field avoids
    // exposing it on the public surface.
    const internal = server as unknown as {
      httpServer: {
        headersTimeout: number;
        requestTimeout: number;
        keepAliveTimeout: number;
      };
    };
    expect(internal.httpServer.headersTimeout).toBe(1_111);
    expect(internal.httpServer.requestTimeout).toBe(2_222);
    expect(internal.httpServer.keepAliveTimeout).toBe(3_333);
  });
});
