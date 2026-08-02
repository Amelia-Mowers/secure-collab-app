#!/usr/bin/env bash
# Start a STANDING Synapse for the client benchmarks, and register an account
# on it. Run inside the Nix dev shell, which provides `synapse_homeserver`:
#
#   nix develop --command bash ui/e2e/bench-synapse.sh start
#   nix develop --command bash ui/e2e/bench-synapse.sh stop
#
# WHY THIS EXISTS: the integration harness starts Synapse per-test inside Rust
# (crates/tables-over-matrix/tests/harness.rs), so there is no server a CLI can
# be pointed at. Benchmarks need one that outlives a single process — and one
# with PASSWORD login, which prod disables and which --sso cannot replace
# without a browser per sandbox.
#
# The config mirrors that harness deliberately: same registration settings, same
# relaxed rate limits. A benchmark should measure the client, not the server's
# rate-limit policy.
set -u

CMD="${1:-start}"
PORT="${BENCH_SYNAPSE_PORT:-8448}"
DIR="${BENCH_SYNAPSE_DIR:-/tmp/tidework-bench-synapse}"
URL="http://localhost:$PORT"
USER_NAME="${BENCH_USER:-benchuser}"
PASSWORD="${TIDEWORK_PASSWORD:-bench-pw-2026}"

stop_server() {
  if [ -f "$DIR/homeserver.pid" ]; then
    kill "$(cat "$DIR/homeserver.pid")" 2>/dev/null && echo "stopped synapse"
    rm -f "$DIR/homeserver.pid"
  else
    echo "no pid file at $DIR/homeserver.pid — nothing to stop"
  fi
}

case "$CMD" in
  stop) stop_server; exit 0 ;;
  start) ;;
  *) echo "usage: bench-synapse.sh [start|stop]" >&2; exit 2 ;;
esac

command -v synapse_homeserver >/dev/null 2>&1 || {
  echo "error: synapse_homeserver not on PATH — run inside 'nix develop'" >&2
  exit 1
}

# A fresh server every start. A benchmark against a database carrying rooms from
# a previous run is measuring the leftovers as much as the code.
stop_server >/dev/null 2>&1
rm -rf "$DIR"
mkdir -p "$DIR/media_store"

cat > "$DIR/log.yaml" <<YAML
version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
handlers:
  file:
    class: logging.FileHandler
    formatter: precise
    filename: $DIR/synapse.log
root:
  level: WARNING
  handlers: [file]
disable_existing_loggers: false
YAML

cat > "$DIR/homeserver.yaml" <<YAML
server_name: "localhost"
pid_file: $DIR/homeserver.pid
public_baseurl: "$URL/"
listeners:
  - port: $PORT
    type: http
    tls: false
    bind_addresses: ['127.0.0.1']
    x_forwarded: false
    resources:
      - names: [client]
        compress: false
database:
  name: sqlite3
  args:
    database: $DIR/homeserver.db
log_config: "$DIR/log.yaml"
media_store_path: $DIR/media_store
signing_key_path: "$DIR/signing.key"
trusted_key_servers: []
suppress_key_server_warning: true
report_stats: false
enable_registration: true
enable_registration_without_verification: true
registration_requires_token: false
macaroon_secret_key: "bench_macaroon_secret_do_not_use_in_prod"
form_secret: "bench_form_secret_do_not_use_in_prod"
presence:
  enabled: false
# Relaxed to match the integration harness: a benchmark should measure the
# client, not how quickly the server says "slow down".
rc_message:
  per_second: 1000
  burst_count: 5000
rc_registration:
  per_second: 1000
  burst_count: 1000
rc_login:
  address: { per_second: 1000, burst_count: 1000 }
  account: { per_second: 1000, burst_count: 1000 }
  failed_attempts: { per_second: 1000, burst_count: 1000 }
rc_joins:
  local: { per_second: 1000, burst_count: 1000 }
  remote: { per_second: 1000, burst_count: 1000 }
rc_invites:
  per_room: { per_second: 1000, burst_count: 1000 }
  per_user: { per_second: 1000, burst_count: 1000 }
  per_issuer: { per_second: 1000, burst_count: 1000 }
YAML

synapse_homeserver --config-path "$DIR/homeserver.yaml" --generate-keys >/dev/null 2>&1
nohup synapse_homeserver --config-path "$DIR/homeserver.yaml" > "$DIR/stdout.log" 2>&1 &

# 180s, not 60: the FIRST start runs database migrations and took longer than
# a minute on a cold box, so the original check reported failure while Synapse
# was still coming up perfectly well.
for i in $(seq 1 180); do
  if curl -fsS "$URL/_matrix/client/versions" >/dev/null 2>&1; then
    echo "synapse up at $URL after ${i}s"
    break
  fi
  sleep 1
  [ "$i" = 180 ] && { echo "synapse did not start; see $DIR/stdout.log" >&2; exit 1; }
done

# register_new_matrix_user needs the shared secret; simpler to use the public
# registration API, which this config enables.
reg=$(curl -fsS -X POST "$URL/_matrix/client/v3/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\",\"auth\":{\"type\":\"m.login.dummy\"},\"inhibit_login\":false}" 2>/dev/null)

if printf '%s' "$reg" | grep -q '"user_id"'; then
  echo "registered @$USER_NAME:localhost"
else
  echo "registration response: $reg" >&2
  echo "(if it says M_USER_IN_USE the account already exists, which is fine)" >&2
fi

cat <<INFO

Ready. To benchmark:

  export HOMESERVER=$URL
  export TIDEWORK_PASSWORD=$PASSWORD
  export TIDEWORK_RECOVERY_KEY=...   # see BENCH.md — the CLI cannot mint one yet
  bash ui/e2e/bench-coldstart.sh $USER_NAME 100 1000

Stop with: bash ui/e2e/bench-synapse.sh stop
INFO
