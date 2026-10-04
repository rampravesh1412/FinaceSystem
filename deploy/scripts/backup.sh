#!/usr/bin/env bash
#
# Nightly mongodump, run by amiri-backup.timer.
#
# A gzipped archive per night into $DATA_DIR/backups, 14 kept. This is a same-box backup:
# it protects against a bad migration, a mistaken delete or a corrupted collection — not
# against losing the box. Ship these off-server (S3, another host) before treating the
# ledger as safely backed up.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck disable=SC1091
set -a; source ./.env; set +a

RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Against the BUNDLED mongo: every database, not just amiri_finance — `admin` holds the
# user definitions, and a restore that brings the ledger back but not the accounts that
# can read it is half a restore. Against an EXTERNAL cluster that is not possible, and the
# branch below dumps the application database alone; see the comment there.
ARCHIVE="/backups/amiri-all-${STAMP}.archive.gz"

# WHICH database gets dumped has to follow MONGODB_URI, not the compose topology. When the
# API is pointed at an external cluster the bundled mongo container keeps running as a
# compose dependency, and a backup that dumped it would quietly archive an empty database
# every night while the real ledger went unbacked-up — a green timer and no backups.
if [[ -n "${MONGODB_URI:-}" ]]; then
    # External cluster (Atlas). Neither --oplog nor an all-database dump works here: the
    # oplog lives in `local` and `admin` holds the provider's own users, and an
    # application user is granted read on neither. The URI names the database, so this
    # dumps exactly that one — the ledger, without the account definitions.
    #
    # Losing --oplog means losing point-in-time consistency across the dump. The managed
    # cluster's own continuous backups are the real protection there; this archive is for
    # a bad migration or a mistaken delete.
    docker compose -f docker-compose.prod.yml run --rm -T --no-deps \
        -e MONGODB_URI --entrypoint mongodump mongo \
            --uri="$MONGODB_URI" --gzip --archive="$ARCHIVE"
else
    # --oplog so the dump is a consistent snapshot rather than a smear across the run. The
    # ledger is written in transactions and a torn dump could restore half a posting.
    docker compose -f docker-compose.prod.yml exec -T \
        -e MONGO_ROOT_USER="$MONGO_ROOT_USER" \
        -e MONGO_ROOT_PASSWORD="$MONGO_ROOT_PASSWORD" \
        mongo mongodump \
            -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin \
            --oplog --gzip --archive="$ARCHIVE"
fi

HOST_ARCHIVE="${DATA_DIR}/backups/$(basename "$ARCHIVE")"
echo "wrote $HOST_ARCHIVE ($(du -h "$HOST_ARCHIVE" | cut -f1))"

find "${DATA_DIR}/backups" -name '*.archive.gz' -mtime "+${RETAIN_DAYS}" -delete

# Restore, for when it is needed and nobody wants to be inventing the command:
#
#   docker compose -f docker-compose.prod.yml exec -T mongo mongorestore \
#       -u "$MONGO_ROOT_USER" -p '<password>' --authenticationDatabase admin \
#       --gzip --archive=/backups/<file>.archive.gz --oplogReplay --drop
