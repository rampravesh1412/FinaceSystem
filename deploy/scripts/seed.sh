#!/usr/bin/env bash
#
# Seed the organisation, roles and the first admin user. Run ONCE, after the first
# successful deploy:
#
#   /srv/amiri/deploy/scripts/seed.sh
#
# `run --rm api` starts a throwaway container from the deployed image with the same env
# and network as the live one — the seed talks to the same database, then exits. tsx is a
# devDependency and is not in the production image, so the compiled script is used;
# apps/api/tsconfig.json emits src/scripts/ into dist/scripts/ along with everything else.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec docker compose -f docker-compose.prod.yml run --rm --no-deps api node dist/scripts/seed.js "$@"
