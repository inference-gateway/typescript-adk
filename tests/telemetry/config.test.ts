import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METRICS_EXPORTER,
  DEFAULT_PROMETHEUS_HOST,
  DEFAULT_PROMETHEUS_PORT,
  DEFAULT_SERVICE_NAME,
  DEFAULT_SERVICE_VERSION,
  OTEL_EXPORTER_PROMETHEUS_HOST_ENV,
  OTEL_EXPORTER_PROMETHEUS_PORT_ENV,
  OTEL_METRICS_EXPORTER_ENV,
  OTEL_SERVICE_NAME_ENV,
  OTEL_SERVICE_VERSION_ENV,
  TELEMETRY_ENABLED_ENV,
  loadTelemetryConfigFromEnv,
} from '../../src/telemetry/index.js';

describe('loadTelemetryConfigFromEnv', () => {
  it('defaults to disabled with package defaults when env is empty', () => {
    const config = loadTelemetryConfigFromEnv({});
    expect(config).toEqual({
      enable: false,
      serviceName: DEFAULT_SERVICE_NAME,
      serviceVersion: DEFAULT_SERVICE_VERSION,
      metricsExporter: DEFAULT_METRICS_EXPORTER,
      prometheusHost: DEFAULT_PROMETHEUS_HOST,
      prometheusPort: DEFAULT_PROMETHEUS_PORT,
    });
  });

  it('parses truthy TELEMETRY_ENABLED values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const config = loadTelemetryConfigFromEnv({
        [TELEMETRY_ENABLED_ENV]: value,
      });
      expect(config.enable, `value=${value}`).toBe(true);
    }
  });

  it('parses falsy TELEMETRY_ENABLED values', () => {
    for (const value of ['0', 'false', 'no', 'off', '', 'nonsense']) {
      const config = loadTelemetryConfigFromEnv({
        [TELEMETRY_ENABLED_ENV]: value,
      });
      expect(config.enable, `value=${value}`).toBe(false);
    }
  });

  it('reads OTEL_SERVICE_NAME and OTEL_SERVICE_VERSION', () => {
    const config = loadTelemetryConfigFromEnv({
      [TELEMETRY_ENABLED_ENV]: 'true',
      [OTEL_SERVICE_NAME_ENV]: 'echo-agent',
      [OTEL_SERVICE_VERSION_ENV]: '2.4.0',
    });
    expect(config).toEqual({
      enable: true,
      serviceName: 'echo-agent',
      serviceVersion: '2.4.0',
      metricsExporter: DEFAULT_METRICS_EXPORTER,
      prometheusHost: DEFAULT_PROMETHEUS_HOST,
      prometheusPort: DEFAULT_PROMETHEUS_PORT,
    });
  });
});

describe('loadTelemetryConfigFromEnv metrics exporter selection', () => {
  it('defaults the metrics exporter to otlp', () => {
    expect(loadTelemetryConfigFromEnv({}).metricsExporter).toBe('otlp');
  });

  it('parses otlp / prometheus / none case-insensitively', () => {
    const cases: Array<[string, 'otlp' | 'prometheus' | 'none']> = [
      ['otlp', 'otlp'],
      ['prometheus', 'prometheus'],
      ['Prometheus', 'prometheus'],
      ['  PROMETHEUS ', 'prometheus'],
      ['none', 'none'],
      ['NONE', 'none'],
    ];
    for (const [value, expected] of cases) {
      const config = loadTelemetryConfigFromEnv({
        [OTEL_METRICS_EXPORTER_ENV]: value,
      });
      expect(config.metricsExporter, `value=${value}`).toBe(expected);
    }
  });

  it('falls back to otlp for unknown or empty exporter values', () => {
    for (const value of ['', '   ', 'jaeger', 'console']) {
      const config = loadTelemetryConfigFromEnv({
        [OTEL_METRICS_EXPORTER_ENV]: value,
      });
      expect(config.metricsExporter, `value=${value}`).toBe('otlp');
    }
  });

  it('reads the Prometheus host and port', () => {
    const config = loadTelemetryConfigFromEnv({
      [OTEL_METRICS_EXPORTER_ENV]: 'prometheus',
      [OTEL_EXPORTER_PROMETHEUS_HOST_ENV]: '127.0.0.1',
      [OTEL_EXPORTER_PROMETHEUS_PORT_ENV]: '9999',
    });
    expect(config.prometheusHost).toBe('127.0.0.1');
    expect(config.prometheusPort).toBe(9999);
  });

  it('allows port 0 for an OS-assigned ephemeral port', () => {
    const config = loadTelemetryConfigFromEnv({
      [OTEL_EXPORTER_PROMETHEUS_PORT_ENV]: '0',
    });
    expect(config.prometheusPort).toBe(0);
  });

  it('falls back to the default port for invalid / out-of-range values', () => {
    for (const value of ['', 'abc', '-1', '70000', '9464.5']) {
      const config = loadTelemetryConfigFromEnv({
        [OTEL_EXPORTER_PROMETHEUS_PORT_ENV]: value,
      });
      expect(config.prometheusPort, `value=${value}`).toBe(
        DEFAULT_PROMETHEUS_PORT
      );
    }
  });

  it('falls back to the default host when unset or empty', () => {
    expect(
      loadTelemetryConfigFromEnv({
        [OTEL_EXPORTER_PROMETHEUS_HOST_ENV]: '',
      }).prometheusHost
    ).toBe(DEFAULT_PROMETHEUS_HOST);
    expect(loadTelemetryConfigFromEnv({}).prometheusHost).toBe(
      DEFAULT_PROMETHEUS_HOST
    );
  });
});
