#!/bin/sh
# Point /etc/nginx/certs at a usable key pair before nginx reads its config.
#
# The config names fixed paths so it does not have to know where the certificate came
# from. When Let's Encrypt has issued one, these are symlinks into the mounted
# /etc/letsencrypt tree — following the live/ symlink means a renewal is picked up by a
# reload with no config change. When it has not (first boot on a fresh server, DNS not
# propagated yet, an expired account), a self-signed placeholder is generated instead.
#
# The placeholder exists so that nginx STARTS. A missing ssl_certificate is a hard config
# error: the container would crash-loop, port 80 would be closed, and the ACME challenge
# that would fix it could never be answered. A browser warning is recoverable; a locked
# door is not.
set -eu

CERT_DIR=/etc/nginx/certs
LIVE_DIR="/etc/letsencrypt/live/${SERVER_NAME}"

mkdir -p "$CERT_DIR" /var/www/certbot

if [ -s "$LIVE_DIR/fullchain.pem" ] && [ -s "$LIVE_DIR/privkey.pem" ]; then
    ln -sf "$LIVE_DIR/fullchain.pem" "$CERT_DIR/fullchain.pem"
    ln -sf "$LIVE_DIR/privkey.pem"   "$CERT_DIR/privkey.pem"
    echo "05-resolve-certs: using the Let's Encrypt certificate for ${SERVER_NAME}"
    exit 0
fi

echo "05-resolve-certs: WARNING — no certificate at ${LIVE_DIR}."
echo "05-resolve-certs: serving a SELF-SIGNED placeholder so :80 stays open for ACME."
echo "05-resolve-certs: issue the real one with deploy/scripts/issue-cert.sh, then restart."

rm -f "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"
openssl req -x509 -nodes -newkey rsa:2048 -days 90 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out    "$CERT_DIR/fullchain.pem" \
    -subj "/CN=${SERVER_NAME}" >/dev/null 2>&1
