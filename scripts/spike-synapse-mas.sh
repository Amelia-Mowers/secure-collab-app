#!/usr/bin/env bash
#
# Throwaway Synapse + MAS (Matrix Authentication Service) stack for the
# ADR 0002 phase A spike: OAuth login from the WASM client.
#
# Mirrors the Conduit harness idiom (throwaway process, temp dirs, no docker):
#   - Postgres on a unix socket (no TCP port to collide)
#   - MAS on http://127.0.0.1:8090 (next-gen auth: OIDC issuer + hosted pages)
#   - Synapse on http://127.0.0.1:8008 with MSC3861 delegating auth to MAS
#
# Run with the bundled tools (Synapse w/ oidc extra, MAS, Postgres, curl,
# python3+pyyaml) layered onto the dev shell:
#   nix shell .#oauth-stack-tools --command \
#     nix develop --command bash scripts/spike-synapse-mas.sh
#
# The stack runs until killed (Ctrl-C); state lives in a temp dir printed at
# startup. Modes:
#   --check  bring the stack up, verify the OIDC wiring, tear down
#   --e2e    bring the stack up, register a test user, run the OAuth e2e spec
#            (ui/e2e/oauth.spec.ts), tear down — also what the `e2e-oauth`
#            CI job runs:
#            nix shell .#oauth-stack-tools --command \
#              nix develop --command bash scripts/spike-synapse-mas.sh --e2e
set -euo pipefail

SYNAPSE_PORT=8008
MAS_PORT=8090
MAS_HEALTH_PORT=8091
MAS_USER="spikeuser"
MAS_PASSWORD="spike-password-123!"

MODE="${1:-}"

for bin in mas-cli synapse_homeserver initdb pg_ctl psql python3; do
  command -v "$bin" >/dev/null || { echo "error: '$bin' not on PATH (run via nix shell — see header)" >&2; exit 1; }
done

# Not /tmp: under WSL the VM auto-stops between invocations and /tmp is tmpfs,
# so logs/state would vanish before they can be inspected.
mkdir -p "$HOME/.cache"
DIR="$(mktemp -d "$HOME/.cache/spike-mas-XXXXXX")"
echo "==> state dir: $DIR"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pg_ctl -D "$DIR/pg" stop -m immediate >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Postgres (unix socket only) ─────────────────────────────────────────────
echo "==> postgres: initdb"
initdb -D "$DIR/pg" --auth=trust --no-sync -U mas >"$DIR/initdb.log" 2>&1
mkdir -p "$DIR/pg-sock"
pg_ctl -D "$DIR/pg" -l "$DIR/pg.log" \
  -o "-c listen_addresses='' -c unix_socket_directories='$DIR/pg-sock'" start >/dev/null
psql -h "$DIR/pg-sock" -U mas -d postgres -c 'CREATE DATABASE mas' >/dev/null

# ── Secrets shared between MAS and Synapse ──────────────────────────────────
ADMIN_SECRET="$(head -c 32 /dev/urandom | xxd -p -c 64)"
CLIENT_SECRET="$(head -c 32 /dev/urandom | xxd -p -c 64)"

# ── MAS config ──────────────────────────────────────────────────────────────
echo "==> mas: generate + patch config"
mas-cli config generate >"$DIR/mas-base.yaml" 2>/dev/null

python3 - "$DIR" "$SYNAPSE_PORT" "$MAS_PORT" "$MAS_HEALTH_PORT" "$ADMIN_SECRET" "$CLIENT_SECRET" <<'PYEOF'
import sys, yaml

dir, synapse_port, mas_port, health_port, admin_secret, client_secret = sys.argv[1:7]

with open(f"{dir}/mas-base.yaml") as f:
    cfg = yaml.safe_load(f)

cfg["http"]["listeners"] = [
    {"name": "web",
     "resources": [{"name": n} for n in
                   ["discovery", "human", "oauth", "compat", "graphql", "assets"]],
     "binds": [{"host": "127.0.0.1", "port": int(mas_port)}],
     "proxy_protocol": False},
    {"name": "internal",
     "resources": [{"name": "health"}],
     "binds": [{"host": "127.0.0.1", "port": int(health_port)}],
     "proxy_protocol": False},
]
cfg["http"]["public_base"] = f"http://127.0.0.1:{mas_port}/"
cfg["http"]["issuer"] = f"http://127.0.0.1:{mas_port}/"
# sqlx needs a non-empty authority host; the `host` query param then overrides
# it with the unix socket directory.
cfg["database"]["uri"] = f"postgresql://mas@localhost/mas?host={dir}/pg-sock"
cfg["matrix"] = {
    "homeserver": "localhost",
    "secret": admin_secret,
    "endpoint": f"http://127.0.0.1:{synapse_port}/",
}
# The static OAuth client Synapse uses to talk to MAS (documented convention id).
cfg["clients"] = [{
    "client_id": "0000000000000000000SYNAPSE",
    "client_auth_method": "client_secret_basic",
    "client_secret": client_secret,
}]
cfg["passwords"] = {"enabled": True}
# Open password registration, no email verification — throwaway spike server.
cfg["account"] = {
    "password_registration_enabled": True,
    "email_change_allowed": False,
}
# Dev-only: the registration policy requires https client/redirect URIs in
# production; the throwaway stack serves the app from http://localhost.
cfg["policy"] = {
    "data": {
        "client_registration": {
            "allow_insecure_uris": True,
            "allow_host_mismatch": True,
        }
    }
}

with open(f"{dir}/mas.yaml", "w") as f:
    yaml.safe_dump(cfg, f)
PYEOF

echo "==> mas: migrate + start"
mas-cli database migrate --config "$DIR/mas.yaml" >"$DIR/mas-migrate.log" 2>&1 \
  || { echo "error: mas migrate failed:" >&2; tail -20 "$DIR/mas-migrate.log" >&2; exit 1; }
mas-cli config sync --config "$DIR/mas.yaml" >"$DIR/mas-sync.log" 2>&1 \
  || { echo "warning: mas config sync failed:" >&2; tail -10 "$DIR/mas-sync.log" >&2; }
mas-cli server --config "$DIR/mas.yaml" >"$DIR/mas.log" 2>&1 &
PIDS+=($!)

# ── Synapse config ──────────────────────────────────────────────────────────
echo "==> synapse: generate + patch config"
(cd "$DIR" && synapse_homeserver \
  --generate-config --server-name localhost \
  --config-path "$DIR/homeserver.yaml" --data-directory "$DIR/synapse" \
  --report-stats no >"$DIR/synapse-gen.log" 2>&1)

python3 - "$DIR" "$SYNAPSE_PORT" "$MAS_PORT" "$ADMIN_SECRET" "$CLIENT_SECRET" <<'PYEOF'
import sys, yaml

dir, synapse_port, mas_port, admin_secret, client_secret = sys.argv[1:6]

with open(f"{dir}/homeserver.yaml") as f:
    cfg = yaml.safe_load(f)

cfg["listeners"] = [{
    "port": int(synapse_port),
    "bind_addresses": ["127.0.0.1"],
    "type": "http",
    "x_forwarded": True,
    "resources": [{"names": ["client"], "compress": False}],
}]
cfg["experimental_features"] = {
    "msc3861": {
        "enabled": True,
        "issuer": f"http://127.0.0.1:{mas_port}/",
        "client_id": "0000000000000000000SYNAPSE",
        "client_auth_method": "client_secret_basic",
        "client_secret": client_secret,
        "admin_token": admin_secret,
        "account_management_url": f"http://127.0.0.1:{mas_port}/account",
    }
}
# MSC3861 requires registration + password auth off (MAS owns them).
cfg["enable_registration"] = False
cfg.pop("registration_shared_secret", None)
cfg["password_config"] = {"enabled": False}
cfg["suppress_key_server_warning"] = True

with open(f"{dir}/homeserver.yaml", "w") as f:
    yaml.safe_dump(cfg, f)
PYEOF

echo "==> synapse: start"
synapse_homeserver --config-path "$DIR/homeserver.yaml" >"$DIR/synapse.log" 2>&1 &
PIDS+=($!)

# ── Health checks ───────────────────────────────────────────────────────────
wait_for() { # url, name, tries
  for _ in $(seq 1 "${3:-60}"); do
    curl -fsS "$1" >/dev/null 2>&1 && { echo "==> $2: up"; return 0; }
    sleep 0.5
  done
  echo "error: $2 did not come up — see logs in $DIR" >&2
  tail -20 "$DIR/${4:-$2}.log" >&2 || true
  exit 1
}

wait_for "http://127.0.0.1:$MAS_HEALTH_PORT/health" "mas"
wait_for "http://127.0.0.1:$SYNAPSE_PORT/_matrix/client/versions" "synapse"

# ── Verify the MSC3861 wiring end to end ────────────────────────────────────
echo "==> checking OIDC discovery + delegation"
curl -fsS "http://127.0.0.1:$MAS_PORT/.well-known/openid-configuration" | head -c 200 >/dev/null \
  && echo "    mas issuer: OK"
AUTH_METADATA="$(curl -fsS "http://127.0.0.1:$SYNAPSE_PORT/_matrix/client/unstable/org.matrix.msc2965/auth_metadata" 2>/dev/null \
  || curl -fsS "http://127.0.0.1:$SYNAPSE_PORT/_matrix/client/v1/auth_metadata" 2>/dev/null || true)"
if echo "$AUTH_METADATA" | grep -q "127.0.0.1:$MAS_PORT"; then
  echo "    synapse → mas delegation: OK"
else
  echo "error: synapse auth_metadata does not point at MAS:" >&2
  echo "$AUTH_METADATA" | head -c 400 >&2
  exit 1
fi

echo
echo "READY"
echo "  synapse: http://127.0.0.1:$SYNAPSE_PORT"
echo "  mas:     http://127.0.0.1:$MAS_PORT"
echo "  logs:    $DIR"

if [[ "$MODE" == "--check" ]]; then
  echo "==> --check passed; tearing down"
  exit 0
fi

if [[ "$MODE" == "--e2e" ]]; then
  echo "==> registering test user '$MAS_USER'"
  mas-cli manage register-user --config "$DIR/mas.yaml" \
    --password "$MAS_PASSWORD" --ignore-password-complexity --yes "$MAS_USER" \
    >"$DIR/mas-register.log" 2>&1 \
    || { echo "error: user registration failed:" >&2; tail -20 "$DIR/mas-register.log" >&2; exit 1; }

  echo "==> running OAuth e2e spec"
  cd "$(dirname "$0")/../ui"
  E2E_SYNAPSE_URL="http://127.0.0.1:$SYNAPSE_PORT" \
  E2E_MAS_USER="$MAS_USER" E2E_MAS_PASSWORD="$MAS_PASSWORD" \
    npx playwright test e2e/oauth.spec.ts
  exit $?
fi

wait
