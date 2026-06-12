#!/usr/bin/env bash
#
# Deploy the TideWork hosted homeserver stack to the droplet.
# Run from a workstation or CI with ssh access (the tidework_deploy /
# tidework_droplet key). Pushes configs + sops-ENCRYPTED secrets and runs
# remote-setup.sh on the server — the workstation/CI never decrypts anything
# (the droplet's SSH host key is a sops recipient; it decrypts locally).
#
#   bash infra/deploy.sh root@142.93.86.143
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> pushing deploy bundle"
ssh "$TARGET" "mkdir -p /srv/tidework/deploy"
scp -q \
  "$HERE/docker-compose.yml" \
  "$HERE/remote-setup.sh" \
  "$TARGET":/srv/tidework/deploy/
scp -qr "$HERE/synapse" "$HERE/mas" "$HERE/nginx" "$TARGET":/srv/tidework/deploy/
scp -q "$HERE/secrets/postgres.sops.env" "$TARGET":/srv/tidework/deploy/secrets.sops.env
scp -q "$HERE/secrets/billing.sops.env" "$TARGET":/srv/tidework/deploy/billing.sops.env

echo "==> running remote setup"
ssh "$TARGET" "bash /srv/tidework/deploy/remote-setup.sh"

echo "==> smoke checks"
ssh "$TARGET" 'curl -fsS https://matrix.tidework.io/_matrix/client/versions >/dev/null && echo "  synapse: OK"'
ssh "$TARGET" 'curl -fsS https://auth.tidework.io/.well-known/openid-configuration >/dev/null && echo "  mas: OK"'
ssh "$TARGET" 'curl -fsS https://matrix.tidework.io/_matrix/client/unstable/org.matrix.msc2965/auth_metadata 2>/dev/null | grep -q auth.tidework.io && echo "  synapse → mas delegation: OK" || echo "  delegation: check manually"'
echo "DEPLOYED"
