#!/usr/bin/env bash
#
# Bring the self-host stack up from nothing and prove it actually serves a
# TideWork-capable homeserver. This is what makes `infra/selfhost/` a supported
# path rather than a worked example: CI runs it on every change, so it cannot
# quietly stop working.
#
#   ./smoke-test.sh            # uses a throwaway .env, cleans up after itself
#
# Deliberately does NOT go through Caddy. Certificates need a public DNS name
# and a reachable port 80, neither of which exists on a CI runner, and faking
# them would test the fake. Caddy is exercised only as far as "the config
# parses"; everything below it is tested for real.
set -euo pipefail

cd "$(dirname "$0")"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "  ok   $*"; }

# Same trap as scripts/release.sh: Windows ships a `python3` stub on PATH that
# only advertises the Microsoft Store, so a name that resolves is not an
# interpreter. Ask each candidate its own version.
PY_BIN=""
for candidate in python3 python py; do
  resolved="$(command -v "$candidate" 2>/dev/null)" || continue
  "$resolved" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1 || continue
  PY_BIN="$resolved"; break
done
[ -n "$PY_BIN" ] || fail "python 3 is required (tried python3, python, py)"

SERVER_NAME="${SMOKE_SERVER_NAME:-smoke.test}"
PROJECT="tidework-selfhost-smoke"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.yml -f docker-compose.smoke.yml)

cleanup() {
  echo "--- cleaning up"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf data .env setup.log bootstrap.log
}
trap cleanup EXIT

echo "--- setup"
# Derived from .env.example, NOT hand-written here: the point is to exercise the
# defaults a real user gets. A test with its own config proves that config works
# and says nothing about the one we ship.
sed -e "s#^TIDEWORK_SERVER_NAME=.*#TIDEWORK_SERVER_NAME=$SERVER_NAME#"     -e "s#^TIDEWORK_HOSTNAME=.*#TIDEWORK_HOSTNAME=$SERVER_NAME#"     -e "s#^TIDEWORK_ACME_EMAIL=.*#TIDEWORK_ACME_EMAIL=smoke@$SERVER_NAME#"     .env.example > .env

# `bash ./setup.sh`, not `./setup.sh`: the executable bit does not survive every
# checkout (Windows, a downloaded zip), and CI failed on exactly that — "Permission
# denied" from a script that is committed as 100755.
# Show setup's output when it fails. Suppressing it turned a one-line cause
# ("Permission denied") into a job that just said FAIL: setup.sh.
if ! bash ./setup.sh > setup.log 2>&1; then
  echo "--- setup.sh output ---"
  cat setup.log
  fail "setup.sh"
fi
ok "setup.sh rendered the config and generated the key"

# The rendered config must be valid YAML and must not still contain a
# placeholder — a template that silently ships '${POSTGRES_PASSWORD}' as a
# literal password is a very confusing failure hours later.
"$PY_BIN" -c "
import sys, yaml
c = yaml.safe_load(open('data/synapse/homeserver.yaml'))
assert c['server_name'] == '$SERVER_NAME', c['server_name']
assert '\${' not in open('data/synapse/homeserver.yaml').read(), 'unsubstituted placeholder'
assert c['rc_message']['per_second'] >= 1, 'rc_message too low for TideWork writes'
" || fail "rendered homeserver.yaml is not valid or not fully substituted"
ok "homeserver.yaml is valid, fully substituted, and has usable rate limits"

# Caddy never starts here, but its config must still be syntactically valid —
# otherwise the first thing a real user hits is a proxy that will not boot.
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -e TIDEWORK_HOSTNAME="$SERVER_NAME" \
  -e TIDEWORK_SERVER_NAME="$SERVER_NAME" \
  -e TIDEWORK_ACME_EMAIL="smoke@$SERVER_NAME" \
  "${CADDY_IMAGE:-caddy:2-alpine}" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
  || fail "Caddyfile does not validate"
ok "Caddyfile validates"

echo "--- bringing up postgres + synapse"
"${COMPOSE[@]}" up -d postgres synapse || fail "docker compose up"

echo "--- waiting for synapse"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:8008/_matrix/client/versions" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && {
    "${COMPOSE[@]}" logs --tail 60 synapse
    fail "synapse did not become ready in 120s"
  }
  sleep 2
done
ok "synapse is serving the client API"

# The collation gotcha: Synapse starts and THEN refuses, so a healthy container
# is not proof. Its own startup check is the authority.
if "${COMPOSE[@]}" logs synapse 2>&1 | grep -qi "incorrect collation\|database has incorrect"; then
  fail "postgres was created with the wrong collation (needs C)"
fi
ok "postgres collation accepted by synapse"

echo "--- registering a user"
"${COMPOSE[@]}" exec -T synapse register_new_matrix_user \
  -c /data/homeserver.yaml -u smokeuser -p smoke-password-12345 --no-admin \
  http://localhost:8008 >/dev/null || fail "register_new_matrix_user"
ok "created @smokeuser:$SERVER_NAME"

echo "--- logging in the way TideWork does"
LOGIN=$(curl -fsS -X POST "http://localhost:8008/_matrix/client/v3/login" \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"smokeuser"},"password":"smoke-password-12345"}') \
  || fail "password login rejected — TideWork signs in this way"
TOKEN=$(printf '%s' "$LOGIN" | "$PY_BIN" -c "import json,sys; print(json.load(sys.stdin)['access_token'])")
[ -n "$TOKEN" ] || fail "no access token"
ok "password login works"

# The capabilities TideWork actually needs from a homeserver. Checking them here
# means a future Synapse release that drops one fails this job rather than a
# user's workspace.
echo "--- checking what TideWork needs"

# Distinguishing "this endpoint exists" from "this endpoint is missing" needs the
# errcode, not the status. Matrix answers M_NOT_FOUND when a thing does not exist
# YET, and M_UNRECOGNIZED when the server does not implement the endpoint at all
# — and for key backup on a fresh account the first is the NORMAL answer. A check
# that treated 404 as failure would fail against a healthy server; one that
# treated it as success would pass against a server with no key backup at all.
errcode() { # method, path, [body]
  local method="$1" path="$2" body="${3:-}"
  curl -sS -X "$method" -H "Authorization: Bearer $TOKEN"     -H 'Content-Type: application/json' ${body:+-d "$body"}     "http://localhost:8008$path" 2>/dev/null     | "$PY_BIN" -c "import json,sys
try: print(json.load(sys.stdin).get('errcode',''))
except Exception: print('')" 2>/dev/null || true
}

CODE="$(errcode GET /_matrix/client/v3/room_keys/version)"
[ "$CODE" = "M_UNRECOGNIZED" ] && fail "key backup not implemented — recovery on a new device would not work"
ok "key backup implemented (errcode '${CODE:-none}'; M_NOT_FOUND is healthy before a backup exists)"

CODE="$(errcode POST /_matrix/client/v3/keys/device_signing/upload '{}')"
[ "$CODE" = "M_UNRECOGNIZED" ] && fail "cross-signing not implemented — device verification would not work"
ok "cross-signing implemented (errcode '${CODE:-none}'; a UIA challenge is healthy)"

ROOM=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"preset":"private_chat","name":"smoke"}' \
  "http://localhost:8008/_matrix/client/v3/createRoom" \
  | "$PY_BIN" -c "import json,sys; print(json.load(sys.stdin)['room_id'])") \
  || fail "could not create a room"
ok "created a room"

curl -fsS -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"algorithm":"m.megolm.v1.aes-sha2"}' \
  "http://localhost:8008/_matrix/client/v3/rooms/$ROOM/state/m.room.encryption" >/dev/null \
  || fail "could not enable encryption on a room — this is the product"
ok "room encryption can be enabled"

curl -fsS -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"body":"x","msgtype":"m.text"}' \
  "http://localhost:8008/_matrix/client/v3/rooms/$ROOM/send/io.tidework.cell.update/smoke1" >/dev/null \
  || fail "could not send TideWork's custom event type"
ok "io.tidework.cell.update accepted"

# ── The invitation-token flow ───────────────────────────────────────────────
#
# This is the configuration worth recommending — self-serve sign-up that is not
# open to the world — so it is the one that must not quietly break. Re-render
# with tokens required, restart, and prove BOTH halves: a sign-up without a
# token is refused, and the same sign-up with one succeeds.
echo "--- invitation-token registration"

# No re-render here: invitation-only IS the default now, so this is the shipped
# configuration rather than a variant the test switched into.
grep -q '^registration_requires_token: true' data/synapse/homeserver.yaml   || fail "the default config does not require an invitation token"
ok "invitation tokens are the shipped default"

# Without a token: the server must OFFER the token stage and refuse to proceed.
FLOWS=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"username":"tokenless","password":"smoke-password-12345"}' \
  "http://localhost:8008/_matrix/client/v3/register" \
  | "$PY_BIN" -c "import json,sys; d=json.load(sys.stdin); print(' '.join(sorted({s for f in d.get('flows',[]) for s in f.get('stages',[])})))")
case "$FLOWS" in
  *m.login.registration_token*) ;;
  *) fail "server did not ask for a registration token (offered: ${FLOWS:-nothing})" ;;
esac
ok "sign-up without a token is challenged for one"

# The real first-run path, not a reimplementation of it: bootstrap.sh is what a
# user runs, so it is what gets tested. It starts the stack, creates the admin
# and mints the first invitation.
SMOKE_COMPOSE="${COMPOSE[*]}" TIDEWORK_ADMIN_USER=smokeadmin TIDEWORK_ADMIN_PASSWORD=smoke-password-12345   bash ./bootstrap.sh > bootstrap.log 2>&1 || { cat bootstrap.log; fail "bootstrap.sh"; }
REG_TOKEN=$(grep -oE 'Invitation  [A-Za-z0-9_-]+' bootstrap.log | awk '{print $2}')
[ -n "$REG_TOKEN" ] || { cat bootstrap.log; fail "bootstrap.sh printed no invitation token"; }
ok "bootstrap.sh created the admin and minted an invitation"

# With the token: the same two-stage handshake `complete_registration` performs.
SESSION=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d '{"username":"tokenuser","password":"smoke-password-12345"}' \
  "http://localhost:8008/_matrix/client/v3/register" \
  | "$PY_BIN" -c "import json,sys; print(json.load(sys.stdin).get('session',''))")
[ -n "$SESSION" ] || fail "no UIA session offered"

# Keep this response and check it. Discarding it turned "the token stage was
# rejected" into a confusing failure two steps later, where the server reported
# the dummy stage complete and the token stage still outstanding, with no hint
# as to why.
TOKEN_STAGE=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"tokenuser\",\"password\":\"smoke-password-12345\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$REG_TOKEN\",\"session\":\"$SESSION\"}}" \
  "http://localhost:8008/_matrix/client/v3/register")
# Assert on `completed`, NOT on the string appearing anywhere in the response:
# a UIA challenge always LISTS the token stage under `flows`, so a grep for the
# name passes even when the token was rejected. A check that cannot fail is
# worse than no check — this one silently passed through two flaky runs.
echo "$TOKEN_STAGE" \
  | "$PY_BIN" -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'm.login.registration_token' in d.get('completed',[]) else 1)" \
  || fail "the token stage did not complete: $(echo "$TOKEN_STAGE" | head -c 400)"

FINAL=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"tokenuser\",\"password\":\"smoke-password-12345\",\"auth\":{\"type\":\"m.login.dummy\",\"session\":\"$SESSION\"}}" \
  "http://localhost:8008/_matrix/client/v3/register")
echo "$FINAL" | grep -q '"user_id"' \
  || fail "registration with a valid token did not complete: $(echo "$FINAL" | head -c 200)"
ok "@tokenuser registered with the invitation token"

echo
echo "PASS — this stack serves a homeserver TideWork can use."
