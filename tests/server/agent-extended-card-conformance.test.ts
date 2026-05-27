import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_REQUIRED_ERROR_CODE,
  OIDCAuthenticator,
  createOIDCVerifier,
} from '../../src/auth/index.js';
import {
  AGENT_CARD_PATH,
  A2AServer,
  GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
  JSONRPC_ERROR_CODES,
  JSONRPC_VERSION,
  createA2AServer,
} from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';
import {
  generateTestKey,
  signTestToken,
  startJWKSServer,
  type RunningJWKSServer,
  type TestKey,
} from '../auth/helpers.js';

const ISSUER = 'https://issuer.test';
const CLIENT_ID = 'a2a-test-client';

function publicCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'extended-agent',
    description: 'Agent under test',
    version: '1.0.0',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo input.', tags: [] },
    ],
    supportsExtendedAgentCard: true,
    ...overrides,
  };
}

function extendedCard(): AgentCard {
  return {
    ...publicCard(),
    securitySchemes: {
      oidc: {
        openIdConnectSecurityScheme: {
          openIdConnectUrl:
            'https://issuer.test/.well-known/openid-configuration',
          description: 'OpenID Connect authentication via JWT Bearer tokens.',
        },
      },
    },
    security: [{ schemes: { oidc: { list: [] } } }],
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

async function postJSON(
  baseUrl: string,
  body: unknown,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token !== undefined) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${baseUrl}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('agent/getAuthenticatedExtendedCard conformance', () => {
  let close: (() => Promise<void>) | undefined;
  let jwksServer: RunningJWKSServer | undefined;
  let key: TestKey;

  beforeEach(async () => {
    key = await generateTestKey('test-key-extended-card');
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

  it('returns the extended card to an authenticated caller', async () => {
    const server = createA2AServer({
      card: publicCard(),
      extendedCard: extendedCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user-1',
    });
    const res = await postJSON(
      baseUrl,
      {
        jsonrpc: JSONRPC_VERSION,
        method: GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
        id: 1,
      },
      token
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: AgentCard;
    };
    expect(body.jsonrpc).toBe(JSONRPC_VERSION);
    expect(body.id).toBe(1);
    expect(body.result.name).toBe('extended-agent');
    expect(body.result.securitySchemes).toBeDefined();
    expect(body.result.security).toBeDefined();
  });

  it('accepts an optional tenant param', async () => {
    const server = createA2AServer({
      card: publicCard(),
      extendedCard: extendedCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user-1',
    });
    const res = await postJSON(
      baseUrl,
      {
        jsonrpc: JSONRPC_VERSION,
        method: GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
        id: 2,
        params: { tenant: 'acme' },
      },
      token
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: AgentCard };
    expect(body.result.name).toBe('extended-agent');
  });

  it('rejects an unauthenticated request with HTTP 401 + JSON-RPC -32001', async () => {
    const server = createA2AServer({
      card: publicCard(),
      extendedCard: extendedCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await postJSON(baseUrl, {
      jsonrpc: JSONRPC_VERSION,
      method: GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
      id: 3,
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number };
    };
    expect(body.jsonrpc).toBe(JSONRPC_VERSION);
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
  });

  it('rejects an invalid token with HTTP 401 + JSON-RPC -32001', async () => {
    const server = createA2AServer({
      card: publicCard(),
      extendedCard: extendedCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await postJSON(
      baseUrl,
      {
        jsonrpc: JSONRPC_VERSION,
        method: GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
        id: 4,
      },
      'not-a-real-token'
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      error: { code: number };
    };
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
  });

  it('omits auth schemes from the public well-known agent card', async () => {
    const server = createA2AServer({
      card: publicCard(),
      extendedCard: extendedCard(),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const res = await fetch(`${baseUrl}${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentCard;
    expect(body.securitySchemes).toBeUndefined();
    expect(body.security).toBeUndefined();
    expect(body.supportsExtendedAgentCard).toBe(true);
  });

  it('returns method-not-found when no extended card is configured', async () => {
    const server = createA2AServer({
      card: publicCard({ supportsExtendedAgentCard: false }),
      authenticator: new OIDCAuthenticator(buildVerifier()),
    });
    const { baseUrl, close: stop } = await startServer(server);
    close = stop;

    const token = await signTestToken(key, {
      issuer: ISSUER,
      audience: CLIENT_ID,
      subject: 'user-1',
    });
    const res = await postJSON(
      baseUrl,
      {
        jsonrpc: JSONRPC_VERSION,
        method: GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
        id: 5,
      },
      token
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(JSONRPC_ERROR_CODES.METHOD_NOT_FOUND);
  });
});
