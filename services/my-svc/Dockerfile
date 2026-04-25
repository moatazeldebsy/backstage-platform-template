FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY src/ ./src/

FROM gcr.io/distroless/nodejs20-debian12:nonroot
WORKDIR /app
COPY --from=builder /app .
EXPOSE 3000
CMD ["src/index.js"]
