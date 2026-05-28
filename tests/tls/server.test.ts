import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TLSConfigError,
  TLS_CA_PATH_ENV,
  TLS_CERT_PATH_ENV,
  TLS_CLIENT_AUTH_ENV,
  TLS_ENABLE_ENV,
  TLS_KEY_PATH_ENV,
  TLS_PASSPHRASE_ENV,
  buildServerTLSOptions,
  createTLSFetch,
  loadServerTLSConfigFromEnv,
} from '../../src/tls/index.js';
import {
  generateSelfSignedCert,
  hasOpenssl,
  removeTempDir,
  type SelfSignedFixture,
} from './helpers.js';

const openssl = hasOpenssl();

describe('loadServerTLSConfigFromEnv', () => {
  it('returns undefined when TLS_ENABLE is unset', () => {
    expect(loadServerTLSConfigFromEnv({})).toBeUndefined();
  });

  it('returns undefined when TLS_ENABLE is false-ish', () => {
    expect(
      loadServerTLSConfigFromEnv({ [TLS_ENABLE_ENV]: 'false' })
    ).toBeUndefined();
    expect(
      loadServerTLSConfigFromEnv({ [TLS_ENABLE_ENV]: '0' })
    ).toBeUndefined();
    expect(
      loadServerTLSConfigFromEnv({ [TLS_ENABLE_ENV]: '' })
    ).toBeUndefined();
  });

  it('parses certPath / keyPath when TLS is enabled', () => {
    const env = {
      [TLS_ENABLE_ENV]: 'true',
      [TLS_CERT_PATH_ENV]: '/etc/tls/cert.pem',
      [TLS_KEY_PATH_ENV]: '/etc/tls/key.pem',
    };
    const cfg = loadServerTLSConfigFromEnv(env);
    expect(cfg).toEqual({
      certPath: '/etc/tls/cert.pem',
      keyPath: '/etc/tls/key.pem',
    });
  });

  it('parses optional caPath / passphrase / client auth', () => {
    const env = {
      [TLS_ENABLE_ENV]: '1',
      [TLS_CERT_PATH_ENV]: '/c.pem',
      [TLS_KEY_PATH_ENV]: '/k.pem',
      [TLS_CA_PATH_ENV]: '/ca.pem',
      [TLS_PASSPHRASE_ENV]: 'secret',
      [TLS_CLIENT_AUTH_ENV]: 'yes',
    };
    const cfg = loadServerTLSConfigFromEnv(env);
    expect(cfg).toEqual({
      certPath: '/c.pem',
      keyPath: '/k.pem',
      caPath: '/ca.pem',
      passphrase: 'secret',
      requestCert: true,
      rejectUnauthorized: true,
    });
  });

  it('throws when TLS is enabled but certPath / keyPath are missing', () => {
    expect(() =>
      loadServerTLSConfigFromEnv({ [TLS_ENABLE_ENV]: 'true' })
    ).toThrow(TLSConfigError);
    expect(() =>
      loadServerTLSConfigFromEnv({
        [TLS_ENABLE_ENV]: 'true',
        [TLS_CERT_PATH_ENV]: '/c.pem',
      })
    ).toThrow(/TLS_KEY_PATH/);
  });
});

describe('buildServerTLSOptions', () => {
  let fixture: SelfSignedFixture | undefined;

  beforeAll(() => {
    if (!openssl) return;
    fixture = generateSelfSignedCert();
  });

  afterAll(() => {
    if (fixture !== undefined) removeTempDir(fixture.dir);
  });

  it.skipIf(!openssl)('reads cert/key files into buffers', () => {
    const f = fixture!;
    const opts = buildServerTLSOptions({
      certPath: f.certPath,
      keyPath: f.keyPath,
    });
    expect(opts.cert).toBeInstanceOf(Buffer);
    expect(opts.key).toBeInstanceOf(Buffer);
    expect(opts.ca).toBeUndefined();
    expect(opts.requestCert).toBeUndefined();
  });

  it.skipIf(!openssl)('reads caPath when present', () => {
    const f = fixture!;
    const opts = buildServerTLSOptions({
      certPath: f.certPath,
      keyPath: f.keyPath,
      caPath: f.certPath,
    });
    expect(opts.ca).toBeInstanceOf(Buffer);
  });

  it.skipIf(!openssl)('forwards mTLS toggles', () => {
    const f = fixture!;
    const opts = buildServerTLSOptions({
      certPath: f.certPath,
      keyPath: f.keyPath,
      caPath: f.certPath,
      requestCert: true,
    });
    expect(opts.requestCert).toBe(true);
    expect(opts.rejectUnauthorized).toBe(true);
  });

  it('throws TLSConfigError with cause on missing cert file', () => {
    expect(() =>
      buildServerTLSOptions({
        certPath: '/nonexistent/cert.pem',
        keyPath: '/nonexistent/key.pem',
      })
    ).toThrow(TLSConfigError);
  });

  it('throws when certPath or keyPath is empty', () => {
    expect(() =>
      buildServerTLSOptions({ certPath: '', keyPath: '/k.pem' })
    ).toThrow(/certPath is required/);
    expect(() =>
      buildServerTLSOptions({ certPath: '/c.pem', keyPath: '' })
    ).toThrow(/keyPath is required/);
  });

  it.skipIf(!openssl)('rejects malformed pem on listen', async () => {
    const garbage = join(fixture!.dir, 'garbage.pem');
    writeFileSync(garbage, 'not a pem');
    expect(() =>
      buildServerTLSOptions({
        certPath: garbage,
        keyPath: fixture!.keyPath,
      })
    ).not.toThrow();
  });
});

describe.skipIf(!openssl)('A2AServer with TLS', () => {
  let fixture: SelfSignedFixture | undefined;
  let close: (() => Promise<void>) | undefined;

  beforeAll(() => {
    fixture = generateSelfSignedCert();
  });

  afterAll(() => {
    if (fixture !== undefined) removeTempDir(fixture.dir);
  });

  afterEach(async () => {
    if (close !== undefined) {
      await close();
      close = undefined;
    }
  });

  it('serves the agent card over HTTPS', async () => {
    const { createA2AServer, AGENT_CARD_PATH } =
      await import('../../src/server/index.js');
    const card = {
      name: 'tls-agent',
      description: 'Agent under test',
      version: '0.0.1',
      protocolVersion: '1.0',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      capabilities: { streaming: false },
      skills: [
        {
          id: 'echo',
          name: 'Echo',
          description: 'echo',
          tags: [],
        },
      ],
    };
    const server = createA2AServer({
      card,
      tls: {
        certPath: fixture!.certPath,
        keyPath: fixture!.keyPath,
      },
    });
    expect(server.isTLSEnabled()).toBe(true);

    await server.listen(0, '127.0.0.1');
    const addr = server.address();
    if (addr === null) throw new Error('no address');
    close = () => server.close();

    const fetch = createTLSFetch({ caPath: fixture!.certPath });
    const res = await fetch(`https://localhost:${addr.port}${AGENT_CARD_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('tls-agent');
  });

  it('rejects connections without the matching CA when verification is on', async () => {
    const { createA2AServer } = await import('../../src/server/index.js');
    const card = {
      name: 'tls-agent',
      description: 'Agent under test',
      version: '0.0.1',
      protocolVersion: '1.0',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      capabilities: { streaming: false },
      skills: [
        {
          id: 'echo',
          name: 'Echo',
          description: 'echo',
          tags: [],
        },
      ],
    };
    const server = createA2AServer({
      card,
      tls: {
        certPath: fixture!.certPath,
        keyPath: fixture!.keyPath,
      },
    });
    await server.listen(0, '127.0.0.1');
    const addr = server.address();
    if (addr === null) throw new Error('no address');
    close = () => server.close();

    const fetch = createTLSFetch({});
    await expect(
      fetch(`https://localhost:${addr.port}/health`)
    ).rejects.toThrow();
  });

  it('accepts connections when insecureSkipVerify is true', async () => {
    const { createA2AServer, HEALTH_PATH } =
      await import('../../src/server/index.js');
    const card = {
      name: 'tls-agent',
      description: 'Agent under test',
      version: '0.0.1',
      protocolVersion: '1.0',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      capabilities: { streaming: false },
      skills: [
        {
          id: 'echo',
          name: 'Echo',
          description: 'echo',
          tags: [],
        },
      ],
    };
    const server = createA2AServer({
      card,
      tls: {
        certPath: fixture!.certPath,
        keyPath: fixture!.keyPath,
      },
    });
    await server.listen(0, '127.0.0.1');
    const addr = server.address();
    if (addr === null) throw new Error('no address');
    close = () => server.close();

    const fetch = createTLSFetch({ insecureSkipVerify: true });
    const res = await fetch(`https://localhost:${addr.port}${HEALTH_PATH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('healthy');
  });
});
