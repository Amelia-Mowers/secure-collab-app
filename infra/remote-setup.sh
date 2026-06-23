#!/usr/bin/env bash
#
# Server-side setup for the TideWork stack — invoked by deploy.sh, runs ON the
# droplet as root. Idempotent: first run does one-time generation (Synapse
# signing key, MAS secrets, databases, TLS certs); later runs just re-render
# configs and restart what changed.
#
# Tier-2 secrets: this host's SSH host key (ed25519) is a sops/age recipient,
# so decryption happens here and only here. Generated secrets (MAS keys,
# signing key) are created on this box and never leave it.
set -euo pipefail

DEPLOY=/srv/tidework/deploy
SRV=/srv/tidework
SOPS_VERSION=3.9.4
SSH_TO_AGE_VERSION=1.2.0

# ── Tooling (age via apt; sops + ssh-to-age pinned release binaries) ────────
if ! command -v age >/dev/null; then
  apt-get install -y -q age >/dev/null
fi
if ! command -v sops >/dev/null; then
  curl -fsSL -o /usr/local/bin/sops \
    "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64"
  chmod +x /usr/local/bin/sops
fi
if ! command -v ssh-to-age >/dev/null; then
  curl -fsSL "https://github.com/Mic92/ssh-to-age/releases/download/${SSH_TO_AGE_VERSION}/ssh-to-age.linux-amd64" \
    -o /usr/local/bin/ssh-to-age
  chmod +x /usr/local/bin/ssh-to-age
fi
if ! command -v psql >/dev/null; then
  apt-get install -y -q postgresql-client >/dev/null
fi

# ── Decrypt tier-2 secrets with this host's identity ────────────────────────
umask 077
mkdir -p "$SRV/secrets"
ssh-to-age -private-key -i /etc/ssh/ssh_host_ed25519_key > "$SRV/secrets/host-age-key.txt"
export SOPS_AGE_KEY_FILE="$SRV/secrets/host-age-key.txt"
sops -d "$DEPLOY/secrets.sops.env" > "$SRV/secrets/postgres.env"
set -a; . "$SRV/secrets/postgres.env"; set +a
sops -d "$DEPLOY/billing.sops.env" > "$SRV/secrets/billing.env"
set -a; . "$SRV/secrets/billing.env"; set +a
sops -d "$DEPLOY/email.sops.env" > "$SRV/secrets/email.env"
set -a; . "$SRV/secrets/email.env"; set +a

# ── One-time: MAS↔Synapse shared secrets (generated here, stay here) ────────
if [ ! -f "$SRV/secrets/shared.env" ]; then
  {
    echo "MAS_ADMIN_TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64)"
    echo "MAS_SYNAPSE_CLIENT_SECRET=$(head -c 32 /dev/urandom | xxd -p -c 64)"
  } > "$SRV/secrets/shared.env"
fi
set -a; . "$SRV/secrets/shared.env"; set +a

# ── One-time: databases on the managed cluster ──────────────────────────────
# verify-full for every psql/runtime connection: authenticate the server
# against the DO cluster CA (public cert shipped in the bundle).
export PGPASSWORD="$PG_PASSWORD"
export PGSSLMODE=verify-full
export PGSSLROOTCERT="$DEPLOY/db-ca.crt"
PSQL="psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d defaultdb -tAc"
for db in synapse mas; do
  if [ "$($PSQL "SELECT 1 FROM pg_database WHERE datname='$db'")" != "1" ]; then
    # Synapse requires C collation + UTF8.
    $PSQL "CREATE DATABASE $db ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0" >/dev/null
    echo "  created database: $db"
  fi
done
unset PGPASSWORD

# ── Render configs ──────────────────────────────────────────────────────────
mkdir -p "$SRV/synapse" "$SRV/mas"

# DB CA cert for sslmode=verify-full (public cert — safe to ship in the bundle).
# Mounted into each container (/data, /config); the per-dir chowns below give
# the synapse (991) and mas (65532) users read access.
cp "$DEPLOY/db-ca.crt" "$SRV/synapse/db-ca.crt"
cp "$DEPLOY/db-ca.crt" "$SRV/mas/db-ca.crt"

# ── One-time: MAS generated secrets (encryption + signing keys) ─────────────
if [ ! -f "$SRV/mas/secrets.yaml" ]; then
  docker run --rm ghcr.io/element-hq/matrix-authentication-service:1.12.0 \
    config generate 2>/dev/null \
    | python3 -c 'import sys,yaml; c=yaml.safe_load(sys.stdin); print(yaml.safe_dump({"secrets": c["secrets"]}))' \
    > "$SRV/mas/secrets.yaml"
  echo "  generated mas secrets"
fi

export PG_HOST PG_PORT PG_USER PG_PASSWORD MAS_ADMIN_TOKEN MAS_SYNAPSE_CLIENT_SECRET MAS_BILLING_CLIENT_SECRET SMTP_PASSWORD
envsubst '$PG_HOST $PG_PORT $PG_USER $PG_PASSWORD $MAS_ADMIN_TOKEN $MAS_SYNAPSE_CLIENT_SECRET' \
  < "$DEPLOY/synapse/homeserver.yaml.tmpl" > "$SRV/synapse/homeserver.yaml"
envsubst '$PG_HOST $PG_PORT $PG_USER $PG_PASSWORD $MAS_ADMIN_TOKEN $MAS_SYNAPSE_CLIENT_SECRET $MAS_BILLING_CLIENT_SECRET $SMTP_PASSWORD' \
  < "$DEPLOY/mas/config.yaml.tmpl" > "$SRV/mas/config.rendered.yaml"
# MAS 1.12 does not actually merge multiple --config files - combine the
# rendered config with the generated secrets into one file ourselves.
python3 - <<'PY'
import yaml
base = yaml.safe_load(open('/srv/tidework/mas/config.rendered.yaml'))
base.update(yaml.safe_load(open('/srv/tidework/mas/secrets.yaml')))
yaml.safe_dump(base, open('/srv/tidework/mas/config.yaml', 'w'))
PY
# The MAS container runs as uid 65532 (nonroot) and umask 077 makes the
# rendered files root-only — hand the mas dir to the container user.
chown -R 65532:65532 "$SRV/mas"

# ── One-time: Synapse signing key (generate in a scratch dir, keep only key) ─
if [ ! -f "$SRV/synapse/tidework.io.signing.key" ]; then
  TMP=$(mktemp -d)
  docker run --rm -v "$TMP":/data \
    -e SYNAPSE_SERVER_NAME=tidework.io -e SYNAPSE_REPORT_STATS=no \
    matrixdotorg/synapse:v1.148.0 generate >/dev/null
  cp "$TMP"/tidework.io.signing.key "$SRV/synapse/"
  rm -rf "$TMP"
  echo "  generated synapse signing key"
fi
mkdir -p "$SRV/synapse/media_store"
chown -R 991:991 "$SRV/synapse" # synapse container UID

# ── nginx vhosts + TLS ──────────────────────────────────────────────────────
cp "$DEPLOY/nginx/matrix.conf" /etc/nginx/sites-available/matrix.conf
cp "$DEPLOY/nginx/auth.conf" /etc/nginx/sites-available/auth.conf
ln -sf /etc/nginx/sites-available/matrix.conf /etc/nginx/sites-enabled/matrix.conf
ln -sf /etc/nginx/sites-available/auth.conf /etc/nginx/sites-enabled/auth.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx

# certonly + webroot: certbot obtains/renews certs but NEVER edits nginx
# config (the repo-managed vhosts own their TLS blocks and reference the
# cert paths directly). Renewals reload nginx via the deploy hook below.
mkdir -p /var/www/html
if [ ! -d /etc/letsencrypt/live/matrix.tidework.io ]; then
  certbot certonly --webroot -w /var/www/html --non-interactive --agree-tos -m admin@tidework.io --no-eff-email -d matrix.tidework.io -d auth.tidework.io
fi
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh
systemctl reload nginx
' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# ── Up ──────────────────────────────────────────────────────────────────────
cp "$DEPLOY/docker-compose.yml" "$SRV/docker-compose.yml"
cd "$SRV" && docker compose pull -q && docker compose up -d --wait --force-recreate
# --force-recreate: configs are bind-mounted files; compose can't see content
# changes, so recreate to pick up re-rendered configs every deploy.

# ── Monitoring: healthcheck timer that alerts via Resend on failure ─────────
# Reuses the decrypted $SMTP_PASSWORD (the Resend API key) as the alert creds —
# no separate secret to manage. Idempotent.
install -m 0755 "$DEPLOY/healthcheck.sh" /usr/local/bin/tidework-healthcheck.sh
install -m 0644 "$DEPLOY/systemd/tidework-healthcheck.service" /etc/systemd/system/tidework-healthcheck.service
install -m 0644 "$DEPLOY/systemd/tidework-healthcheck.timer" /etc/systemd/system/tidework-healthcheck.timer
mkdir -p /root/.config/tidework-alert
printf '%s' "$SMTP_PASSWORD" > /root/.config/tidework-alert/resend.key
chmod 600 /root/.config/tidework-alert/resend.key
systemctl daemon-reload
systemctl enable --now tidework-healthcheck.timer >/dev/null 2>&1 || true

echo "remote setup complete"
