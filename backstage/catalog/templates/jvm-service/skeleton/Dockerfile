FROM gradle:8.11-jdk21 AS build
WORKDIR /app
COPY build.gradle.kts settings.gradle.kts ./
COPY config/ ./config/
COPY src/ ./src/
RUN gradle bootJar --no-daemon

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar

# Run as non-root (Trivy DS-0002 / container hardening)
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE ${{ values.port }}

ENTRYPOINT ["java", "-jar", "app.jar"]
