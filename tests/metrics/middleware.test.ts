import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  METRIC_NAMES,
  MetricsRegistry,
  createMetricsMiddleware,
} from '../../src/metrics/index.js';

interface Harness {
  base: string;
  server: Server;
  registry: MetricsRegistry;
}

async function startHarness(options?: {
  excludePaths?: string[];
}): Promise<Harness> {
  const registry = new MetricsRegistry({ collectDefaultMetrics: false });
  const app = new Hono();
  app.use(
    '*',
    createMetricsMiddleware({
      registry,
      ...(options?.excludePaths !== undefined
        ? { excludePaths: options.excludePaths }
        : {}),
    })
  );
  app.get('/ping', (c) => c.json({ ok: true }));
  app.get('/health', (c) => c.json({ status: 'healthy' }));
  app.get('/boom', () => {
    throw new Error('boom');
  });

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve());
    server.listen(0, '127.0.0.1');
  });
  const addr = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${addr.port}`, server, registry };
}

async function closeHarness(harness: Harness): Promise<void> {
  await new Promise<void>((resolve) => harness.server.close(() => resolve()));
}

describe('createMetricsMiddleware', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await closeHarness(harness);
      harness = undefined;
    }
  });

  it('records a 200 GET with method/path/status labels', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.base}/ping`);
    expect(res.status).toBe(200);
    const exposition = await harness.registry.metrics();
    expect(exposition).toMatch(
      /a2a_request_count_total\{method="GET",path="\/ping",status="200"\} 1/
    );
    expect(exposition).toMatch(
      /a2a_request_duration_seconds_count\{method="GET",path="\/ping",status="200"\} 1/
    );
  });

  it('records 5xx responses from handler errors', async () => {
    harness = await startHarness();
    const res = await fetch(`${harness.base}/boom`);
    expect(res.status).toBe(500);
    const exposition = await harness.registry.metrics();
    expect(exposition).toMatch(
      /a2a_request_count_total\{method="GET",path="\/boom",status="500"\} 1/
    );
  });

  it('aggregates multiple requests to the same path', async () => {
    harness = await startHarness();
    await fetch(`${harness.base}/ping`);
    await fetch(`${harness.base}/ping`);
    await fetch(`${harness.base}/ping`);
    const exposition = await harness.registry.metrics();
    expect(exposition).toMatch(
      /a2a_request_count_total\{method="GET",path="\/ping",status="200"\} 3/
    );
  });

  it('skips paths in excludePaths', async () => {
    harness = await startHarness({ excludePaths: ['/health'] });
    await fetch(`${harness.base}/health`);
    await fetch(`${harness.base}/ping`);
    const exposition = await harness.registry.metrics();
    expect(exposition).toMatch(
      /a2a_request_count_total\{method="GET",path="\/ping",status="200"\} 1/
    );
    expect(exposition).not.toMatch(
      /a2a_request_count_total\{method="GET",path="\/health"/
    );
  });

  it('histogram observation reflects a non-zero duration', async () => {
    harness = await startHarness();
    await fetch(`${harness.base}/ping`);
    const exposition = await harness.registry.metrics();
    const sumMatch = exposition.match(
      /a2a_request_duration_seconds_sum\{method="GET",path="\/ping",status="200"\} (\S+)/
    );
    expect(sumMatch).not.toBeNull();
    expect(Number(sumMatch![1])).toBeGreaterThan(0);
    expect(METRIC_NAMES.REQUEST_DURATION).toBe('a2a_request_duration_seconds');
  });
});
