import type { Context, MiddlewareHandler, Next } from 'hono';
import type { JWTPayload, JWTVerifyResult } from 'jose';
import { NOOP_LOGGER, type Logger as LoggingLogger } from '../logging/index.js';
import {
  JSONRPC_VERSION,
  type JSONRPCErrorResponse,
  type JSONRPCId,
} from '../server/jsonrpc.js';
import type { AuthConfig } from './config.js';
import { isAuthConfigComplete } from './config.js';
import {
  TokenVerificationError,
  createOIDCVerifier,
  fetchOIDCProviderMetadata,
  type OIDCProviderMetadata,
  type OIDCVerifier,
} from './oidc.js';

/**
 * Application-defined JSON-RPC error code returned when an A2A request fails
 * authentication. Inside the `-32000..-32099` server-error range reserved for
 * application use by the JSON-RPC 2.0 spec.
 */
export const AUTHENTICATION_REQUIRED_ERROR_CODE = -32001;

/**
 * Hono context variable key under which a successful verification stores the
 * decoded token. Accessed via `c.get(AUTH_CONTEXT_KEY)` from downstream
 * handlers.
 */
export const AUTH_CONTEXT_KEY = 'auth';

/**
 * Structural logger interface. Re-exported alias of the canonical
 * {@link LoggingLogger} so existing imports from `./authenticator` keep
 * working without callers having to know about the `logging` module.
 */
export type Logger = LoggingLogger;

/**
 * Information about a successfully authenticated request. Attached to the
 * Hono context under {@link AUTH_CONTEXT_KEY}; downstream handlers should
 * treat it as read-only.
 */
export interface AuthContext {
  readonly token: string;
  readonly claims: JWTPayload;
  readonly result: JWTVerifyResult<JWTPayload>;
}

/**
 * Common interface implemented by both the real OIDC authenticator and the
 * disabled no-op authenticator. Callers wire `middleware()` into the HTTP
 * pipeline unconditionally.
 */
export interface Authenticator {
  /** `true` for a real OIDC authenticator, `false` for the no-op. */
  readonly enabled: boolean;
  /** Hono middleware that enforces (or no-ops) Bearer-token authentication. */
  middleware(): MiddlewareHandler;
}

/**
 * Disabled authenticator. Returned by {@link createAuthenticator} when
 * `config.enable` is false or required config fields are missing.
 *
 * The middleware passes the request through unchanged, performing zero work.
 */
export class NoopAuthenticator implements Authenticator {
  readonly enabled = false;

  middleware(): MiddlewareHandler {
    return async (_c: Context, next: Next): Promise<void> => {
      await next();
    };
  }
}

/**
 * OIDC-backed authenticator. Verifies `Authorization: Bearer <token>` against
 * a JWKS resolved from the discovery document; rejects unauthenticated
 * requests with a JSON-RPC `-32001` error and HTTP 401.
 */
export class OIDCAuthenticator implements Authenticator {
  readonly enabled = true;
  private readonly verifier: OIDCVerifier;
  private readonly logger: Logger;

  constructor(verifier: OIDCVerifier, logger: Logger = NOOP_LOGGER) {
    this.verifier = verifier;
    this.logger = logger;
  }

  middleware(): MiddlewareHandler {
    return async (c: Context, next: Next): Promise<Response | void> => {
      const header = c.req.header('Authorization');
      if (header === undefined || header.length === 0) {
        this.logger.warn('auth: missing authorization header');
        return jsonRpcUnauthorized(
          c,
          'missing authorization header',
          'missing'
        );
      }
      if (!header.startsWith('Bearer ')) {
        this.logger.warn('auth: invalid authorization header format');
        return jsonRpcUnauthorized(
          c,
          'invalid authorization header format',
          'malformed'
        );
      }
      const token = header.slice('Bearer '.length).trim();
      try {
        const result = await this.verifier.verify(token, {
          signal: c.req.raw.signal,
        });
        const authContext: AuthContext = {
          token,
          claims: result.payload,
          result,
        };
        c.set(AUTH_CONTEXT_KEY, authContext);
        await next();
        return;
      } catch (err) {
        if (err instanceof TokenVerificationError) {
          this.logger.warn(
            `auth: token rejected (${err.reason}): ${err.message}`
          );
          return jsonRpcUnauthorized(c, err.message, err.reason);
        }
        this.logger.error('auth: unexpected verification error', err);
        return jsonRpcUnauthorized(c, 'token verification failed', 'unknown');
      }
    };
  }
}

/**
 * Options accepted by {@link createAuthenticator}.
 */
export interface CreateAuthenticatorOptions {
  /** Auth configuration; typically the output of `loadAuthConfigFromEnv()`. */
  readonly config: AuthConfig;
  /** Structural logger. Defaults to a noop. */
  readonly logger?: Logger;
  /**
   * Override the OIDC discovery fetch. Primarily for tests; production
   * callers should not need this.
   */
  readonly fetchMetadata?: (
    issuerUrl: string,
    signal?: AbortSignal
  ) => Promise<OIDCProviderMetadata>;
  /** Optional signal that aborts the discovery fetch. */
  readonly signal?: AbortSignal;
  /**
   * Forwarded to {@link createOIDCVerifier} - see its docstring. Primarily
   * useful in tests.
   */
  readonly cacheMaxAgeMs?: number;
  readonly cooldownMs?: number;
  readonly clockToleranceSeconds?: number;
}

/**
 * Build the appropriate {@link Authenticator} for `options.config`:
 *
 *  - If auth is disabled, returns a {@link NoopAuthenticator}.
 *  - If auth is enabled but required fields are missing, throws - the server
 *    fails closed on explicit-but-broken config instead of silently booting
 *    unauthenticated (matching the Go ADK since v0.26.4).
 *  - Otherwise fetches the OIDC discovery document and returns a fully
 *    configured {@link OIDCAuthenticator}.
 *
 * Asynchronous because OIDC discovery is a network call; callers should
 * resolve this at boot time and reuse the result.
 */
export async function createAuthenticator(
  options: CreateAuthenticatorOptions
): Promise<Authenticator> {
  const config = options.config;

  if (!config.enable) {
    return new NoopAuthenticator();
  }
  if (!isAuthConfigComplete(config)) {
    throw new Error(
      'auth: AUTH_ENABLED=true but required fields are missing (AUTH_ISSUER_URL, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET)'
    );
  }

  const fetchMetadata =
    options.fetchMetadata ??
    ((url: string, signal?: AbortSignal): Promise<OIDCProviderMetadata> =>
      fetchOIDCProviderMetadata(url, signal !== undefined ? { signal } : {}));
  const metadata = await fetchMetadata(config.issuerUrl, options.signal);

  const verifierOptions: Parameters<typeof createOIDCVerifier>[0] = {
    metadata,
    audience: config.clientId,
  };
  if (options.cacheMaxAgeMs !== undefined) {
    (verifierOptions as { cacheMaxAgeMs?: number }).cacheMaxAgeMs =
      options.cacheMaxAgeMs;
  }
  if (options.cooldownMs !== undefined) {
    (verifierOptions as { cooldownMs?: number }).cooldownMs =
      options.cooldownMs;
  }
  if (options.clockToleranceSeconds !== undefined) {
    (
      verifierOptions as { clockToleranceSeconds?: number }
    ).clockToleranceSeconds = options.clockToleranceSeconds;
  }
  const verifier = createOIDCVerifier(verifierOptions);
  return new OIDCAuthenticator(verifier, options.logger ?? NOOP_LOGGER);
}

function jsonRpcUnauthorized(
  c: Context,
  message: string,
  reason: string
): Response {
  const id = extractRequestId(c);
  const body: JSONRPCErrorResponse = {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code: AUTHENTICATION_REQUIRED_ERROR_CODE,
      message,
      data: { reason },
    },
  };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Bearer',
    },
  });
}

/**
 * Best-effort extraction of the JSON-RPC request id so the 401 error envelope
 * can be correlated to the request the client sent. The middleware never
 * consumes the body for the success path, so a synchronous peek isn't
 * possible; we use whatever Hono has buffered, which in practice means we
 * report `null` when the body hasn't been read yet. That's spec-compliant -
 * JSON-RPC 2.0 §5 allows `id: null` when the id can't be detected.
 */
function extractRequestId(c: Context): JSONRPCId {
  const cached: unknown = c.get('__authParsedId');
  if (
    cached === null ||
    typeof cached === 'string' ||
    typeof cached === 'number'
  ) {
    return cached;
  }
  return null;
}
