import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * On-disk paths of a freshly minted self-signed cert / key pair. Generated
 * by {@link generateSelfSignedCert} into a unique temp directory that the
 * caller is responsible for cleaning up via {@link removeTempDir}.
 */
export interface SelfSignedFixture {
  /** Absolute path to the temp directory holding the PEM files. */
  readonly dir: string;
  /** Absolute path to the PEM-encoded server certificate. */
  readonly certPath: string;
  /** Absolute path to the PEM-encoded private key (unencrypted). */
  readonly keyPath: string;
  /** PEM contents of the certificate. */
  readonly certPem: string;
  /** PEM contents of the private key. */
  readonly keyPem: string;
}

/**
 * Shell out to `openssl` to generate a self-signed cert + key pair for
 * `localhost` (both DNS and 127.0.0.1 SANs) into a temp directory. Skip the
 * caller's test gracefully if `openssl` is not on PATH.
 *
 * Returns enough material for both server and client (via `caPath: certPath`)
 * since the certificate is its own issuer.
 */
export function generateSelfSignedCert(): SelfSignedFixture {
  const dir = mkdtempSync(join(tmpdir(), 'adk-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const confPath = join(dir, 'openssl.cnf');

  const config = `[req]
distinguished_name = dn
x509_extensions    = v3_req
prompt             = no

[dn]
CN = localhost

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth

[alt_names]
DNS.1 = localhost
IP.1  = 127.0.0.1
`;
  writeFileSync(confPath, config);

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-nodes',
      '-newkey',
      'rsa:2048',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '3650',
      '-config',
      confPath,
    ],
    { stdio: 'pipe' }
  );

  return {
    dir,
    certPath,
    keyPath,
    certPem: readFileSync(certPath, 'utf8'),
    keyPem: readFileSync(keyPath, 'utf8'),
  };
}

/** Recursively remove the fixture directory; ignores missing dirs. */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Whether the `openssl` binary is available on PATH. Tests that need real
 * cert material should `it.skipIf(!hasOpenssl())` so CI machines without
 * openssl don't false-fail.
 */
export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
