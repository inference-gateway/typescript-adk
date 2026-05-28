import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_NAME,
  DEFAULT_SERVICE_VERSION,
  OTEL_SERVICE_NAME_ENV,
  OTEL_SERVICE_VERSION_ENV,
  TELEMETRY_ENABLE_ENV,
  loadTelemetryConfigFromEnv,
} from '../../src/telemetry/index.js';

describe('loadTelemetryConfigFromEnv', () => {
  it('defaults to disabled with package defaults when env is empty', () => {
    const config = loadTelemetryConfigFromEnv({});
    expect(config).toEqual({
      enable: false,
      serviceName: DEFAULT_SERVICE_NAME,
      serviceVersion: DEFAULT_SERVICE_VERSION,
    });
  });

  it('parses truthy TELEMETRY_ENABLE values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const config = loadTelemetryConfigFromEnv({
        [TELEMETRY_ENABLE_ENV]: value,
      });
      expect(config.enable, `value=${value}`).toBe(true);
    }
  });

  it('parses falsy TELEMETRY_ENABLE values', () => {
    for (const value of ['0', 'false', 'no', 'off', '', 'nonsense']) {
      const config = loadTelemetryConfigFromEnv({
        [TELEMETRY_ENABLE_ENV]: value,
      });
      expect(config.enable, `value=${value}`).toBe(false);
    }
  });

  it('reads OTEL_SERVICE_NAME and OTEL_SERVICE_VERSION', () => {
    const config = loadTelemetryConfigFromEnv({
      [TELEMETRY_ENABLE_ENV]: 'true',
      [OTEL_SERVICE_NAME_ENV]: 'echo-agent',
      [OTEL_SERVICE_VERSION_ENV]: '2.4.0',
    });
    expect(config).toEqual({
      enable: true,
      serviceName: 'echo-agent',
      serviceVersion: '2.4.0',
    });
  });
});
