# Mobile Developer Guide

This guide helps iOS, Android, and Flutter developers get started with the Internal Developer Platform. For a full template reference see [docs/mobile-platform.md](https://moatazeldebsy.github.io/backstage-platform-template/mobile-platform/).

## Golden Path: Create Your First App

### iOS (Swift + SwiftUI)

1. Go to **Backstage → Create** and choose **iOS App (Swift)**
2. Fill in: app name, bundle ID (e.g. `com.mycompany.myapp`), minimum iOS version (15.0–17.0), owner
3. Optionally enable Firebase Crashlytics
4. Choose your GitHub repo name and click **Create**

Your repo will contain:
- Swift + SwiftUI project with MVVM skeleton
- GitHub Actions CI: SwiftLint → unit tests → archive
- Fastlane `Fastfile` with `test`, `build`, `beta`, `release` lanes
- SonarCloud + Snyk scanning wired to CI
- TechDocs wired to Backstage

### Android (Kotlin + Jetpack Compose)

1. Go to **Backstage → Create** and choose **Android App (Kotlin)**
2. Fill in: app name, package name (e.g. `com.mycompany.myapp`), min SDK, owner
3. Optionally enable Firebase for crash reporting + analytics
4. Choose your GitHub repo name and click **Create**

Your repo will contain:
- Kotlin + Jetpack Compose project with MVVM skeleton
- GitHub Actions CI: lint → unit tests → build APK
- Fastlane `Fastfile` with `test`, `build_debug`, `build_release`, `distribute` lanes
- TechDocs wired to Backstage

### Flutter (Dart, Multi-Platform)

1. Go to **Backstage → Create** and choose **Flutter App (Dart)**
2. Fill in: app name, package name, target platforms (Android / iOS / Web)
3. Optionally enable **Flutter Web K8s deploy** to run the web build in the cluster
4. Choose your GitHub repo name and click **Create**

Your repo will contain:
- Flutter project with Material 3 UI skeleton
- GitHub Actions CI: analyze → tests → build APK → build Web
- Optional Dockerfile + Helm values for Flutter Web deployment
- Fastlane `Fastfile` for distribution

## Adding Tests to an Existing Mobile App

### Flutter Integration Tests (Firebase Test Lab)

1. Go to **Backstage → Create** → **Flutter Integration Test Suite**
2. Pick your existing Flutter app from the catalog
3. Choose **Local Emulator** (fast, free) or **Firebase Test Lab** (real devices)
4. The scaffolder opens a PR on your app repo with:
   - `integration_test/<suite-name>/app_test.dart`
   - GitHub Actions workflow (emulator or Firebase Test Lab)

### Appium Mobile Test Suite (BrowserStack / Sauce Labs)

1. Go to **Backstage → Create** → **Appium Mobile Test Suite**
2. Select your **Device Farm**: Local Emulator, BrowserStack, or Sauce Labs
3. Select your **Device Matrix**: Pixel 6 / Samsung S21 / iPhone 14 / Pixel 7
4. The scaffolder:
   - Scaffolds WebdriverIO + Appium config with multi-device support
   - Creates a K8s Secret for your BrowserStack / Sauce Labs credentials
   - Generates CI with parallel execution across selected devices

## Local Setup

### Android

```bash
# Install Android Studio
# https://developer.android.com/studio

# Verify SDK
adb --version

# Build via Gradle
./gradlew assembleDebug

# Run unit tests
./gradlew test

# Run with Fastlane
gem install fastlane
fastlane test
```

### Flutter

```bash
# Install Flutter SDK
# https://docs.flutter.dev/get-started/install

# Verify installation
flutter doctor

# Install dependencies
flutter pub get

# Run on connected device
flutter run

# Run tests
flutter test --coverage

# Analyze
flutter analyze
```

## Fastlane Release Management

Both Android and Flutter skeletons include a `Fastfile`. To distribute to **Firebase App Distribution**:

```bash
# One-time setup
gem install fastlane
gem install fastlane-plugin-firebase_app_distribution

# Distribute (requires FIREBASE_APP_ID and FIREBASE_TOKEN env vars)
fastlane distribute        # Android
fastlane distribute_android  # Flutter
```

Set secrets in GitHub Actions:
- `FIREBASE_APP_ID` — from Firebase Console → Project Settings → Your Apps
- `FIREBASE_TOKEN` — run `fastlane run firebase_app_distribution_login` locally

## Firebase Integration

If you enabled Firebase during scaffolding:

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. Add your Android app with the same package name you chose in the template
3. Download `google-services.json` → place in `android/app/` (Android) or `app/` (Kotlin project)
4. For Flutter: also download `GoogleService-Info.plist` → place in `ios/Runner/`
5. Push to `main` — Crashlytics will start collecting crashes automatically

## BrowserStack Device Farm

When using the **Appium Mobile Test Suite** with BrowserStack:

1. Sign up at [browserstack.com](https://www.browserstack.com) (free trial available)
2. Get your credentials from **Account → Settings → Access Key**
3. The scaffolder creates a K8s Secret named `<suite-name>-browserstack` in `services-dev`
4. Update the secret values:
   ```bash
   kubectl edit secret <suite-name>-browserstack -n services-dev
   ```
5. Set the same values as GitHub Actions secrets `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY`

## Mobile Scorecard (Tech Insights)

Mobile apps registered in the catalog get a **Mobile Scorecard** in Backstage Tech Insights.

| Check | How to pass |
|-------|-------------|
| `has-owner` | Set `spec.owner` in `catalog-info.yaml` |
| `has-techdocs` | Keep `backstage.io/techdocs-ref: dir:.` annotation |
| `has-runbook-url` | Keep the runbook annotation in `catalog-info.yaml` |
| `has-mobile-test-coverage` | Add `mobile-test-coverage` to `idp.io/quality-gates` annotation |
| `has-mobile-crash-reporting` | Add `mobile-crash-reporting` to quality gates OR `mobile.io/crash-reporting` annotation |
| `has-mobile-ui-tests` | Add `appium` or `flutter-integration` tag, or add `mobile-ui-tests` quality gate |
| `has-mobile-fastlane` | Add `mobile-fastlane` to quality gates |

To update your scorecard, edit `catalog-info.yaml` in your app repo:
```yaml
metadata:
  annotations:
    idp.io/quality-gates: "mobile-test-coverage,mobile-crash-reporting,mobile-ui-tests,mobile-fastlane"
```

## Code Signing

### iOS — Fastlane Match (S3)

Use the `mobile-code-signing` template from Backstage to set up automated code signing:

1. Go to **Backstage → Create** → **Mobile Code Signing**
2. Select your iOS app and choose **Fastlane Match**
3. The scaffolder adds to your repo:
   - `Matchfile` pointing to an S3 bucket for certificate/profile storage
   - CI workflow using `bundle exec fastlane match appstore`
   - AWS Secrets Manager secret for Match passphrase (`/mobile/<app>/match-passphrase`)

```bash
# One-time: create the Match storage bucket and certificates
bundle exec fastlane match init
bundle exec fastlane match appstore    # distribution cert + provisioning profile
bundle exec fastlane match development # development cert

# In CI (reads from S3 automatically):
bundle exec fastlane match appstore --readonly
```

### Android — Keystore via AWS Secrets Manager

1. Go to **Backstage → Create** → **Mobile Code Signing**
2. Select your Android app and choose **Keystore**
3. The scaffolder adds:
   - `build.gradle` signing config reading from environment variables
   - CI workflow that fetches the keystore from `AWS_SECRETS_MANAGER` (`/mobile/<app>/keystore`)
   - Upload script to store the keystore in Secrets Manager

```bash
# One-time: generate and upload keystore
keytool -genkey -v -keystore release.jks -alias <alias> -keyalg RSA -keysize 2048 -validity 10000
aws secretsmanager create-secret --name /mobile/<app>/keystore --secret-binary fileb://release.jks
```

---

## App Store Deploy

Use the `mobile-app-store-deploy` template to add a one-click release pipeline:

1. Go to **Backstage → Create** → **App Store Deploy**
2. Select your app and target store (Google Play and/or App Store)
3. The scaffolder adds:
   - `release.yml` GitHub Actions workflow with `workflow_dispatch` + `release/**` branch triggers
   - Version bump step (patch / minor / major selector)
   - Fastlane `deliver` (iOS) or `supply` (Android) lane

Trigger a release:
```bash
# Via GitHub UI: Actions → Release → Run workflow → choose bump type
# Or via gh CLI:
gh workflow run release.yml -f bump=patch
```

---

## Device Farm Testing

Use the `mobile-device-farm` template to add Firebase TestLab testing to an existing app.

Device matrices available:

| Size | Devices | Use case |
|---|---|---|
| Low (1 device) | Pixel 6 or iPhone 14 | Fast smoke check on every PR |
| Medium (3 devices) | Pixel 6 + S21 + Pixel 7 / iPhone 14 + 13 + SE | Pre-release regression |
| High (5 devices) | Full coverage matrix | Release gate |

```bash
# Run tests manually against Firebase TestLab
gcloud firebase test android run \
  --type instrumentation \
  --app app/build/outputs/apk/debug/app-debug.apk \
  --test app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
  --device model=Pixel6,version=31,locale=en,orientation=portrait
```

---

## Shared SDK Library

Use the `mobile-sdk` template to scaffold a shared library used across multiple mobile apps:

1. Go to **Backstage → Create** → **Mobile SDK**
2. Choose platform targets: Android (Kotlin), iOS (SPM), Flutter, Kotlin Multiplatform
3. The scaffolder creates a library repo with:
   - Conditional build targets per platform
   - GitHub Actions CI: test → build → publish (on version-tagged releases)
   - Publishing to GitHub Packages (Android/KMP), SPM index (iOS), pub.dev (Flutter)

```bash
# Publish a new version (bumps version tag and triggers publish workflow)
git tag v1.2.0
git push origin v1.2.0
```

---

## Local Setup

### iOS

```bash
# Install Xcode from the Mac App Store
# Install Fastlane
gem install bundler
bundle install    # installs Gemfile dependencies (Fastlane + plugins)

# Run tests
bundle exec fastlane test

# Build for TestFlight
bundle exec fastlane beta
```
