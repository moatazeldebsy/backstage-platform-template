# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# ── Stage 2: serve ───────────────────────────────────────────────────────────
# Unprivileged nginx runs as uid 101 and listens on 8080 (Trivy DS-0002 / hardening)
FROM nginxinc/nginx-unprivileged:1.27-alpine

USER root
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
USER 101

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
