import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_REQUIRED_ERROR_CODE,
  createAuthenticator,
  fetchOIDCProviderMetadata,
  type Authenticator,
} from '../../src/auth/index.js';
import { A2AServer, createA2AServer } from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

/**
 * Keycloak end-to-end test. Skipped by default; runs only when:
 *
 *   RUN_KEYCLOAK_INTEGRATION=1 \
 *   KEYCLOAK_ISSUER_URL=http://localhost:8080/realms/a2a \
 *   KEYCLOAK_CLIENT_ID=a2a-test \
 *   KEYCLOAK_CLIENT_SECRET=<secret> \
 *   KEYCLOAK_USERNAME=tester \
 *   KEYCLOAK_PASSWORD=tester \
 *     pnpm vitest run tests/auth/keycloak.integration.test.ts
 *
 * Bring up Keycloak with e.g.:
 *
 *   docker run --rm -p 8080:8080 \
 *     -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin \
 *     quay.io/keycloak/keycloak:latest start-dev
 *
 * and provision an "a2a" realm with a confidential client whose Direct
 * Access Grants flow is enabled.
 */
const shouldRun =
  process.env['RUN_KEYCLOAK_INTEGRATION'] === '1' ||
  process.env['RUN_KEYCLOAK_INTEGRATION'] === 'true';

const issuerUrl = process.env['KEYCLOAK_ISSUER_URL'] ?? '';
const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? '';
const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
const username = process.env['KEYCLOAK_USERNAME'] ?? '';
const password = process.env['KEYCLOAK_PASSWORD'] ?? '';

const describeMaybe = shouldRun ? describe : describe.skip;

describeMaybe('Keycloak end-to-end (integration)', () => {
  let server: A2AServer | undefined;
  let baseUrl = '';
  let accessToken = '';

  beforeAll(async () => {
    expect(issuerUrl).not.toBe('');
    expect(clientId).not.toBe('');
    expect(clientSecret).not.toBe('');
    expect(username).not.toBe('');
    expect(password).not.toBe('');

    const metadata = await fetchOIDCProviderMetadata(issuerUrl);
    if (metadata.token_endpoint === undefined) {
      throw new Error('Keycloak discovery did not advertise token_endpoint');
    }
    const tokenRes = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        client_secret: clientSecret,
        username,
        password,
      }).toString(),
    });
    if (!tokenRes.ok) {
      throw new Error(
        `keycloak token endpoint returned HTTP ${tokenRes.status}: ${await tokenRes.text()}`
      );
    }
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    accessToken = tokenBody.access_token;
    expect(accessToken.length).toBeGreaterThan(0);

    const authenticator: Authenticator = await createAuthenticator({
      config: {
        enable: true,
        issuerUrl,
        clientId,
        clientSecret,
      },
    });
    expect(authenticator.enabled).toBe(true);

    const card: AgentCard = {
      name: 'keycloak-protected-agent',
      description: 'agent protected by keycloak',
      version: '1.0.0',
      protocolVersion: '1.0',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      capabilities: {},
      skills: [],
    };

    server = createA2AServer({ card, authenticator });
    server.registerMethod('ping', async () => ({ ok: true }));
    await server.listen(0, '127.0.0.1');
    const addr = server.address();
    if (addr === null) {
      throw new Error('server did not report a listening address');
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
    }
  });

  it('rejects unauthenticated requests with 401 + -32001', async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
  });

  it('accepts a Keycloak-issued token', async () => {
    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean } };
    expect(body.result).toEqual({ ok: true });
  });
});
