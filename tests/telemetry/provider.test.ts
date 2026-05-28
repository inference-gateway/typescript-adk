import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEMETRY_ENABLE_ENV,
  TelemetryProvider,
  createTelemetryProvider,
} from '../../src/telemetry/index.js';

describe('TelemetryProvider lifecycle (no SDK started)', () => {
  it('defaults to disabled and never starts the SDK', () => {
    const provider = createTelemetryProvider({ env: {} });
    expect(provider.isEnabled()).toBe(false);
    provider.start();
    expect(provider.isStarted()).toBe(false);
  });

  it('shutdown is a no-op when telemetry is disabled', async () => {
    const provider = createTelemetryProvider({ env: {} });
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it('resolves serviceName/serviceVersion overrides over env', () => {
    const provider = createTelemetryProvider({
      env: {
        OTEL_SERVICE_NAME: 'env-name',
        OTEL_SERVICE_VERSION: '0.1.0',
      },
      serviceName: 'override-name',
      serviceVersion: '9.9.9',
    });
    const config = provider.getConfig();
    expect(config.serviceName).toBe('override-name');
    expect(config.serviceVersion).toBe('9.9.9');
  });
});

// The global OTel TracerProvider can only be registered once per process, so
// every test in this file shares a single provider+exporter pair set up in
// `beforeAll`. Between tests we call `exporter.reset()` so each one starts
// with an empty captured-span list.
describe('TelemetryProvider span emission', () => {
  let exporter: InMemorySpanExporter;
  let provider: TelemetryProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new TelemetryProvider({
      env: { [TELEMETRY_ENABLE_ENV]: 'true' },
      serviceName: 'test-svc',
      serviceVersion: '1.0.0',
      spanProcessors: [new SimpleSpanProcessor(exporter)],
      instrumentations: [],
    });
    provider.start();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    exporter.reset();
  });

  it('emits a single span for withSpan on success', async () => {
    const result = await provider.withSpan('test.operation', async (span) => {
      span.setAttribute('test.attr', 'hello');
      return 42;
    });
    expect(result).toBe(42);

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    const first = finished[0];
    expect(first?.name).toBe('test.operation');
    expect(first?.attributes['test.attr']).toBe('hello');
    expect(first?.status.code).toBe(0);
  });

  it('records exceptions and sets ERROR status when withSpan throws', async () => {
    await expect(
      provider.withSpan('test.failing', () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    expect(finished).toHaveLength(1);
    const first = finished[0];
    expect(first?.status.code).toBe(2);
    expect(first?.status.message).toBe('boom');
    expect(first?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('annotates spans with the configured service resource attributes', async () => {
    await provider.withSpan('test.resource', () => undefined);

    await provider.forceFlush();
    const first = exporter.getFinishedSpans()[0];
    const attrs = first?.resource.attributes ?? {};
    expect(attrs['service.name']).toBe('test-svc');
    expect(attrs['service.version']).toBe('1.0.0');
  });
});
