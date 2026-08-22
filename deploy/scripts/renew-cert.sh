#!/usr/bin/env bash
#
# Renewal check, run twice a day by amiri-certbot-renew.timer.
#
# certbot exits 0 and does nothing when the certificate has more than 30 days left, so
# running this often is free.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
set -a; source ./.env; set +a

# --webroot overrides whatever the renewal config recorded at issuance. If that was
# --standalone, certbot would try to bind port 80 and lose it to nginx; the webroot
# directory is bind-mounted into the web container and served under
# /.well-known/acme-challenge/ by both its :80 and :443 servers.
docker run --rm \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v /var/lib/letsencrypt:/var/lib/letsencrypt \
    -v "${DATA_DIR}/certbot-www:/var/www/certbot" \
    certbot/certbot renew --webroot -w /var/www/certbot --non-interactive

# Unconditional, rather than via certbot's --deploy-hook: the hook runs INSIDE the
# container, which has no docker socket and so cannot reload anything. A no-op reload
# twice a day costs nothing; a renewed certificate that nginx never picks up costs the
# site.
docker compose -f docker-compose.prod.yml exec -T web nginx -s reload 2>/dev/null \
    || true
