# Android App (Kotlin)

Scaffold a production-ready Android app with Kotlin, Jetpack Compose, Gradle, Fastlane CI/CD, and optional Firebase integration.

## How to use

1. Open Backstage → **Create**
2. Find **Android App (Kotlin)** and click **Choose**
3. Fill in the parameters and click **Create**

## What gets scaffolded

- Kotlin + Jetpack Compose project (MVVM skeleton)
- `gradle/libs.versions.toml` version catalog with AGP 8, Kotlin 2, Compose BOM
- GitHub Actions CI: lint → unit tests → debug APK (all branches) → release APK (main only)
- Fastlane `Fastfile` with `test`, `build_debug`, `build_release`, `distribute` lanes
- Optional Firebase Crashlytics + Analytics integration
- Backstage `catalog-info.yaml` with `spec.type: mobile`
- TechDocs (`mkdocs.yml` + `docs/`)

## Parameters

| Parameter | Description |
|-----------|-------------|
| App Name | Lowercase, hyphens only (e.g. `my-android-app`) |
| Package Name | Reverse-domain Android package (e.g. `com.acme.myapp`) |
| Min SDK | Minimum Android API level: 26, 28, or 33 |
| Enable Firebase | Adds Crashlytics + Analytics dependencies |
| Owner | Backstage group owning this app |

## Source

Template definition: [`template.yaml`](../template.yaml)
