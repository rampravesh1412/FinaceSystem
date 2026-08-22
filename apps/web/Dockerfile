# syntax=docker/dockerfile:1.7
#
# Web image: the Vite build served by nginx, which is also the TLS terminator and the
# reverse proxy in front of the API. Build context is the REPO ROOT:
#
#   docker build -f apps/web/Dockerfile .
#
# The API is proxied under /api on the SAME origin rather than given its own subdomain.
# That is not a deployment convenience — apps/web/src/lib/api.ts hardcodes `/api/v1` and
# the refresh cookie is SameSite=Strict, so a second origin would silently drop it.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV CI=1

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include-workspace-root \
        --workspace @amiri/shared \
        --workspace @amiri/web

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# @amiri/shared resolves through its `exports` map to dist/, so it must be compiled before
# the web build typechecks against it.
RUN npm run build --workspace @amiri/shared \
 && npm run build --workspace @amiri/web

# ---------------------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# openssl is for the self-signed placeholder in 05-resolve-certs.sh, not for serving.
RUN apk add --no-cache openssl

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx/app.conf.template /etc/nginx/templates/app.conf.template
COPY apps/web/nginx/05-resolve-certs.sh /docker-entrypoint.d/05-resolve-certs.sh
RUN chmod +x /docker-entrypoint.d/05-resolve-certs.sh

# Overwritten by compose; a default keeps `docker run` on the image usable.
ENV SERVER_NAME=account.amiri247.in
ENV API_UPSTREAM=api:4000

EXPOSE 80 443

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-qO-", "http://127.0.0.1/healthz"]
