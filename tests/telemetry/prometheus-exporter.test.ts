import { metrics } from '@opentelemetry/api';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OTEL_EXPORTER_PROMETHEUS_HOST_ENV,
  OTEL_EXPORTER_PROMETHEUS_PORT_ENV,
  OTEL_METRICS_EXPORTER_ENV,
  TELEMETRY_ENABLED_ENV,
  TelemetryProvider,
} from '../../src/telemetry/index.js';

// Grab a free port, then hand it to the exporter. There is a small TOCTOU
// window between closing this probe and the exporter re-binding, but on
// loopback in a single isolated worker it is not observed in practice.
// ponytail: TOCTOU on port reuse; switch to exporter-reported port if flaky.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr !== 'string' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

// The Prometheus HTTP server binds asynchronously after start(); poll until the
// scrape endpoint answers (or give up after ~1s).
async function fetchWithRetry(url: string, attempts = 50): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw lastErr;
}

describe('TelemetryProvider Prometheus pull exporter', () => {
  let provider: TelemetryProvider;
  let port: number;

  beforeAll(async () => {
    port = await freePort();
    provider = new TelemetryProvider({
      env: {
        [TELEMETRY_ENABLED_ENV]: 'true',
        [OTEL_METRICS_EXPORTER_ENV]: 'prometheus',
        [OTEL_EXPORTER_PROMETHEUS_HOST_ENV]: '127.0.0.1',
        [OTEL_EXPORTER_PROMETHEUS_PORT_ENV]: String(port),
      },
      serviceName: 'prom-agent',
      serviceVersion: '1.0.0',
      instrumentations: [],
      spanProcessors: [],
    });
    provider.start();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it('resolves the prometheus exporter and configured host/port', () => {
    const config = provider.getConfig();
    expect(config.metricsExporter).toBe('prometheus');
    expect(config.prometheusHost).toBe('127.0.0.1');
    expect(config.prometheusPort).toBe(port);
  });

  it('serves recorded metrics, then stops after shutdown', async () => {
    const meter = metrics.getMeter('prometheus-exporter-test');
    const counter = meter.createCounter('adk_prom_test_counter');
    counter.add(3, { route: 'echo' });

    const res = await fetchWithRetry(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('adk_prom_test_counter');
    expect(body).toContain('route="echo"');

    await provider.shutdown();
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
  });
});
