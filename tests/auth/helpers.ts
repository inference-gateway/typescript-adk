import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JWK,
  type KeyObject,
} from 'jose';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OIDCProviderMetadata } from '../../src/auth/oidc.js';

const ALG = 'RS256';

export interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: JWK;
}

export async function generateTestKey(kid: string): Promise<TestKey> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = ALG;
  publicJwk.use = 'sig';
  return {
    kid,
    privateKey: privateKey as unknown as KeyObject,
    publicJwk,
  };
}

export interface SignTokenOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly subject?: string;
  readonly expiresInSeconds?: number;
  readonly issuedAtSeconds?: number;
  readonly extraClaims?: Record<string, unknown>;
}

export async function signTestToken(
  key: TestKey,
  options: SignTokenOptions
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (options.expiresInSeconds ?? 300);
  const iat = options.issuedAtSeconds ?? now;
  const payload: Record<string, unknown> = {
    ...(options.extraClaims ?? {}),
    iss: options.issuer,
    aud: options.audience,
  };
  if (options.subject !== undefined) {
    payload['sub'] = options.subject;
  }
  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key.privateKey);
}

export interface FakeIssuerOptions {
  readonly issuer: string;
  readonly jwksUri?: string;
  readonly keys: readonly TestKey[];
}

/**
 * In-memory implementation of the bits of `fetch` we need for OIDC discovery
 * and JWKS endpoints. Routes:
 *
 *  - GET `<issuer>/.well-known/openid-configuration`  -> discovery doc
 *  - GET `<jwksUri>`                                  -> JWKS document
 *
 * Anything else returns 404. Tracks how many times each route was called so
 * tests can assert caching behaviour.
 */
export function makeFakeOIDCFetch(options: FakeIssuerOptions): {
  fetch: typeof fetch;
  metadata: OIDCProviderMetadata;
  discoveryHits: () => number;
  jwksHits: () => number;
  setKeys(keys: readonly TestKey[]): void;
} {
  const jwksUri =
    options.jwksUri ?? `${stripTrailingSlash(options.issuer)}/jwks`;
  const metadata: OIDCProviderMetadata = {
    issuer: options.issuer,
    jwks_uri: jwksUri,
  };
  const discoveryUrl = `${stripTrailingSlash(options.issuer)}/.well-known/openid-configuration`;
  let activeKeys: readonly TestKey[] = options.keys;
  let discoveryCalls = 0;
  let jwksCalls = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    void init;
    const url = typeof input === 'string' ? input : input.toString();
    if (url === discoveryUrl) {
      discoveryCalls += 1;
      return new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === jwksUri) {
      jwksCalls += 1;
      return new Response(
        JSON.stringify({ keys: activeKeys.map((k) => k.publicJwk) }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetch: fetchImpl,
    metadata,
    discoveryHits: () => discoveryCalls,
    jwksHits: () => jwksCalls,
    setKeys(keys: readonly TestKey[]): void {
      activeKeys = keys;
    },
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export interface RunningJWKSServer {
  readonly jwksUrl: string;
  readonly hits: () => number;
  setKeys(keys: readonly TestKey[]): void;
  close(): Promise<void>;
}

/**
 * Spin up a real localhost HTTP server that serves a JWKS document. Avoids
 * patching `globalThis.fetch` (which `jose`'s `createRemoteJWKSet` uses
 * internally) so concurrent test fetches to other servers aren't intercepted.
 */
export async function startJWKSServer(
  initialKeys: readonly TestKey[]
): Promise<RunningJWKSServer> {
  let activeKeys: readonly TestKey[] = initialKeys;
  let hits = 0;

  const app = new Hono();
  app.get('/jwks', () => {
    hits += 1;
    return new Response(
      JSON.stringify({ keys: activeKeys.map((k) => k.publicJwk) }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });

  const httpServer = createAdaptorServer({ fetch: app.fetch }) as Server;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.once('listening', () => resolve());
    httpServer.listen(0, '127.0.0.1');
  });
  const addr = httpServer.address() as AddressInfo;
  const jwksUrl = `http://127.0.0.1:${addr.port}/jwks`;

  return {
    jwksUrl,
    hits: () => hits,
    setKeys(keys: readonly TestKey[]): void {
      activeKeys = keys;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
