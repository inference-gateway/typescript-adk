/**
 * MCP client configuration. Mirrors the Go ADK's optional MCP client
 * (`inference-gateway/adk` PR #251, `docs/mcp.md`) so an agent behaves the same
 * whether it is implemented in Go or TypeScript.
 *
 * Everything is disabled by default: {@link MCPConfig.enable} is `false` unless
 * `MCP_ENABLE` is truthy, and {@link loadMCPConfigFromEnv} returns a config with
 * an empty {@link MCPConfig.servers} list when `MCP_SERVERS` is unset. Callers
 * should treat "enabled with no servers" as a no-op.
 */
export interface MCPConfig {
  /** Master switch. Defaults to `false` (`MCP_ENABLE`). */
  readonly enable: boolean;
  /** MCP server base URLs (`MCP_SERVERS`, comma-separated). */
  readonly servers: readonly string[];
  /** Path appended to each server URL (`MCP_ENDPOINT`). Default `/mcp`. */
  readonly endpoint: string;
  /** Tool-catalog refresh interval in ms (`MCP_REFRESH_INTERVAL`). Default 5m. */
  readonly refreshIntervalMs: number;
  /** Init/list-tools timeout in ms (`MCP_DIAL_TIMEOUT`). Default 30s. */
  readonly dialTimeoutMs: number;
  /** Single tool-invocation timeout in ms (`MCP_CALL_TIMEOUT`). Default 30s. */
  readonly callTimeoutMs: number;
  /**
   * Max initial connection attempts per server (`MCP_MAX_RETRIES`). `0` means
   * retry forever. Default `0`.
   */
  readonly maxRetries: number;
  /** Initial connection backoff in ms (`MCP_RETRY_INTERVAL`). Doubles. Default 2s. */
  readonly retryIntervalMs: number;
  /** Upper bound on connection backoff in ms (`MCP_RETRY_MAX_INTERVAL`). Default 30s. */
  readonly retryMaxIntervalMs: number;
}

export const MCP_ENABLE_ENV = 'MCP_ENABLE';
export const MCP_SERVERS_ENV = 'MCP_SERVERS';
export const MCP_ENDPOINT_ENV = 'MCP_ENDPOINT';
export const MCP_REFRESH_INTERVAL_ENV = 'MCP_REFRESH_INTERVAL';
export const MCP_DIAL_TIMEOUT_ENV = 'MCP_DIAL_TIMEOUT';
export const MCP_CALL_TIMEOUT_ENV = 'MCP_CALL_TIMEOUT';
export const MCP_MAX_RETRIES_ENV = 'MCP_MAX_RETRIES';
export const MCP_RETRY_INTERVAL_ENV = 'MCP_RETRY_INTERVAL';
export const MCP_RETRY_MAX_INTERVAL_ENV = 'MCP_RETRY_MAX_INTERVAL';

export const DEFAULT_MCP_ENDPOINT = '/mcp';
export const DEFAULT_MCP_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MCP_DIAL_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_MAX_RETRIES = 0;
export const DEFAULT_MCP_RETRY_INTERVAL_MS = 2_000;
export const DEFAULT_MCP_RETRY_MAX_INTERVAL_MS = 30_000;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function parseBool(raw: string | undefined): boolean {
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a Go-style duration string (`"5m"`, `"30s"`, `"1500ms"`, `"1m30s"`)
 * into milliseconds. Returns `fallback` for an empty, unset, or unparseable
 * value so a stray env var never crashes boot. Exported for testing.
 */
export function parseDurationMs(
  raw: string | undefined,
  fallback: number
): number {
  if (raw === undefined) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  let total = 0;
  let matched = false;
  // Sticky (`y`) anchors each match at lastIndex, so a long digit run with no
  // unit can't trigger the O(n^2) multi-start rescan CodeQL flags on the global
  // form - and it mirrors Go's contiguous number+unit parsing.
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/y;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    matched = true;
    total += Number(m[1]) * DURATION_UNIT_MS[m[2] as string]!;
  }
  return matched ? total : fallback;
}

function parseInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function parseServers(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read MCP configuration from an environment-shaped map (defaults to
 * `process.env`). All values fall back to the Go ADK defaults; see the field
 * docs on {@link MCPConfig}.
 */
export function loadMCPConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): MCPConfig {
  const endpointRaw = env[MCP_ENDPOINT_ENV];
  return {
    enable: parseBool(env[MCP_ENABLE_ENV]),
    servers: parseServers(env[MCP_SERVERS_ENV]),
    endpoint:
      endpointRaw !== undefined && endpointRaw.length > 0
        ? endpointRaw
        : DEFAULT_MCP_ENDPOINT,
    refreshIntervalMs: parseDurationMs(
      env[MCP_REFRESH_INTERVAL_ENV],
      DEFAULT_MCP_REFRESH_INTERVAL_MS
    ),
    dialTimeoutMs: parseDurationMs(
      env[MCP_DIAL_TIMEOUT_ENV],
      DEFAULT_MCP_DIAL_TIMEOUT_MS
    ),
    callTimeoutMs: parseDurationMs(
      env[MCP_CALL_TIMEOUT_ENV],
      DEFAULT_MCP_CALL_TIMEOUT_MS
    ),
    maxRetries: parseInteger(env[MCP_MAX_RETRIES_ENV], DEFAULT_MCP_MAX_RETRIES),
    retryIntervalMs: parseDurationMs(
      env[MCP_RETRY_INTERVAL_ENV],
      DEFAULT_MCP_RETRY_INTERVAL_MS
    ),
    retryMaxIntervalMs: parseDurationMs(
      env[MCP_RETRY_MAX_INTERVAL_ENV],
      DEFAULT_MCP_RETRY_MAX_INTERVAL_MS
    ),
  };
}
