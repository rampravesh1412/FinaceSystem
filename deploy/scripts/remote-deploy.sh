#!/usr/bin/env bash
#
# The single command GitHub Actions runs over SSH. Registry credentials arrive on STDIN,
# never as an argument — anything in argv is visible in `ps` to every user on the box for
# as long as the command runs.
#
#   printf '%s' "$TOKEN" | ssh deploy@host \
#       "/srv/amiri/deploy/scripts/remote-deploy.sh <registry-user> <api-image> <web-image>"
#
# Keeping this here rather than inline in the workflow means the shell quoting is written
# once, in a file that can be run by hand when a deploy needs debugging.
set -euo pipefail

REGISTRY_USER="${1:?registry username}"
API_IMAGE="${2:?api image ref}"
WEB_IMAGE="${3:?web image ref}"

# The token is scoped to the workflow run that issued it and expires with it, but leaving
# it in ~/.docker/config.json until then still widens the blast radius of a compromised
# box for no benefit — the pull is over long before the job is.
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT

docker login ghcr.io -u "$REGISTRY_USER" --password-stdin

# Not `exec` — that would replace this shell and take the logout trap with it.
/srv/amiri/deploy/scripts/deploy.sh "$API_IMAGE" "$WEB_IMAGE"
