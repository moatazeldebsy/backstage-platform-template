FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN addgroup -S mcp && adduser -S mcp -G mcp
COPY package*.json ./
RUN npm ci --omit=dev

# Same base-layer hardening applied to the platform's own MCP server images in
# #383. Trivy findings on node:*-alpine come from the base rather than from
# anything the service ships: libssl3/libcrypto3 account for the high-severity
# ones, and upstream does not always rebuild the tag once Alpine publishes the
# patch, so an explicit `apk upgrade` is what actually clears them.
#
# npm is the other source (tar, minimatch, glob, cross-spawn, sigstore,
# brace-expansion, ip-address, diff — all under /usr/local/lib/node_modules/npm).
# It is a build-time tool; this stage only runs `node dist/index.js`, so removing
# it deletes that whole class of findings. Must run AFTER npm ci, and while we
# are still root — the USER switch is below.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist
USER mcp
EXPOSE ${{ values.port }}
CMD ["node", "dist/index.js"]
