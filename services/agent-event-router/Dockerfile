FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
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
