import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyResult,
} from 'jose';

/**
 * Subset of an OIDC Discovery document we actually consume. The full set is
 * specified in https://openid.net/specs/openid-connect-discovery-1_0.html .
 */
export interface OIDCProviderMetadata {
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly authorization_endpoint?: string;
  readonly token_endpoint?: string;
  readonly userinfo_endpoint?: string;
  readonly end_session_endpoint?: string;
}

/**
 * Thrown when an OIDC discovery fetch fails or returns an unusable document.
 * The triggering error (if any) is exposed via standard `Error.cause`.
 */
export class OIDCDiscoveryError extends Error {
  override readonly name = 'OIDCDiscoveryError';

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
  }
}

/**
 * Thrown when a Bearer token fails verification. `reason` is a short stable
 * code suitable for logging/metrics; `message` may include details that are
 * safe to propagate to the client (e.g., "token expired").
 */
export class TokenVerificationError extends Error {
  override readonly name = 'TokenVerificationError';
  readonly reason:
    | 'missing'
    | 'malformed'
    | 'expired'
    | 'invalid_signature'
    | 'invalid_issuer'
    | 'invalid_audience'
    | 'verification_failed';

  constructor(
    reason: TokenVerificationError['reason'],
    message: string,
    cause?: unknown
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.reason = reason;
  }
}

/** Trimmed trailing slash; ensures discovery URL composition is stable. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Fetch the OIDC provider metadata from the well-known discovery endpoint.
 *
 * Per RFC 8414 / OpenID Connect Discovery 1.0, the document lives at
 * `<issuer>/.well-known/openid-configuration`.
 */
export async function fetchOIDCProviderMetadata(
  issuerUrl: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<OIDCProviderMetadata> {
  const fetchImpl = options.fetch ?? fetch;
  const discoveryUrl = `${stripTrailingSlash(issuerUrl)}/.well-known/openid-configuration`;

  let res: Response;
  try {
    const init: RequestInit =
      options.signal !== undefined ? { signal: options.signal } : {};
    res = await fetchImpl(discoveryUrl, init);
  } catch (err) {
    throw new OIDCDiscoveryError(
      `failed to fetch OIDC discovery document at ${discoveryUrl}`,
      err
    );
  }

  if (!res.ok) {
    throw new OIDCDiscoveryError(
      `OIDC discovery document at ${discoveryUrl} returned HTTP ${res.status}`
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new OIDCDiscoveryError(
      `OIDC discovery document at ${discoveryUrl} is not valid JSON`,
      err
    );
  }

  if (typeof body !== 'object' || body === null) {
    throw new OIDCDiscoveryError(
      `OIDC discovery document at ${discoveryUrl} is not a JSON object`
    );
  }

  const obj = body as Record<string, unknown>;
  const issuer = obj['issuer'];
  const jwksUri = obj['jwks_uri'];

  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new OIDCDiscoveryError(
      `OIDC discovery document is missing required field "issuer"`
    );
  }
  if (typeof jwksUri !== 'string' || jwksUri.length === 0) {
    throw new OIDCDiscoveryError(
      `OIDC discovery document is missing required field "jwks_uri"`
    );
  }

  const metadata: OIDCProviderMetadata = {
    issuer,
    jwks_uri: jwksUri,
    ...(typeof obj['authorization_endpoint'] === 'string'
      ? { authorization_endpoint: obj['authorization_endpoint'] }
      : {}),
    ...(typeof obj['token_endpoint'] === 'string'
      ? { token_endpoint: obj['token_endpoint'] }
      : {}),
    ...(typeof obj['userinfo_endpoint'] === 'string'
      ? { userinfo_endpoint: obj['userinfo_endpoint'] }
      : {}),
    ...(typeof obj['end_session_endpoint'] === 'string'
      ? { end_session_endpoint: obj['end_session_endpoint'] }
      : {}),
  };

  return metadata;
}

/**
 * Options accepted by {@link createOIDCVerifier}.
 */
export interface CreateOIDCVerifierOptions {
  /**
   * Discovery document. Typically obtained via
   * {@link fetchOIDCProviderMetadata}. The `issuer` claim on incoming tokens
   * is matched against this object's `issuer`.
   */
  readonly metadata: OIDCProviderMetadata;
  /**
   * Expected `aud` claim on incoming tokens. Maps to `AUTH_CLIENT_ID`.
   */
  readonly audience: string;
  /**
   * JWKS cache TTL in milliseconds. `jose`'s default of 10 minutes is used
   * when omitted. The verifier transparently refetches when an unknown
   * `kid` is observed, so a high TTL is safe.
   */
  readonly cacheMaxAgeMs?: number;
  /**
   * Optional cooldown between forced JWKS refetches on a `kid` miss.
   * Defaults to the `jose` default (30 seconds).
   */
  readonly cooldownMs?: number;
  /**
   * Permitted clock skew in seconds when validating `exp`/`nbf`/`iat`.
   * Defaults to 0.
   */
  readonly clockToleranceSeconds?: number;
}

/**
 * Verifier returned by {@link createOIDCVerifier}. Stateless from the
 * caller's perspective; the underlying JWKS is cached internally.
 */
export interface OIDCVerifier {
  /**
   * Verify a raw bearer token. Resolves with the decoded claims on success,
   * rejects with {@link TokenVerificationError} on any validation failure.
   */
  verify(
    token: string,
    options?: { signal?: AbortSignal }
  ): Promise<JWTVerifyResult<JWTPayload>>;
}

/**
 * Build an {@link OIDCVerifier} from discovery metadata and an expected
 * audience. The verifier:
 *
 *  - Caches the JWKS for the issuer's recommended TTL (jose's default of
 *    10 minutes, overridable via `cacheMaxAgeMs`).
 *  - Refetches the JWKS when an incoming token references an unknown `kid`,
 *    with a cooldown to avoid hammering the issuer.
 *  - Validates `iss` against `metadata.issuer` and `aud` against `audience`.
 *
 * Errors from `jose` are mapped onto {@link TokenVerificationError.reason}
 * codes so callers can distinguish "expired" from "wrong signer" without
 * inspecting message strings.
 */
export function createOIDCVerifier(
  options: CreateOIDCVerifierOptions
): OIDCVerifier {
  const { metadata, audience } = options;
  const remoteJWKSOptions: Parameters<typeof createRemoteJWKSet>[1] = {};
  if (options.cacheMaxAgeMs !== undefined) {
    remoteJWKSOptions.cacheMaxAge = options.cacheMaxAgeMs;
  }
  if (options.cooldownMs !== undefined) {
    remoteJWKSOptions.cooldownDuration = options.cooldownMs;
  }
  const jwks = createRemoteJWKSet(
    new URL(metadata.jwks_uri),
    remoteJWKSOptions
  );

  return {
    async verify(
      token: string,
      verifyOptions: { signal?: AbortSignal } = {}
    ): Promise<JWTVerifyResult<JWTPayload>> {
      if (typeof token !== 'string' || token.length === 0) {
        throw new TokenVerificationError('missing', 'bearer token is empty');
      }
      try {
        const verifyOpts: Parameters<typeof jwtVerify>[2] = {
          issuer: metadata.issuer,
          audience,
        };
        if (options.clockToleranceSeconds !== undefined) {
          verifyOpts.clockTolerance = options.clockToleranceSeconds;
        }
        return await jwtVerify(token, jwks, verifyOpts);
      } catch (err) {
        throw mapJoseError(err, verifyOptions.signal);
      }
    },
  };
}

function mapJoseError(
  err: unknown,
  _signal?: AbortSignal
): TokenVerificationError {
  if (err instanceof joseErrors.JWTExpired) {
    return new TokenVerificationError('expired', 'token expired', err);
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') {
      return new TokenVerificationError(
        'invalid_issuer',
        'token issuer does not match configured AUTH_ISSUER_URL',
        err
      );
    }
    if (err.claim === 'aud') {
      return new TokenVerificationError(
        'invalid_audience',
        'token audience does not match configured AUTH_CLIENT_ID',
        err
      );
    }
    return new TokenVerificationError(
      'verification_failed',
      `token claim "${err.claim}" failed validation`,
      err
    );
  }
  if (
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return new TokenVerificationError(
      'invalid_signature',
      'token signature could not be verified',
      err
    );
  }
  if (
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWTInvalid
  ) {
    return new TokenVerificationError('malformed', 'token is malformed', err);
  }
  return new TokenVerificationError(
    'verification_failed',
    'token verification failed',
    err
  );
}
