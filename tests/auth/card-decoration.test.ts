import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_SECURITY_SCHEME_NAME,
  decorateAgentCardWithAuth,
} from '../../src/auth/card-decoration.js';
import type { AuthConfig } from '../../src/auth/config.js';
import type { AgentCard } from '../../src/types/generated/a2a.js';

function baseCard(): AgentCard {
  return {
    name: 'a',
    description: 'd',
    version: '0.0.1',
    protocolVersion: '1.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {},
    skills: [],
  };
}

const enabledConfig: AuthConfig = {
  enable: true,
  issuerUrl: 'https://issuer.test',
  clientId: 'client',
  clientSecret: 'secret',
};

describe('decorateAgentCardWithAuth', () => {
  it('is a no-op when auth is disabled', () => {
    const card = baseCard();
    const result = decorateAgentCardWithAuth(card, {
      ...enabledConfig,
      enable: false,
    });
    expect(result).toBe(card);
  });

  it('is a no-op when issuer URL is empty', () => {
    const card = baseCard();
    const result = decorateAgentCardWithAuth(card, {
      ...enabledConfig,
      issuerUrl: '',
    });
    expect(result).toBe(card);
  });

  it('adds the OIDC security scheme and requirement when enabled', () => {
    const card = baseCard();
    const result = decorateAgentCardWithAuth(card, enabledConfig);
    expect(result).not.toBe(card);
    const scheme = result.securitySchemes?.[DEFAULT_OIDC_SECURITY_SCHEME_NAME];
    expect(scheme?.openIdConnectSecurityScheme?.openIdConnectUrl).toBe(
      'https://issuer.test/.well-known/openid-configuration'
    );
    expect(result.security).toHaveLength(1);
    expect(
      result.security?.[0]?.schemes?.[DEFAULT_OIDC_SECURITY_SCHEME_NAME]
    ).toBeDefined();
  });

  it('strips a trailing slash on the issuer URL', () => {
    const result = decorateAgentCardWithAuth(baseCard(), {
      ...enabledConfig,
      issuerUrl: 'https://issuer.test/',
    });
    expect(
      result.securitySchemes?.[DEFAULT_OIDC_SECURITY_SCHEME_NAME]
        ?.openIdConnectSecurityScheme?.openIdConnectUrl
    ).toBe('https://issuer.test/.well-known/openid-configuration');
  });

  it('does not overwrite an existing scheme with the same name', () => {
    const card: AgentCard = {
      ...baseCard(),
      securitySchemes: {
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: 'https://other.example/openid',
          },
        },
      },
    };
    const result = decorateAgentCardWithAuth(card, enabledConfig);
    expect(result).toBe(card);
  });

  it('preserves existing security requirements', () => {
    const card: AgentCard = {
      ...baseCard(),
      security: [{ schemes: { api: { list: ['read'] } } }],
    };
    const result = decorateAgentCardWithAuth(card, enabledConfig);
    expect(result.security).toHaveLength(2);
    expect(result.security?.[0]?.schemes?.['api']?.list).toEqual(['read']);
    expect(
      result.security?.[1]?.schemes?.[DEFAULT_OIDC_SECURITY_SCHEME_NAME]
    ).toBeDefined();
  });

  it('honours a custom schemeName', () => {
    const result = decorateAgentCardWithAuth(baseCard(), enabledConfig, {
      schemeName: 'keycloak',
    });
    expect(result.securitySchemes?.['keycloak']).toBeDefined();
    expect(result.security?.[0]?.schemes?.['keycloak']).toBeDefined();
  });
});
