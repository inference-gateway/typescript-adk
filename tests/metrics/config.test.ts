import { describe, expect, it } from 'vitest';
import {
  DEFAULT_METRICS_HOST,
  DEFAULT_METRICS_IDLE_TIMEOUT_MS,
  DEFAULT_METRICS_PATH,
  DEFAULT_METRICS_PORT,
  DEFAULT_METRICS_READ_TIMEOUT_MS,
  DEFAULT_METRICS_WRITE_TIMEOUT_MS,
  METRICS_ENABLE_ENV,
  METRICS_HOST_ENV,
  METRICS_IDLE_TIMEOUT_MS_ENV,
  METRICS_PATH_ENV,
  METRICS_PORT_ENV,
  METRICS_READ_TIMEOUT_MS_ENV,
  METRICS_WRITE_TIMEOUT_MS_ENV,
  loadMetricsConfigFromEnv,
} from '../../src/metrics/index.js';
import { TELEMETRY_ENABLE_ENV } from '../../src/telemetry/index.js';

describe('loadMetricsConfigFromEnv', () => {
  it('defaults to disabled with the standard port/host/path when env is empty', () => {
    expect(loadMetricsConfigFromEnv({})).toEqual({
      enable: false,
      port: DEFAULT_METRICS_PORT,
      host: DEFAULT_METRICS_HOST,
      path: DEFAULT_METRICS_PATH,
      readTimeoutMs: DEFAULT_METRICS_READ_TIMEOUT_MS,
      writeTimeoutMs: DEFAULT_METRICS_WRITE_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_METRICS_IDLE_TIMEOUT_MS,
      collectDefaultMetrics: true,
    });
  });

  it('METRICS_ENABLE truthy values turn the server on', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const cfg = loadMetricsConfigFromEnv({ [METRICS_ENABLE_ENV]: value });
      expect(cfg.enable, `value=${value}`).toBe(true);
    }
  });

  it('METRICS_ENABLE falsy values keep the server off', () => {
    for (const value of ['0', 'false', 'no', 'off', '', 'nonsense']) {
      const cfg = loadMetricsConfigFromEnv({ [METRICS_ENABLE_ENV]: value });
      expect(cfg.enable, `value=${value}`).toBe(false);
    }
  });

  it('falls back to TELEMETRY_ENABLE when METRICS_ENABLE is unset', () => {
    expect(
      loadMetricsConfigFromEnv({ [TELEMETRY_ENABLE_ENV]: 'true' }).enable
    ).toBe(true);
    expect(
      loadMetricsConfigFromEnv({ [TELEMETRY_ENABLE_ENV]: 'false' }).enable
    ).toBe(false);
  });

  it('METRICS_ENABLE takes precedence over TELEMETRY_ENABLE', () => {
    const cfg = loadMetricsConfigFromEnv({
      [METRICS_ENABLE_ENV]: 'false',
      [TELEMETRY_ENABLE_ENV]: 'true',
    });
    expect(cfg.enable).toBe(false);
  });

  it('reads METRICS_PORT/HOST/PATH overrides', () => {
    const cfg = loadMetricsConfigFromEnv({
      [METRICS_PORT_ENV]: '9999',
      [METRICS_HOST_ENV]: '127.0.0.1',
      [METRICS_PATH_ENV]: '/m',
    });
    expect(cfg.port).toBe(9999);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.path).toBe('/m');
  });

  it('accepts port 0 to request an OS-assigned port', () => {
    const cfg = loadMetricsConfigFromEnv({ [METRICS_PORT_ENV]: '0' });
    expect(cfg.port).toBe(0);
  });

  it('falls back to the default port on invalid METRICS_PORT', () => {
    for (const value of ['-1', '1.5', 'banana', '']) {
      const cfg = loadMetricsConfigFromEnv({ [METRICS_PORT_ENV]: value });
      expect(cfg.port, `value=${value}`).toBe(DEFAULT_METRICS_PORT);
    }
  });

  it('reads timeout overrides', () => {
    const cfg = loadMetricsConfigFromEnv({
      [METRICS_READ_TIMEOUT_MS_ENV]: '1500',
      [METRICS_WRITE_TIMEOUT_MS_ENV]: '7500',
      [METRICS_IDLE_TIMEOUT_MS_ENV]: '12000',
    });
    expect(cfg.readTimeoutMs).toBe(1500);
    expect(cfg.writeTimeoutMs).toBe(7500);
    expect(cfg.idleTimeoutMs).toBe(12000);
  });

  it('falls back to the default timeouts on invalid values', () => {
    const cfg = loadMetricsConfigFromEnv({
      [METRICS_READ_TIMEOUT_MS_ENV]: 'not-a-number',
      [METRICS_WRITE_TIMEOUT_MS_ENV]: '-5',
      [METRICS_IDLE_TIMEOUT_MS_ENV]: '0',
    });
    expect(cfg.readTimeoutMs).toBe(DEFAULT_METRICS_READ_TIMEOUT_MS);
    expect(cfg.writeTimeoutMs).toBe(DEFAULT_METRICS_WRITE_TIMEOUT_MS);
    expect(cfg.idleTimeoutMs).toBe(DEFAULT_METRICS_IDLE_TIMEOUT_MS);
  });
});
