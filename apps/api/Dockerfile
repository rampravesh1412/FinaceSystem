# syntax=docker/dockerfile:1.7
#
# API image. Build context is the REPO ROOT, not apps/api — this is an npm workspaces
# monorepo and the api depends on @amiri/shared through the root lockfile:
#
#   docker build -f apps/api/Dockerfile .
#
# bookworm-slim rather than alpine on purpose: @node-rs/argon2 ships prebuilt binaries per
# libc, and the glibc build is the one that is always published. On musl a missing prebuild
# falls back to compiling Rust from source inside the image.

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV CI=1

# ---------------------------------------------------------------------------------------
# deps — install with the manifests only, so a source edit does not invalidate the install
# layer. Every workspace manifest is copied because npm reads all of them to resolve the
# lockfile, even when only two are selected for installation.
# ---------------------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include-workspace-root \
        --workspace @amiri/shared \
        --workspace @amiri/api

# ---------------------------------------------------------------------------------------
# build — compile @amiri/shared first; the api imports its emitted .d.ts and .js.
# ---------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build --workspace @amiri/shared \
 && npm run build --workspace @amiri/api

# ---------------------------------------------------------------------------------------
# prod-deps — the same install with devDependencies dropped. `npm ci` wipes node_modules
# before it installs, so this genuinely is a clean production tree, not a pruned dev one.
# ---------------------------------------------------------------------------------------
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --include-workspace-root \
        --workspace @amiri/shared \
        --workspace @amiri/api

# ---------------------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM to node, which the graceful shutdown in
# server.ts depends on — without an init, PID 1 semantics swallow the signal and the
# container is SIGKILLed 10s later, mid-transaction.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

# The whole tree, so the node_modules/@amiri/shared workspace symlink stays intact.
COPY --from=prod-deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist

# UPLOAD_DIR is relative to the api workdir. Created here so the bind mount inherits an
# owner the unprivileged user can write to.
RUN mkdir -p /app/apps/api/uploads && chown -R node:node /app/apps/api/uploads

WORKDIR /app/apps/api
USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=45s --retries=5 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||4000}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
