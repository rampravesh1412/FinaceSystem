#!/usr/bin/env bash
#
# Obtain the first Let's Encrypt certificate for the site.
#
#   sudo LETSENCRYPT_EMAIL=you@example.com /srv/amiri/deploy/scripts/issue-cert.sh
#
# Via sudo — it writes to /etc/letsencrypt. Run once, after DNS for the domain resolves to
# this server. Renewals are automatic from then on (amiri-certbot-renew.timer).
#
# certbot runs as a CONTAINER, not a package: Amazon Linux 2023 does not ship it, and the
# official image behaves identically everywhere, which matters for a script that has to
# work the same on this box and on whatever replaces it.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo — certbot writes to /etc/letsencrypt"; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
set -a; source ./.env; set +a

# No apostrophe in that message: bash parses a lone `'` inside ${VAR:?...} as opening a
# quote, and the script fails to parse rather than reporting the missing variable.
EMAIL="${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL — expiry warnings are sent there}"
DOMAIN="${SERVER_NAME:?SERVER_NAME missing from .env}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

CERTBOT=(
    docker run --rm
    -v /etc/letsencrypt:/etc/letsencrypt
    -v /var/lib/letsencrypt:/var/lib/letsencrypt
    -v "${DATA_DIR}/certbot-www:/var/www/certbot"
)

# ---------------------------------------------------------------------------------------
log "Checking DNS"
# Every A record, not just the first. Two records means round-robin: half the ACME
# validations land on the other machine, find no challenge file, and fail — and after a
# few of those the domain is rate-limited for an hour.
mapfile -t RESOLVED < <(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u)
PUBLIC="$(curl -fsS --max-time 10 \
    -H "X-aws-ec2-metadata-token: $(curl -fsS --max-time 5 -X PUT \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
        http://169.254.169.254/latest/api/token 2>/dev/null)" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null \
    || curl -fsS --max-time 10 https://api.ipify.org)"

echo "    $DOMAIN → ${RESOLVED[*]:-<nothing>}"
echo "    this server → $PUBLIC"

if [[ ${#RESOLVED[@]} -eq 0 ]]; then
    echo; echo "    $DOMAIN does not resolve. Create the A record first."; exit 1
fi
if [[ ${#RESOLVED[@]} -gt 1 ]]; then
    echo
    echo "    $DOMAIN has ${#RESOLVED[@]} A records. Delete every one except $PUBLIC —"
    echo "    with more than one, both the ACME challenge and real users are load-balanced"
    echo "    onto a machine that is not running this app."
    exit 1
fi
if [[ "${RESOLVED[0]}" != "$PUBLIC" ]]; then
    echo
    echo "    DNS points at ${RESOLVED[0]}, not at this server ($PUBLIC). Fix it and retry."
    exit 1
fi

# ---------------------------------------------------------------------------------------
# Two challenge paths, chosen by whether nginx currently owns port 80. --standalone runs
# certbot's own listener, which cannot bind while the web container holds the port;
# --webroot drops the challenge file into the directory that container already serves.
if docker ps --format '{{.Names}}' | grep -qx amiri-web; then
    log "Requesting the certificate (webroot — nginx is running)"
    mkdir -p "${DATA_DIR}/certbot-www"
    "${CERTBOT[@]}" certbot/certbot certonly --webroot -w /var/www/certbot \
        -d "$DOMAIN" \
        --email "$EMAIL" --agree-tos --no-eff-email \
        --non-interactive --keep-until-expiring
else
    log "Requesting the certificate (standalone — port 80 is free)"
    "${CERTBOT[@]}" -p 80:80 certbot/certbot certonly --standalone \
        -d "$DOMAIN" \
        --email "$EMAIL" --agree-tos --no-eff-email \
        --non-interactive --keep-until-expiring
fi

# ---------------------------------------------------------------------------------------
log "Reloading nginx onto the new certificate"
# A restart, not a reload: on first issuance the container generated a self-signed
# placeholder and pointed /etc/nginx/certs at it. Only a fresh entrypoint run repoints
# those symlinks into /etc/letsencrypt. Later renewals rewrite the file behind the
# symlink, where a reload is enough — see renew-cert.sh.
docker compose -f docker-compose.prod.yml restart web 2>/dev/null \
    || echo "    the stack is not up yet — the certificate is in place for the first deploy"

log "Done"
"${CERTBOT[@]}" certbot/certbot certificates -d "$DOMAIN"
