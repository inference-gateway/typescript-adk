/**
 * Authentication configuration. Mirrors `AuthConfig` in the Go ADK
 * (`server/config/config.go`).
 *
 * `enable` defaults to false - disabled mode is a no-op middleware with zero
 * verification overhead. When `enable` is true but a required field is
 * missing, {@link loadAuthConfigFromEnv} returns a disabled config and the
 * builder logs a warning, matching the Go ADK's permissive boot behaviour.
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
 * - `AUTH_ENABLE` - bool, default `false`
 * - `AUTH_ISSUER_URL` - OIDC issuer URL
 * - `AUTH_CLIENT_ID` - OAuth2 client id (used as the expected JWT `aud`)
 * - `AUTH_CLIENT_SECRET` - OAuth2 client secret
 */
export function loadAuthConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): AuthConfig {
  return {
    enable: parseBool(env['AUTH_ENABLE']),
    issuerUrl: env['AUTH_ISSUER_URL'] ?? '',
    clientId: env['AUTH_CLIENT_ID'] ?? '',
    clientSecret: env['AUTH_CLIENT_SECRET'] ?? '',
  };
}

/**
 * Whether `config` has the minimum fields needed for real OIDC verification.
 * When this returns `false` and `config.enable` is `true`, the authenticator
 * factory degrades to a noop and emits a warning.
 */
export function isAuthConfigComplete(config: AuthConfig): boolean {
  return (
    config.enable &&
    config.issuerUrl.length > 0 &&
    config.clientId.length > 0 &&
    config.clientSecret.length > 0
  );
}
