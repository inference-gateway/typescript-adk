import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TokenVerificationError,
  createOIDCVerifier,
  fetchOIDCProviderMetadata,
  OIDCDiscoveryError,
} from '../../src/auth/oidc.js';
import {
  generateTestKey,
  makeFakeOIDCFetch,
  signTestToken,
  startJWKSServer,
  type RunningJWKSServer,
  type TestKey,
} from './helpers.js';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'a2a-test-client';

let key: TestKey;
let altKey: TestKey;
let jwksServer: RunningJWKSServer | undefined;

beforeEach(async () => {
  key = await generateTestKey('test-key-1');
  altKey = await generateTestKey('test-key-2');
});

afterEach(async () => {
  if (jwksServer !== undefined) {
    await jwksServer.close();
    jwksServer = undefined;
  }
});

describe('fetchOIDCProviderMetadata', () => {
  it('reads issuer and jwks_uri from the discovery document', async () => {
    const fake = makeFakeOIDCFetch({ issuer: ISSUER, keys: [key] });
    const metadata = await fetchOIDCProviderMetadata(ISSUER, {
      fetch: fake.fetch,
    });
    expect(metadata.issuer).toBe(ISSUER);
    expect(metadata.jwks_uri).toBe(`${ISSUER}/jwks`);
    expect(fake.discoveryHits()).toBe(1);
  });

  it('strips a trailing slash on the issuer URL before composing discovery URL', async () => {
    const fake = makeFakeOIDCFetch({ issuer: ISSUER, keys: [key] });
    const metadata = await fetchOIDCProviderMetadata(`${ISSUER}/`, {
      fetch: fake.fetch,
    });
    expect(metadata.issuer).toBe(ISSUER);
  });

  it('throws OIDCDiscoveryError on non-2xx', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('boom', { status: 500 });
    await expect(
      fetchOIDCProviderMetadata(ISSUER, { fetch: fetchImpl })
    ).rejects.toBeInstanceOf(OIDCDiscoveryError);
  });

  it('throws OIDCDiscoveryError when the document is missing required fields', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      fetchOIDCProviderMetadata(ISSUER, { fetch: fetchImpl })
    ).rejects.toBeInstanceOf(OIDCDiscoveryError);
  });
});

describe('createOIDCVerifier', () => {
  it('accepts a valid token signed with the published key', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user-1',
    });
    const result = await verifier.verify(token);
    expect(result.payload.sub).toBe('user-1');
    expect(result.payload.iss).toBe(ISSUER);
    expect(result.payload.aud).toBe(CLIENT_ID);
  });

  it('rejects an empty token with reason="missing"', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
    await expect(verifier.verify('')).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'missing',
    });
  });

  it('rejects a malformed token', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
    await expect(verifier.verify('not-a-jwt')).rejects.toBeInstanceOf(
      TokenVerificationError
    );
  });

  it('rejects a token whose issuer does not match', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
    const token = await signTestToken(key, {
      issuer: 'https://attacker.test',
      audience: CLIENT_ID,
    });
    await expect(verifier.verify(token)).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'invalid_issuer',
    });
  });

  it('rejects a token whose audience does not match', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: 'other-client',
    });
    await expect(verifier.verify(token)).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'invalid_audience',
    });
  });

  it('rejects an expired token', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      issuedAtSeconds: nowSeconds - 7200,
      expiresInSeconds: -3600,
    });
    await expect(verifier.verify(token)).rejects.toMatchObject({
      name: 'TokenVerificationError',
      reason: 'expired',
    });
  });

  it('refreshes the JWKS when an incoming token has an unknown kid', async () => {
    jwksServer = await startJWKSServer([key]);
    const verifier = createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
      cooldownMs: 0,
    });

    // Warm the cache.
    const tok1 = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
    });
    await verifier.verify(tok1);
    const hitsAfterFirst = jwksServer.hits();
    expect(hitsAfterFirst).toBe(1);

    // Rotate the issuer's key set.
    jwksServer.setKeys([altKey]);
    const tok2 = await signTestToken(altKey, {
      issuer: ISSUER,
      audience: CLIENT_ID,
    });
    const result = await verifier.verify(tok2);
    expect(result.payload.iss).toBe(ISSUER);
    expect(jwksServer.hits()).toBeGreaterThan(hitsAfterFirst);
  });
});
