# TLS A2A Example (self-signed)

A2A server + client that terminate TLS locally with a self-signed certificate. Mirrors the Go ADK's [`examples/tls-server/`](https://github.com/inference-gateway/adk/tree/main/examples/tls-server).

## What this example shows

- Generate a self-signed cert/key pair for `localhost` with `openssl`.
- Boot an `A2AServer` over HTTPS by passing `tls: { certPath, keyPath }` from `loadServerTLSConfigFromEnv()`.
- Connect with `A2AClient` configured via `tls: { caPath }` so the client trusts the self-signed cert without disabling verification.
- Show both modes for the client: trust the local CA (`CLIENT_TLS_CA_PATH`) or skip verification entirely (`CLIENT_TLS_INSECURE_SKIP_VERIFY=true`) for quick smoke tests.

## Layout

```text
examples/tls-server/
├── README.md
├── certs/                  # generated, gitignored
│   ├── cert.pem
│   └── key.pem
├── client.ts               # HTTPS A2AClient with custom CA
├── generate-certs.sh       # self-signed cert generator (openssl)
├── package.json            # workspace package, depends only on @inference-gateway/adk
├── server.ts               # HTTPS A2A server + echo worker
└── tsconfig.json
```

## Running it

From the repo root:

```sh
pnpm install
```

### 1. Generate a local cert

```sh
cd examples/tls-server
bash ./generate-certs.sh
```

This writes a 10-year self-signed cert to `./certs/cert.pem` and an unencrypted private key to `./certs/key.pem`. Both files cover the `localhost` DNS name and the `127.0.0.1` IP.

> **Do not ship this cert.** It exists for local development only. In production, point `TLS_CERT_PATH` / `TLS_KEY_PATH` at a real cert chain - e.g. one issued by your internal CA or a public CA like Let's Encrypt.

### 2. Start the server

```sh
TLS_ENABLE=true \
TLS_CERT_PATH=./certs/cert.pem \
TLS_KEY_PATH=./certs/key.pem \
pnpm --filter @inference-gateway/adk-example-tls-server start:server
```

### 3. Run the client

In a second terminal:

```sh
CLIENT_TLS_CA_PATH=./examples/tls-server/certs/cert.pem \
pnpm --filter @inference-gateway/adk-example-tls-server start:client
```

(`CLIENT_TLS_CA_PATH` is the CA bundle the client trusts. Because the cert is self-signed, it is its own issuer - pointing at the cert file works.)

For a quick smoke test against a cert you don't trust:

```sh
CLIENT_TLS_INSECURE_SKIP_VERIFY=true \
pnpm --filter @inference-gateway/adk-example-tls-server start:client
```

## Configuration

### Server env vars (consumed by `loadServerTLSConfigFromEnv`)

| Env var           | Required when TLS is enabled | Description                                                                              |
| ----------------- | :--------------------------: | ---------------------------------------------------------------------------------------- |
| `TLS_ENABLE`      |              ✓               | Master toggle. Truthy values: `true`, `1`, `yes`, `on`.                                  |
| `TLS_CERT_PATH`   |              ✓               | Path to the server's TLS certificate (PEM).                                              |
| `TLS_KEY_PATH`    |              ✓               | Path to the server's TLS private key (PEM).                                              |
| `TLS_CA_PATH`     |                              | CA bundle for verifying client certificates (mTLS only).                                 |
| `TLS_PASSPHRASE`  |                              | Passphrase that unlocks `TLS_KEY_PATH`. Omit if the key is unencrypted.                  |
| `TLS_CLIENT_AUTH` |                              | Request + require a client cert (mTLS). Truthy values as above; pair with `TLS_CA_PATH`. |

### Client env vars (consumed by `loadClientTLSConfigFromEnv`)

| Env var                           | Description                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `CLIENT_TLS_CA_PATH`              | CA bundle used to verify the peer cert. Required for self-signed / private-CA targets.             |
| `CLIENT_TLS_CERT_PATH`            | Client certificate (PEM) - only needed when the peer asks for one (mTLS).                          |
| `CLIENT_TLS_KEY_PATH`             | Client private key (PEM) - paired with `CLIENT_TLS_CERT_PATH`.                                     |
| `CLIENT_TLS_PASSPHRASE`           | Passphrase that unlocks `CLIENT_TLS_KEY_PATH`. Omit if the key is unencrypted.                     |
| `CLIENT_TLS_INSECURE_SKIP_VERIFY` | **Dev only.** Skip cert verification. Vulnerable to MITM - use `CLIENT_TLS_CA_PATH` in production. |
| `CLIENT_TLS_SERVERNAME`           | Override the SNI hostname (useful when the request URL is an IP literal).                          |

## Mounting certs in a container

When packaging an ADK agent as an image, the cert/key files don't belong in the image - mount them at runtime from a secret manager or platform-provided secret store.

### Docker

```sh
docker run --rm \
  -p 8443:8443 \
  -v /etc/tls/cert.pem:/run/secrets/tls/cert.pem:ro \
  -v /etc/tls/key.pem:/run/secrets/tls/key.pem:ro \
  -e TLS_ENABLE=true \
  -e TLS_CERT_PATH=/run/secrets/tls/cert.pem \
  -e TLS_KEY_PATH=/run/secrets/tls/key.pem \
  -e A2A_SERVER_HOST=0.0.0.0 \
  -e A2A_SERVER_PORT=8443 \
  my-agent:latest
```

### Kubernetes (Secret + volumeMount)

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: agent-tls
type: kubernetes.io/tls
data:
  tls.crt: <base64-cert>
  tls.key: <base64-key>
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: agent
          image: my-agent:latest
          env:
            - { name: TLS_ENABLE, value: 'true' }
            - { name: TLS_CERT_PATH, value: '/etc/tls/tls.crt' }
            - { name: TLS_KEY_PATH, value: '/etc/tls/tls.key' }
          volumeMounts:
            - { name: tls, mountPath: /etc/tls, readOnly: true }
          ports:
            - containerPort: 8443
      volumes:
        - name: tls
          secret:
            secretName: agent-tls
```

For mTLS, mount your CA bundle and set `TLS_CA_PATH` + `TLS_CLIENT_AUTH=true`. The server will then request and require a client cert during the handshake.
