/**
 * Authentication configuration. Mirrors `AuthConfig` in the Go ADK
 * (`server/config/config.go`).
 *
 * `enable` defaults to false - disabled mode is a no-op middleware with zero
 * verification overhead. When `enable` is true but a required field is
 * missing, the authenticator factory throws so the server fails closed on
 * explicit-but-broken config, matching the Go ADK since v0.26.4.
 */
export interface AuthConfig {
  readonly enable: boolean;
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['', '0', 'false', 'no', 'off']);

function parseBool(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const v = raw.trim().toLowerCase();
  if (TRUTHY.has(v)) {
    return true;
  }
  if (FALSY.has(v)) {
    return false;
  }
  return false;
}

/**
 * Read auth configuration from an environment-shaped map (defaults to
 * `process.env`). Recognised keys:
 *
 * - `AUTH_ENABLED` - bool, default `false`
 * - `AUTH_ISSUER_URL` - OIDC issuer URL
 * - `AUTH_CLIENT_ID` - OAuth2 client id (used as the expected JWT `aud`)
 * - `AUTH_CLIENT_SECRET` - OAuth2 client secret
 */
export function loadAuthConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): AuthConfig {
  return {
    enable: parseBool(env['AUTH_ENABLED']),
    issuerUrl: env['AUTH_ISSUER_URL'] ?? '',
    clientId: env['AUTH_CLIENT_ID'] ?? '',
    clientSecret: env['AUTH_CLIENT_SECRET'] ?? '',
  };
}

/**
 * Whether `config` has the minimum fields needed for real OIDC verification.
 * When this returns `false` and `config.enable` is `true`, the authenticator
 * factory throws instead of silently degrading to a noop.
 */
export function isAuthConfigComplete(config: AuthConfig): boolean {
  return (
    config.enable &&
    config.issuerUrl.length > 0 &&
    config.clientId.length > 0 &&
    config.clientSecret.length > 0
  );
}
