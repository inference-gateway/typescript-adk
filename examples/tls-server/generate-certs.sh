#!/usr/bin/env bash
# Generate a self-signed TLS cert + key for local development.
# Output: ./certs/cert.pem + ./certs/key.pem (10-year validity, CN=localhost,
# SANs for localhost + 127.0.0.1). Re-run anytime to rotate.
#
# Do NOT use the resulting cert/key in production - the private key has no
# passphrase and the cert chains to nothing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${DIR}/certs"
mkdir -p "${CERT_DIR}"

CONF="$(mktemp)"
trap 'rm -f "${CONF}"' EXIT

cat >"${CONF}" <<'EOF'
[req]
distinguished_name = dn
x509_extensions    = v3_req
prompt             = no

[dn]
CN = localhost

[v3_req]
subjectAltName   = @alt_names
basicConstraints = CA:FALSE
keyUsage         = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth

[alt_names]
DNS.1 = localhost
IP.1  = 127.0.0.1
EOF

openssl req \
  -x509 \
  -nodes \
  -newkey rsa:2048 \
  -keyout "${CERT_DIR}/key.pem" \
  -out "${CERT_DIR}/cert.pem" \
  -days 3650 \
  -config "${CONF}"

chmod 600 "${CERT_DIR}/key.pem"

echo "wrote ${CERT_DIR}/cert.pem"
echo "wrote ${CERT_DIR}/key.pem"
