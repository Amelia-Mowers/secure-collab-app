#!/usr/bin/env bash
# Create (or re-check) the public community room, #community:tidework.io.
#
#   MATRIX_TOKEN=... bash infra/community-room.sh
#
# Idempotent. If the alias already resolves it re-applies the state and exits,
# so running it twice cannot squat a second room on the alias — and so this
# file stays the description of what the room IS, not just how it was made
# once. Room state drifts (someone changes a topic in a client); this is what
# it is supposed to be.
#
# WHY NO SECOND HOMESERVER. The product homeserver already federates —
# tidework.io delegates to matrix.tidework.io:443 via .well-known — so a public
# room on it is joinable from any Matrix account on any server. A community
# homeserver would mean a second Synapse to run, patch and moderate, open
# registration to police, and (on a droplet already CPU-bound at ~1.2 of 2
# cores) most likely a second droplet. None of that buys anything a federated
# room does not already give.
#
# WHY THE ROOM IS NOT ENCRYPTED. It is public, and its whole purpose is to be
# readable — including by someone who lands on the community page with no
# account. Encrypting it would mean anyone joining later cannot read a word of
# the history. The product's E2EE guarantee is about workspaces; applying it to
# a public chat room would be cargo-culting the mechanism past its reason.
#
# GETTING A TOKEN (on the droplet — MAS owns auth, Synapse has no passwords):
#   ssh root@<host> "docker exec tidework-mas-1 mas-cli manage \
#       --config /config/config.yaml issue-compatibility-token mia"
# It is long-lived. Do not paste it anywhere that gets committed.
set -eu

HS="${HOMESERVER:-https://matrix.tidework.io}"
SERVER="${SERVER_NAME:-tidework.io}"
LOCALPART="${ALIAS_LOCALPART:-community}"
ALIAS="#${LOCALPART}:${SERVER}"
: "${MATRIX_TOKEN:?set MATRIX_TOKEN (see the header for how to mint one)}"

NAME="TideWork Community"
TOPIC="Questions, feedback and release notes for TideWork — the end-to-end encrypted collaborative workspace. Public and unencrypted: anything posted here is world-readable."

api() { # method, path, [json]
  local method="$1" path="$2"
  shift 2
  if [ "$#" -gt 0 ]; then
    # --data-binary @- rather than --data "$json": the topic contains an em
    # dash, and passing UTF-8 through an argument was enough to get
    # M_NOT_JSON back from Synapse on a Windows shell.
    printf '%s' "$1" | curl -fsS -X "$method" \
      -H "Authorization: Bearer $MATRIX_TOKEN" -H "Content-Type: application/json" \
      --data-binary @- "$HS$path"
  else
    curl -fsS -H "Authorization: Bearer $MATRIX_TOKEN" "$HS$path"
  fi
}

alias_encoded=$(printf '%%23%s%%3A%s' "$LOCALPART" "$SERVER")
room_id=$(api GET "/_matrix/client/v3/directory/room/$alias_encoded" 2>/dev/null \
          | sed -n 's/.*"room_id":"\([^"]*\)".*/\1/p' || true)

if [ -z "$room_id" ]; then
  # Deliberately minimal. A createRoom body carrying initial_state and
  # power_level_content_override was rejected with a bare 400, and a create
  # call that half-fails leaves an alias squatted on a misconfigured room.
  # Create the room, then set state explicitly — each step reports its own
  # failure, and re-running fixes exactly the step that broke.
  room_id=$(api POST /_matrix/client/v3/createRoom \
    "{\"preset\":\"public_chat\",\"room_alias_name\":\"$LOCALPART\",\"name\":\"$NAME\"}" \
    | sed -n 's/.*"room_id":"\([^"]*\)".*/\1/p')
  echo "created $ALIAS -> $room_id"
else
  echo "$ALIAS exists -> $room_id"
fi

encoded_room=$(printf '%s' "$room_id" | sed 's/!/%21/; s/:/%3A/')
state="/_matrix/client/v3/rooms/$encoded_room/state"

# world_readable, not the preset's "shared": the point of a community room is
# that someone can read it from a link before deciding to join, and that
# whoever joins in a year can read what was said this week.
api PUT "$state/m.room.history_visibility" '{"history_visibility":"world_readable"}' >/dev/null
api PUT "$state/m.room.topic" "$(printf '{"topic":"%s"}' "$TOPIC")" >/dev/null
echo "state applied: public, unencrypted, world-readable history"

# NOT published to the homeserver's own room directory: Synapse's default
# room_list_publication_rules denies it, and lifting that means a config change
# and a deploy for very little — our directory needs auth to read
# (allow_public_rooms_without_auth is off), so the only people who could browse
# to it are people who already have an account. The alias and the community
# page are the way in.
echo "join: https://matrix.to/#/$ALIAS"
