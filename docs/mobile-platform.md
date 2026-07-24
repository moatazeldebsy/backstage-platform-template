# Mobile Platform

The IDP provides a complete golden-path for mobile app development covering iOS, Android, Flutter, shared SDK libraries, code signing, app-store deployment, and device-farm testing — all self-serviceable from Backstage.

## Template Overview

| Template | Type | Purpose |
|---|---|---|
| **android-app** | Primary | Kotlin + Jetpack Compose golden-path app with CI/CD and Fastlane |
| **ios-app** | Primary | Swift + SwiftUI golden-path app with CI/CD and Fastlane |
| **flutter-app** | Primary | Dart multi-platform app (Android / iOS / Web) with optional K8s Web deploy |
| **mobile-sdk** | Add-on | Shared library for Android (Kotlin), iOS (SPM), Flutter, or Kotlin Multiplatform |
| **mobile-code-signing** | Add-on | Automated code signing — Fastlane Match (S3) for iOS, keystore + Secrets Manager for Android |
| **mobile-app-store-deploy** | Add-on | Automated Google Play / App Store release via Fastlane deliver/supply |
| **mobile-device-farm** | Add-on | Firebase TestLab cloud device testing with configurable device matrix |
| **flutter-integration-test-suite** | Test | Flutter integration tests on Firebase TestLab or local emulator (adds to existing Flutter repo) |
| **appium-mobile-suite** | Test | Appium + WebdriverIO cross-device suite with BrowserStack / Sauce Labs support |

---

## Primary Templates — New App Creation

### Android App (Kotlin + Jetpack Compose)

Scaffolds a production-ready Android app with:
- Kotlin + Jetpack Compose MVVM skeleton
- GitHub Actions CI: lint → unit tests → build APK
- Fastlane `Fastfile` with `test`, `build_debug`, `build_release`, `distribute` lanes
- SonarCloud + Snyk security scanning
- Firebase Crashlytics (optional)
- Configurable `minSdkVersion` (24–34)
- TechDocs wired to Backstage

**Use this when:** scaffolding a new native Android app from scratch.

### iOS App (Swift + SwiftUI)

Scaffolds a production-ready iOS app with:
- Swift + SwiftUI project with MVVM skeleton
- Xcode Cloud / GitHub Actions CI: SwiftLint → unit tests → archive
- Fastlane `Fastfile` with `test`, `build`, `beta`, `release` lanes
- SonarCloud + Snyk security scanning
- Firebase Crashlytics (optional)
- Configurable minimum iOS deployment target (15.0–17.0)
- TechDocs wired to Backstage

**Use this when:** scaffolding a new native iOS app from scratch.

### Flutter App (Dart, Multi-Platform)

Scaffolds a production-ready Flutter app with:
- Flutter + Material 3 UI skeleton targeting Android, iOS, and/or Web
- GitHub Actions CI: analyze → unit tests → build APK → build Web
- Fastlane integration for distribution
- Optional Flutter Web K8s deploy (Dockerfile + `helm-values-local.yaml`)
- Firebase integration (optional)
- TechDocs wired to Backstage

**Use this when:** building an app that targets multiple platforms (Android + iOS + Web) from a single codebase.

---

## Add-On Templates — Enhance Existing Apps

Add-on templates open a PR against an existing app repo; they do not create a new repo.

### Mobile Code Signing

Adds automated code signing to an existing mobile app repo:

**iOS (Fastlane Match):**
- `Matchfile` pointing to an S3 bucket for certificate/profile storage
- GitHub Actions workflow using `bundle exec fastlane match appstore`
- Secrets Manager secret for Match passphrase

**Android (Keystore):**
- Keystore stored in AWS Secrets Manager (`/mobile/<app>/keystore`)
- GitHub Actions workflow that fetches the keystore and signs the APK/AAB
- `build.gradle` signing config wired to CI environment variables

**Use this when:** your app is ready for distribution and needs production-grade code signing.

### Mobile App Store Deploy

Adds automated release pipeline to an existing app repo:

- **Google Play**: Fastlane `supply` lane with `workflow_dispatch` + `release/**` branch triggers
- **App Store**: Fastlane `deliver` lane with TestFlight + Production promotion flow
- Dedicated `release.yml` GitHub Actions workflow
- Version bump step (patch / minor / major selector in workflow input)

**Use this when:** your app CI is working and you want one-click releases to the stores.

### Mobile Device Farm

Adds Firebase TestLab device-farm testing to an existing app repo:

- `gcloud firebase test android run` / `gcloud firebase test ios run` integration
- Configurable device matrix:
  - **Low** (1 device): Pixel 6 / iPhone 14
  - **Medium** (3 devices): Pixel 6 + Samsung S21 + Pixel 7 / iPhone 14 + iPhone 13 + iPhone SE
  - **High** (5 devices): broad coverage matrix
- GitHub Actions workflow that runs on PR and nightly
- Test results exported to GCS and linked from CI summary

**Use this when:** you need to validate your app on real devices across a range of hardware/OS versions.

### Mobile SDK Library

Scaffolds a shared mobile SDK library with:
- **Android**: Kotlin library published to GitHub Packages (`maven-publish`)
- **iOS**: Swift Package Manager (`Package.swift`), published via GitHub releases
- **Flutter**: Dart package published to `pub.dev` (optional)
- **Kotlin Multiplatform (KMP)**: conditional targets for Android, iOS, JVM, JS
- GitHub Actions CI: test → build → publish (version-tagged releases only)

**Use this when:** you have reusable logic (auth, analytics, networking) shared across multiple mobile apps.

---

## Testing Templates

### Flutter Integration Test Suite

Adds Flutter integration tests to an existing Flutter app repo:
- `integration_test/<suite-name>/app_test.dart` scaffold
- GitHub Actions workflow for:
  - **Local emulator**: fast, free, runs on `ubuntu-latest`
  - **Firebase TestLab**: real device execution (requires `FIREBASE_SERVICE_ACCOUNT` secret)

Use from Backstage → Create → "Flutter Integration Test Suite", select the target Flutter app from the catalog.

### Appium Mobile Test Suite

Scaffolds a standalone cross-device test suite:
- WebdriverIO + Appium config with multi-device support
- Device farm options: Local Emulator, BrowserStack, or Sauce Labs
- Parallel CI execution across selected device matrix
- K8s Secret provisioned for device farm credentials

---

## Tech Insights: Mobile Scorecard

Five mobile-specific quality checks are visible on every mobile app's Backstage entity page (Scorecard tab):

| Check | ID | Bronze | Silver | Gold |
|---|---|---|---|---|
| Min SDK version | `has-min-sdk-version` | — | ✅ (≥24 Android / ≥16.0 iOS) | ✅ |
| Crashlytics enabled | `has-crashlytics-enabled` | — | — | ✅ |
| Accessibility tests | `has-accessibility-tests` | — | ✅ | ✅ |
| App size budget | `has-app-size-budget` | — | — | ✅ |
| Code signing | `has-code-signing` | ✅ | ✅ | ✅ |

These checks are evaluated by `idpTechInsights.ts` and pushed to Prometheus via Pushgateway, making them visible in the Grafana QA dashboard as well.

---

## Local Development

### Android

```bash
# Install Android Studio
# https://developer.android.com/studio

# Run tests locally
./gradlew test

# Build debug APK
./gradlew assembleDebug

# Run Fastlane lanes
bundle install
bundle exec fastlane test
bundle exec fastlane build_debug
```

### iOS

```bash
# Install Xcode from the Mac App Store
# Install Fastlane
gem install bundler && bundle install

# Run tests
bundle exec fastlane test

# Build for TestFlight
bundle exec fastlane beta
```

### Flutter

```bash
flutter pub get
flutter analyze
flutter test
flutter build apk
flutter build ios --no-codesign   # CI uses Fastlane for signing
```

---

## Further Reading

- [Mobile Developer Guide](https://github.com/moatazeldebsy/backstage-platform-template/blob/main/backstage/catalog/docs/mobile-developer-guide.md) — detailed per-platform setup and local toolchain
- [Security Scanning](security-scanning.md) — SonarCloud + Snyk integration for mobile repos
- [Shift-Left Quality](shift-left.md) — scorecard model and quality gates
