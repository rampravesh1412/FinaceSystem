#!/usr/bin/env bash
#
# Obtain the first Let's Encrypt certificate for the site.
#
#   ssh root@16.16.129.104 \
#     'LETSENCRYPT_EMAIL=you@example.com /srv/amiri/deploy/scripts/issue-cert.sh'
#
# As root — certbot writes to /etc/letsencrypt. Run once, after DNS for the domain
# resolves to this server. Renewals are automatic from then on
# (amiri-certbot-renew.timer → renew-cert.sh).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root — certbot writes to /etc/letsencrypt"; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
set -a; source ./.env; set +a

EMAIL="${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL — Let's Encrypt sends expiry warnings there}"
DOMAIN="${SERVER_NAME:?SERVER_NAME missing from .env}"
WEBROOT="${DATA_DIR}/certbot-www"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "Checking DNS"
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)"
public="$(curl -fsS --max-time 10 https://api.ipify.org || echo unknown)"
echo "    $DOMAIN → ${resolved:-<nothing>}"
echo "    this server → $public"
if [[ -n "$resolved" && "$public" != unknown && "$resolved" != "$public" ]]; then
    echo
    echo "    DNS does not point here. Let's Encrypt will fail the challenge and, after a"
    echo "    few attempts, rate-limit the domain for an hour. Fix DNS first."
    exit 1
fi

# Two challenge paths, chosen by whether nginx currently owns port 80. --standalone runs
# certbot's own listener, which cannot bind while the web container holds the port;
# --webroot drops the challenge file into the directory that container already serves.
if docker ps --format '{{.Names}}' | grep -qx amiri-web; then
    log "Requesting the certificate (webroot — nginx is running)"
    mkdir -p "$WEBROOT"
    certbot certonly --webroot -w "$WEBROOT" \
        -d "$DOMAIN" \
        --email "$EMAIL" --agree-tos --no-eff-email \
        --non-interactive --keep-until-expiring
else
    log "Requesting the certificate (standalone — port 80 is free)"
    certbot certonly --standalone \
        -d "$DOMAIN" \
        --email "$EMAIL" --agree-tos --no-eff-email \
        --non-interactive --keep-until-expiring
fi

log "Reloading nginx onto the new certificate"
# A restart, not a reload: on first issuance the container generated a self-signed
# placeholder and resolved /etc/nginx/certs to it. Only a fresh entrypoint run repoints
# those symlinks at /etc/letsencrypt. Later renewals rewrite the file behind the symlink,
# where a reload is enough — see renew-cert.sh.
docker compose -f docker-compose.prod.yml restart web 2>/dev/null || true

log "Done"
certbot certificates -d "$DOMAIN"
