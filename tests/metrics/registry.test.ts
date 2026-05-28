import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REQUEST_DURATION_BUCKETS,
  METRIC_NAMES,
  MetricsRegistry,
} from '../../src/metrics/index.js';

describe('MetricsRegistry exposed metrics', () => {
  it('registers the full set of canonical metric names', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    const exposition = await registry.metrics();
    for (const name of Object.values(METRIC_NAMES)) {
      expect(exposition, `missing metric ${name}`).toContain(name);
    }
  });

  it('omits Node defaults when collectDefaultMetrics is false', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    const exposition = await registry.metrics();
    expect(exposition).not.toContain('process_cpu_seconds_total');
    expect(exposition).not.toContain('nodejs_eventloop_lag_seconds');
  });

  it('includes Node defaults when collectDefaultMetrics is true (default)', async () => {
    const registry = new MetricsRegistry();
    const exposition = await registry.metrics();
    expect(exposition).toContain('process_cpu_seconds_total');
  });

  it('reports a Prometheus text content type', () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    expect(registry.getContentType()).toMatch(/^text\/plain/);
  });
});

describe('MetricsRegistry token usage', () => {
  it('recordTokenUsage increments prompt/completion/total counters', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.recordTokenUsage({ promptTokens: 100, completionTokens: 40 });
    registry.recordTokenUsage({ promptTokens: 50, completionTokens: 10 });

    const exposition = await registry.metrics();
    expect(exposition).toContain(`${METRIC_NAMES.TOKENS_PROMPT} 150`);
    expect(exposition).toContain(`${METRIC_NAMES.TOKENS_COMPLETION} 50`);
    expect(exposition).toContain(`${METRIC_NAMES.TOKENS_TOTAL} 200`);
  });

  it('uses explicit totalTokens when supplied', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.recordTokenUsage({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 99,
    });
    const exposition = await registry.metrics();
    expect(exposition).toContain(`${METRIC_NAMES.TOKENS_TOTAL} 99`);
  });

  it('ignores zero token counts', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.recordTokenUsage({ promptTokens: 0, completionTokens: 0 });
    const exposition = await registry.metrics();
    expect(exposition).toContain(`${METRIC_NAMES.TOKENS_PROMPT} 0`);
    expect(exposition).toContain(`${METRIC_NAMES.TOKENS_COMPLETION} 0`);
  });
});

describe('MetricsRegistry task and tool counters', () => {
  it('increments task counters by the supplied count', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.incrementTasksQueued();
    registry.incrementTasksQueued(2);
    registry.incrementTasksCompleted(4);
    registry.incrementTasksFailed(1);

    const exposition = await registry.metrics();
    expect(exposition).toContain(`${METRIC_NAMES.TASKS_QUEUED} 3`);
    expect(exposition).toContain(`${METRIC_NAMES.TASKS_COMPLETED} 4`);
    expect(exposition).toContain(`${METRIC_NAMES.TASKS_FAILED} 1`);
  });

  it('increments tool failure counter', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.incrementToolCallFailures();
    registry.incrementToolCallFailures(5);

    const exposition = await registry.metrics();
    expect(exposition).toContain(`${METRIC_NAMES.TOOL_CALL_FAILURES} 6`);
  });

  it('ignores non-positive increments', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.incrementTasksQueued(0);
    registry.incrementTasksQueued(-3);
    const exposition = await registry.metrics();
    expect(exposition).toContain(`${METRIC_NAMES.TASKS_QUEUED} 0`);
  });
});

describe('MetricsRegistry request metrics', () => {
  it('labels request count and observes duration', async () => {
    const registry = new MetricsRegistry({ collectDefaultMetrics: false });
    registry.recordRequest({
      method: 'POST',
      path: '/',
      status: 200,
      durationSeconds: 0.042,
    });
    registry.recordRequest({
      method: 'POST',
      path: '/',
      status: 200,
      durationSeconds: 0.018,
    });
    registry.recordRequest({
      method: 'GET',
      path: '/health',
      status: 200,
      durationSeconds: 0.001,
    });

    const exposition = await registry.metrics();
    expect(exposition).toMatch(
      /a2a_request_count_total\{method="POST",path="\/",status="200"\} 2/
    );
    expect(exposition).toMatch(
      /a2a_request_count_total\{method="GET",path="\/health",status="200"\} 1/
    );
    expect(exposition).toMatch(
      /a2a_request_duration_seconds_count\{method="POST",path="\/",status="200"\} 2/
    );
  });

  it('uses custom histogram buckets when provided', async () => {
    const registry = new MetricsRegistry({
      collectDefaultMetrics: false,
      requestDurationBuckets: [0.1, 0.5, 1, 5],
    });
    registry.recordRequest({
      method: 'GET',
      path: '/x',
      status: 200,
      durationSeconds: 0.3,
    });
    const exposition = await registry.metrics();
    expect(exposition).toContain('le="0.1"');
    expect(exposition).toContain('le="5"');
    expect(exposition).not.toContain('le="10"');
  });
});

describe('DEFAULT_REQUEST_DURATION_BUCKETS', () => {
  it('is frozen and sorted ascending', () => {
    expect(Object.isFrozen(DEFAULT_REQUEST_DURATION_BUCKETS)).toBe(true);
    const sorted = [...DEFAULT_REQUEST_DURATION_BUCKETS].every(
      (v, i, arr) => i === 0 || arr[i - 1]! < v
    );
    expect(sorted).toBe(true);
  });
});
