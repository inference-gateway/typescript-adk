import { describe, expect, it } from 'vitest';
import {
  GET_AUTHENTICATED_EXTENDED_CARD_METHOD,
  JSONRPC_ERROR_CODES,
  JSONRPCError,
  createGetAuthenticatedExtendedCardHandler,
} from '../../src/server/index.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function makeExtendedCard(): AgentCard {
  return {
    name: 'extended-agent',
    description: 'Agent under test',
    version: '1.2.3',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: { streaming: false },
    skills: [
      { id: 'echo', name: 'Echo', description: 'Echo input.', tags: [] },
    ],
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

describe('createGetAuthenticatedExtendedCardHandler', () => {
  const ctx = { signal: new AbortController().signal };

  it('exports the canonical method name', () => {
    expect(GET_AUTHENTICATED_EXTENDED_CARD_METHOD).toBe(
      'agent/getAuthenticatedExtendedCard'
    );
  });

  it('returns the configured extended card verbatim when params is absent', () => {
    const card = makeExtendedCard();
    const handler = createGetAuthenticatedExtendedCardHandler({ card });

    const result = handler(undefined, ctx);

    expect(result).toBe(card);
  });

  it('returns the card when params is an empty object', () => {
    const card = makeExtendedCard();
    const handler = createGetAuthenticatedExtendedCardHandler({ card });

    const result = handler({}, ctx);

    expect(result).toBe(card);
  });

  it('returns the card when params has a string tenant', () => {
    const card = makeExtendedCard();
    const handler = createGetAuthenticatedExtendedCardHandler({ card });

    const result = handler({ tenant: 'acme' }, ctx);

    expect(result).toBe(card);
  });

  it('rejects array params with -32602', () => {
    const handler = createGetAuthenticatedExtendedCardHandler({
      card: makeExtendedCard(),
    });

    expect(() => handler([], ctx)).toThrow(JSONRPCError);
    try {
      handler([], ctx);
    } catch (err) {
      expect((err as JSONRPCError).code).toBe(
        JSONRPC_ERROR_CODES.INVALID_PARAMS
      );
    }
  });

  it('rejects non-string tenant with -32602', () => {
    const handler = createGetAuthenticatedExtendedCardHandler({
      card: makeExtendedCard(),
    });

    expect(() => handler({ tenant: 42 }, ctx)).toThrow(JSONRPCError);
    try {
      handler({ tenant: 42 }, ctx);
    } catch (err) {
      expect((err as JSONRPCError).code).toBe(
        JSONRPC_ERROR_CODES.INVALID_PARAMS
      );
    }
  });
});
