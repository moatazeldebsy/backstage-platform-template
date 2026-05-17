# Production Backstage image — uses pre-built bundle from `yarn build:backend`
# Run `yarn build:backend` in backstage/app/ before building this image.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-dev python3 python3-pip make g++ curl ca-certificates \
    && pip3 install --break-system-packages mkdocs-techdocs-core \
    && rm -rf /var/lib/apt/lists/*

# Install helm (pinned version with checksum verification)
RUN HELM_VERSION=3.17.3 && \
    HELM_SHA256=e5dde0e37b52cbab4b2a2b5c75eb00e8d7c95c4543cd8c2e7cd739c6b19daa2f && \
    curl -fsSL "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" -o /tmp/helm.tar.gz && \
    echo "${HELM_SHA256}  /tmp/helm.tar.gz" | sha256sum -c - && \
    tar xz -C /tmp -f /tmp/helm.tar.gz && \
    mv /tmp/linux-amd64/helm /usr/local/bin/helm && \
    rm -rf /tmp/helm.tar.gz /tmp/linux-amd64

# Install kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# Install docker CLI (for idp:seed-image scaffolder action — tags & pushes
# placeholder images to the local Kind registry on behalf of new services)
RUN ARCH=$(uname -m) && \
    DOCKER_VERSION=27.3.1 && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz" \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker

# Add node user to docker group (GID 999) so it can access the mounted socket
RUN groupadd -g 999 docker 2>/dev/null || true && usermod -aG docker node

WORKDIR /app

# Build context is backstage/app/ (set in CI), so no "app/" prefix needed

# 1. Skeleton first: sets up package.json files so yarn can resolve workspaces
COPY packages/backend/dist/skeleton.tar.gz skeleton.tar.gz
RUN tar xzf skeleton.tar.gz && rm skeleton.tar.gz

# 2. Copy yarn config so workspaces focus works
COPY .yarnrc.yml ./
COPY .yarn ./.yarn
COPY package.json yarn.lock ./

# 3. Install production dependencies only
RUN yarn workspaces focus --all --production && rm -rf "$(yarn cache dir)"

# 4. Extract the compiled bundle (overwrites dist/ with actual code)
COPY packages/backend/dist/bundle.tar.gz bundle.tar.gz
RUN tar xzf bundle.tar.gz && rm bundle.tar.gz

# node:24-bookworm-slim already has uid 1000 as 'node'
RUN chown -R node:node /app
USER node

EXPOSE 7007

ENV NODE_OPTIONS="--no-node-snapshot"

CMD ["node", "packages/backend", "--config", "app-config.yaml"]
