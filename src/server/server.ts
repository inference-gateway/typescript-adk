import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ArtifactStorageProvider } from '../artifacts/artifact-storage.js';
import type { Authenticator } from '../auth/index.js';
import {
  NOOP_LOGGER,
  createRequestLoggerMiddleware,
  type Logger,
} from '../logging/index.js';
import {
  ATTR_JSONRPC_METHOD,
  ATTR_JSONRPC_REQUEST_ID,
  DEFAULT_JSONRPC_SPAN_KIND,
  SPAN_NAME_JSONRPC_REQUEST,
  recordSpanError,
  setSpanAttributes,
  type TelemetryProvider,
} from '../telemetry/index.js';
import type { AgentCard } from '../types/generated/a2a.js';
import {
  GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
  createGetAuthenticatedExtendedCardHandler,
} from './agent-extended-card.js';
import {
  DEFAULT_ARTIFACTS_PATH,
  registerArtifactsRoute,
} from './artifacts-route.js';
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
  /**
   * Optional artifact storage backend. When provided, the server mounts a
   * `GET <artifactsPath>/:artifactId/:filename` endpoint that streams the
   * stored bytes with their recorded `Content-Type`. When omitted, the
   * endpoint is not registered and matching requests yield 404.
   *
   * Pair with a backend that produces matching download URLs (the in-memory
   * and filesystem providers' `getUrl` already match this shape).
   */
  readonly artifactStorage?: ArtifactStorageProvider;
  /**
   * Path the artifact download endpoint is mounted at. Defaults to
   * {@link DEFAULT_ARTIFACTS_PATH}. Ignored when {@link artifactStorage} is
   * omitted.
   */
  readonly artifactsPath?: string;
  /**
   * Structural logger used for request-level logs. When provided, the server
   * installs a request-logging middleware that:
   *
   *  - Generates (or honors an incoming) `x-request-id` correlation header.
   *  - Stores a child logger bound with `{ requestId }` under
   *    `c.get('logger')` so downstream method handlers can re-bind it with
   *    `{ taskId }` and emit task-scoped logs.
   *  - Emits `request received` / `request completed` lines with method,
   *    path, status, and duration.
   *  - Skips logging for {@link HEALTH_PATH} by default; override via
   *    `SERVER_DISABLE_HEALTHCHECK_LOG=false`.
   *
   * Defaults to a no-op logger (zero overhead). Pass a logger built with
   * {@link import('../logging/index.js').createLogger} for the
   * pino-backed production default.
   */
  readonly logger?: Logger;
  /**
   * Optional OpenTelemetry provider. When supplied, each JSON-RPC request gets
   * a server span (`adk.jsonrpc.request`) annotated with the JSON-RPC method
   * and request id, so traces tie the inbound HTTP boundary to the dispatched
   * method handler. The server does not call `start()` on the provider -
   * callers own its lifecycle and should call it before `listen()` and
   * `shutdown()` after `close()`.
   *
   * A disabled provider ({@link TelemetryProvider.isEnabled} returns `false`)
   * still wraps requests, but the underlying tracer is a no-op so the
   * overhead is the tracer lookup only.
   */
  readonly telemetry?: TelemetryProvider;
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
  private readonly artifactStorage: ArtifactStorageProvider | undefined;
  private readonly artifactsPath: string;
  private readonly logger: Logger;
  private readonly telemetry: TelemetryProvider | undefined;
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
    this.artifactStorage = config.artifactStorage;
    this.artifactsPath = config.artifactsPath ?? DEFAULT_ARTIFACTS_PATH;
    this.logger = config.logger ?? NOOP_LOGGER;
    this.telemetry = config.telemetry;

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

  /** Logger configured on this server (or `NOOP_LOGGER` if none was supplied). */
  getLogger(): Logger {
    return this.logger;
  }

  private buildApp(): Hono {
    const app = new Hono();

    if (this.logger !== NOOP_LOGGER) {
      app.use(
        '*',
        createRequestLoggerMiddleware({
          logger: this.logger,
          healthPath: HEALTH_PATH,
        })
      );
    }

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

    if (this.artifactStorage !== undefined) {
      registerArtifactsRoute(app, {
        storage: this.artifactStorage,
        path: this.artifactsPath,
      });
    }

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

      return this.runWithJsonRpcSpan(body, async () => {
        const result = await dispatch(body, this.registry, signal);
        if (result === null) {
          return new Response(null, { status: 204 });
        }
        return c.json(result as JSONRPCResponse | JSONRPCResponse[]);
      });
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

  private async runWithJsonRpcSpan(
    rawBody: string,
    fn: () => Promise<Response>
  ): Promise<Response> {
    if (this.telemetry === undefined) {
      return fn();
    }
    const { method, id } = peekJsonRpcMethodAndId(rawBody);
    return this.telemetry.withSpan(
      SPAN_NAME_JSONRPC_REQUEST,
      async (span) => {
        setSpanAttributes(span, {
          [ATTR_JSONRPC_METHOD]: method,
          [ATTR_JSONRPC_REQUEST_ID]: id,
        });
        try {
          return await fn();
        } catch (err) {
          recordSpanError(span, err);
          throw err;
        }
      },
      { kind: DEFAULT_JSONRPC_SPAN_KIND }
    );
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

/**
 * Best-effort extraction of the JSON-RPC `method` and `id` from a raw request
 * body, used for telemetry attributes. Returns `undefined` for both fields
 * when the body is not parseable or not a single-request object - batch
 * requests yield `undefined` because a single span cannot meaningfully
 * represent a heterogeneous batch.
 */
function peekJsonRpcMethodAndId(rawBody: string): {
  method: string | undefined;
  id: string | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { method: undefined, id: undefined };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { method: undefined, id: undefined };
  }
  const obj = parsed as Record<string, unknown>;
  const method = typeof obj['method'] === 'string' ? obj['method'] : undefined;
  const idValue = obj['id'];
  let id: string | undefined;
  if (typeof idValue === 'string') {
    id = idValue;
  } else if (typeof idValue === 'number') {
    id = String(idValue);
  }
  return { method, id };
}
