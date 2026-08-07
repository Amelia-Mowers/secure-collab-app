#!/usr/bin/env bash
#
# Start the stack and make it usable: an admin account, and your first
# invitation token.
#
#   ./bootstrap.sh
#
# Separate from setup.sh because an account can only be created against a
# RUNNING homeserver, and setup.sh deliberately touches nothing that is running.
#
# Non-interactive (CI, or a re-run):
#   TIDEWORK_ADMIN_USER=admin TIDEWORK_ADMIN_PASSWORD=... ./bootstrap.sh
#
# Safe to re-run. An existing admin is left alone; a fresh invitation token is
# minted each time, which is the usual reason to run it again.
set -euo pipefail

cd "$(dirname "$0")"
die() { echo "error: $*" >&2; exit 1; }

[ -f .env ] || die "no .env — copy .env.example to .env, edit it, then run ./setup.sh"
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -f data/synapse/homeserver.yaml ] || die "no rendered config — run ./setup.sh first"

PY_BIN=""
for candidate in python3 python py; do
  resolved="$(command -v "$candidate" 2>/dev/null)" || continue
  "$resolved" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1 || continue
  PY_BIN="$resolved"; break
done
[ -n "$PY_BIN" ] || die "python 3 is required"

COMPOSE=(docker compose)
[ -n "${SMOKE_COMPOSE:-}" ] && read -r -a COMPOSE <<< "$SMOKE_COMPOSE"

echo "starting the stack ..."
"${COMPOSE[@]}" up -d || die "docker compose up failed"

# Reached through the compose network, so this works whether or not Synapse is
# published on a host port — the real deployment deliberately is not.
echo "waiting for synapse ..."
for i in $(seq 1 90); do
  if "${COMPOSE[@]}" exec -T synapse curl -fsS http://localhost:8008/health >/dev/null 2>&1; then
    break
  fi
  [ "$i" = 90 ] && {
    "${COMPOSE[@]}" logs --tail 40 synapse
    die "synapse did not become ready"
  }
  sleep 2
done

ADMIN_USER="${TIDEWORK_ADMIN_USER:-}"
if [ -z "$ADMIN_USER" ]; then
  read -r -p "admin username [admin]: " ADMIN_USER
  ADMIN_USER="${ADMIN_USER:-admin}"
fi

ADMIN_PASS="${TIDEWORK_ADMIN_PASSWORD:-}"
ADMIN_CREATED=""
if [ -z "$ADMIN_PASS" ]; then
  # Asked for rather than generated: this is the account that can create tokens
  # and administer the server, and a generated password printed to a terminal
  # ends up in scrollback and shell logs.
  read -r -s -p "password for @$ADMIN_USER:$TIDEWORK_SERVER_NAME: " ADMIN_PASS; echo
  read -r -s -p "again: " ADMIN_PASS2; echo
  [ "$ADMIN_PASS" = "$ADMIN_PASS2" ] || die "passwords do not match"
fi
[ -n "$ADMIN_PASS" ] || die "no password"

# register_new_matrix_user fails if the user exists, which is exactly the
# re-run case — so a failure here is only fatal if we cannot then log in.
if "${COMPOSE[@]}" exec -T synapse register_new_matrix_user \
  -c /data/homeserver.yaml -u "$ADMIN_USER" -p "$ADMIN_PASS" --admin \
  http://localhost:8008 >/dev/null 2>&1; then
  ADMIN_CREATED=yes
  echo "  created @$ADMIN_USER:$TIDEWORK_SERVER_NAME (admin)"
else
  echo "  @$ADMIN_USER:$TIDEWORK_SERVER_NAME already exists — leaving it alone"
fi

login_json() {
  "$PY_BIN" -c "
import json,sys
print(json.dumps({'type':'m.login.password',
                  'identifier':{'type':'m.id.user','user':sys.argv[1]},
                  'password':sys.argv[2]}))" "$ADMIN_USER" "$ADMIN_PASS"
}

ADMIN_TOKEN=$("${COMPOSE[@]}" exec -T synapse curl -sS -X POST \
  -H 'Content-Type: application/json' -d "$(login_json)" \
  http://localhost:8008/_matrix/client/v3/login \
  | "$PY_BIN" -c "
import json,sys
d = json.load(sys.stdin)
if 'access_token' not in d:
    sys.stderr.write('could not sign in as @%s: %s\n' % (sys.argv[1], d.get('error', d)))
    sys.exit(1)
print(d['access_token'])" "$ADMIN_USER") || die "admin sign-in failed (wrong password for an existing account?)"

INVITE=""
if [ "${SYNAPSE_REGISTRATION_REQUIRES_TOKEN:-false}" = "true" ]; then
  INVITE=$("${COMPOSE[@]}" exec -T synapse curl -sS -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
    -d '{"uses_allowed": 5}' \
    http://localhost:8008/_synapse/admin/v1/registration_tokens/new \
    | "$PY_BIN" -c "
import json,sys
d = json.load(sys.stdin)
if 'token' not in d:
    sys.stderr.write('could not mint an invitation token: %s\n' % d.get('error', d))
    sys.exit(1)
print(d['token'])") || die "could not mint an invitation token"
fi

# Written where a machine can read it exactly. Scraping the pretty block below
# is what broke the smoke test: its regex assumed the token alphabet and
# silently TRUNCATED any token containing a character outside it, which failed
# about one run in four and looked like a flake rather than a parsing bug.
if [ -n "$INVITE" ]; then
  printf '%s
' "$INVITE" > data/invitation.txt
  chmod 600 data/invitation.txt 2>/dev/null || true
fi

cat <<EOF

──────────────────────────────────────────────────────────────────────────────
Your homeserver is running.

  Address     https://$TIDEWORK_HOSTNAME
  Admin       @$ADMIN_USER:$TIDEWORK_SERVER_NAME
EOF

if [ -n "$INVITE" ]; then
  cat <<EOF
  Invitation  $INVITE   (5 uses, also in data/invitation.txt)

Give the invitation to the people you want on this server. They open
https://app.tidework.io, choose "Custom server", enter https://$TIDEWORK_HOSTNAME,
and paste it into the "Invitation token" field when creating an account.

Nobody without an invitation can sign up. Mint more with:
    ./make-token.sh --uses 10 --days 7
EOF
else
  cat <<EOF

Registration is closed, so accounts are created by you:
    ./register-user.sh alice

To let people sign themselves up with an invitation instead, set
SYNAPSE_REGISTRATION_REQUIRES_TOKEN=true and SYNAPSE_OPEN_REGISTRATION=true in
.env, then re-run ./setup.sh and this script.
EOF
fi

echo "──────────────────────────────────────────────────────────────────────────────"
[ -n "$ADMIN_CREATED" ] || echo "(admin already existed; a fresh invitation was minted)"
