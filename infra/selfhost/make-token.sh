#!/usr/bin/env bash
#
# Mint an invitation token, so people can sign themselves up without the server
# being open to everyone.
#
#   ./make-token.sh                 # one use, never expires
#   ./make-token.sh --uses 10       # ten people
#   ./make-token.sh --days 7        # expires in a week
#
# This is the middle ground between the two bad options: an open server is found
# and abused within days, and creating every account by hand does not scale past
# a few people. You mint one token, share it with your team, and they sign up in
# the app — there is a field for it on the Create account tab.
#
# Requires SYNAPSE_OPEN_REGISTRATION=true and SYNAPSE_REGISTRATION_REQUIRES_TOKEN=true
# in .env (then ./setup.sh and `docker compose up -d`), which together mean
# "anyone with a token, nobody without".
set -euo pipefail

cd "$(dirname "$0")"
die() { echo "error: $*" >&2; exit 1; }

USES=1
DAYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uses) USES="${2:?--uses needs a number}"; shift 2 ;;
    --days) DAYS="${2:?--days needs a number}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -f .env ] || die "no .env — run ./setup.sh first"
# shellcheck disable=SC1091
set -a; . ./.env; set +a

PY_BIN=""
for candidate in python3 python py; do
  resolved="$(command -v "$candidate" 2>/dev/null)" || continue
  "$resolved" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1 || continue
  PY_BIN="$resolved"; break
done
[ -n "$PY_BIN" ] || die "python 3 is required"

docker compose ps --status running --services 2>/dev/null | grep -qx synapse \
  || die "synapse is not running — start it with: docker compose up -d"

if [ "${SYNAPSE_REGISTRATION_REQUIRES_TOKEN:-false}" != "true" ]; then
  echo "warning: SYNAPSE_REGISTRATION_REQUIRES_TOKEN is not true in .env," >&2
  echo "         so this server does not ask for a token and one will not help." >&2
  echo >&2
fi

# The admin API needs an admin's access token. Rather than store one, log in as
# an admin here, use it, and let it expire — nothing is written to disk.
read -r -p "admin username (created with ./register-user.sh <name> --admin): " ADMIN_USER
[ -n "$ADMIN_USER" ] || die "no username"
read -r -s -p "password for @$ADMIN_USER:$TIDEWORK_SERVER_NAME: " ADMIN_PASS
echo

LOGIN_JSON=$(docker compose exec -T synapse curl -sS -X POST \
  -H 'Content-Type: application/json' \
  -d "$("$PY_BIN" -c "
import json,sys
print(json.dumps({'type':'m.login.password',
                  'identifier':{'type':'m.id.user','user':sys.argv[1]},
                  'password':sys.argv[2]}))" "$ADMIN_USER" "$ADMIN_PASS")" \
  "http://localhost:8008/_matrix/client/v3/login") || die "login request failed"

ADMIN_TOKEN=$(printf '%s' "$LOGIN_JSON" | "$PY_BIN" -c "
import json,sys
d=json.load(sys.stdin)
if 'access_token' not in d:
    sys.stderr.write('login failed: %s\n' % d.get('error', d))
    sys.exit(1)
print(d['access_token'])") || exit 1

BODY=$("$PY_BIN" -c "
import json, sys, time
uses, days = int(sys.argv[1]), sys.argv[2]
body = {'uses_allowed': uses}
if days:
    body['expiry_time'] = int((time.time() + int(days) * 86400) * 1000)
print(json.dumps(body))" "$USES" "$DAYS")

RESULT=$(docker compose exec -T synapse curl -sS -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$BODY" \
  "http://localhost:8008/_synapse/admin/v1/registration_tokens/new") || die "token request failed"

TOKEN=$(printf '%s' "$RESULT" | "$PY_BIN" -c "
import json,sys
d=json.load(sys.stdin)
if 'token' not in d:
    sys.stderr.write('could not create a token: %s\n' % d.get('error', d))
    sys.exit(1)
print(d['token'])") || exit 1

cat <<EOF

Invitation token: $TOKEN

  uses:    $USES
  expires: ${DAYS:+in $DAYS day(s)}${DAYS:-never}

Share it with the people you want on this server. They sign up at the app,
choose "Custom server", enter https://$TIDEWORK_HOSTNAME, and paste the token
into the "Invitation token" field.

Treat it like an invitation, not a secret: anyone holding it can create an
account here, up to the number of uses above.
EOF
