#!/usr/bin/env bash
#
# Create the FIRST super admin. Run once, after the first successful deploy:
#
#   sudo -u deploy /srv/amiri/deploy/scripts/bootstrap-admin.sh --email you@example.com --name "Your Name"
#
# It prompts for a password, checks it against the same policy the app enforces, and
# refuses to run a second time once a super admin exists. Add every further user from
# inside the app.
#
# This replaces a `seed.sh` that could never have worked: apps/api/src/scripts/seed.ts
# exits under NODE_ENV=production by design, because it creates four accounts whose
# password is written down in the repository.
#
# `run --rm` starts a throwaway container from the deployed image, with the same
# environment and network as the live one, so it talks to the same database and then
# exits. `--no-deps` because mongo is already up; letting compose start dependencies here
# would only re-run its health wait.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# No `-T`: compose allocates a TTY, which is what lets the script read the password
# without echoing it. Without a TTY it falls back to the ADMIN_PASSWORD variable.
exec docker compose -f docker-compose.prod.yml run --rm --no-deps api \
    node dist/scripts/bootstrap-admin.js "$@"
