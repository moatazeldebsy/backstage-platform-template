# Mobile Developer Guide

This guide helps Android and Flutter developers get started with the Internal Developer Platform.

## Golden Path: Create Your First App

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

### Appium Mobile Test Suite (BrowserStack / Sauce Labs / LambdaTest)

1. Go to **Backstage → Create** → **Appium Mobile Test Suite**
2. Select your **Device Farm**: Local Emulator, BrowserStack, Sauce Labs, or LambdaTest
3. Select your **Device Matrix**: Pixel 6 / Samsung S21 / iPhone 14 / Pixel 7
4. The scaffolder:
   - Scaffolds WebdriverIO + Appium config with multi-device support
   - Creates a K8s Secret for your device-farm credentials
   - LambdaTest credentials (`LT_USERNAME` / `LT_ACCESS_KEY`) are also injected
     into the repo automatically by the platform — nothing to set up by hand
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

## Cloud Device Farms

Choosing any cloud farm changes the generated CI: it skips the local Appium
server, exports that vendor's credentials, and runs per pull request instead of
on the weekly cron the local-emulator variant uses.

### BrowserStack

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

## CI/CD Architecture

```
GitHub Push
  └── GitHub Actions CI
        ├── Android: lint → test → assembleDebug → (main) assembleRelease
        └── Flutter: analyze → test → build apk → build web → (main) push Docker image

(main branch only)
  └── Flutter Web: Docker image → GHCR → ArgoCD → services-dev namespace
```

For native app distribution, use Fastlane lanes — ArgoCD is not involved (there is no K8s deployment for native mobile apps).
