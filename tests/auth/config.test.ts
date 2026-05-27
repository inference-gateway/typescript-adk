import { describe, expect, it } from 'vitest';
import {
  isAuthConfigComplete,
  loadAuthConfigFromEnv,
} from '../../src/auth/config.js';

describe('loadAuthConfigFromEnv', () => {
  it('defaults to disabled with empty fields', () => {
    const config = loadAuthConfigFromEnv({});
    expect(config.enable).toBe(false);
    expect(config.issuerUrl).toBe('');
    expect(config.clientId).toBe('');
    expect(config.clientSecret).toBe('');
  });

  it('parses AUTH_ENABLE as a boolean', () => {
    expect(loadAuthConfigFromEnv({ AUTH_ENABLE: 'true' }).enable).toBe(true);
    expect(loadAuthConfigFromEnv({ AUTH_ENABLE: '1' }).enable).toBe(true);
    expect(loadAuthConfigFromEnv({ AUTH_ENABLE: 'YES' }).enable).toBe(true);
    expect(loadAuthConfigFromEnv({ AUTH_ENABLE: 'false' }).enable).toBe(false);
    expect(loadAuthConfigFromEnv({ AUTH_ENABLE: '0' }).enable).toBe(false);
    expect(loadAuthConfigFromEnv({ AUTH_ENABLE: 'bogus' }).enable).toBe(false);
  });

  it('reads issuer URL, client ID, and client secret verbatim', () => {
    const config = loadAuthConfigFromEnv({
      AUTH_ENABLE: 'true',
      AUTH_ISSUER_URL: 'https://issuer.example.com',
      AUTH_CLIENT_ID: 'my-client',
      AUTH_CLIENT_SECRET: 's3cret',
    });
    expect(config).toEqual({
      enable: true,
      issuerUrl: 'https://issuer.example.com',
      clientId: 'my-client',
      clientSecret: 's3cret',
    });
  });
});

describe('isAuthConfigComplete', () => {
  it('returns false when disabled', () => {
    expect(
      isAuthConfigComplete({
        enable: false,
        issuerUrl: 'https://issuer.example.com',
        clientId: 'id',
        clientSecret: 'secret',
      })
    ).toBe(false);
  });

  it('returns false when any required field is empty', () => {
    expect(
      isAuthConfigComplete({
        enable: true,
        issuerUrl: '',
        clientId: 'id',
        clientSecret: 'secret',
      })
    ).toBe(false);
    expect(
      isAuthConfigComplete({
        enable: true,
        issuerUrl: 'https://issuer.example.com',
        clientId: '',
        clientSecret: 'secret',
      })
    ).toBe(false);
    expect(
      isAuthConfigComplete({
        enable: true,
        issuerUrl: 'https://issuer.example.com',
        clientId: 'id',
        clientSecret: '',
      })
    ).toBe(false);
  });

  it('returns true when enabled and all required fields are set', () => {
    expect(
      isAuthConfigComplete({
        enable: true,
        issuerUrl: 'https://issuer.example.com',
        clientId: 'id',
        clientSecret: 'secret',
      })
    ).toBe(true);
  });
});
