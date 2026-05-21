# Multi-stage Backstage image — the bundle is built INSIDE the image.
# No host-side `yarn build:backend` is required before `docker compose build`.
# BuildKit cache mounts keep repeat builds fast.

# ─── Stage 1: build the backend bundle ───────────────────────────────────────
FROM node:24-bookworm-slim AS builder
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

RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    yarn install --immutable

# Now copy the actual source — only invalidates the build step below.
COPY packages ./packages
COPY plugins ./plugins

# Produces packages/backend/dist/{skeleton,bundle}.tar.gz
RUN yarn build:backend


# ─── Stage 2: runtime image ──────────────────────────────────────────────────
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-dev python3 python3-pip make g++ curl ca-certificates \
    && pip3 install --break-system-packages mkdocs-techdocs-core \
    && rm -rf /var/lib/apt/lists/*

# Install helm (pinned version with checksum verification)
RUN HELM_VERSION=3.17.3 && \
    HELM_SHA256=ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd && \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" -o /tmp/helm.tar.gz && \
    echo "${HELM_SHA256}  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar xz -C /tmp -f /tmp/helm.tar.gz && \
    mv /tmp/linux-amd64/helm /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz /tmp/linux-amd64

# Install kubectl (pinned version with checksum verification — matches the helm
# pattern above. Pinning removes the extra network round-trip to stable.txt on
# every build and keeps the layer cache-friendly + supply-chain verifiable.)
RUN KUBECTL_VERSION=v1.31.4 && \
    KUBECTL_SHA256=298e19e9c6c17199011404278f0ff8168a7eca4217edad9097af577023a5620f && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl && \
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

# 1. Skeleton first: sets up package.json files so yarn can resolve workspaces
COPY --from=builder /app/packages/backend/dist/skeleton.tar.gz ./skeleton.tar.gz
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# 2. Copy yarn config so workspaces focus works
COPY --from=builder /app/.yarnrc.yml ./
COPY --from=builder /app/.yarn ./.yarn
COPY --from=builder /app/package.json /app/yarn.lock ./
# vm2 is resolved via portal:./vm2-shim in package.json resolutions
COPY --from=builder /app/vm2-shim ./vm2-shim

# 3. Install production dependencies only
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    yarn workspaces focus --all --production && rm -rf "$(yarn cache dir)"

# 4. Extract the compiled bundle (overwrites dist/ with actual code)
COPY --from=builder /app/packages/backend/dist/bundle.tar.gz ./bundle.tar.gz
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

# node:24-bookworm-slim already has uid 1000 as 'node'
RUN chown -R node:node /app
USER node

EXPOSE 7007

ENV NODE_OPTIONS="--no-node-snapshot"

CMD ["node", "packages/backend", "--config", "app-config.yaml"]
