# PowerShell mirror of deploy.sh for this Windows workstation, where only the
# Windows OpenSSH client can reach the ssh-agent (Git Bash / WSL ssh cannot).
# Pushes the COMPLETE bundle every time — cherry-picking files is how a stale
# remote-setup.sh once silently skipped a container recreate.
#
#   powershell -File infra/deploy.ps1            # default target
#   powershell -File infra/deploy.ps1 root@1.2.3.4
param([string]$Target = "root@142.93.86.143")
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==> pushing deploy bundle to $Target"
# Clean dirs first: scp -r into an existing directory NESTS instead of
# overwriting (deploy/nginx/nginx/...), which once hung a deploy.
ssh -o BatchMode=yes $Target "mkdir -p /srv/tidework/deploy && rm -rf /srv/tidework/deploy/synapse /srv/tidework/deploy/mas /srv/tidework/deploy/nginx /srv/tidework/deploy/systemd"
scp -q "$here\docker-compose.yml" "$here\remote-setup.sh" "$here\healthcheck.sh" "$here\db-ca.crt" "${Target}:/srv/tidework/deploy/"
scp -qr "$here\synapse" "$here\mas" "$here\nginx" "$here\systemd" "${Target}:/srv/tidework/deploy/"
scp -q "$here\secrets\postgres.sops.env" "${Target}:/srv/tidework/deploy/secrets.sops.env"
scp -q "$here\secrets\billing.sops.env" "${Target}:/srv/tidework/deploy/billing.sops.env"
scp -q "$here\secrets\email.sops.env" "${Target}:/srv/tidework/deploy/email.sops.env"

Write-Host "==> running remote setup"
ssh -o BatchMode=yes $Target "sed -i 's/\r$//' /srv/tidework/deploy/remote-setup.sh /srv/tidework/deploy/healthcheck.sh /srv/tidework/deploy/*/*.tmpl /srv/tidework/deploy/nginx/*.conf /srv/tidework/deploy/systemd/* 2>/dev/null; bash /srv/tidework/deploy/remote-setup.sh"

Write-Host "==> smoke checks"
ssh -o BatchMode=yes $Target 'curl -fsS https://matrix.tidework.io/_matrix/client/versions >/dev/null && echo "  synapse: OK"'
ssh -o BatchMode=yes $Target 'curl -fsS https://auth.tidework.io/.well-known/openid-configuration >/dev/null && echo "  mas: OK"'
Write-Host "DEPLOYED"
