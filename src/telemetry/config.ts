/**
 * Telemetry configuration. Mirrors `OpenTelemetryConfig` in the Go ADK
 * (`server/otel/otel.go`).
 *
 * `enable` defaults to `false` - disabled mode skips SDK initialisation entirely
 * and {@link import('./provider.js').TelemetryProvider.getTracer} returns a
 * no-op tracer from the global OpenTelemetry API.
 *
 * The OTLP exporter honours the standard OpenTelemetry environment variables
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_EXPORTER_OTLP_PROTOCOL`) - this config layer only adds the
 * inference-gateway-org-specific `TELEMETRY_ENABLE` toggle and the
 * `OTEL_SERVICE_NAME`/`OTEL_SERVICE_VERSION` defaults pulled from the agent
 * card when the server constructs the provider.
 */
export interface TelemetryConfig {
  /** Master switch. SDK is not started when `false`. Defaults to `false`. */
  readonly enable: boolean;
  /**
   * `service.name` resource attribute. Defaults to the package name when
   * neither this field nor `OTEL_SERVICE_NAME` is set.
   */
  readonly serviceName: string;
  /**
   * `service.version` resource attribute. Defaults to the package version when
   * neither this field nor `OTEL_SERVICE_VERSION` is set.
   */
  readonly serviceVersion: string;
  /**
   * Which exporter the metrics signal uses. Defaults to
   * {@link DEFAULT_METRICS_EXPORTER} (`'otlp'`). See {@link MetricsExporter}.
   */
  readonly metricsExporter: MetricsExporter;
  /**
   * Host the Prometheus pull endpoint binds to when
   * {@link metricsExporter} is `'prometheus'`. Defaults to
   * {@link DEFAULT_PROMETHEUS_HOST}. Ignored for the `otlp`/`none` exporters.
   */
  readonly prometheusHost: string;
  /**
   * TCP port the Prometheus pull endpoint listens on when
   * {@link metricsExporter} is `'prometheus'`. Defaults to
   * {@link DEFAULT_PROMETHEUS_PORT}. Pass `0` to let the OS pick an ephemeral
   * port (handy in tests). Ignored for the `otlp`/`none` exporters.
   */
  readonly prometheusPort: number;
}

/**
 * Selects how the metrics signal is exported. Mirrors the standard
 * OpenTelemetry `OTEL_METRICS_EXPORTER` env var and the ADL schema's per-signal
 * exporter block (`metrics.exporter.{otlp,prometheus}`):
 *
 * - `'otlp'` (default) - push metrics over OTLP to
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` via a {@link
 *   import('@opentelemetry/sdk-metrics').PeriodicExportingMetricReader}.
 * - `'prometheus'` - expose a pull-based Prometheus scrape endpoint on
 *   `OTEL_EXPORTER_PROMETHEUS_HOST`:`OTEL_EXPORTER_PROMETHEUS_PORT`.
 * - `'none'` - disable the metrics signal entirely (no reader registered);
 *   traces and logs still export. Equivalent to omitting the `metrics` block
 *   in the ADL manifest.
 */
export type MetricsExporter = 'otlp' | 'prometheus' | 'none';

/**
 * Environment variable that, when truthy, enables telemetry. Distinct from the
 * standard OTel `OTEL_SDK_DISABLED` so users can disable our SDK initialisation
 * without flipping the global OTel kill-switch (which would also disable any
 * SDK initialised by a parent process or sidecar).
 */
export const TELEMETRY_ENABLE_ENV = 'TELEMETRY_ENABLE';

/**
 * Standard OpenTelemetry env var for the `service.name` resource attribute.
 * Honored by the SDK directly; we read it here to surface the resolved value
 * back on {@link TelemetryConfig}.
 */
export const OTEL_SERVICE_NAME_ENV = 'OTEL_SERVICE_NAME';

/**
 * Standard OpenTelemetry env var for the `service.version` resource attribute.
 * Honored by the SDK directly; we read it here to surface the resolved value
 * back on {@link TelemetryConfig}.
 */
export const OTEL_SERVICE_VERSION_ENV = 'OTEL_SERVICE_VERSION';

/**
 * Standard OpenTelemetry env var for the OTLP exporter endpoint. Recognised
 * directly by the OTLP exporters - listed here so callers can discover which
 * env vars the integration honours.
 */
export const OTEL_EXPORTER_OTLP_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/**
 * Standard OpenTelemetry env var for OTLP exporter headers. Recognised
 * directly by the OTLP exporters - listed here for documentation.
 */
export const OTEL_EXPORTER_OTLP_HEADERS_ENV = 'OTEL_EXPORTER_OTLP_HEADERS';

/**
 * Standard OpenTelemetry env var for the OTLP transport protocol
 * (`http/protobuf`, `http/json`, etc.). The OTLP HTTP exporters handle this
 * automatically; we expose the constant for documentation.
 */
export const OTEL_EXPORTER_OTLP_PROTOCOL_ENV = 'OTEL_EXPORTER_OTLP_PROTOCOL';

/**
 * Standard OpenTelemetry env var selecting the metrics exporter. Recognised
 * values (case-insensitive): `otlp` (default), `prometheus`, `none`. Unknown
 * or empty values fall back to {@link DEFAULT_METRICS_EXPORTER}.
 */
export const OTEL_METRICS_EXPORTER_ENV = 'OTEL_METRICS_EXPORTER';

/**
 * Standard OpenTelemetry env var for the host the Prometheus pull endpoint
 * binds to. Only consulted when {@link OTEL_METRICS_EXPORTER_ENV} is
 * `prometheus`. Defaults to {@link DEFAULT_PROMETHEUS_HOST}.
 */
export const OTEL_EXPORTER_PROMETHEUS_HOST_ENV = 'OTEL_EXPORTER_PROMETHEUS_HOST';

/**
 * Standard OpenTelemetry env var for the port the Prometheus pull endpoint
 * listens on. Only consulted when {@link OTEL_METRICS_EXPORTER_ENV} is
 * `prometheus`. Defaults to {@link DEFAULT_PROMETHEUS_PORT}.
 */
export const OTEL_EXPORTER_PROMETHEUS_PORT_ENV = 'OTEL_EXPORTER_PROMETHEUS_PORT';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

function parseBool(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) {
    return true;
  }
  if (FALSY.has(v)) {
    return false;
  }
  return false;
}

/**
 * Default `service.name` when neither the config nor the env supplies one.
 */
export const DEFAULT_SERVICE_NAME = '@inference-gateway/adk';

/**
 * Default `service.version` when neither the config nor the env supplies one.
 */
export const DEFAULT_SERVICE_VERSION = '0.0.0';

/**
 * Default metrics exporter - OTLP push, preserving the pre-existing behaviour.
 */
export const DEFAULT_METRICS_EXPORTER: MetricsExporter = 'otlp';

/**
 * Default bind host for the Prometheus pull endpoint. Binds all interfaces so a
 * sidecar or cluster scraper can reach it; matches the sibling
 * {@link import('../metrics/config.js').DEFAULT_METRICS_HOST}.
 */
export const DEFAULT_PROMETHEUS_HOST = '0.0.0.0';

/**
 * Default TCP port for the Prometheus pull endpoint. `9464` is the
 * OpenTelemetry-conventional Prometheus exporter port, distinct from the
 * standalone prom-client metrics server's `9090` so both can run side by side.
 */
export const DEFAULT_PROMETHEUS_PORT = 9464;

function parseMetricsExporter(raw: string | undefined): MetricsExporter {
  switch (raw?.trim().toLowerCase()) {
    case 'prometheus':
      return 'prometheus';
    case 'none':
      return 'none';
    case 'otlp':
      return 'otlp';
    default:
      return DEFAULT_METRICS_EXPORTER;
  }
}

function nonEmpty(raw: string | undefined, fallback: string): string {
  return raw !== undefined && raw.length > 0 ? raw : fallback;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    return fallback;
  }
  return n;
}

/**
 * Read telemetry configuration from an environment-shaped map (defaults to
 * `process.env`). Recognised keys:
 *
 * - {@link TELEMETRY_ENABLE_ENV} - bool, default `false`
 * - {@link OTEL_SERVICE_NAME_ENV} - service name, default {@link DEFAULT_SERVICE_NAME}
 * - {@link OTEL_SERVICE_VERSION_ENV} - service version, default {@link DEFAULT_SERVICE_VERSION}
 * - {@link OTEL_METRICS_EXPORTER_ENV} - `otlp`/`prometheus`/`none`, default {@link DEFAULT_METRICS_EXPORTER}
 * - {@link OTEL_EXPORTER_PROMETHEUS_HOST_ENV} - Prometheus bind host, default {@link DEFAULT_PROMETHEUS_HOST}
 * - {@link OTEL_EXPORTER_PROMETHEUS_PORT_ENV} - Prometheus bind port, default {@link DEFAULT_PROMETHEUS_PORT}
 *
 * The OTLP exporter env vars ({@link OTEL_EXPORTER_OTLP_ENDPOINT_ENV},
 * {@link OTEL_EXPORTER_OTLP_HEADERS_ENV},
 * {@link OTEL_EXPORTER_OTLP_PROTOCOL_ENV}) are consumed directly by the
 * exporters - this function does not pre-parse them.
 */
export function loadTelemetryConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): TelemetryConfig {
  return {
    enable: parseBool(env[TELEMETRY_ENABLE_ENV]),
    serviceName: env[OTEL_SERVICE_NAME_ENV] ?? DEFAULT_SERVICE_NAME,
    serviceVersion: env[OTEL_SERVICE_VERSION_ENV] ?? DEFAULT_SERVICE_VERSION,
    metricsExporter: parseMetricsExporter(env[OTEL_METRICS_EXPORTER_ENV]),
    prometheusHost: nonEmpty(
      env[OTEL_EXPORTER_PROMETHEUS_HOST_ENV],
      DEFAULT_PROMETHEUS_HOST
    ),
    prometheusPort: parsePort(
      env[OTEL_EXPORTER_PROMETHEUS_PORT_ENV],
      DEFAULT_PROMETHEUS_PORT
    ),
  };
}
