import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHENTICATION_REQUIRED_ERROR_CODE,
  AUTH_CONTEXT_KEY,
  NoopAuthenticator,
  OIDCAuthenticator,
  createAuthenticator,
  type AuthContext,
  type AuthConfig,
  type Authenticator,
} from '../../src/auth/index.js';
import type { OIDCVerifier } from '../../src/auth/oidc.js';
import { TokenVerificationError } from '../../src/auth/oidc.js';
import {
  generateTestKey,
  signTestToken,
  startJWKSServer,
  type RunningJWKSServer,
  type TestKey,
} from './helpers.js';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'a2a-test-client';

let key: TestKey;
let jwksServer: RunningJWKSServer | undefined;

beforeEach(async () => {
  key = await generateTestKey('test-key-auth');
});

afterEach(async () => {
  if (jwksServer !== undefined) {
    await jwksServer.close();
    jwksServer = undefined;
  }
});

type Env = { Variables: { auth?: AuthContext } };

function buildApp(authenticator: Authenticator): Hono<Env> {
  const app = new Hono<Env>();
  app.use('/rpc', authenticator.middleware());
  app.post('/rpc', (c) => {
    const auth = c.get(AUTH_CONTEXT_KEY);
    return c.json({
      authenticated: auth !== undefined,
      sub: auth?.claims.sub ?? null,
    });
  });
  return app;
}

describe('NoopAuthenticator', () => {
  it('is disabled and passes the request through without auth', async () => {
    const auth = new NoopAuthenticator();
    expect(auth.enabled).toBe(false);
    const app = buildApp(auth);
    const res = await app.request('/rpc', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: false, sub: null });
  });
});

describe('OIDCAuthenticator', () => {
  it('rejects requests missing an Authorization header with JSON-RPC -32001 + HTTP 401', async () => {
    const stubVerifier: OIDCVerifier = {
      async verify() {
        throw new Error('should not be called');
      },
    };
    const auth = new OIDCAuthenticator(stubVerifier);
    const app = buildApp(auth);
    const res = await app.request('/rpc', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = (await res.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string; data: { reason: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
    expect(body.error.data.reason).toBe('missing');
  });

  it('rejects an Authorization header without a Bearer scheme', async () => {
    const stubVerifier: OIDCVerifier = {
      async verify() {
        throw new Error('should not be called');
      },
    };
    const auth = new OIDCAuthenticator(stubVerifier);
    const app = buildApp(auth);
    const res = await app.request('/rpc', {
      method: 'POST',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: number; data: { reason: string } };
    };
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
    expect(body.error.data.reason).toBe('malformed');
  });

  it('attaches claims to the request context on success', async () => {
    jwksServer = await startJWKSServer([key]);
    const authenticator = await createAuthenticator({
      config: {
        enable: true,
        issuerUrl: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: 'secret',
      },
      fetchMetadata: async () => {
        if (jwksServer === undefined) {
          throw new Error('jwks server not started');
        }
        return { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl };
      },
    });
    expect(authenticator.enabled).toBe(true);
    const app = buildApp(authenticator);
    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user-42',
    });
    const res = await app.request('/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ authenticated: true, sub: 'user-42' });
  });

  it('translates TokenVerificationError reasons onto the 401 response', async () => {
    const stubVerifier: OIDCVerifier = {
      async verify() {
        throw new TokenVerificationError('expired', 'token expired');
      },
    };
    const auth = new OIDCAuthenticator(stubVerifier);
    const app = buildApp(auth);
    const res = await app.request('/rpc', {
      method: 'POST',
      headers: { Authorization: 'Bearer some.jwt.token' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: number; data: { reason: string }; message: string };
    };
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
    expect(body.error.data.reason).toBe('expired');
    expect(body.error.message).toBe('token expired');
  });
});

describe('createAuthenticator', () => {
  it('returns a noop when AUTH_ENABLED is false', async () => {
    const auth = await createAuthenticator({
      config: {
        enable: false,
        issuerUrl: '',
        clientId: '',
        clientSecret: '',
      },
    });
    expect(auth.enabled).toBe(false);
    expect(auth).toBeInstanceOf(NoopAuthenticator);
  });

  it('throws when AUTH_ENABLED=true but required fields are missing', async () => {
    await expect(
      createAuthenticator({
        config: {
          enable: true,
          issuerUrl: '',
          clientId: '',
          clientSecret: '',
        },
      })
    ).rejects.toThrow(/required fields are missing/);
  });

  it('does not call the discovery fetch when disabled', async () => {
    const fetchMetadata = vi.fn();
    const config: AuthConfig = {
      enable: false,
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: 's',
    };
    await createAuthenticator({ config, fetchMetadata });
    expect(fetchMetadata).not.toHaveBeenCalled();
  });
});
