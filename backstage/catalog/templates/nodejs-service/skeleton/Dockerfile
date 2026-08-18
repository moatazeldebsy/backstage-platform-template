FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Same base-layer hardening applied to the platform's own Node images in #383.
# Trivy findings on node:*-alpine come from the base rather than from anything
# the service ships: libssl3/libcrypto3 account for the high-severity ones, and
# upstream does not always rebuild the tag once Alpine publishes the patch, so
# an explicit `apk upgrade` is what actually clears them.
#
# npm is the other source (tar, minimatch, glob, cross-spawn, sigstore,
# brace-expansion, ip-address, diff — all under /usr/local/lib/node_modules/npm).
# It is a build-time tool; this image only ever runs `node src/index.js`, so
# removing it deletes that whole class of findings instead of chasing each CVE.
# Must run AFTER npm install, and before USER node while we are still root.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY src/ ./src/
COPY openapi.yaml ./openapi.yaml

# Run as non-root (Trivy DS-0002 / container hardening)
USER node

EXPOSE ${{ values.port }}

CMD ["node", "src/index.js"]
