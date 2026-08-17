FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
# Trivy flagged 300 alerts across these images, all from the base layer rather
# than from anything we ship: libssl3/libcrypto3 3.5.6-r0 (CVE-2026-45447 high,
# plus 14 more). node:20-alpine has NOT been rebuilt upstream with the patched
# 3.5.7-r0 — verified by pulling it — so rebuilding alone does not clear them.
# Alpine's repo has the fix, hence the explicit upgrade.
#
# npm accounts for the remaining findings (tar, minimatch, glob, cross-spawn,
# sigstore, brace-expansion, ip-address, diff — every one under
# /usr/local/lib/node_modules/npm/). It is a build-time tool: this stage runs
# `node dist/index.js` and the healthcheck uses busybox wget, so nothing here
# needs it. Removing it deletes that whole class rather than chasing each CVE.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S router && adduser -S router -G router
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
USER router
EXPOSE 3004
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:3004/healthz || exit 1
CMD ["node", "dist/index.js"]
