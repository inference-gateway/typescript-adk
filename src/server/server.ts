import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Authenticator } from '../auth/index.js';
import type { AgentCard } from '../types/generated/a2a.js';
import {
  GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
  createGetAuthenticatedExtendedCardHandler,
} from './agent-extended-card.js';
import {
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  JSONRPCError,
  createErrorResponse,
  dispatch,
  type JSONRPCId,
  type JSONRPCResponse,
} from './jsonrpc.js';
import { MethodRegistry, type MethodHandler } from './method-registry.js';
import type { StreamingMethodHandler } from './message-stream.js';
import { SSE_HEADERS } from './sse.js';

/**
 * Path of the unauthenticated agent card discovery endpoint, per the A2A
 * discovery convention.
 */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

/**
 * Path of the liveness endpoint. Returns `{ status: "healthy" }` whenever the
 * HTTP listener is up - independent of registered methods.
 */
export const HEALTH_PATH = '/health';

/**
 * Default mount point for the JSON-RPC endpoint. Override via
 * {@link A2AServerConfig.jsonRpcPath} when fronting the agent behind a
 * gateway that needs a more specific path.
 */
export const DEFAULT_JSONRPC_PATH = '/';

/**
 * Default `Cache-Control` header applied to the agent card response. A short
 * positive TTL keeps clients from re-fetching on every interaction while still
 * letting card updates propagate within a minute.
 */
export const DEFAULT_AGENT_CARD_CACHE_CONTROL = 'public, max-age=60';

export interface A2AServerConfig {
  /**
   * The public agent card. Served verbatim from the discovery endpoint, so it
   * must not contain auth metadata intended only for the authenticated
   * extended card.
   */
  readonly card: AgentCard;
  /**
   * Optional extended agent card returned to authenticated callers via the
   * `agent/getAuthenticatedExtendedCard` JSON-RPC method. When provided, the
   * server auto-registers that method; when omitted, the method is not
   * registered and calls receive `-32601 method not found`.
   *
   * The extended card typically wraps {@link card} and adds auth schemes plus
   * any capabilities the agent only exposes after authentication. Pair this
   * with an enabled {@link authenticator} so the method is actually gated -
   * registering it with no authenticator allows anonymous callers to fetch
   * the extended card.
   */
  readonly extendedCard?: AgentCard;
  /**
   * Value for the `Cache-Control` header on the agent card response. Defaults
   * to {@link DEFAULT_AGENT_CARD_CACHE_CONTROL}.
   */
  readonly cacheControl?: string;
  /**
   * Path the JSON-RPC endpoint is mounted at. Defaults to
   * {@link DEFAULT_JSONRPC_PATH}.
   */
  readonly jsonRpcPath?: string;
  /**
   * Optional authenticator. When provided and `enabled`, its middleware is
   * applied to the JSON-RPC endpoint (`POST <jsonRpcPath>`). The agent card
   * discovery (`GET /.well-known/agent-card.json`) and health
   * (`GET /health`) endpoints are intentionally left unauthenticated so
   * clients can discover the agent before negotiating credentials.
   *
   * A disabled or omitted authenticator is a zero-overhead no-op.
   */
  readonly authenticator?: Authenticator;
}

type NodeServer = Server;

/**
 * Minimal HTTP server core for an A2A agent. Exposes:
 *
 * - `GET /.well-known/agent-card.json` - unauthenticated card discovery
 * - `GET /health` - liveness probe
 * - `POST <jsonRpcPath>` - JSON-RPC 2.0 endpoint dispatched via the
 *   per-instance {@link MethodRegistry}
 *
 * Deliberately decoupled from the LLM agent - a server with no methods
 * registered still serves discovery and health.
 */
export class A2AServer {
  private readonly card: AgentCard;
  private readonly cacheControl: string;
  private readonly jsonRpcPath: string;
  private readonly authenticator: Authenticator | undefined;
  private readonly registry = new MethodRegistry();
  private readonly streamingRegistry = new Map<
    string,
    StreamingMethodHandler
  >();
  private readonly app: Hono;
  private readonly httpServer: NodeServer;

  constructor(config: A2AServerConfig) {
    this.card = config.card;
    this.cacheControl = config.cacheControl ?? DEFAULT_AGENT_CARD_CACHE_CONTROL;
    this.jsonRpcPath = config.jsonRpcPath ?? DEFAULT_JSONRPC_PATH;
    this.authenticator = config.authenticator;

    if (config.extendedCard !== undefined) {
      this.registry.register(
        GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
        createGetAuthenticatedExtendedCardHandler({
          card: config.extendedCard,
        })
      );
    }

    this.app = this.buildApp();
    this.httpServer = createAdaptorServer({
      fetch: this.app.fetch,
    }) as NodeServer;
  }

  private buildApp(): Hono {
    const app = new Hono();

    app.get(AGENT_CARD_PATH, () => {
      return new Response(JSON.stringify(this.card), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': this.cacheControl,
        },
      });
    });

    app.get(HEALTH_PATH, (c) => c.json({ status: 'healthy' }));

    if (this.authenticator !== undefined && this.authenticator.enabled) {
      app.use(this.jsonRpcPath, this.authenticator.middleware());
    }

    app.post(this.jsonRpcPath, async (c) => {
      const body = await c.req.text();
      const signal = c.req.raw.signal;

      const streamingResponse = this.tryDispatchStreaming(body, signal);
      if (streamingResponse !== null) {
        return streamingResponse;
      }

      const result = await dispatch(body, this.registry, signal);
      if (result === null) {
        return new Response(null, { status: 204 });
      }
      return c.json(result as JSONRPCResponse | JSONRPCResponse[]);
    });

    app.notFound((c) => c.json({ error: 'Not Found' }, 404));

    return app;
  }

  /**
   * Register a handler for a JSON-RPC method. Replaces any prior handler for
   * the same name. Throws if `name` is empty.
   */
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: MethodHandler<P, R>
  ): void {
    this.registry.register(name, handler);
  }

  /**
   * Register a handler for a JSON-RPC method whose response is an SSE event
   * stream rather than a single JSON-RPC result envelope. The server detects
   * streaming methods by name and routes them through an SSE response (status
   * 200, `Content-Type: text/event-stream`), bypassing the regular dispatch
   * pipeline.
   *
   * A streaming method may not share a name with a regular method registered
   * via {@link registerMethod} - if both exist, the streaming path wins.
   */
  registerStreamingMethod(name: string, handler: StreamingMethodHandler): void {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('method name must be a non-empty string');
    }
    this.streamingRegistry.set(name, handler);
  }

  /**
   * Remove a previously registered handler. Returns `true` if one was
   * removed, `false` if no handler existed for that name. Removes the handler
   * regardless of whether it was registered via {@link registerMethod} or
   * {@link registerStreamingMethod}.
   */
  unregisterMethod(name: string): boolean {
    const streamingRemoved = this.streamingRegistry.delete(name);
    const standardRemoved = this.registry.unregister(name);
    return streamingRemoved || standardRemoved;
  }

  /**
   * Whether a handler is currently registered for `name`. Includes both
   * regular and streaming methods.
   */
  hasMethod(name: string): boolean {
    return this.registry.has(name) || this.streamingRegistry.has(name);
  }

  /**
   * Names of all currently registered methods. Useful for diagnostics and
   * tests; do not depend on iteration order. Includes both regular and
   * streaming methods.
   */
  registeredMethods(): string[] {
    const names = new Set<string>(this.registry.list());
    for (const name of this.streamingRegistry.keys()) {
      names.add(name);
    }
    return [...names];
  }

  private tryDispatchStreaming(
    rawBody: string,
    signal: AbortSignal
  ): Response | null {
    if (this.streamingRegistry.size === 0) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const reqObj = parsed as Record<string, unknown>;
    const method = reqObj['method'];
    if (typeof method !== 'string' || !this.streamingRegistry.has(method)) {
      return null;
    }
    const handler = this.streamingRegistry.get(method);
    if (handler === undefined) {
      return null;
    }
    if (reqObj['jsonrpc'] !== JSONRPC_VERSION) {
      return null;
    }
    const id = extractStreamingId(reqObj);
    const params = 'params' in reqObj ? reqObj['params'] : undefined;
    try {
      const { readable } = handler(params, { signal });
      return new Response(readable, {
        status: 200,
        headers: { ...SSE_HEADERS },
      });
    } catch (err) {
      if (err instanceof JSONRPCError) {
        return jsonResponse(
          createErrorResponse(id, err.code, err.message, err.data)
        );
      }
      return jsonResponse(
        createErrorResponse(
          id,
          JSONRPC_ERROR_CODES.INTERNAL_ERROR,
          'internal error'
        )
      );
    }
  }

  /**
   * Begin listening on the given port and (optional) host. Resolves once the
   * underlying HTTP server emits `listening`, or rejects on a startup error.
   *
   * Pass port `0` to let the OS pick an ephemeral port - useful in tests.
   */
  listen(port: number, host?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.httpServer.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      if (host !== undefined) {
        this.httpServer.listen(port, host);
      } else {
        this.httpServer.listen(port);
      }
    });
  }

  /**
   * Stop accepting new connections and wait for in-flight requests to drain.
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.close((err?: Error | undefined) => {
        if (err !== undefined && err !== null) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Address of the listening socket, or `null` if the server is not listening
   * on a TCP socket.
   */
  address(): AddressInfo | null {
    const addr = this.httpServer.address();
    if (addr === null || typeof addr === 'string') {
      return null;
    }
    return addr;
  }
}

/**
 * Convenience factory equivalent to `new A2AServer(config)`.
 */
export function createA2AServer(config: A2AServerConfig): A2AServer {
  return new A2AServer(config);
}

function extractStreamingId(reqObj: Record<string, unknown>): JSONRPCId {
  if (!('id' in reqObj)) {
    return null;
  }
  const raw = reqObj['id'];
  if (raw === null || typeof raw === 'string' || typeof raw === 'number') {
    return raw;
  }
  return null;
}

function jsonResponse(body: JSONRPCResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
