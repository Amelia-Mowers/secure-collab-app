#!/usr/bin/env bash
#
# Generate the secrets and signing key, then render the Synapse config.
# Safe to re-run: existing secrets and the signing key are kept, and the config
# is re-rendered from the template.
#
#   cp .env.example .env && $EDITOR .env
#   ./setup.sh
#   docker compose up -d
set -euo pipefail

cd "$(dirname "$0")"
die() { echo "error: $*" >&2; exit 1; }

[ -f .env ] || die "no .env — copy .env.example to .env and edit it first"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

[ -n "${TIDEWORK_SERVER_NAME:-}" ] || die "TIDEWORK_SERVER_NAME is not set in .env"
[ -n "${TIDEWORK_HOSTNAME:-}" ] || die "TIDEWORK_HOSTNAME is not set in .env"
[ "$TIDEWORK_SERVER_NAME" != "example.org" ] \
  || die "TIDEWORK_SERVER_NAME is still example.org — it becomes every user ID here and cannot be changed later"
command -v docker >/dev/null || die "docker is required"

SYNAPSE_IMAGE="${SYNAPSE_IMAGE:-matrixdotorg/synapse:v1.148.0}"

# NOT `tr </dev/urandom | head -c 48`: head closes the pipe at 48 bytes, tr dies
# of SIGPIPE, and `set -o pipefail` turns that into a fatal error — the script
# exits 141 before doing anything, on every machine.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(24))'
  else
    die "need openssl or python3 to generate a secret"
  fi
}

# Write a generated secret back to .env so it survives a re-run. Regenerating
# either of these is destructive: a new database password locks the server out
# of its own data, and a new registration secret silently stops working for
# anyone holding the old one.
persist() { # key, value
  local tmp
  tmp="$(mktemp)"
  if grep -q "^$1=" .env; then
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k {print k, v; next} {print}' .env > "$tmp"
    mv "$tmp" .env
  else
    rm -f "$tmp"
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD="$(gen_secret)"
  persist POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
  echo "  generated POSTGRES_PASSWORD"
fi
if [ -z "${SYNAPSE_REGISTRATION_SHARED_SECRET:-}" ]; then
  SYNAPSE_REGISTRATION_SHARED_SECRET="$(gen_secret)"
  persist SYNAPSE_REGISTRATION_SHARED_SECRET "$SYNAPSE_REGISTRATION_SHARED_SECRET"
  echo "  generated SYNAPSE_REGISTRATION_SHARED_SECRET"
fi

mkdir -p data/synapse/media_store

# ── 1. Signing key ──────────────────────────────────────────────────────────
# Synapse's `generate` writes a whole starter config AND a signing key. We want
# only the key; our config is rendered over the top in step 2. It needs no
# database, so it runs before the stack is up.
SIGNING_KEY="data/synapse/${TIDEWORK_SERVER_NAME}.signing.key"
if [ ! -f "$SIGNING_KEY" ]; then
  echo "generating the signing key ..."
  docker run --rm \
    -v "$PWD/data/synapse:/data" \
    -e SYNAPSE_SERVER_NAME="$TIDEWORK_SERVER_NAME" \
    -e SYNAPSE_REPORT_STATS=no \
    "$SYNAPSE_IMAGE" generate >/dev/null
  [ -f "$SIGNING_KEY" ] || die "signing key was not generated (is the docker daemon running?)"
fi

# ── 2. Our config, over whatever `generate` left ────────────────────────────
export TIDEWORK_SERVER_NAME TIDEWORK_HOSTNAME POSTGRES_PASSWORD
export SYNAPSE_REGISTRATION_SHARED_SECRET
export SYNAPSE_ENABLE_REGISTRATION="${SYNAPSE_ENABLE_REGISTRATION:-false}"
# Federation off is a config block, not a flag — an empty whitelist means
# "federate with nobody".
if [ "${TIDEWORK_FEDERATION:-true}" = "false" ]; then
  export FEDERATION_BLOCK="federation_domain_whitelist: []"
else
  export FEDERATION_BLOCK=""
fi

echo "rendering config ..."
render() {
  if command -v envsubst >/dev/null 2>&1; then
    # Named substitutions only: a bare `envsubst` would also eat any `$` that
    # Synapse's own syntax might use in this template later.
    envsubst '${TIDEWORK_SERVER_NAME} ${TIDEWORK_HOSTNAME} ${POSTGRES_PASSWORD} ${SYNAPSE_ENABLE_REGISTRATION} ${SYNAPSE_REGISTRATION_SHARED_SECRET} ${FEDERATION_BLOCK}' \
      < synapse/homeserver.yaml.tmpl
  else
    # gettext is not installed everywhere; python is.
    python3 - <<'PY'
import os, sys
text = open("synapse/homeserver.yaml.tmpl", encoding="utf-8").read()
for k in ("TIDEWORK_SERVER_NAME", "TIDEWORK_HOSTNAME", "POSTGRES_PASSWORD",
          "SYNAPSE_ENABLE_REGISTRATION", "SYNAPSE_REGISTRATION_SHARED_SECRET",
          "FEDERATION_BLOCK"):
    text = text.replace("${%s}" % k, os.environ.get(k, ""))
sys.stdout.write(text)
PY
  fi
}
render > data/synapse/homeserver.yaml

grep -q '\${' data/synapse/homeserver.yaml \
  && die "config still contains an unsubstituted \${...} — check .env"

cat > data/synapse/log.config <<'YAML'
version: 1
formatters:
  precise:
    format: '%(asctime)s %(levelname)s %(name)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
YAML

echo
echo "ready. start it with:"
echo "    docker compose up -d"
echo

if [ "$TIDEWORK_SERVER_NAME" != "$TIDEWORK_HOSTNAME" ]; then
  cat <<EOF
DELEGATION — your server name ($TIDEWORK_SERVER_NAME) differs from where Synapse
runs ($TIDEWORK_HOSTNAME), so https://$TIDEWORK_SERVER_NAME must serve:

  /.well-known/matrix/client
      {"m.homeserver": {"base_url": "https://$TIDEWORK_HOSTNAME"}}

  /.well-known/matrix/server
      {"m.server": "$TIDEWORK_HOSTNAME:443"}

Both need  Access-Control-Allow-Origin: *  — the client one is fetched by a
browser, and a missing header there is the classic "works with curl, fails in
the app" failure.

EOF
fi

echo "then create your first account:"
echo "    ./register-user.sh alice"
