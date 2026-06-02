# Flutter Web — multi-stage build
# Stage 1: build Flutter web app
FROM ghcr.io/cirruslabs/flutter:3.27.0 AS builder
WORKDIR /app
COPY pubspec.yaml pubspec.lock* ./
RUN flutter pub get
COPY . .
RUN flutter build web --release

# Stage 2: serve with Nginx (unprivileged)
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=builder /app/build/web /usr/share/nginx/html
EXPOSE 8080
