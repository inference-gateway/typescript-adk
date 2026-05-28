/**
 * Configuration for the Prometheus metrics endpoint. Mirrors the Go ADK's
 * `PrometheusConfig` in `adk/server/otel/otel.go` - a separate HTTP server
 * (default port `9090`) that exposes `/metrics` in the Prometheus text format.
 *
 * The endpoint is opt-in. {@link MetricsConfig.enable} is `false` by default
 * and is also gated by either {@link METRICS_ENABLE_ENV} or
 * {@link TELEMETRY_ENABLE_ENV} - whichever is set first wins, in the order
 * declared on {@link loadMetricsConfigFromEnv}.
 */
export interface MetricsConfig {
  /** Master switch. Server is not started when `false`. Defaults to `false`. */
  readonly enable: boolean;
  /**
   * TCP port for the metrics HTTP server. Defaults to {@link DEFAULT_METRICS_PORT}.
   * Pass `0` to let the OS pick an ephemeral port (handy in tests).
   */
  readonly port: number;
  /**
   * Host the metrics HTTP server binds to. Defaults to
   * {@link DEFAULT_METRICS_HOST}. Use `127.0.0.1` to keep metrics off the
   * public interface when the agent runs behind a sidecar scraper.
   */
  readonly host: string;
  /** Path the Prometheus exposition endpoint is mounted at. */
  readonly path: string;
  /**
   * Read timeout for the metrics server, in milliseconds. Applied to the
   * underlying Node HTTP server via `server.headersTimeout`. Defaults to
   * {@link DEFAULT_METRICS_READ_TIMEOUT_MS}.
   */
  readonly readTimeoutMs: number;
  /**
   * Write timeout for the metrics server, in milliseconds. Applied to the
   * underlying Node HTTP server via `server.requestTimeout`. Defaults to
   * {@link DEFAULT_METRICS_WRITE_TIMEOUT_MS}.
   */
  readonly writeTimeoutMs: number;
  /**
   * Idle (keep-alive) timeout for the metrics server, in milliseconds.
   * Applied to the underlying Node HTTP server via `server.keepAliveTimeout`.
   * Defaults to {@link DEFAULT_METRICS_IDLE_TIMEOUT_MS}.
   */
  readonly idleTimeoutMs: number;
  /**
   * When `true`, the registry collects Node.js default metrics
   * (process CPU/memory, event-loop lag, GC). Defaults to `true` - matches the
   * Go ADK's behaviour of exposing process-level metrics alongside the
   * domain-specific counters.
   */
  readonly collectDefaultMetrics: boolean;
}

/**
 * Environment variable that, when truthy, enables the metrics HTTP server.
 * Takes precedence over {@link TELEMETRY_ENABLE_ENV} when both are set.
 */
export const METRICS_ENABLE_ENV = 'METRICS_ENABLE';

/**
 * Shared kill-switch with the telemetry SDK - when truthy and
 * {@link METRICS_ENABLE_ENV} is unset, the metrics server also starts. This
 * mirrors the Go ADK's combined `TelemetryConfig.Enable` flag where one toggle
 * lights up both tracing and Prometheus.
 */
export const TELEMETRY_ENABLE_ENV = 'TELEMETRY_ENABLE';

/** Env var that overrides {@link MetricsConfig.port}. */
export const METRICS_PORT_ENV = 'METRICS_PORT';

/** Env var that overrides {@link MetricsConfig.host}. */
export const METRICS_HOST_ENV = 'METRICS_HOST';

/** Env var that overrides {@link MetricsConfig.path}. */
export const METRICS_PATH_ENV = 'METRICS_PATH';

/** Env var that overrides {@link MetricsConfig.readTimeoutMs}. */
export const METRICS_READ_TIMEOUT_MS_ENV = 'METRICS_READ_TIMEOUT_MS';

/** Env var that overrides {@link MetricsConfig.writeTimeoutMs}. */
export const METRICS_WRITE_TIMEOUT_MS_ENV = 'METRICS_WRITE_TIMEOUT_MS';

/** Env var that overrides {@link MetricsConfig.idleTimeoutMs}. */
export const METRICS_IDLE_TIMEOUT_MS_ENV = 'METRICS_IDLE_TIMEOUT_MS';

/**
 * Default TCP port for the metrics endpoint. Matches the de-facto Prometheus
 * scraping default and the Go ADK's `PrometheusConfig.Port`.
 */
export const DEFAULT_METRICS_PORT = 9090;

/** Default bind host. */
export const DEFAULT_METRICS_HOST = '0.0.0.0';

/** Default exposition path. */
export const DEFAULT_METRICS_PATH = '/metrics';

/** Default read timeout (5 seconds). */
export const DEFAULT_METRICS_READ_TIMEOUT_MS = 5_000;

/** Default write timeout (10 seconds). */
export const DEFAULT_METRICS_WRITE_TIMEOUT_MS = 10_000;

/** Default idle (keep-alive) timeout (60 seconds). */
export const DEFAULT_METRICS_IDLE_TIMEOUT_MS = 60_000;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return false;
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  allowZero = false
): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (allowZero ? n < 0 : n <= 0) return fallback;
  return n;
}

/**
 * Read metrics configuration from an environment-shaped map (defaults to
 * `process.env`). The `enable` flag falls back from {@link METRICS_ENABLE_ENV}
 * to {@link TELEMETRY_ENABLE_ENV}; everything else uses its own var with a
 * sensible default.
 */
export function loadMetricsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): MetricsConfig {
  const metricsEnable = parseBool(env[METRICS_ENABLE_ENV]);
  const telemetryEnable = parseBool(env[TELEMETRY_ENABLE_ENV]);
  const enable = metricsEnable ?? telemetryEnable ?? false;

  return {
    enable,
    port: parsePositiveInt(env[METRICS_PORT_ENV], DEFAULT_METRICS_PORT, true),
    host:
      env[METRICS_HOST_ENV] !== undefined && env[METRICS_HOST_ENV]!.length > 0
        ? env[METRICS_HOST_ENV]!
        : DEFAULT_METRICS_HOST,
    path:
      env[METRICS_PATH_ENV] !== undefined && env[METRICS_PATH_ENV]!.length > 0
        ? env[METRICS_PATH_ENV]!
        : DEFAULT_METRICS_PATH,
    readTimeoutMs: parsePositiveInt(
      env[METRICS_READ_TIMEOUT_MS_ENV],
      DEFAULT_METRICS_READ_TIMEOUT_MS
    ),
    writeTimeoutMs: parsePositiveInt(
      env[METRICS_WRITE_TIMEOUT_MS_ENV],
      DEFAULT_METRICS_WRITE_TIMEOUT_MS
    ),
    idleTimeoutMs: parsePositiveInt(
      env[METRICS_IDLE_TIMEOUT_MS_ENV],
      DEFAULT_METRICS_IDLE_TIMEOUT_MS
    ),
    collectDefaultMetrics: true,
  };
}
