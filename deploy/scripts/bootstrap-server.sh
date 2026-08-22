#!/usr/bin/env bash
#
# One-time server bootstrap for account.amiri247.in — EC2 i-06ea805fe87ab2d93, t3.small,
# eu-north-1.
#
#   scp -i amiri.pem deploy/scripts/bootstrap-server.sh ec2-user@<IP>:/tmp/
#   ssh -i amiri.pem ec2-user@<IP> 'sudo bash /tmp/bootstrap-server.sh'
#
# sudo, not root: EC2 AMIs ship with direct root login disabled. The login user is
# `ec2-user` on Amazon Linux and `ubuntu` on the Ubuntu AMIs; both are supported.
#
# Idempotent by design — every step checks before it acts, so re-running it after a
# partial failure, or months later to pick up a change, is safe.
#
# What it leaves behind:
#   • Docker + the compose plugin
#   • a `deploy` user in the docker group, with an SSH key for GitHub Actions
#   • /srv/amiri/{deploy,uploads,secrets,backups,certbot-www}
#   • generated Mongo keyfile, Mongo root password and JWT secrets
#   • a 2 GB swapfile
#   • systemd timers for certificate renewal and nightly database backups
#
# It does NOT deploy the app. Push to main (or run the Deploy workflow) for that.
set -euo pipefail

DOMAIN="${DOMAIN:-account.amiri247.in}"
APP_USER="${APP_USER:-deploy}"
DATA_DIR="${DATA_DIR:-/srv/amiri}"
COMPOSE_VERSION="${COMPOSE_VERSION:-v2.32.4}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo: sudo bash $0"; exit 1; }

# ---------------------------------------------------------------------------------------
# Distribution
# ---------------------------------------------------------------------------------------
# Amazon Linux 2023 and Ubuntu differ in package manager, Docker packaging, whether the
# compose plugin is packaged at all, and whether there is a host firewall. Everything
# distro-specific is decided here and nowhere else.
. /etc/os-release
if   command -v dnf     >/dev/null 2>&1; then PKG=dnf
elif command -v apt-get >/dev/null 2>&1; then PKG=apt
else
    echo "Unsupported distribution: ${PRETTY_NAME:-unknown} (need dnf or apt)"
    exit 1
fi
log "Detected ${PRETTY_NAME:-unknown} — using $PKG"

# ---------------------------------------------------------------------------------------
log "Swap"
# t3.small is 2 GB. mongod, node and the nginx container fit, but with little headroom —
# and the failure mode without swap is the OOM killer choosing mongod mid-transaction.
# Swap here is a safety net, not capacity; if it is in steady use, the box is too small.
if ! swapon --show | grep -q .; then
    # dd rather than fallocate: on xfs (the Amazon Linux default) a fallocated file is
    # sparse, and mkswap rejects it.
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # The default of 60 swaps far too eagerly for a database host.
    sysctl -qw vm.swappiness=10
    grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo "    2G swapfile added"
else
    echo "    swap already configured"
fi

# ---------------------------------------------------------------------------------------
log "Base packages"
if [[ $PKG == dnf ]]; then
    # `curl` is deliberately NOT in this list. Amazon Linux 2023 preinstalls curl-minimal,
    # which already provides /usr/bin/curl; asking for the full curl package makes dnf
    # refuse the whole transaction over a file conflict rather than swapping the two.
    # Everything here speaks plain HTTPS, which curl-minimal handles.
    dnf install -y -q ca-certificates rsync tar openssl jq >/dev/null
    command -v curl >/dev/null || dnf install -y -q --allowerasing curl >/dev/null
else
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl gnupg rsync tar openssl jq
fi

# ---------------------------------------------------------------------------------------
log "Docker"
if ! command -v docker >/dev/null 2>&1; then
    if [[ $PKG == dnf ]]; then
        # Amazon Linux ships Docker in its own repositories; the upstream Docker CE repo
        # has no build for it.
        dnf install -y -q docker >/dev/null
    else
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
            | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y -qq \
            docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi
else
    echo "    already installed: $(docker --version)"
fi
systemctl enable --now docker >/dev/null

# Compose v2 is a CLI plugin, and Amazon Linux does not package it. Installed by hand
# there, into the directory docker looks in for plugins.
if ! docker compose version >/dev/null 2>&1; then
    log "Docker Compose plugin"
    PLUGIN_DIR=/usr/libexec/docker/cli-plugins
    mkdir -p "$PLUGIN_DIR"
    case "$(uname -m)" in
        x86_64)  COMPOSE_ARCH=x86_64 ;;
        aarch64) COMPOSE_ARCH=aarch64 ;;
        *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
    esac
    curl -fsSL -o "$PLUGIN_DIR/docker-compose" \
        "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}"
    chmod +x "$PLUGIN_DIR/docker-compose"
    docker compose version
fi

# ---------------------------------------------------------------------------------------
log "Deploy user and directory layout"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "$APP_USER"
fi
getent group docker >/dev/null || groupadd docker
usermod -aG docker "$APP_USER"

mkdir -p "$DATA_DIR"/{deploy,uploads,secrets,backups,certbot-www}
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR/secrets"

# Bind mounts carry host uids into the container, so these two have to be owned by the
# uid that writes them there, not by $APP_USER:
#   uploads  — the API runs as the image's unprivileged `node` user, uid 1000
#   backups  — mongodump runs as mongod's user inside mongo:7, uid 999
chown -R 1000:1000 "$DATA_DIR/uploads"
chown -R 999:999   "$DATA_DIR/backups"

# ---------------------------------------------------------------------------------------
log "SSH key for GitHub Actions"
CI_KEY="$DATA_DIR/secrets/ci_deploy_key"
if [[ ! -f "$CI_KEY" ]]; then
    ssh-keygen -t ed25519 -N '' -C "github-actions@$DOMAIN" -f "$CI_KEY" >/dev/null
    chown "$APP_USER:$APP_USER" "$CI_KEY" "$CI_KEY.pub"
fi
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "/home/$APP_USER/.ssh"
touch "/home/$APP_USER/.ssh/authorized_keys"
grep -qxFf "$CI_KEY.pub" "/home/$APP_USER/.ssh/authorized_keys" \
    || cat "$CI_KEY.pub" >> "/home/$APP_USER/.ssh/authorized_keys"
chown -R "$APP_USER:$APP_USER" "/home/$APP_USER/.ssh"
chmod 600 "/home/$APP_USER/.ssh/authorized_keys"

# ---------------------------------------------------------------------------------------
log "MongoDB keyfile"
# Internal replica-set authentication. mongod refuses to start if the keyfile is readable
# by group or other, or if it is not owned by the uid mongod runs as (999 in mongo:7).
KEYFILE="$DATA_DIR/secrets/mongo-keyfile"
if [[ ! -f "$KEYFILE" ]]; then
    openssl rand -base64 756 > "$KEYFILE"
fi
chmod 400 "$KEYFILE"
chown 999:999 "$KEYFILE"

# ---------------------------------------------------------------------------------------
log "Environment files"
gen_secret() { openssl rand -hex 32; }

ENV_FILE="$DATA_DIR/deploy/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    cat > "$ENV_FILE" <<EOF
# Written by bootstrap-server.sh. Read by docker compose; never committed.
DATA_DIR=$DATA_DIR
SERVER_NAME=$DOMAIN

# Overwritten by every deploy with the commit that is live.
API_IMAGE=ghcr.io/rampravesh1412/finacesystem-api:bootstrap
WEB_IMAGE=ghcr.io/rampravesh1412/finacesystem-web:bootstrap

MONGO_ROOT_USER=amiri_root
# Hex, so it needs no percent-encoding when it is spliced into the MONGODB_URI.
MONGO_ROOT_PASSWORD=$(gen_secret)

BACKUP_RETAIN_DAYS=14
EOF
    chown "$APP_USER:$APP_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
else
    echo "    $ENV_FILE exists — left untouched (it holds the live Mongo password)"
fi

API_ENV="$DATA_DIR/deploy/api.env"
if [[ ! -f "$API_ENV" ]]; then
    cat > "$API_ENV" <<EOF
# Written by bootstrap-server.sh. MONGODB_URI is NOT here — compose assembles it from
# .env so the database password has a single source of truth.
NODE_ENV=production
PORT=4000
API_PREFIX=/api/v1

MONGODB_DB_NAME=amiri_finance

JWT_ACCESS_SECRET=$(gen_secret)
JWT_REFRESH_SECRET=$(gen_secret)
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL_DAYS=7

# Same-origin deployment: the browser only ever sees https://$DOMAIN, and nginx proxies
# /api to this process. The allowlist still matters for anything calling from elsewhere.
CORS_ORIGINS=https://$DOMAIN
COOKIE_SECURE=true
COOKIE_DOMAIN=$DOMAIN

LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15

LOG_LEVEL=info

UPLOAD_DIR=./uploads
PUBLIC_URL=https://$DOMAIN

ORG_NAME=AMIRI Finance
ORG_CURRENCY=INR
FISCAL_YEAR_START_MONTH=4
EOF
    chown "$APP_USER:$APP_USER" "$API_ENV"
    chmod 600 "$API_ENV"
else
    echo "    $API_ENV exists — left untouched (rotating JWT secrets logs everyone out)"
fi

# ---------------------------------------------------------------------------------------
log "Firewall"
# Amazon Linux has no host firewall installed and does not need one — the EC2 security
# group is the firewall, and it is the only one that can be trusted anyway since Docker's
# published ports bypass a host firewall's INPUT chain.
if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null
    ufw allow 80/tcp  >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw --force enable >/dev/null
    ufw status verbose | sed 's/^/    /'
else
    echo "    no host firewall — the EC2 security group must allow 22, 80 and 443"
fi

# ---------------------------------------------------------------------------------------
log "Certificate renewal timer"
# certbot runs as a container rather than a package: it is not in the Amazon Linux
# repositories, and the official image behaves identically on every distribution.
cat > /etc/systemd/system/amiri-certbot-renew.service <<EOF
[Unit]
Description=Renew the Let's Encrypt certificate for $DOMAIN and reload nginx
After=docker.service
Requires=docker.service
# The scripts arrive with the first deploy's rsync. Until then the timer fires against
# nothing, and skipping quietly beats a failed unit in every status output.
ConditionPathExists=$DATA_DIR/deploy/scripts/renew-cert.sh

[Service]
Type=oneshot
ExecStart=$DATA_DIR/deploy/scripts/renew-cert.sh
EOF

cat > /etc/systemd/system/amiri-certbot-renew.timer <<'EOF'
[Unit]
Description=Twice-daily certificate renewal check

[Timer]
OnCalendar=*-*-* 03,15:24:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

log "Nightly backup timer"
cat > /etc/systemd/system/amiri-backup.service <<EOF
[Unit]
Description=mongodump of the AMIRI Finance database
After=docker.service
Requires=docker.service
ConditionPathExists=$DATA_DIR/deploy/scripts/backup.sh

[Service]
Type=oneshot
ExecStart=$DATA_DIR/deploy/scripts/backup.sh
EOF

cat > /etc/systemd/system/amiri-backup.timer <<'EOF'
[Unit]
Description=Nightly database backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now amiri-certbot-renew.timer amiri-backup.timer >/dev/null

# ---------------------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsS --max-time 5 \
    -H "X-aws-ec2-metadata-token: $(curl -fsS --max-time 5 -X PUT \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
        http://169.254.169.254/latest/api/token 2>/dev/null)" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo '<this-box>')"

log "Done"
cat <<EOF

Next steps
──────────
1. DNS — this box is $PUBLIC_IP. $DOMAIN must resolve to it and to
   NOTHING else; extra A records send both browsers and the ACME challenge to the
   wrong server. Check with:

       dig +short $DOMAIN        # exactly one line: $PUBLIC_IP

2. GitHub repository secrets (Settings ▸ Secrets and variables ▸ Actions):

       SSH_HOST         $PUBLIC_IP
       SSH_USER         $APP_USER
       SSH_KNOWN_HOSTS  $PUBLIC_IP $(awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null)
       SSH_PRIVATE_KEY  the private key printed below, in full

$(sed 's/^/       /' "$CI_KEY")

   Copy it now — nothing else prints it, though it stays at $CI_KEY.

3. Push to main. The Deploy workflow builds, pushes to GHCR and rolls this box forward.

4. Issue the TLS certificate (needs step 1 done):

       sudo LETSENCRYPT_EMAIL=you@example.com $DATA_DIR/deploy/scripts/issue-cert.sh

   Until then the site answers HTTPS with a self-signed placeholder.

5. Seed the first admin user, ONCE, after the first successful deploy:

       sudo -u $APP_USER $DATA_DIR/deploy/scripts/seed.sh

EOF
