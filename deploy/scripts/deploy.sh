#!/usr/bin/env bash
#
# Roll the server forward to a pair of already-built images. Invoked over SSH by
# .github/workflows/deploy.yml, and safe to run by hand:
#
#   /srv/amiri/deploy/scripts/deploy.sh ghcr.io/…/finacesystem-api:<tag> \
#                                       ghcr.io/…/finacesystem-web:<tag>
#
# Nothing is built here. The box has 1 vCPU's worth of ambition and a Vite build on it
# would take the site down with it; CI builds, the server only pulls.
#
# On any failure after the pull, the previous tags are put back and brought up again. A
# half-deployed accounting system is worse than an old one.
#
# -E so the ERR trap is inherited by functions and subshells; without it a failure inside
# one would exit without ever rolling back.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE="./.env"
COMPOSE=(docker compose -f docker-compose.prod.yml)

NEW_API_IMAGE="${1:?usage: deploy.sh <api-image> <web-image>}"
NEW_WEB_IMAGE="${2:?usage: deploy.sh <api-image> <web-image>}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m ✗  %s\033[0m\n' "$*"; }

# shellcheck disable=SC1091
set -a; source "$ENV_FILE"; set +a

PREV_API_IMAGE="${API_IMAGE:-}"
PREV_WEB_IMAGE="${WEB_IMAGE:-}"
log "current: ${PREV_API_IMAGE:-none} / ${PREV_WEB_IMAGE:-none}"
log "target:  $NEW_API_IMAGE / $NEW_WEB_IMAGE"

# `sed -i` in place rather than a rewrite, so the Mongo password and everything else in
# this file is impossible to lose to a bug in this script.
set_images() {
    sed -i "s|^API_IMAGE=.*|API_IMAGE=$1|" "$ENV_FILE"
    sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=$2|" "$ENV_FILE"
}

rollback() {
    if [[ -z "$PREV_API_IMAGE" || "$PREV_API_IMAGE" == *:bootstrap ]]; then
        fail "deploy failed and there is no previous release to fall back to"
        "${COMPOSE[@]}" ps
        exit 1
    fi
    fail "deploy failed — rolling back to $PREV_API_IMAGE"
    set_images "$PREV_API_IMAGE" "$PREV_WEB_IMAGE"
    "${COMPOSE[@]}" up -d --wait --wait-timeout 180 || fail "the rollback did not come up cleanly either"
    "${COMPOSE[@]}" ps
    exit 1
}

# ---------------------------------------------------------------------------------------
log "Pulling images"
# Pulled BEFORE .env is touched: a bad tag or an expired registry login should fail with
# the old release still recorded and still running.
docker pull -q "$NEW_API_IMAGE"
docker pull -q "$NEW_WEB_IMAGE"

set_images "$NEW_API_IMAGE" "$NEW_WEB_IMAGE"
trap rollback ERR

# ---------------------------------------------------------------------------------------
log "Database"
./scripts/mongo-init.sh

# ---------------------------------------------------------------------------------------
log "Starting the stack"
# --wait blocks until every service with a healthcheck reports healthy. Since web depends
# on api being healthy, a build that cannot reach Mongo or fails env validation never
# becomes the live site — it times out here and the trap puts the old one back.
"${COMPOSE[@]}" up -d --remove-orphans --wait --wait-timeout 240

# ---------------------------------------------------------------------------------------
log "Verifying"
# Through nginx and the proxy, over the real TLS listener, rather than by asking Docker
# whether it thinks the container is fine. --insecure because a fresh box may still be on
# the self-signed placeholder; this asserts the app answers, not that the chain is valid.
#
# GET /api/v1/ is the API's own banner route, so a 200 here proves the whole path works:
# TLS, nginx, the proxy hop, express, and an API process that got past env validation.
for i in $(seq 1 20); do
    if curl -fsS --insecure --max-time 10 "https://${SERVER_NAME}/api/v1/" | grep -q '"success":true'; then
        break
    fi
    [[ $i -eq 20 ]] && { fail "the API never answered through nginx"; "${COMPOSE[@]}" logs --tail=80 api web; false; }
    sleep 3
done

curl -fsS --insecure --max-time 10 -o /dev/null "https://${SERVER_NAME}/" \
    || { fail "the SPA shell did not load"; "${COMPOSE[@]}" logs --tail=80 web; false; }

trap - ERR

# ---------------------------------------------------------------------------------------
log "Cleaning up"
# Untagged layers only. Named images from the previous release are deliberately kept —
# they are what a manual rollback pulls from when the registry is unreachable.
docker image prune -f --filter "until=168h" >/dev/null || true

"${COMPOSE[@]}" ps
log "Deployed $NEW_API_IMAGE"
