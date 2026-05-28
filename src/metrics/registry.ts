import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type RegistryContentType,
} from 'prom-client';

/**
 * Canonical metric names. Mirrors the Go ADK's `adk/server/otel/otel.go`
 * Prometheus integration so dashboards and alerts built against the Go agent
 * keep working when the TypeScript agent is deployed in the same Prometheus.
 *
 * Counters use the `_total` suffix per Prometheus best practice. Histograms
 * use a `_seconds` suffix so the base unit is unambiguous.
 *
 * Prefixed with `a2a_` to namespace the metrics inside the agent process. The
 * prefix matches the protocol the agent speaks and stays out of the way of
 * unrelated metrics in mixed deployments.
 */
export const METRIC_NAMES = Object.freeze({
  /** Counter - prompt tokens consumed by LLM calls. */
  TOKENS_PROMPT: 'a2a_tokens_prompt_total',
  /** Counter - completion tokens emitted by LLM calls. */
  TOKENS_COMPLETION: 'a2a_tokens_completion_total',
  /** Counter - total tokens (prompt + completion) summed at usage time. */
  TOKENS_TOTAL: 'a2a_tokens_total',
  /** Counter - tasks accepted onto the work queue. */
  TASKS_QUEUED: 'a2a_tasks_queued_total',
  /** Counter - tasks that reached the terminal `completed` state. */
  TASKS_COMPLETED: 'a2a_tasks_completed_total',
  /** Counter - tasks that reached the terminal `failed` state. */
  TASKS_FAILED: 'a2a_tasks_failed_total',
  /** Counter - tool invocations that raised an error. */
  TOOL_CALL_FAILURES: 'a2a_tool_call_failures_total',
  /** Counter - HTTP requests served, labelled by `method`, `path`, `status`. */
  REQUEST_COUNT: 'a2a_request_count_total',
  /** Histogram - HTTP request duration in seconds, labelled by `method`, `path`, `status`. */
  REQUEST_DURATION: 'a2a_request_duration_seconds',
} as const);

/**
 * Default histogram buckets for HTTP request duration, in seconds. Cover the
 * 5ms - 10s span that agent HTTP traffic typically lives in. Matches the
 * `prometheus.DefBuckets` defaults the Go ADK relies on.
 */
export const DEFAULT_REQUEST_DURATION_BUCKETS: readonly number[] =
  Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

/** Label keys used by HTTP-request metrics. */
export type RequestLabel = 'method' | 'path' | 'status';

/** Constructor options for {@link MetricsRegistry}. */
export interface MetricsRegistryOptions {
  /**
   * When `true`, register Node.js default metrics (CPU, memory, event-loop
   * lag, GC) on construction. Defaults to `true` - matches the Go ADK, which
   * exposes process-level metrics alongside the domain counters.
   */
  readonly collectDefaultMetrics?: boolean;
  /**
   * Custom histogram buckets for the request-duration histogram. Defaults to
   * {@link DEFAULT_REQUEST_DURATION_BUCKETS}.
   */
  readonly requestDurationBuckets?: readonly number[];
}

/**
 * Container that owns a {@link Registry} plus the canonical agent metrics
 * declared in {@link METRIC_NAMES}. Each {@link MetricsRegistry} is fully
 * self-contained - it does not touch `prom-client`'s default global registry,
 * so two coexisting instances in the same process (e.g., tests + production
 * code) cannot collide.
 *
 * The metric accessors are intentionally narrow conveniences over the
 * underlying {@link Counter}/{@link Histogram} instances - callers who need
 * advanced operations (`reset()`, exemplars, child labels) should grab the
 * raw metric via {@link getRegistry}.
 */
export class MetricsRegistry {
  private readonly registry: Registry;
  private readonly tokensPrompt: Counter<string>;
  private readonly tokensCompletion: Counter<string>;
  private readonly tokensTotal: Counter<string>;
  private readonly tasksQueued: Counter<string>;
  private readonly tasksCompleted: Counter<string>;
  private readonly tasksFailed: Counter<string>;
  private readonly toolCallFailures: Counter<string>;
  private readonly requestCount: Counter<RequestLabel>;
  private readonly requestDuration: Histogram<RequestLabel>;

  constructor(options: MetricsRegistryOptions = {}) {
    this.registry = new Registry();

    if (options.collectDefaultMetrics !== false) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.tokensPrompt = new Counter({
      name: METRIC_NAMES.TOKENS_PROMPT,
      help: 'Prompt tokens consumed by LLM calls.',
      registers: [this.registry],
    });
    this.tokensCompletion = new Counter({
      name: METRIC_NAMES.TOKENS_COMPLETION,
      help: 'Completion tokens emitted by LLM calls.',
      registers: [this.registry],
    });
    this.tokensTotal = new Counter({
      name: METRIC_NAMES.TOKENS_TOTAL,
      help: 'Total tokens (prompt + completion) consumed by LLM calls.',
      registers: [this.registry],
    });
    this.tasksQueued = new Counter({
      name: METRIC_NAMES.TASKS_QUEUED,
      help: 'Tasks accepted onto the work queue.',
      registers: [this.registry],
    });
    this.tasksCompleted = new Counter({
      name: METRIC_NAMES.TASKS_COMPLETED,
      help: 'Tasks that reached the terminal completed state.',
      registers: [this.registry],
    });
    this.tasksFailed = new Counter({
      name: METRIC_NAMES.TASKS_FAILED,
      help: 'Tasks that reached the terminal failed state.',
      registers: [this.registry],
    });
    this.toolCallFailures = new Counter({
      name: METRIC_NAMES.TOOL_CALL_FAILURES,
      help: 'Tool invocations that raised an error.',
      registers: [this.registry],
    });
    this.requestCount = new Counter({
      name: METRIC_NAMES.REQUEST_COUNT,
      help: 'HTTP requests served by the agent.',
      labelNames: ['method', 'path', 'status'] as const,
      registers: [this.registry],
    });
    this.requestDuration = new Histogram({
      name: METRIC_NAMES.REQUEST_DURATION,
      help: 'HTTP request duration in seconds.',
      labelNames: ['method', 'path', 'status'] as const,
      buckets: [
        ...(options.requestDurationBuckets ?? DEFAULT_REQUEST_DURATION_BUCKETS),
      ],
      registers: [this.registry],
    });
  }

  /** The underlying prom-client {@link Registry}. Use for advanced cases. */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * `Content-Type` header value to return alongside the metrics body. Forwards
   * whatever the underlying registry advertises (Prometheus or OpenMetrics).
   */
  getContentType(): RegistryContentType {
    return this.registry.contentType;
  }

  /** Render the metrics in their text exposition format. */
  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /**
   * Record token usage from a single LLM call. Increments
   * {@link METRIC_NAMES.TOKENS_PROMPT}, {@link METRIC_NAMES.TOKENS_COMPLETION},
   * and {@link METRIC_NAMES.TOKENS_TOTAL} by the matching field.
   *
   * `totalTokens` defaults to `promptTokens + completionTokens` when omitted -
   * matches what {@link import('../server/default-background-task-handler.js').UsageTracker.addUsage}
   * does for the task metadata fields.
   */
  recordTokenUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens?: number;
  }): void {
    if (usage.promptTokens > 0) {
      this.tokensPrompt.inc(usage.promptTokens);
    }
    if (usage.completionTokens > 0) {
      this.tokensCompletion.inc(usage.completionTokens);
    }
    const total =
      usage.totalTokens ?? usage.promptTokens + usage.completionTokens;
    if (total > 0) {
      this.tokensTotal.inc(total);
    }
  }

  /** Increment {@link METRIC_NAMES.TASKS_QUEUED} by `count`. */
  incrementTasksQueued(count = 1): void {
    if (count > 0) this.tasksQueued.inc(count);
  }

  /** Increment {@link METRIC_NAMES.TASKS_COMPLETED} by `count`. */
  incrementTasksCompleted(count = 1): void {
    if (count > 0) this.tasksCompleted.inc(count);
  }

  /** Increment {@link METRIC_NAMES.TASKS_FAILED} by `count`. */
  incrementTasksFailed(count = 1): void {
    if (count > 0) this.tasksFailed.inc(count);
  }

  /** Increment {@link METRIC_NAMES.TOOL_CALL_FAILURES} by `count`. */
  incrementToolCallFailures(count = 1): void {
    if (count > 0) this.toolCallFailures.inc(count);
  }

  /**
   * Record one HTTP request. Increments {@link METRIC_NAMES.REQUEST_COUNT}
   * and observes the duration on {@link METRIC_NAMES.REQUEST_DURATION}, both
   * labelled with `{ method, path, status }`. Duration is in seconds.
   */
  recordRequest(labels: {
    method: string;
    path: string;
    status: number;
    durationSeconds: number;
  }): void {
    const labelValues = {
      method: labels.method,
      path: labels.path,
      status: String(labels.status),
    };
    this.requestCount.inc(labelValues);
    this.requestDuration.observe(labelValues, labels.durationSeconds);
  }
}
