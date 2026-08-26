import { readFileSync } from 'node:fs';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import type { SecureVersion } from 'node:tls';
import { TLSConfigError } from './errors.js';

/**
 * Env var read by {@link loadServerTLSConfigFromEnv} as the master toggle.
 * Treated as enabled when the value (after `.toLowerCase().trim()`) equals
 * `'true'`, `'1'`, `'yes'`, or `'on'`. Any other value - including an empty
 * string or unset - returns `undefined` from the loader.
 */
export const TLS_ENABLED_ENV = 'TLS_ENABLED';
/** Env var holding the path to the server's TLS certificate (PEM). */
export const TLS_CERT_PATH_ENV = 'TLS_CERT_PATH';
/** Env var holding the path to the server's TLS private key (PEM). */
export const TLS_KEY_PATH_ENV = 'TLS_KEY_PATH';
/**
 * Optional env var holding the path to a CA bundle used to verify client
 * certificates. Only meaningful for mTLS deployments; ignored unless the
 * server also requests/requires client certs.
 */
export const TLS_CA_PATH_ENV = 'TLS_CA_PATH';
/** Optional env var holding the passphrase that unlocks the private key. */
export const TLS_PASSPHRASE_ENV = 'TLS_PASSPHRASE';
/**
 * Optional env var enabling mutual TLS: when truthy the server requests a
 * client certificate (`requestCert: true`) and rejects connections that do
 * not present one signed by the configured {@link TLS_CA_PATH_ENV} bundle
 * (`rejectUnauthorized: true`). Truthy values match the same set as
 * {@link TLS_ENABLED_ENV}.
 */
export const TLS_CLIENT_AUTH_ENV = 'TLS_CLIENT_AUTH';

/**
 * Server-side TLS configuration. Cert/key/CA are referenced by filesystem
 * path (PEM). Paths are read synchronously at boot time - the same pattern
 * the `AgentCard` loader uses for `loadAgentCardFromFile`.
 *
 * For mutual TLS, set {@link caPath} (the bundle used to validate client
 * certs) and {@link requestCert} (and typically {@link rejectUnauthorized}).
 */
export interface ServerTLSConfig {
  /** Path to the server's TLS certificate, PEM-encoded. Required. */
  readonly certPath: string;
  /** Path to the server's TLS private key, PEM-encoded. Required. */
  readonly keyPath: string;
  /**
   * Optional path to a PEM CA bundle. When set, it's used to verify client
   * certificates presented during the TLS handshake (mTLS).
   */
  readonly caPath?: string;
  /** Optional passphrase that unlocks {@link keyPath}. */
  readonly passphrase?: string;
  /**
   * Request a client certificate during the TLS handshake. Default `false`.
   * Pair with {@link caPath} + {@link rejectUnauthorized} for mTLS.
   */
  readonly requestCert?: boolean;
  /**
   * Reject connections whose client certificate does not validate against
   * {@link caPath}. Default `true` when {@link requestCert} is set, mirroring
   * Node's default for `tls.createServer`.
   *
   * Only honored when {@link requestCert} is `true`.
   */
  readonly rejectUnauthorized?: boolean;
  /**
   * Minimum negotiated TLS version. Defaults to Node's default
   * (currently `TLSv1.2`).
   */
  readonly minVersion?: SecureVersion;
}

/**
 * Build a `https.ServerOptions` object from a {@link ServerTLSConfig} by
 * reading the cert/key/CA files synchronously. Throws
 * {@link TLSConfigError} on any I/O or validation failure - the message
 * names the offending path and the underlying error is attached as
 * `Error.cause`.
 *
 * Called once from the {@link A2AServer} constructor; not intended for the
 * request path.
 */
export function buildServerTLSOptions(
  config: ServerTLSConfig
): HttpsServerOptions {
  if (typeof config.certPath !== 'string' || config.certPath.length === 0) {
    throw new TLSConfigError('TLS certPath is required');
  }
  if (typeof config.keyPath !== 'string' || config.keyPath.length === 0) {
    throw new TLSConfigError('TLS keyPath is required');
  }

  const cert = readPem(config.certPath, 'certPath');
  const key = readPem(config.keyPath, 'keyPath');

  const options: HttpsServerOptions = { cert, key };

  if (config.caPath !== undefined) {
    options.ca = readPem(config.caPath, 'caPath');
  }
  if (config.passphrase !== undefined) {
    options.passphrase = config.passphrase;
  }
  if (config.requestCert === true) {
    options.requestCert = true;
    options.rejectUnauthorized = config.rejectUnauthorized ?? true;
  }
  if (config.minVersion !== undefined) {
    options.minVersion = config.minVersion;
  }

  return options;
}

/**
 * Read a TLS config from environment variables. Returns `undefined` when
 * {@link TLS_ENABLED_ENV} is not set to a truthy value, so callers can use
 * the result in an optional config slot without an `if` ladder.
 *
 * Throws {@link TLSConfigError} when TLS is enabled but
 * {@link TLS_CERT_PATH_ENV} or {@link TLS_KEY_PATH_ENV} is missing - this
 * is a misconfiguration that should fail fast at boot.
 *
 * @param env - Defaults to `process.env`. Pass an explicit map to load from
 *   a custom environment (useful in tests).
 */
export function loadServerTLSConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ServerTLSConfig | undefined {
  if (!isTruthyEnv(env[TLS_ENABLED_ENV])) {
    return undefined;
  }

  const certPath = env[TLS_CERT_PATH_ENV];
  const keyPath = env[TLS_KEY_PATH_ENV];

  if (typeof certPath !== 'string' || certPath.length === 0) {
    throw new TLSConfigError(
      `${TLS_ENABLED_ENV}=true but ${TLS_CERT_PATH_ENV} is unset`
    );
  }
  if (typeof keyPath !== 'string' || keyPath.length === 0) {
    throw new TLSConfigError(
      `${TLS_ENABLED_ENV}=true but ${TLS_KEY_PATH_ENV} is unset`
    );
  }

  const config: Record<string, unknown> = { certPath, keyPath };

  const caPath = env[TLS_CA_PATH_ENV];
  if (typeof caPath === 'string' && caPath.length > 0) {
    config['caPath'] = caPath;
  }
  const passphrase = env[TLS_PASSPHRASE_ENV];
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    config['passphrase'] = passphrase;
  }
  if (isTruthyEnv(env[TLS_CLIENT_AUTH_ENV])) {
    config['requestCert'] = true;
    config['rejectUnauthorized'] = true;
  }

  return config as unknown as ServerTLSConfig;
}

function readPem(path: string, field: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new TLSConfigError(
      `failed to read TLS ${field} from ${path}: ${(err as Error).message}`,
      err
    );
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}
