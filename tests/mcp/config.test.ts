import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  DEFAULT_MCP_DIAL_TIMEOUT_MS,
  DEFAULT_MCP_ENDPOINT,
  DEFAULT_MCP_MAX_RETRIES,
  DEFAULT_MCP_REFRESH_INTERVAL_MS,
  DEFAULT_MCP_RETRY_INTERVAL_MS,
  DEFAULT_MCP_RETRY_MAX_INTERVAL_MS,
  MCP_ENABLED_ENV,
  MCP_ENDPOINT_ENV,
  MCP_MAX_RETRIES_ENV,
  MCP_REFRESH_INTERVAL_ENV,
  MCP_SERVERS_ENV,
  loadMCPConfigFromEnv,
  parseDurationMs,
} from '../../src/mcp/index.js';

describe('loadMCPConfigFromEnv', () => {
  it('defaults to disabled with Go ADK defaults when env is empty', () => {
    expect(loadMCPConfigFromEnv({})).toEqual({
      enable: false,
      servers: [],
      endpoint: DEFAULT_MCP_ENDPOINT,
      refreshIntervalMs: DEFAULT_MCP_REFRESH_INTERVAL_MS,
      dialTimeoutMs: DEFAULT_MCP_DIAL_TIMEOUT_MS,
      callTimeoutMs: DEFAULT_MCP_CALL_TIMEOUT_MS,
      maxRetries: DEFAULT_MCP_MAX_RETRIES,
      retryIntervalMs: DEFAULT_MCP_RETRY_INTERVAL_MS,
      retryMaxIntervalMs: DEFAULT_MCP_RETRY_MAX_INTERVAL_MS,
    });
  });

  it('parses truthy A2A_MCP_ENABLED values', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadMCPConfigFromEnv({ [MCP_ENABLED_ENV]: value }).enable).toBe(
        true
      );
    }
  });

  it('splits and trims comma-separated A2A_MCP_SERVERS, dropping blanks', () => {
    const config = loadMCPConfigFromEnv({
      [MCP_SERVERS_ENV]: ' http://a:8080 , ,http://b:9090 ',
    });
    expect(config.servers).toEqual(['http://a:8080', 'http://b:9090']);
  });

  it('honours A2A_MCP_ENDPOINT and falls back to the default on empty', () => {
    expect(
      loadMCPConfigFromEnv({ [MCP_ENDPOINT_ENV]: '/tools' }).endpoint
    ).toBe('/tools');
    expect(loadMCPConfigFromEnv({ [MCP_ENDPOINT_ENV]: '' }).endpoint).toBe(
      DEFAULT_MCP_ENDPOINT
    );
  });

  it('parses duration strings into milliseconds', () => {
    expect(
      loadMCPConfigFromEnv({ [MCP_REFRESH_INTERVAL_ENV]: '10m' })
        .refreshIntervalMs
    ).toBe(600_000);
  });

  it('keeps A2A_MCP_MAX_RETRIES=0 (retry forever) and rejects negatives', () => {
    expect(
      loadMCPConfigFromEnv({ [MCP_MAX_RETRIES_ENV]: '0' }).maxRetries
    ).toBe(0);
    expect(
      loadMCPConfigFromEnv({ [MCP_MAX_RETRIES_ENV]: '5' }).maxRetries
    ).toBe(5);
    expect(
      loadMCPConfigFromEnv({ [MCP_MAX_RETRIES_ENV]: '-3' }).maxRetries
    ).toBe(DEFAULT_MCP_MAX_RETRIES);
  });
});

describe('parseDurationMs', () => {
  it('parses single-unit durations', () => {
    expect(parseDurationMs('30s', 0)).toBe(30_000);
    expect(parseDurationMs('5m', 0)).toBe(300_000);
    expect(parseDurationMs('2s', 0)).toBe(2_000);
    expect(parseDurationMs('500ms', 0)).toBe(500);
    expect(parseDurationMs('1h', 0)).toBe(3_600_000);
  });

  it('parses combined durations like Go', () => {
    expect(parseDurationMs('1m30s', 0)).toBe(90_000);
  });

  it('returns the fallback for unset, empty, or unparseable input', () => {
    expect(parseDurationMs(undefined, 42)).toBe(42);
    expect(parseDurationMs('', 42)).toBe(42);
    expect(parseDurationMs('nonsense', 42)).toBe(42);
  });
});
