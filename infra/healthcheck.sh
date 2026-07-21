#!/usr/bin/env bash
# TideWork production healthcheck. Run by tidework-healthcheck.timer; emails via
# Resend (HTTP API) only on a status CHANGE (failing<->healthy) so it doesn't
# spam. Exit non-zero when something is wrong (so `systemctl status` shows it).
#
# Config it reads:
#   /root/.config/tidework-alert/resend.key   the Resend API key (chmod 600)
#   TIDEWORK_ALERT_TO / TIDEWORK_ALERT_FROM    overridable below
set -uo pipefail

ALERT_TO="${TIDEWORK_ALERT_TO:-mia.mowe@gmail.com}"
ALERT_FROM="${TIDEWORK_ALERT_FROM:-noreply@tidework.io}"
RESEND_KEY_FILE=/root/.config/tidework-alert/resend.key
STATE_FILE=/run/tidework-health.state
DISK_WARN_PCT=85
CERT_WARN_DAYS=14
PG_HOST="${PG_HOST:-db-pgsql-sfo2-50714-do-user-34911662-0.m.db.ondigitalocean.com}"
PG_PORT="${PG_PORT:-25060}"

fails=()
chk() { local d="$1"; shift; "$@" >/dev/null 2>&1 || fails+=("$d"); }

# Local app health
chk "Synapse /health"  curl -fsS -m 10 http://127.0.0.1:8008/health

# MAS, with self-heal. MAS has a zombie failure mode (2026-07-12 incident): a
# DB blip kills its HTTP task, the graceful shutdown hangs and is aborted, and
# the container stays "Up" with no listener — so restart:unless-stopped never
# fires and nginx 502s until someone restarts it. The image is distroless (no
# curl/shell), so a compose healthcheck can't probe it; heal from the host.
healed=""
mas_ok=true
curl -fsS -m 10 http://127.0.0.1:8091/health >/dev/null 2>&1 || mas_ok=false
if ! $mas_ok; then
  docker restart tidework-mas-1 >/dev/null 2>&1
  for _ in 1 2 3 4 5 6; do
    sleep 5
    curl -fsS -m 5 http://127.0.0.1:8091/health >/dev/null 2>&1 && { mas_ok=true; break; }
  done
  if $mas_ok; then
    healed="MAS /health was down; docker restart tidework-mas-1 recovered it"
  else
    fails+=("MAS /health (down, restart did not recover it)")
  fi
fi

# Public path: exercises nginx + a valid TLS cert + reachability end-to-end
chk "matrix.tidework.io" curl -fsS -m 12 https://matrix.tidework.io/_matrix/client/versions
chk "auth.tidework.io"   curl -fsS -m 12 https://auth.tidework.io/.well-known/openid-configuration
# Managed-DB reachability (TCP only — no auth/TLS handshake needed to prove up)
chk "Postgres reachable" timeout 6 bash -c "exec 3<>/dev/tcp/${PG_HOST}/${PG_PORT}"

# Disk
disk=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')
[ "${disk:-0}" -ge "$DISK_WARN_PCT" ] && fails+=("Disk ${disk}% used on /")

# TLS cert expiry on the public hosts
for host in matrix.tidework.io auth.tidework.io; do
  end=$(echo | timeout 10 openssl s_client -servername "$host" -connect "$host:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$end" ]; then
    days=$(( ($(date -d "$end" +%s) - $(date +%s)) / 86400 ))
    [ "$days" -lt "$CERT_WARN_DAYS" ] && fails+=("$host TLS cert expires in ${days}d")
  else
    fails+=("$host TLS cert check failed")
  fi
done

[ "${#fails[@]}" -eq 0 ] && status=ok || status=fail
prev=$(cat "$STATE_FILE" 2>/dev/null || echo "")
echo "$status" >"$STATE_FILE"

send() { # subject, body
  local key; key=$(cat "$RESEND_KEY_FILE" 2>/dev/null) || return 0
  [ -n "$key" ] || return 0
  curl -fsS -m 15 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" -H "Content-Type: application/json" \
    --data @- >/dev/null 2>&1 <<JSON
{"from":"$ALERT_FROM","to":["$ALERT_TO"],"subject":"$1","text":"$2"}
JSON
}

host=$(hostname)
if [ "$status" = fail ] && [ "$prev" != fail ]; then
  body="TideWork prod healthcheck FAILED on ${host}:\\n"
  for f in "${fails[@]}"; do body="${body} - ${f}\\n"; done
  send "[TideWork] prod ALERT ($host)" "$body"
elif [ "$status" = ok ] && [ "$prev" = fail ]; then
  send "[TideWork] prod recovered ($host)" "All healthchecks passing again."
fi

# Self-heal notice: always email — it's rare, and a silent restart would hide a
# recurring problem (repeated notices = time to find the root cause).
[ -n "$healed" ] && send "[TideWork] prod self-heal ($host)" "$healed"

[ "$status" = ok ]
