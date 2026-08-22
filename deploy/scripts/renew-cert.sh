#!/usr/bin/env bash
#
# Renewal check, run twice a day by amiri-certbot-renew.timer.
#
# certbot exits 0 and does nothing when the certificate has more than 30 days left, so
# running this often is free; the deploy hook only fires on an actual renewal.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The renewal config records the challenge method used at issuance. When that was
# --standalone, certbot would try to bind port 80 and lose it to nginx, so the method is
# forced to webroot here — the directory is bind-mounted into the web container and served
# under /.well-known/acme-challenge/ by both the :80 and :443 servers.
# shellcheck disable=SC1091
set -a; source ./.env; set +a

certbot renew \
    --webroot -w "${DATA_DIR}/certbot-www" \
    --non-interactive \
    --deploy-hook "docker compose -f $(pwd)/docker-compose.prod.yml exec -T web nginx -s reload"
