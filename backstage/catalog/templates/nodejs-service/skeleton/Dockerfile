FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY openapi.yaml ./openapi.yaml

# Run as non-root (Trivy DS-0002 / container hardening)
USER node

EXPOSE ${{ values.port }}

CMD ["node", "src/index.js"]
