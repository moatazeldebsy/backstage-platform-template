# Flutter App (Dart)

Scaffold a production-ready Flutter app with Dart, multi-platform support (Android / iOS / Web), GitHub Actions CI/CD, Fastlane, and optional Firebase integration.

## How to use

1. Open Backstage → **Create**
2. Find **Flutter App (Dart)** and click **Choose**
3. Fill in the parameters and click **Create**

## What gets scaffolded

- Flutter + Dart project with Material 3 UI skeleton
- Widget tests + `analysis_options.yaml` (flutter_lints)
- GitHub Actions CI: analyze → test → build APK → build Web → (main) push Docker image
- Optional Flutter Web → Dockerfile (Nginx) → Helm deploy to the platform K8s cluster
- Fastlane `Fastfile` for Android distribution (Firebase App Distribution)
- Optional Firebase Crashlytics + Analytics integration
- Backstage `catalog-info.yaml` with `spec.type: mobile`
- TechDocs (`mkdocs.yml` + `docs/`)

## Parameters

| Parameter | Description |
|-----------|-------------|
| App Name | Lowercase, hyphens only (e.g. `my-flutter-app`) |
| Package Name | Reverse-domain bundle ID (e.g. `com.acme.myapp`) |
| Target Platforms | Android, iOS, and/or Web (checkboxes) |
| Flutter Web K8s Deploy | Build Web → Docker → Helm → cluster (requires Web selected) |
| Enable Firebase | Adds Crashlytics + Analytics dependencies |
| Owner | Backstage group owning this app |

## Source

Template definition: [`template.yaml`](../template.yaml)
