import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { NOOP_LOGGER, type Logger } from '../logging/index.js';
import type { Struct } from '../types/generated/a2a.js';
import { loadMCPConfigFromEnv, type MCPConfig } from './config.js';

/**
 * A single tool discovered on an MCP server, flattened into the shape the
 * selector tools ({@link import('./tools.js')}) surface to the LLM. `server` is
 * the base URL the tool lives on, used to disambiguate same-named tools across
 * servers.
 */
export interface DiscoveredMCPTool {
  readonly server: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Struct;
}

/** Arguments accepted by {@link MCPToolProvider.callTool}. */
export interface MCPCallToolInput {
  /** Tool name to invoke. */
  readonly name: string;
  /** Optional server base URL to disambiguate a name exposed by several servers. */
  readonly server?: string;
  /** Arguments object forwarded to the MCP tool. */
  readonly arguments?: Record<string, unknown>;
}

/**
 * Read side of the MCP client consumed by the `mcp_list_tools` /
 * `mcp_call_tool` selector tools. Kept as its own interface so tests can supply
 * a fake without standing up a real transport.
 */
export interface MCPToolProvider {
  /**
   * Snapshot of every discovered tool, optionally filtered by a
   * case-insensitive substring match on name or description.
   */
  listTools(search?: string): readonly DiscoveredMCPTool[];
  /**
   * Invoke a discovered tool and return a JSON string suitable for feeding back
   * to the LLM as a `tool` message. Never rejects for an unknown tool - it
   * returns a JSON error payload instead so the model can recover.
   */
  callTool(input: MCPCallToolInput, signal?: AbortSignal): Promise<string>;
}

/** Construction options for {@link MCPClient}. */
export interface MCPClientOptions {
  /** Structured logger. Defaults to {@link NOOP_LOGGER}. */
  readonly logger?: Logger;
  /**
   * Client identity advertised to MCP servers on connect. Defaults to
   * `@inference-gateway/adk`.
   */
  readonly clientName?: string;
  /** Client version advertised to MCP servers. Defaults to `0.0.0`. */
  readonly clientVersion?: string;
}

interface ServerState {
  client: Client | undefined;
  tools: DiscoveredMCPTool[];
}

const RETRY_FOREVER = 0;

/**
 * Optional MCP client mirroring the Go ADK's (`inference-gateway/adk` #251).
 *
 * Connects to one or more MCP servers over the official SDK's Streamable HTTP
 * transport, discovers their tools in the background, and refreshes the catalog
 * on {@link MCPConfig.refreshIntervalMs}. Listing returns from an in-memory
 * snapshot so the hot path never blocks on a network round-trip, and a server
 * that is down or slow never drops the catalog of the healthy ones.
 *
 * Register the selector tools onto an agent toolbox with
 * {@link import('./tools.js').registerMCPTools} rather than exposing every
 * discovered tool to the LLM directly - see the module docs.
 *
 * ponytail: refresh failures keep the last-good snapshot for that server and
 * retry on the next interval (no separate growing poll-backoff, and no
 * reconnect of a dropped session mid-run). Upgrade path: add a per-server
 * poll-backoff + reconnect loop if flapping servers prove noisy in practice.
 */
export class MCPClient implements MCPToolProvider {
  private readonly config: MCPConfig;
  private readonly logger: Logger;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly servers = new Map<string, ServerState>();
  private readonly stopController = new AbortController();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(config: MCPConfig, options: MCPClientOptions = {}) {
    this.config = config;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.clientName = options.clientName ?? '@inference-gateway/adk';
    this.clientVersion = options.clientVersion ?? '0.0.0';
    for (const server of config.servers) {
      this.servers.set(server, { client: undefined, tools: [] });
    }
  }

  /**
   * Kick off background connection + discovery for every configured server and
   * arm the refresh timer. Non-blocking: returns immediately while connections
   * are still being established. Calling more than once is a no-op.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.config.servers.length === 0) {
      this.logger.warn('mcp client started with no servers configured');
      return;
    }
    for (const server of this.config.servers) {
      void this.connectWithRetry(server);
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
    }, this.config.refreshIntervalMs);
    // Never keep the event loop alive just for the refresh tick.
    this.refreshTimer.unref?.();
  }

  /**
   * Abort in-flight connection retries, stop the refresh timer, and close every
   * open MCP session. Safe to call when never started.
   */
  async stop(): Promise<void> {
    this.stopController.abort();
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    const closes: Promise<void>[] = [];
    for (const state of this.servers.values()) {
      if (state.client !== undefined) {
        closes.push(state.client.close().catch(() => undefined));
        state.client = undefined;
      }
    }
    await Promise.all(closes);
  }

  /** {@link MCPToolProvider.listTools} */
  listTools(search?: string): readonly DiscoveredMCPTool[] {
    const all: DiscoveredMCPTool[] = [];
    for (const state of this.servers.values()) {
      all.push(...state.tools);
    }
    const needle = search?.trim().toLowerCase();
    if (needle === undefined || needle.length === 0) {
      return all;
    }
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        t.description.toLowerCase().includes(needle)
    );
  }

  /** {@link MCPToolProvider.callTool} */
  async callTool(
    input: MCPCallToolInput,
    signal?: AbortSignal
  ): Promise<string> {
    const match = this.findTool(input.name, input.server);
    if (match === undefined) {
      return JSON.stringify({
        isError: true,
        error: `mcp tool "${input.name}" not found${input.server !== undefined ? ` on server "${input.server}"` : ''}`,
      });
    }
    const client = this.servers.get(match.server)?.client;
    if (client === undefined) {
      return JSON.stringify({
        isError: true,
        error: `mcp server "${match.server}" is not connected`,
      });
    }
    try {
      const result = await client.callTool(
        { name: match.name, arguments: input.arguments ?? {} },
        undefined,
        {
          timeout: this.config.callTimeoutMs,
          ...(signal !== undefined ? { signal } : {}),
        }
      );
      return JSON.stringify({
        server: match.server,
        name: match.name,
        isError: result['isError'] === true,
        content: result['content'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn('mcp tool call failed', {
        server: match.server,
        tool: match.name,
        error: message,
      });
      return JSON.stringify({
        server: match.server,
        name: match.name,
        isError: true,
        error: message,
      });
    }
  }

  /**
   * Build the transport used to reach `url`. Streamable HTTP by default;
   * overridable so tests can substitute an in-memory transport.
   *
   * The SDK types `Transport.sessionId` as `string` while the concrete
   * transport exposes `string | undefined`; the cast bridges that under our
   * exactOptionalPropertyTypes and is otherwise a no-op.
   */
  protected createTransport(url: URL): Transport {
    return new StreamableHTTPClientTransport(url) as unknown as Transport;
  }

  private findTool(
    name: string,
    server: string | undefined
  ): DiscoveredMCPTool | undefined {
    if (server !== undefined) {
      return this.servers.get(server)?.tools.find((t) => t.name === name);
    }
    for (const state of this.servers.values()) {
      const found = state.tools.find((t) => t.name === name);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  private async connectWithRetry(baseUrl: string): Promise<void> {
    const { maxRetries, retryIntervalMs, retryMaxIntervalMs } = this.config;
    let attempt = 0;
    let delay = retryIntervalMs;
    while (!this.stopController.signal.aborted) {
      try {
        const client = new Client(
          { name: this.clientName, version: this.clientVersion },
          { capabilities: {} }
        );
        const transport = this.createTransport(
          new URL(joinEndpoint(baseUrl, this.config.endpoint))
        );
        await client.connect(transport, { timeout: this.config.dialTimeoutMs });
        const state = this.servers.get(baseUrl);
        if (state === undefined) {
          await client.close().catch(() => undefined);
          return;
        }
        state.client = client;
        this.logger.info('mcp server connected', { server: baseUrl });
        await this.refreshServer(baseUrl);
        return;
      } catch (err) {
        attempt++;
        const message = err instanceof Error ? err.message : String(err);
        if (maxRetries !== RETRY_FOREVER && attempt >= maxRetries) {
          this.logger.error('mcp server connection gave up', {
            server: baseUrl,
            attempts: attempt,
            error: message,
          });
          return;
        }
        this.logger.warn('mcp server connection failed, retrying', {
          server: baseUrl,
          attempt,
          delayMs: delay,
          error: message,
        });
        await sleep(delay, this.stopController.signal);
        delay = Math.min(delay * 2, retryMaxIntervalMs);
      }
    }
  }

  private async refreshAll(): Promise<void> {
    for (const baseUrl of this.servers.keys()) {
      await this.refreshServer(baseUrl);
    }
  }

  private async refreshServer(baseUrl: string): Promise<void> {
    const state = this.servers.get(baseUrl);
    if (state?.client === undefined) {
      return;
    }
    try {
      const result = await state.client.listTools(undefined, {
        timeout: this.config.dialTimeoutMs,
        signal: this.stopController.signal,
      });
      state.tools = result.tools.map((t) => ({
        server: baseUrl,
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema as Struct,
      }));
    } catch (err) {
      if (this.stopController.signal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Keep the last-good snapshot so one failing server never blanks the
      // catalog of the healthy ones.
      this.logger.warn('mcp tool refresh failed, keeping last snapshot', {
        server: baseUrl,
        error: message,
      });
    }
  }
}

/**
 * Append `endpoint` to `baseUrl`, collapsing a duplicate slash at the join.
 * Mirrors the Go ADK's "path appended to each server URL" semantics rather than
 * `new URL(endpoint, base)`, which would discard any base path.
 */
export function joinEndpoint(baseUrl: string, endpoint: string): string {
  // Trim trailing slashes with an O(n) walk rather than /\/+$/, which CodeQL
  // flags as polynomial-backtracking on adversarial input.
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') {
    end--;
  }
  const base = baseUrl.slice(0, end);
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${path}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Construct an {@link MCPClient} from environment configuration, or return
 * `undefined` when MCP is disabled (`MCP_ENABLE` falsy) or no servers are
 * configured. Does NOT call {@link MCPClient.start} - the caller decides when to
 * begin background discovery.
 */
export function createMCPClientFromEnv(
  options: MCPClientOptions & {
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {}
): MCPClient | undefined {
  const { env, ...clientOptions } = options;
  const config = loadMCPConfigFromEnv(env);
  if (!config.enable || config.servers.length === 0) {
    return undefined;
  }
  return new MCPClient(config, clientOptions);
}
