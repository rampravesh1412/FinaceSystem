#!/usr/bin/env bash
#
# Initialise the replica set and create the root user. Idempotent — deploy.sh runs it on
# every deploy, and after the first it is two cheap checks.
#
# The ordering here is the documented keyfile-replica-set procedure and it is the only one
# that works: with --keyFile, mongod requires authentication, but while the admin database
# holds no users the LOCALHOST EXCEPTION permits exactly two things from inside the
# container — rs.initiate(), and the creation of the first user. Do them in that order and
# the set comes up authenticated. Create the user first and rs.initiate() is then refused
# for want of credentials that cannot yet be presented.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
COMPOSE=(docker compose -f docker-compose.prod.yml)

# shellcheck disable=SC1091
set -a; source ./.env; set +a

log() { printf '\033[1;36m[mongo-init]\033[0m %s\n' "$*"; }

# Every command here has to work in both states this script can find the server in: before
# the root user exists, when only the localhost exception is available, and after, when
# almost everything except `ping` and `hello` requires credentials. Authenticated first,
# unauthenticated as the fallback — the reverse order would silently succeed against a
# pre-auth server and mask a wrong password in .env.
mongo_eval() {
    "${COMPOSE[@]}" exec -T mongo mongosh --quiet --norc \
        -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
        --eval "$1" 2>/dev/null \
    || "${COMPOSE[@]}" exec -T mongo mongosh --quiet --norc --eval "$1" 2>/dev/null
}

log "starting mongo"
"${COMPOSE[@]}" up -d mongo

# `up -d` returns once the container is running, which is well before mongod is listening.
# `ping` is one of the few commands answered pre-authentication, so it probes liveness in
# either state.
log "waiting for mongod to accept connections"
for i in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T mongo mongosh --quiet --norc \
            --eval 'db.adminCommand({ping:1}).ok' 2>/dev/null | grep -q 1; then
        break
    fi
    [[ $i -eq 60 ]] && { log "mongod never came up"; "${COMPOSE[@]}" logs --tail=50 mongo; exit 1; }
    sleep 2
done

# ---------------------------------------------------------------------------------------
# 1. Replica set
# ---------------------------------------------------------------------------------------
# The member host is `mongo:27017`, the compose service name — the driver reads the member
# list out of the replica-set config and dials what it finds there, so `localhost` would
# have the API container trying to reach a mongod inside itself.
if mongo_eval 'rs.status().ok' | grep -q 1; then
    log "replica set already initialised"
else
    log "initialising replica set rs0"
    # AlreadyInitialized (23) is swallowed rather than treated as failure: rs.status() can
    # also fail for want of credentials, and a needlessly aborted deploy is a worse
    # outcome than a redundant initiate.
    mongo_eval '
        try {
            rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongo:27017" }] });
            print("initiated");
        } catch (e) {
            if (e.code !== 23) throw e;
            print("already initiated");
        }
    ' | sed 's/^/    /'
fi

log "waiting for a PRIMARY"
for i in $(seq 1 60); do
    if mongo_eval 'db.hello().isWritablePrimary' | grep -q true; then
        break
    fi
    [[ $i -eq 60 ]] && { log "no primary was elected"; "${COMPOSE[@]}" logs --tail=50 mongo; exit 1; }
    sleep 2
done

# ---------------------------------------------------------------------------------------
# 2. Root user
# ---------------------------------------------------------------------------------------
# An authenticated ping is the check, not "does a user named X exist" — it proves the
# password in .env is the one the server holds, which is the thing the API is about to
# depend on.
if "${COMPOSE[@]}" exec -T mongo mongosh --quiet --norc \
        -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
        --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; then
    log "root user present and the password matches"
else
    log "creating root user $MONGO_ROOT_USER"
    "${COMPOSE[@]}" exec -T \
        -e MONGO_ROOT_USER="$MONGO_ROOT_USER" \
        -e MONGO_ROOT_PASSWORD="$MONGO_ROOT_PASSWORD" \
        mongo mongosh --quiet --norc --eval '
            db.getSiblingDB("admin").createUser({
                user: process.env.MONGO_ROOT_USER,
                pwd:  process.env.MONGO_ROOT_PASSWORD,
                roles: [{ role: "root", db: "admin" }],
            })
        '
    log "root user created — the localhost exception is now closed"
fi

log "ok"
