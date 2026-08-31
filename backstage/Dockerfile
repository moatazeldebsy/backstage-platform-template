# Multi-stage Backstage image — the bundle is built INSIDE the image.
# No host-side `yarn build:backend` is required before `docker compose build`.
# BuildKit cache mounts keep repeat builds fast.

# ─── Stage 1: build the backend bundle ───────────────────────────────────────
FROM node:22.22-bookworm-slim AS builder
WORKDIR /app

# Native build deps for sqlite/better-sqlite3/bcrypt etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Build context is backstage/app/ (set in docker-compose.yml).
# Copy Yarn config + lockfile + workspace manifests ONLY so that source-only
# changes don't bust the (slow) yarn install cache.
COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn ./.yarn
# vm2-shim is resolved via portal:./vm2-shim in package.json resolutions
COPY vm2-shim ./vm2-shim
# Workspace manifests only — full source is copied AFTER install so edits
# inside packages/* don't invalidate the 8-minute install layer.
COPY packages/app/package.json ./packages/app/
COPY packages/backend/package.json ./packages/backend/
# Every workspace listed in yarn.lock needs its manifest here, or the immutable
# install below fails resolving a workspace it cannot see. Add a line whenever a
# package is added under packages/.
COPY packages/engineering-intelligence-core/package.json ./packages/engineering-intelligence-core/

RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    yarn install --immutable

# Now copy the actual source — only invalidates the build steps below.
COPY packages ./packages
COPY plugins ./plugins

# Build the frontend bundle first — plugin-app-backend serves static files from
# packages/app/dist/ at runtime, so this must run before yarn build:backend.
RUN yarn workspace app build

# Produces packages/backend/dist/{skeleton,bundle}.tar.gz
RUN yarn build:backend


# ─── Stage 2: runtime image ──────────────────────────────────────────────────
FROM node:22.22-bookworm-slim

# Cache mount for pip so mkdocs-techdocs-core's dependency tree isn't
# re-downloaded from PyPI on every cold build (apt itself isn't cache-mounted
# since its package archives are removed by rm -rf below anyway).
RUN --mount=type=cache,target=/root/.cache/pip \
    apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-dev python3 python3-pip make g++ curl ca-certificates \
    && pip3 install --break-system-packages mkdocs-techdocs-core \
    && rm -rf /var/lib/apt/lists/*

# Install helm (pinned version with checksum verification, multi-arch).
# dpkg --print-architecture yields "amd64"/"arm64", matching both the Debian
# base image's own arch naming and helm/kubectl's release asset naming.
RUN HELM_VERSION=3.17.3 && \
    HELM_ARCH=$(dpkg --print-architecture) && \
    case "$HELM_ARCH" in \
      amd64) HELM_SHA256=ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd ;; \
      arm64) HELM_SHA256=7944e3defd386c76fd92d9e6fec5c2d65a323f6fadc19bfb5e704e3eee10348e ;; \
      *) echo "unsupported architecture: ${HELM_ARCH}" >&2 && exit 1 ;; \
    esac && \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${HELM_ARCH}.tar.gz" -o /tmp/helm.tar.gz && \
    echo "${HELM_SHA256}  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar xz -C /tmp -f /tmp/helm.tar.gz && \
    mv "/tmp/linux-${HELM_ARCH}/helm" /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz "/tmp/linux-${HELM_ARCH}"

# Install kubectl (pinned version with checksum verification — matches the helm
# pattern above. Pinning removes the extra network round-trip to stable.txt on
# every build and keeps the layer cache-friendly + supply-chain verifiable.)
RUN KUBECTL_VERSION=v1.31.4 && \
    KUBECTL_ARCH=$(dpkg --print-architecture) && \
    case "$KUBECTL_ARCH" in \
      amd64) KUBECTL_SHA256=298e19e9c6c17199011404278f0ff8168a7eca4217edad9097af577023a5620f ;; \
      arm64) KUBECTL_SHA256=b97e93c20e3be4b8c8fa1235a41b4d77d4f2022ed3d899230dbbbbd43d26f872 ;; \
      *) echo "unsupported architecture: ${KUBECTL_ARCH}" >&2 && exit 1 ;; \
    esac && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${KUBECTL_ARCH}/kubectl" -o /usr/local/bin/kubectl && \
    echo "${KUBECTL_SHA256}  /usr/local/bin/kubectl" | sha256sum -c - && \
    chmod +x /usr/local/bin/kubectl

# Install docker CLI (for idp:seed-image scaffolder action — tags & pushes
# placeholder images to the local Kind registry on behalf of new services)
RUN ARCH=$(uname -m) && \
    DOCKER_VERSION=27.3.1 && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz" \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Add node user to docker group (GID 999) so it can access the mounted socket
RUN groupadd -g 999 docker 2>/dev/null || true && usermod -aG docker node

WORKDIR /app

# Hand /app to the node user now, while it's still empty — this is instant.
# Every file created below is written with --chown or as USER node from the
# start, so there's no final recursive `chown -R` over the whole production
# node_modules tree (that used to cost ~4 minutes on its own: it re-walks
# every file on every single build regardless of layer/BuildKit caching).
# node:22-bookworm-slim already has uid/gid 1000 as 'node'.
RUN chown node:node /app

# 1. Skeleton first: sets up package.json files so yarn can resolve workspaces
COPY --from=builder --chown=node:node /app/packages/backend/dist/skeleton.tar.gz ./skeleton.tar.gz
USER node
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# 2. Copy yarn config so workspaces focus works
COPY --from=builder --chown=node:node /app/.yarnrc.yml ./
COPY --from=builder --chown=node:node /app/.yarn ./.yarn
COPY --from=builder --chown=node:node /app/package.json /app/yarn.lock ./
# vm2 is resolved via portal:./vm2-shim in package.json resolutions
COPY --from=builder --chown=node:node /app/vm2-shim ./vm2-shim

# 3. Install production dependencies only. Cache mount lives under the node
# user's home (not /root, which USER node can't write to) with uid/gid pinned
# so the mount's contents are owned by node from the start. The parent dir is
# pre-created (as node) because yarn also writes an `index/` dir as a sibling
# of `cache/` — without this, Docker auto-creates that parent as root when
# attaching the mount, and yarn's write to the sibling dir fails with EACCES.
RUN mkdir -p /home/node/.yarn/berry/cache
RUN --mount=type=cache,target=/home/node/.yarn/berry/cache,uid=1000,gid=1000 \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache dir)"

# 4. Extract the compiled bundle (overwrites dist/ with actual code)
COPY --from=builder --chown=node:node /app/packages/backend/dist/bundle.tar.gz ./bundle.tar.gz
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

# 4b. The backend's schema collector reads packages/app/config.d.ts at startup
# (via the "app" package's configSchema field) to determine which custom
# config keys — like externalLinks — are safe to expose to the frontend.
# The skeleton/bundle tarballs above only carry package.json + compiled dist/
# output, not this source-only declaration file, so without this the backend
# crashes on boot: "Invalid schema in packages/app/config.d.ts, missing Config
# export" (really: file not found).
COPY --from=builder --chown=node:node /app/packages/app/config.d.ts ./packages/app/config.d.ts
# Same reasoning for the backend's own schema, which declares the
# engineeringIntelligence and langfuse keys. It is referenced by the "backend"
# package's configSchema field, so a missing file here is the identical
# boot-time crash as above, not a silently ignored schema.
COPY --from=builder --chown=node:node /app/packages/backend/config.d.ts ./packages/backend/config.d.ts

# 5. Copy configuration file (from build context parent directory)
COPY --chown=node:node ../app-config.yaml ./app-config.yaml

EXPOSE 7007

ENV NODE_OPTIONS="--no-node-snapshot"

CMD ["node", "packages/backend", "--config", "app-config.yaml"]
