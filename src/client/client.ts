import pkg from '../../package.json' with { type: 'json' };
import type {
  AgentCard,
  Message,
  SendMessageConfiguration,
  Struct,
  Task,
} from '../types/generated/a2a.js';
import {
  A2AAbortError,
  A2AClientError,
  A2AHTTPError,
  A2AJSONRPCError,
  A2ANetworkError,
  A2ATimeoutError,
} from './errors.js';
import {
  DEFAULT_RETRY_CONFIG,
  isRetryableError,
  withRetry,
  type RetryConfig,
} from './retry.js';

/**
 * Default path of the unauthenticated agent card discovery endpoint, per the
 * A2A discovery convention. Mirrors `AGENT_CARD_PATH` in
 * `src/server/server.ts`.
 */
export const DEFAULT_AGENT_CARD_PATH = '/.well-known/agent-card.json';

/**
 * Default path of the liveness endpoint. Mirrors `HEALTH_PATH` in
 * `src/server/server.ts`.
 */
export const DEFAULT_HEALTH_PATH = '/health';

/**
 * Default JSON-RPC endpoint path. Matches `DEFAULT_JSONRPC_PATH` in
 * `src/server/server.ts`.
 */
export const DEFAULT_JSONRPC_PATH = '/';

/**
 * Default per-request timeout, in milliseconds. Applies independently to each
 * attempt - retries do not share a single budget.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `fetch`-compatible function signature accepted via {@link A2AClientConfig.fetch}.
 * Defaults to `globalThis.fetch`.
 */
export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

/**
 * Shape of the `/health` endpoint response.
 *
 * The server's status field is loosely typed - the A2A spec accepts
 * `healthy`/`degraded`/`unhealthy`, but the client does not enforce this
 * value set since downstream agents may return additional states.
 */
export interface HealthResponse {
  readonly status: string;
}

/**
 * JSON-RPC params accepted by the `message/send` method. Mirrors
 * `MessageSendParams` in `src/server/message-send.ts` - keep these in lockstep.
 */
export interface SendMessageParams {
  readonly message: Message;
  readonly configuration?: SendMessageConfiguration;
  readonly metadata?: Struct;
}

export interface A2AClientConfig {
  /**
   * Base URL of the remote A2A server, e.g. `http://localhost:8080`. A trailing
   * slash is tolerated but stripped before path composition.
   */
  readonly baseURL: string;
  /**
   * Per-attempt timeout in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}. Set to `0` to disable timeouts.
   */
  readonly timeoutMs?: number;
  /**
   * Static headers attached to every outbound request. `Content-Type` and
   * `User-Agent` are set automatically and may be overridden via this map.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * `fetch` implementation. Defaults to `globalThis.fetch` (Node 22+ provides
   * one via undici). Inject a custom function for testing or to plug in
   * proxies/agents.
   */
  readonly fetch?: FetchLike;
  /**
   * Value for the outbound `User-Agent` header. Defaults to a string derived
   * from this package's name and version.
   */
  readonly userAgent?: string;
  /**
   * Path of the JSON-RPC endpoint on the remote agent. Defaults to
   * {@link DEFAULT_JSONRPC_PATH}.
   */
  readonly jsonRpcPath?: string;
  /**
   * Path of the agent-card discovery endpoint. Defaults to
   * {@link DEFAULT_AGENT_CARD_PATH}.
   */
  readonly agentCardPath?: string;
  /**
   * Path of the health endpoint. Defaults to {@link DEFAULT_HEALTH_PATH}.
   */
  readonly healthPath?: string;
  /**
   * Retry policy. Pass partial overrides to tune individual fields, or `false`
   * to disable retries entirely. Defaults to {@link DEFAULT_RETRY_CONFIG}.
   */
  readonly retry?: Partial<RetryConfig> | false;
}

/**
 * Options accepted by every public method on {@link A2AClient}.
 */
export interface RequestOptions {
  /** Caller-supplied abort signal. Aborting propagates as {@link A2AAbortError}. */
  readonly signal?: AbortSignal;
}

/**
 * Options accepted by {@link A2AClient.getTask}, extending the base
 * {@link RequestOptions} with `tasks/get`-specific params.
 */
export interface GetTaskOptions extends RequestOptions {
  /** Cap the returned `history` to this many most-recent messages. */
  readonly historyLength?: number;
  /** Arbitrary metadata forwarded to the server. */
  readonly metadata?: Struct;
}

interface JSONRPCErrorWire {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface JSONRPCResponseWire {
  readonly jsonrpc?: string;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: JSONRPCErrorWire;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function composeSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return AbortSignal.any(defined);
}

/**
 * Client for the Agent-to-Agent (A2A) protocol. Wraps the agent's HTTP
 * surface - card discovery, health probe, and the JSON-RPC methods
 * `message/send` and `tasks/get` - behind a typed, Promise-based API.
 *
 * Mirrors `client.Client` in the Go ADK
 * (https://github.com/inference-gateway/adk/blob/main/client/client.go).
 *
 * Streaming methods (`message/stream`, `tasks/resubscribe`) are deliberately
 * deferred - see issue #15 - but the constructor surface is shaped so they
 * slot in without API churn.
 */
export class A2AClient {
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly jsonRpcPath: string;
  private readonly agentCardPath: string;
  private readonly healthPath: string;
  private readonly retryConfig: RetryConfig | null;
  private idCounter = 0;

  constructor(config: A2AClientConfig) {
    if (typeof config.baseURL !== 'string' || config.baseURL.length === 0) {
      throw new A2AClientError('baseURL is required');
    }
    this.baseURL = stripTrailingSlash(config.baseURL);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.headers = config.headers ?? {};
    const resolvedFetch = config.fetch ?? globalThis.fetch;
    if (typeof resolvedFetch !== 'function') {
      throw new A2AClientError(
        'no fetch implementation available; pass `fetch` in config'
      );
    }
    this.fetchImpl = resolvedFetch;
    this.userAgent = config.userAgent ?? `${pkg.name}/${pkg.version}`;
    this.jsonRpcPath = config.jsonRpcPath ?? DEFAULT_JSONRPC_PATH;
    this.agentCardPath = config.agentCardPath ?? DEFAULT_AGENT_CARD_PATH;
    this.healthPath = config.healthPath ?? DEFAULT_HEALTH_PATH;

    if (config.retry === false) {
      this.retryConfig = null;
    } else {
      this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...(config.retry ?? {}) };
    }
  }

  /** Base URL the client was configured with (trailing slash stripped). */
  getBaseURL(): string {
    return this.baseURL;
  }

  /**
   * Fetch the agent's public card via `GET /.well-known/agent-card.json`.
   * Returns the parsed `AgentCard`. Does not run client-side validation -
   * use {@link validateAgentCard} from `src/agent/card.ts` to enforce the
   * required-field subset.
   */
  async getAgentCard(opts: RequestOptions = {}): Promise<AgentCard> {
    const url = this.baseURL + this.agentCardPath;
    const json = await this.executeGET(url, opts.signal);
    return json as AgentCard;
  }

  /**
   * Probe the agent's liveness endpoint. Returns `{ status }` verbatim.
   */
  async getHealth(opts: RequestOptions = {}): Promise<HealthResponse> {
    const url = this.baseURL + this.healthPath;
    const json = await this.executeGET(url, opts.signal);
    if (!isPlainObject(json) || typeof json['status'] !== 'string') {
      throw new A2AClientError(
        'invalid health response: expected { status: string }'
      );
    }
    return { status: json['status'] };
  }

  /**
   * Invoke the JSON-RPC `message/send` method. Returns the wire-format `Task`
   * the server creates and enqueues.
   */
  async sendMessage(
    params: SendMessageParams,
    opts: RequestOptions = {}
  ): Promise<Task> {
    return await this.executeJSONRPC<Task>('message/send', params, opts.signal);
  }

  /**
   * Invoke the JSON-RPC `tasks/get` method. Returns the wire-format `Task`,
   * with `history` capped to the last `historyLength` messages when supplied.
   */
  async getTask(taskId: string, opts: GetTaskOptions = {}): Promise<Task> {
    const params: Record<string, unknown> = { taskId };
    if (opts.historyLength !== undefined) {
      params['historyLength'] = opts.historyLength;
    }
    if (opts.metadata !== undefined) {
      params['metadata'] = opts.metadata;
    }
    return await this.executeJSONRPC<Task>('tasks/get', params, opts.signal);
  }

  private async executeGET(
    url: string,
    userSignal: AbortSignal | undefined
  ): Promise<unknown> {
    return await this.withOptionalRetry(async () => {
      const response = await this.fetchWithTimeout(
        url,
        { method: 'GET', headers: { Accept: 'application/json' } },
        userSignal
      );
      if (!response.ok) {
        const body = await safeReadText(response);
        throw new A2AHTTPError(response.status, body);
      }
      try {
        return (await response.json()) as unknown;
      } catch (err) {
        throw new A2AClientError('failed to decode JSON response', err);
      }
    }, userSignal);
  }

  private async executeJSONRPC<T>(
    method: string,
    params: unknown,
    userSignal: AbortSignal | undefined
  ): Promise<T> {
    const url = this.baseURL + this.jsonRpcPath;
    const id = ++this.idCounter;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return await this.withOptionalRetry(async () => {
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          body,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
        userSignal
      );

      if (!response.ok) {
        const text = await safeReadText(response);
        throw new A2AHTTPError(response.status, text);
      }

      let envelope: unknown;
      try {
        envelope = (await response.json()) as unknown;
      } catch (err) {
        throw new A2AClientError('failed to decode JSON-RPC response', err);
      }
      if (!isPlainObject(envelope)) {
        throw new A2AClientError('invalid JSON-RPC response: not an object');
      }
      const rpc = envelope as JSONRPCResponseWire;
      if (rpc.error !== undefined) {
        throw new A2AJSONRPCError(
          rpc.error.code,
          rpc.error.message,
          rpc.error.data
        );
      }
      if (rpc.result === undefined) {
        throw new A2AClientError(
          'invalid JSON-RPC response: missing both result and error'
        );
      }
      return rpc.result as T;
    }, userSignal);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    userSignal: AbortSignal | undefined
  ): Promise<Response> {
    const headers = new Headers();
    headers.set('User-Agent', this.userAgent);
    for (const [k, v] of Object.entries(this.headers)) {
      headers.set(k, v);
    }
    const initHeaders = init.headers;
    if (initHeaders !== undefined) {
      const overlay = new Headers(initHeaders);
      overlay.forEach((value, key) => headers.set(key, value));
    }

    const timeoutSignal =
      this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined;
    const signal = composeSignals(userSignal, timeoutSignal);

    const fetchInit: RequestInit = { ...init, headers };
    if (signal !== undefined) {
      (fetchInit as { signal: AbortSignal }).signal = signal;
    }

    try {
      return await this.fetchImpl(url, fetchInit);
    } catch (err) {
      throw this.classifyFetchError(err, userSignal, timeoutSignal);
    }
  }

  private classifyFetchError(
    err: unknown,
    userSignal: AbortSignal | undefined,
    timeoutSignal: AbortSignal | undefined
  ): A2AClientError {
    if (err instanceof A2AClientError) {
      return err;
    }
    if (userSignal?.aborted === true) {
      return new A2AAbortError(err);
    }
    if (timeoutSignal?.aborted === true) {
      return new A2ATimeoutError(this.timeoutMs, err);
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      return new A2ATimeoutError(this.timeoutMs, err);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return new A2AAbortError(err);
    }
    const message =
      err instanceof Error && err.message.length > 0
        ? err.message
        : 'network request failed';
    return new A2ANetworkError(message, err);
  }

  private async withOptionalRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal | undefined
  ): Promise<T> {
    if (this.retryConfig === null) {
      return await operation();
    }
    return await withRetry(
      operation,
      this.retryConfig,
      isRetryableError,
      signal
    );
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * Convenience factory equivalent to `new A2AClient(config)`.
 */
export function createA2AClient(config: A2AClientConfig): A2AClient {
  return new A2AClient(config);
}
