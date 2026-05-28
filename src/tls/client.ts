import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import { URL } from 'node:url';
import { TLSConfigError } from './errors.js';

/**
 * Env var paths used by {@link loadClientTLSConfigFromEnv}. These mirror the
 * Go ADK's `ClientTLSConfig` envs so a single deployment can share env
 * conventions across Go and TypeScript agents.
 */
export const CLIENT_TLS_CERT_PATH_ENV = 'CLIENT_TLS_CERT_PATH';
export const CLIENT_TLS_KEY_PATH_ENV = 'CLIENT_TLS_KEY_PATH';
export const CLIENT_TLS_CA_PATH_ENV = 'CLIENT_TLS_CA_PATH';
export const CLIENT_TLS_PASSPHRASE_ENV = 'CLIENT_TLS_PASSPHRASE';
export const CLIENT_TLS_INSECURE_SKIP_VERIFY_ENV =
  'CLIENT_TLS_INSECURE_SKIP_VERIFY';
export const CLIENT_TLS_SERVERNAME_ENV = 'CLIENT_TLS_SERVERNAME';

/**
 * Client-side TLS configuration for outbound HTTPS calls (LLM provider, A2A
 * peer). All cert material is referenced by file path - the loader reads the
 * file synchronously the first time a connection is made.
 *
 * Use {@link insecureSkipVerify} only for local self-signed development. In
 * production, pass {@link caPath} pointing at the CA that signed the peer's
 * certificate.
 */
export interface ClientTLSConfig {
  /**
   * Optional client certificate PEM path. Required only for mTLS where the
   * server requests a client cert.
   */
  readonly certPath?: string;
  /** Optional client private key PEM path (paired with {@link certPath}). */
  readonly keyPath?: string;
  /**
   * Optional CA bundle PEM path. When set, this CA is added to the trust
   * roots for verifying the peer certificate - use this for self-signed or
   * private-CA-signed peers without resorting to {@link insecureSkipVerify}.
   */
  readonly caPath?: string;
  /** Optional passphrase that unlocks {@link keyPath}. */
  readonly passphrase?: string;
  /**
   * Skip certificate verification entirely. Defaults to `false`. Setting
   * this to `true` makes the connection vulnerable to MITM - it's intended
   * for local development against self-signed certs only. Production
   * deployments should configure {@link caPath} instead.
   */
  readonly insecureSkipVerify?: boolean;
  /**
   * Override the SNI server name sent during the TLS handshake. Defaults to
   * the request URL's host. Useful when the request host is an IP literal or
   * a load-balancer address that doesn't match the cert CN/SAN.
   */
  readonly servername?: string;
}

/**
 * Read a {@link ClientTLSConfig} from environment variables. Returns
 * `undefined` when no client-TLS env vars are set, so callers can pass the
 * result directly into an optional config slot.
 */
export function loadClientTLSConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ClientTLSConfig | undefined {
  const certPath = env[CLIENT_TLS_CERT_PATH_ENV];
  const keyPath = env[CLIENT_TLS_KEY_PATH_ENV];
  const caPath = env[CLIENT_TLS_CA_PATH_ENV];
  const passphrase = env[CLIENT_TLS_PASSPHRASE_ENV];
  const insecure = env[CLIENT_TLS_INSECURE_SKIP_VERIFY_ENV];
  const servername = env[CLIENT_TLS_SERVERNAME_ENV];

  const hasAny =
    (typeof certPath === 'string' && certPath.length > 0) ||
    (typeof keyPath === 'string' && keyPath.length > 0) ||
    (typeof caPath === 'string' && caPath.length > 0) ||
    (typeof passphrase === 'string' && passphrase.length > 0) ||
    isTruthy(insecure) ||
    (typeof servername === 'string' && servername.length > 0);

  if (!hasAny) {
    return undefined;
  }

  const config: Record<string, unknown> = {};
  if (typeof certPath === 'string' && certPath.length > 0) {
    config['certPath'] = certPath;
  }
  if (typeof keyPath === 'string' && keyPath.length > 0) {
    config['keyPath'] = keyPath;
  }
  if (typeof caPath === 'string' && caPath.length > 0) {
    config['caPath'] = caPath;
  }
  if (typeof passphrase === 'string' && passphrase.length > 0) {
    config['passphrase'] = passphrase;
  }
  if (isTruthy(insecure)) {
    config['insecureSkipVerify'] = true;
  }
  if (typeof servername === 'string' && servername.length > 0) {
    config['servername'] = servername;
  }
  return config as unknown as ClientTLSConfig;
}

/**
 * Build a Node `https.Agent` configured from a {@link ClientTLSConfig}.
 * Reads any referenced PEM files synchronously. Reuses the same agent
 * across multiple requests for connection-pool efficiency - callers should
 * cache the returned agent rather than rebuilding per call.
 *
 * Throws {@link TLSConfigError} if a referenced path cannot be read or if
 * {@link ClientTLSConfig.certPath} and {@link ClientTLSConfig.keyPath} are
 * not both set together (mTLS requires both).
 */
export function createTLSHttpsAgent(config: ClientTLSConfig): Agent {
  if ((config.certPath !== undefined) !== (config.keyPath !== undefined)) {
    throw new TLSConfigError(
      'client TLS requires both certPath and keyPath when either is set'
    );
  }
  const opts: ConstructorParameters<typeof Agent>[0] = { keepAlive: true };
  if (config.certPath !== undefined) {
    opts.cert = readPem(config.certPath, 'certPath');
  }
  if (config.keyPath !== undefined) {
    opts.key = readPem(config.keyPath, 'keyPath');
  }
  if (config.caPath !== undefined) {
    opts.ca = readPem(config.caPath, 'caPath');
  }
  if (config.passphrase !== undefined) {
    opts.passphrase = config.passphrase;
  }
  if (config.insecureSkipVerify === true) {
    opts.rejectUnauthorized = false;
  }
  if (config.servername !== undefined) {
    opts.servername = config.servername;
  }
  return new Agent(opts);
}

/**
 * `fetch`-compatible function signature returned by {@link createTLSFetch}.
 * Matches `globalThis.fetch` closely enough for the LLM and A2A clients.
 */
export type TLSFetch = (
  input: string,
  init?: TLSFetchInit
) => Promise<Response>;

/**
 * Header input accepted by {@link createTLSFetch}. Matches the subset of
 * `HeadersInit` from the fetch spec the LLM/A2A clients actually use.
 */
export type TLSFetchHeaders =
  | Headers
  | Readonly<Record<string, string>>
  | ReadonlyArray<readonly [string, string]>;

/** Subset of `RequestInit` honored by {@link createTLSFetch}. */
export interface TLSFetchInit {
  readonly method?: string;
  readonly headers?: TLSFetchHeaders;
  readonly body?: string | Uint8Array | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Build a `fetch`-compatible function that routes HTTPS requests through an
 * `https.Agent` configured with the supplied {@link ClientTLSConfig}.
 *
 * HTTP (plaintext) requests are delegated to {@link globalThis.fetch} so this
 * helper can be used as a drop-in `fetch` for mixed-scheme clients without
 * breaking plaintext targets.
 *
 * The implementation uses `node:https.request` directly - no third-party HTTP
 * library is involved. Streaming bodies are not supported; callers must
 * provide the full body up-front (matches the LLM/A2A client usage).
 */
export function createTLSFetch(config: ClientTLSConfig): TLSFetch {
  const agent = createTLSHttpsAgent(config);
  const servername = config.servername;

  return function tlsFetch(input, init = {}): Promise<Response> {
    const url = new URL(input);
    if (url.protocol !== 'https:') {
      return globalThis.fetch(input, init as unknown as RequestInit);
    }

    const headers = normalizeHeaders(init.headers);
    const bodyBuf = normalizeBody(init.body);
    if (bodyBuf !== undefined && !('content-length' in headers)) {
      headers['content-length'] = String(bodyBuf.byteLength);
    }

    const reqOptions: HttpsRequestOptions = {
      method: init.method ?? 'GET',
      hostname: url.hostname,
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers,
      agent,
    };
    if (servername !== undefined) {
      reqOptions.servername = servername;
    }

    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const respHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) respHeaders.append(k, item);
            } else {
              respHeaders.set(k, String(v));
            }
          }
          resolve(
            new Response(buf.length === 0 ? null : buf, {
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              headers: respHeaders,
            })
          );
        });
        res.on('error', reject);
      });

      req.on('error', reject);

      if (init.signal !== undefined) {
        const signal = init.signal;
        if (signal.aborted) {
          req.destroy(new DOMException('aborted', 'AbortError'));
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            req.destroy(new DOMException('aborted', 'AbortError'));
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      }

      if (bodyBuf !== undefined) {
        req.write(bodyBuf);
      }
      req.end();
    });
  };
}

function readPem(path: string, field: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new TLSConfigError(
      `failed to read client TLS ${field} from ${path}: ${(err as Error).message}`,
      err
    );
  }
}

function isTruthy(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function normalizeHeaders(
  input: TLSFetchHeaders | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === undefined) return out;
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(input)) {
    for (const entry of input) {
      const k = entry[0];
      const v = entry[1];
      if (k === undefined || v === undefined) continue;
      out[k.toLowerCase()] = v;
    }
    return out;
  }
  for (const [k, v] of Object.entries(input as Record<string, string>)) {
    if (typeof v === 'string') {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function normalizeBody(
  body: string | Uint8Array | undefined
): Buffer | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.from(body);
}
