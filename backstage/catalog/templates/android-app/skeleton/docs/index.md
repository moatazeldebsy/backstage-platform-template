# ${{ values.name }}

${{ values.description }}

## Quick Start

### Prerequisites

- Android Studio Ladybug or later
- JDK 17
- Android SDK (API ${{ values.minSdk }}+)

### Build

```bash
# Debug build
./gradlew assembleDebug

# Run unit tests
./gradlew test

# Run lint
./gradlew lint
```

### Release

Use Fastlane to build and distribute:

```bash
# Install Fastlane
gem install fastlane

# Run tests
fastlane test

# Build release APK
fastlane build_release

# Distribute via Firebase App Distribution
fastlane distribute
```

## Architecture

This app follows MVVM architecture with Jetpack Compose UI.

| Layer | Technology |
|-------|-----------|
| UI | Jetpack Compose |
| State | ViewModel + StateFlow |
| DI | Hilt (add if needed) |
| Testing | JUnit 4 + Espresso |

## CI/CD

GitHub Actions runs on every push:
1. **Lint** — `./gradlew lint`
2. **Test** — `./gradlew test`
3. **Build** — `./gradlew assembleDebug` (all branches) / `assembleRelease` (main only)

## Owner

Team: **${{ values.owner }}**
