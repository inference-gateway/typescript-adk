import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_REQUIRED_ERROR_CODE,
  OIDCAuthenticator,
  NoopAuthenticator,
  createOIDCVerifier,
} from '../../src/auth/index.js';
import {
  AGENT_CARD_PATH,
  A2AServer,
  HEALTH_PATH,
  createA2AServer,
} from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';
import {
  generateTestKey,
  signTestToken,
  startJWKSServer,
  type RunningJWKSServer,
  type TestKey,
} from './helpers.js';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'a2a-test-client';

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'auth-test-agent',
    description: 'Agent under test',
    version: '1.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {},
    skills: [],
    ...overrides,
  };
}

async function startServer(
  server: A2AServer
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await server.listen(0, '127.0.0.1');
  const addr = server.address();
  if (addr === null) {
    throw new Error('server did not report listening address');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => server.close(),
  };
}

describe('A2AServer with authenticator wired in', () => {
  let close: (() => Promise<void>) | undefined;
  let jwksServer: RunningJWKSServer | undefined;
  let key: TestKey;

  beforeEach(async () => {
    key = await generateTestKey('test-key-server');
    jwksServer = await startJWKSServer([key]);
  });

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
    if (jwksServer !== undefined) {
      await jwksServer.close();
      jwksServer = undefined;
    }
  });

  function buildVerifier(): ReturnType<typeof createOIDCVerifier> {
    if (jwksServer === undefined) {
      throw new Error('jwksServer not started');
    }
    return createOIDCVerifier({
      metadata: { issuer: ISSUER, jwks_uri: jwksServer.jwksUrl },
      audience: CLIENT_ID,
    });
  }

  it('leaves the agent card discovery endpoint unauthenticated', async () => {
    const server = createA2AServer({
      card: makeCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
  });

  it('leaves the health endpoint unauthenticated', async () => {
    const server = createA2AServer({
      card: makeCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${HEALTH_PATH}`);
    expect(res.status).toBe(200);
  });

  it('rejects JSON-RPC requests missing a token with HTTP 401 + JSON-RPC -32001', async () => {
    const server = createA2AServer({
      card: makeCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'noop', id: 1 }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
  });

  it('accepts a valid token and routes to the JSON-RPC method registry', async () => {
    const server = createA2AServer({
      card: makeCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    server.registerMethod('ping', async () => ({ ok: true }));
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user-1',
    });
    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean } };
    expect(body.result).toEqual({ ok: true });
  });

  it('is zero-overhead when the authenticator is the noop', async () => {
    const server = createA2AServer({
      card: makeCard(),
      authenticator: new NoopAuthenticator(),
    });
    server.registerMethod('ping', async () => ({ ok: true }));
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(res.status).toBe(200);
  });
});
