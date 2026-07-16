import {
  type Span,
  SpanStatusCode,
  type SpanOptions,
  type Tracer,
  trace,
  context,
} from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  DEFAULT_SERVICE_NAME,
  DEFAULT_SERVICE_VERSION,
  OTEL_SERVICE_NAME_ENV,
  OTEL_SERVICE_VERSION_ENV,
  loadTelemetryConfigFromEnv,
  type TelemetryConfig,
} from './config.js';

type NodeSDKConfig = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;

/**
 * Name passed to `trace.getTracer(name, version)` for spans created via this
 * provider. Matches the npm package name so spans are easy to filter by
 * library in a tracing backend.
 */
export const TELEMETRY_INSTRUMENTATION_NAME = '@inference-gateway/adk';

/**
 * Options accepted by {@link createTelemetryProvider}. All fields are optional;
 * sensible defaults are populated from environment variables and the resolved
 * {@link TelemetryConfig}.
 */
export interface CreateTelemetryProviderOptions {
  /**
   * Explicit configuration. When omitted, loaded from
   * {@link loadTelemetryConfigFromEnv} on construction.
   */
  readonly config?: TelemetryConfig;
  /**
   * Override `service.name` after env/config resolution. Useful when the
   * server already knows the agent card name and wants it to win over both.
   */
  readonly serviceName?: string;
  /** Override `service.version` after env/config resolution. */
  readonly serviceVersion?: string;
  /**
   * Replace the default OTLP HTTP trace exporter pipeline with explicit span
   * processors. Primary test seam - wrap an `InMemorySpanExporter` in a
   * `SimpleSpanProcessor` and assert against the captured spans.
   *
   * The {@link NodeSDK} owns the lifecycle of these processors. When supplied,
   * the default {@link OTLPTraceExporter} is not registered.
   */
  readonly spanProcessors?: NodeSDKConfig['spanProcessors'];
  /**
   * Replace the default OTLP HTTP log record processor. Mirrors
   * {@link spanProcessors} but for the logs signal.
   */
  readonly logRecordProcessor?: NodeSDKConfig['logRecordProcessor'];
  /**
   * Replace the metric reader selected by
   * {@link TelemetryConfig.metricsExporter}. Pass a no-op reader to disable
   * metric export in tests, or a Prometheus/OTLP reader to force a specific
   * pipeline regardless of env.
   */
  readonly metricReader?: NodeSDKConfig['metricReader'];
  /**
   * Replace the default {@link getNodeAutoInstrumentations} bundle. Pass an
   * empty array to disable auto-instrumentation entirely (manual spans
   * created via {@link TelemetryProvider.withSpan} still flow).
   */
  readonly instrumentations?: NodeSDKConfig['instrumentations'];
  /**
   * Read environment variables from this object instead of `process.env`.
   * Test seam mirroring {@link loadTelemetryConfigFromEnv}.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Telemetry provider that wraps a configured {@link NodeSDK}.
 *
 * Two operating modes:
 *
 * - **Disabled** (`config.enable === false`): {@link start} is a no-op, the
 *   underlying SDK is never instantiated, and {@link getTracer} returns the
 *   global no-op tracer. Zero runtime cost beyond the provider object itself.
 *
 * - **Enabled**: {@link start} initialises the {@link NodeSDK} with OTLP HTTP
 *   trace/log exporters, a metric reader selected by
 *   {@link TelemetryConfig.metricsExporter} (OTLP push by default, a Prometheus
 *   pull endpoint, or none), the standard Node auto-instrumentation bundle, and
 *   a resource with `service.name`/`service.version` populated from the
 *   resolved config. All exporters are overridable via constructor options.
 *
 * The provider does not register itself globally on construction - call
 * {@link start} to start exporting and {@link shutdown} to flush and stop. It
 * is safe to call both unconditionally regardless of `enable`.
 */
export class TelemetryProvider {
  private readonly config: TelemetryConfig;
  private readonly options: CreateTelemetryProviderOptions;
  private sdk: NodeSDK | null = null;
  private started = false;

  constructor(options: CreateTelemetryProviderOptions = {}) {
    this.options = options;
    const fromEnv = loadTelemetryConfigFromEnv(options.env);
    const base = options.config ?? fromEnv;
    const serviceName = options.serviceName ?? base.serviceName;
    const serviceVersion = options.serviceVersion ?? base.serviceVersion;
    this.config = {
      enable: base.enable,
      serviceName: serviceName.length > 0 ? serviceName : DEFAULT_SERVICE_NAME,
      serviceVersion:
        serviceVersion.length > 0 ? serviceVersion : DEFAULT_SERVICE_VERSION,
      metricsExporter: base.metricsExporter,
      prometheusHost: base.prometheusHost,
      prometheusPort: base.prometheusPort,
    };
  }

  /** Resolved telemetry configuration after merging env, config, and overrides. */
  getConfig(): TelemetryConfig {
    return this.config;
  }

  /** Whether the underlying SDK has been started. */
  isStarted(): boolean {
    return this.started;
  }

  /** Whether telemetry is enabled by the resolved configuration. */
  isEnabled(): boolean {
    return this.config.enable;
  }

  /**
   * Initialise and start the {@link NodeSDK} when telemetry is enabled.
   * No-ops when disabled or already started, so it is safe to call
   * unconditionally during server boot.
   */
  start(): void {
    if (!this.config.enable || this.started) {
      return;
    }

    // Override env vars so the NodeSDK's default resource detection picks up
    // the configured values instead of whatever the outer environment has set.
    // The SDK merges the explicit resource with the detected one, and the
    // detected resource wins for conflicting attributes, so we must set the
    // env vars to ensure our config takes precedence.
    process.env[OTEL_SERVICE_NAME_ENV] = this.config.serviceName;
    process.env[OTEL_SERVICE_VERSION_ENV] = this.config.serviceVersion;

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.config.serviceName,
      [ATTR_SERVICE_VERSION]: this.config.serviceVersion,
    });

    const sdkConfig: NodeSDKConfig = {
      resource,
      instrumentations:
        this.options.instrumentations ?? getNodeAutoInstrumentations(),
    };

    if (this.options.spanProcessors !== undefined) {
      sdkConfig.spanProcessors = this.options.spanProcessors;
    } else {
      sdkConfig.traceExporter = new OTLPTraceExporter();
    }

    sdkConfig.logRecordProcessor =
      this.options.logRecordProcessor ??
      new SimpleLogRecordProcessor({ exporter: new OTLPLogExporter() });

    const metricReader = this.options.metricReader ?? this.createMetricReader();
    if (metricReader !== undefined) {
      sdkConfig.metricReader = metricReader;
    }

    this.sdk = new NodeSDK(sdkConfig);
    this.sdk.start();
    this.started = true;
  }

  /**
   * Build the metric reader for the resolved {@link TelemetryConfig.metricsExporter}:
   *
   * - `'otlp'` (default) - {@link PeriodicExportingMetricReader} pushing over
   *   OTLP HTTP.
   * - `'prometheus'` - {@link PrometheusExporter}, which starts its own HTTP
   *   scrape endpoint on `prometheusHost:prometheusPort` (default `/metrics`)
   *   and is stopped again by {@link shutdown}.
   * - `'none'` - `undefined`, so no metric reader is registered and the metrics
   *   signal stays off while traces/logs keep flowing.
   */
  private createMetricReader(): NodeSDKConfig['metricReader'] {
    switch (this.config.metricsExporter) {
      case 'none':
        return undefined;
      case 'prometheus':
        return new PrometheusExporter({
          host: this.config.prometheusHost,
          port: this.config.prometheusPort,
        });
      case 'otlp':
      default:
        return new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
        });
    }
  }

  /**
   * Flush pending telemetry and shut down the SDK. No-ops when telemetry is
   * disabled or {@link start} was never called.
   */
  async shutdown(): Promise<void> {
    if (!this.started || this.sdk === null) {
      return;
    }
    await this.sdk.shutdown();
    this.started = false;
  }

  /**
   * Flush all registered span/log/metric processors without shutting the SDK
   * down. Primary test seam for asserting span emission - the InMemory
   * exporters wipe their state on shutdown, so callers that want to read the
   * captured spans must flush instead.
   *
   * No-op when telemetry is disabled or {@link start} was never called.
   */
  async forceFlush(): Promise<void> {
    if (!this.started) {
      return;
    }
    const tracerProvider = trace.getTracerProvider() as unknown as {
      getDelegate?: () => unknown;
      forceFlush?: () => Promise<void>;
    };
    const inner =
      typeof tracerProvider.getDelegate === 'function'
        ? (tracerProvider.getDelegate() as {
            forceFlush?: () => Promise<void>;
          })
        : tracerProvider;
    if (typeof inner.forceFlush === 'function') {
      await inner.forceFlush();
    }
  }

  /**
   * Returns a tracer scoped to this provider. When telemetry is disabled the
   * global API yields a no-op tracer, so callers can wrap code in
   * {@link withSpan} unconditionally.
   */
  getTracer(
    name: string = TELEMETRY_INSTRUMENTATION_NAME,
    version?: string
  ): Tracer {
    if (version !== undefined) {
      return trace.getTracer(name, version);
    }
    return trace.getTracer(name);
  }

  /**
   * Run `fn` inside a new span. The span is ended automatically when `fn`
   * resolves or throws, the span status is set to ERROR on throw, and the
   * thrown value is recorded as a span exception.
   *
   * When telemetry is disabled this still runs `fn` against a no-op span -
   * the cost is one tracer lookup, no exporter activity.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions
  ): Promise<T> {
    const tracer = this.getTracer();
    const span = tracer.startSpan(name, options);
    try {
      return await context.with(trace.setSpan(context.active(), span), () =>
        fn(span)
      );
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  }
}

/**
 * Convenience constructor mirroring the auth/storage factory pattern used
 * elsewhere in the package. Always returns a provider - call
 * {@link TelemetryProvider.isEnabled} to discover whether telemetry will
 * actually start.
 */
export function createTelemetryProvider(
  options: CreateTelemetryProviderOptions = {}
): TelemetryProvider {
  return new TelemetryProvider(options);
}
