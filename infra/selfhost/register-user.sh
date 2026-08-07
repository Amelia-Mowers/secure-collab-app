#!/usr/bin/env bash
#
# Create an account on your homeserver.
#
#   ./register-user.sh alice           # a normal user
#   ./register-user.sh alice --admin   # a server admin
#
# Registration is closed by default, so this is how accounts are made. It uses
# the shared secret in .env and talks to the running Synapse container.
set -euo pipefail

cd "$(dirname "$0")"
die() { echo "error: $*" >&2; exit 1; }

USERNAME="${1:-}"
[ -n "$USERNAME" ] || die "usage: ./register-user.sh <username> [--admin]"
ADMIN=""
[ "${2:-}" = "--admin" ] && ADMIN="--admin"
[ -z "$ADMIN" ] && ADMIN="--no-admin"

[ -f .env ] || die "no .env — run ./setup.sh first"
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ -n "${SYNAPSE_REGISTRATION_SHARED_SECRET:-}" ] || die "no SYNAPSE_REGISTRATION_SHARED_SECRET in .env — run ./setup.sh"

docker compose ps --status running --services 2>/dev/null | grep -qx synapse \
  || die "synapse is not running — start it with: docker compose up -d"

# Runs inside the container, against localhost, so the shared secret never
# leaves the host and never travels over the network.
docker compose exec -T synapse register_new_matrix_user \
  -c /data/homeserver.yaml \
  -u "$USERNAME" \
  $ADMIN \
  http://localhost:8008

cat <<EOF

Account created. Sign in at https://app.tidework.io — choose "Custom server"
and enter:

    https://${TIDEWORK_HOSTNAME}

Your user ID is @${USERNAME}:${TIDEWORK_SERVER_NAME}.

The app is a static site that runs entirely in your browser and talks only to
your homeserver; using ours to reach yours sends us nothing. If you would rather
not rely on that, host the app yourself — see docs/SELF_HOSTING.md.
EOF
