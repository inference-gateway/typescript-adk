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
}

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
 * Read telemetry configuration from an environment-shaped map (defaults to
 * `process.env`). Recognised keys:
 *
 * - {@link TELEMETRY_ENABLE_ENV} - bool, default `false`
 * - {@link OTEL_SERVICE_NAME_ENV} - service name, default {@link DEFAULT_SERVICE_NAME}
 * - {@link OTEL_SERVICE_VERSION_ENV} - service version, default {@link DEFAULT_SERVICE_VERSION}
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
  };
}
