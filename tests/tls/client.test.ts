import { Agent } from 'node:https';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_TLS_CA_PATH_ENV,
  CLIENT_TLS_CERT_PATH_ENV,
  CLIENT_TLS_INSECURE_SKIP_VERIFY_ENV,
  CLIENT_TLS_KEY_PATH_ENV,
  CLIENT_TLS_PASSPHRASE_ENV,
  CLIENT_TLS_SERVERNAME_ENV,
  TLSConfigError,
  createTLSFetch,
  createTLSHttpsAgent,
  loadClientTLSConfigFromEnv,
} from '../../src/tls/index.js';
import {
  generateSelfSignedCert,
  hasOpenssl,
  removeTempDir,
  type SelfSignedFixture,
} from './helpers.js';

const openssl = hasOpenssl();

describe('loadClientTLSConfigFromEnv', () => {
  it('returns undefined when no client-TLS env vars are set', () => {
    expect(loadClientTLSConfigFromEnv({})).toBeUndefined();
  });

  it('parses every supported field', () => {
    const env = {
      [CLIENT_TLS_CERT_PATH_ENV]: '/c.pem',
      [CLIENT_TLS_KEY_PATH_ENV]: '/k.pem',
      [CLIENT_TLS_CA_PATH_ENV]: '/ca.pem',
      [CLIENT_TLS_PASSPHRASE_ENV]: 'pw',
      [CLIENT_TLS_INSECURE_SKIP_VERIFY_ENV]: 'true',
      [CLIENT_TLS_SERVERNAME_ENV]: 'override.example.com',
    };
    expect(loadClientTLSConfigFromEnv(env)).toEqual({
      certPath: '/c.pem',
      keyPath: '/k.pem',
      caPath: '/ca.pem',
      passphrase: 'pw',
      insecureSkipVerify: true,
      servername: 'override.example.com',
    });
  });

  it('returns a partial config when only some fields are set', () => {
    expect(
      loadClientTLSConfigFromEnv({ [CLIENT_TLS_CA_PATH_ENV]: '/ca.pem' })
    ).toEqual({ caPath: '/ca.pem' });
  });
});

describe('createTLSHttpsAgent', () => {
  let fixture: SelfSignedFixture | undefined;

  beforeAll(() => {
    if (!openssl) return;
    fixture = generateSelfSignedCert();
  });

  afterAll(() => {
    if (fixture !== undefined) removeTempDir(fixture.dir);
  });

  it('returns an https.Agent for a minimal CA-only config', () => {
    const agent = createTLSHttpsAgent({});
    expect(agent).toBeInstanceOf(Agent);
  });

  it.skipIf(!openssl)('reads cert/key/ca files into the agent', () => {
    const f = fixture!;
    const agent = createTLSHttpsAgent({
      certPath: f.certPath,
      keyPath: f.keyPath,
      caPath: f.certPath,
    });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('honors insecureSkipVerify', () => {
    const agent = createTLSHttpsAgent({ insecureSkipVerify: true });
    expect(agent).toBeInstanceOf(Agent);
  });

  it('throws when only one of certPath / keyPath is set', () => {
    expect(() => createTLSHttpsAgent({ certPath: '/c.pem' })).toThrow(
      TLSConfigError
    );
    expect(() => createTLSHttpsAgent({ keyPath: '/k.pem' })).toThrow(
      /both certPath and keyPath/
    );
  });

  it('throws TLSConfigError when a referenced cert file is missing', () => {
    expect(() =>
      createTLSHttpsAgent({
        certPath: '/nope/cert.pem',
        keyPath: '/nope/key.pem',
      })
    ).toThrow(TLSConfigError);
  });
});

describe('createTLSFetch', () => {
  it('returns a function with the fetch-like signature', () => {
    const fetch = createTLSFetch({});
    expect(typeof fetch).toBe('function');
    expect(fetch.length).toBeGreaterThanOrEqual(1);
  });

  it('delegates plaintext http requests to globalThis.fetch', async () => {
    const original = globalThis.fetch;
    let captured: string | undefined;
    globalThis.fetch = ((input: unknown) => {
      captured = String(input);
      return Promise.resolve(new Response('ok', { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      const fetch = createTLSFetch({ insecureSkipVerify: true });
      const res = await fetch('http://127.0.0.1:1/plain');
      expect(res.status).toBe(200);
      expect(captured).toBe('http://127.0.0.1:1/plain');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('A2AClient + LLM client config integration', () => {
  it('A2AClient rejects fetch + tls combination', async () => {
    const { A2AClient, A2AClientError } =
      await import('../../src/client/index.js');
    expect(
      () =>
        new A2AClient({
          baseURL: 'https://localhost:8443',
          fetch: globalThis.fetch as never,
          tls: { insecureSkipVerify: true },
        })
    ).toThrow(A2AClientError);
  });

  it('A2AClient builds a TLS-backed fetch when tls is set', async () => {
    const { A2AClient } = await import('../../src/client/index.js');
    const client = new A2AClient({
      baseURL: 'https://localhost:8443',
      tls: { insecureSkipVerify: true },
    });
    expect(client.getBaseURL()).toBe('https://localhost:8443');
  });

  it('OpenAICompatibleLLMClient rejects fetch + tls combination', async () => {
    const { OpenAICompatibleLLMClient, LLMConfigurationError } =
      await import('../../src/llm/index.js');
    expect(
      () =>
        new OpenAICompatibleLLMClient({
          provider: 'openai',
          model: 'gpt-4o',
          fetch: globalThis.fetch as never,
          tls: { insecureSkipVerify: true },
        })
    ).toThrow(LLMConfigurationError);
  });

  it('OpenAICompatibleLLMClient accepts tls alone', async () => {
    const { OpenAICompatibleLLMClient } =
      await import('../../src/llm/index.js');
    const client = new OpenAICompatibleLLMClient({
      provider: 'openai',
      model: 'gpt-4o',
      tls: { insecureSkipVerify: true },
    });
    expect(client.getModel()).toBe('gpt-4o');
  });
});
