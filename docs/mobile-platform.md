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
| **mobile-device-farm** | Add-on | Cloud device testing on Firebase Test Lab or LambdaTest, with a configurable device matrix |
| **flutter-integration-test-suite** | Test | Flutter integration tests on Firebase TestLab or local emulator (adds to existing Flutter repo) |
| **appium-mobile-suite** | Test | Appium + WebdriverIO cross-device suite with BrowserStack / Sauce Labs / LambdaTest support |

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

Adds cloud device-farm testing to an existing app repo, on any of four providers.

| | Firebase Test Lab | LambdaTest | BrowserStack | Sauce Labs |
|---|---|---|---|---|
| Credential | `GCP_SERVICE_ACCOUNT_KEY` | `LT_USERNAME` + `LT_ACCESS_KEY` | `BROWSERSTACK_USERNAME` + `BROWSERSTACK_ACCESS_KEY` | `SAUCE_USERNAME` + `SAUCE_ACCESS_KEY` |
| Extra setup | A GCP project with Test Lab enabled | None | None | None |
| Runner integration | `gcloud firebase test android\|ios run` | REST API — upload, trigger, poll | App Automate REST API — upload, trigger, poll | `saucectl` CLI |
| Device matrix | `device-matrix/firebase/*.yml` | `device-matrix/lambdatest/*.json` | `device-matrix/browserstack/*.json` | `.sauce/config.yml` — see below |
| Execution modes | Device grid | Device grid, or **HyperExecute** | Device grid | Device grid |
| Results | Exported to GCS, linked from the PR comment | Build link in the PR comment, raw JSON artifact | Build link in the PR comment, raw JSON artifact | Build link in the PR comment, `saucectl.log` + JUnit XML artifact |

Device naming differs per provider and is not interchangeable — LambdaTest drops
the manufacturer (`Pixel 6-13`), BrowserStack keeps it (`Google Pixel 6-13`), and
Firebase uses model codes (`oriole`). An unrecognised name fails the build request
with a 400.

**Sauce Labs has no `device-matrix/` directory on purpose.** Its supported path for
Espresso/XCUITest is the `saucectl` CLI, which owns the device list inside
`.sauce/config.yml`. A second file the CLI never reads would look authoritative
and not be, so the devices live in the config the CLI actually uses.

All four providers share the same coverage tiers — **Low** (1 device, ~5 min),
**Medium** (3, ~15 min), **High** (5 including a tablet, ~30 min) — and the same
generated workflow, which runs on every push and pull request.

Credentials are injected into the target repository automatically by
`idp:repo:set-secrets`, sourced from the Backstage backend's own environment.
Nothing needs setting on the repo by hand. See [Credentials](#device-farm-credentials).

**Use this when:** you need to validate your app on real devices across a range of hardware/OS versions.

#### Device farm credentials

All four providers' credentials follow the same path — `local/backstage/.env`
locally, the `backstage-secrets` Kubernetes secret on AWS — and are injected into
scaffolded repos by `idp:repo:set-secrets`:

| Provider | Keys |
|---|---|
| Firebase Test Lab | `GCP_SERVICE_ACCOUNT_KEY` |
| LambdaTest | `LT_USERNAME`, `LT_ACCESS_KEY` (plus `LT_BASIC_AUTH` for the entity tab) |
| BrowserStack | `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` |
| Sauce Labs | `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` |

On AWS these are optional keys on the existing `idp-mvp/backstage` Secrets
Manager secret. That secret carries `lifecycle { ignore_changes = [secret_string] }`
in Terraform, so add them with the AWS console or CLI rather than through a
`terraform apply` — the same route `SONAR_TOKEN` and `SNYK_TOKEN` already take.

Left unset, the templates still scaffold and the scaffolder log names the secret
it skipped; the generated workflow then fails on its first run with an explicit
error rather than an unexplained 401.

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
- Device farm options: Local Emulator, BrowserStack, Sauce Labs, or LambdaTest
- Parallel CI execution across selected device matrix
- K8s Secret provisioned for device farm credentials

The generated workflow adapts to the choice: the local-emulator variant starts an
Appium server on the runner and stays on a weekly cron (a hosted runner has no
device grid), while the cloud variants skip that server, export the chosen
vendor's credentials, and run per pull request as well.

Also available from the CLI:

```bash
idp testsuite --type appium --name my-mobile-suite --service my-app \
  --device-farm lambdatest
```

---

## Tech Insights: Mobile Scorecard

Five mobile-specific quality checks appear in a **Mobile** group on the Scorecard
tab of any entity with `spec.type: mobile` or the `mobile` tag. Non-mobile
entities never see them.

**Mobile scores differently from everything else.** Every other group uses count
thresholds — pass any N checks and you reach a tier. That model is wrong for
mobile, where specific things are non-negotiable: an app you cannot sign is not a
Bronze app no matter how many other boxes it ticks. So each mobile tier *names*
the checks it requires:

| Check | ID | Bronze | Silver | Gold |
|---|---|---|---|---|
| Min SDK version | `has-min-sdk-version` | — | ✅ (≥24 Android / ≥16.0 iOS) | ✅ |
| Crashlytics enabled | `has-crashlytics-enabled` | — | — | ✅ |
| Accessibility tests | `has-accessibility-tests` | — | ✅ | ✅ |
| App size budget | `has-app-size-budget` | — | — | ✅ |
| Code signing | `has-code-signing` | ✅ | ✅ | ✅ |

These are **additional** gates, not a replacement. A mobile entity's tier is the
*lower* of its count-based tier (the general Hygiene / Shift-Left / Test Coverage
/ Security checks) and its mobile tier, so it has to clear both the platform-wide
bar and the mobile-specific one. Missing a mobile requirement is called out
explicitly on the entity page, above the general "N more checks" hint, because no
amount of other work will move the tier until it is met.

`accessibility-tests` and `code-signing-setup` are scaffolded as `"false"`: both
are wired up by their own template (`accessibility-suite` and
`mobile-code-signing`), so a new app does not get scored for work it has not done.
Flip the annotation when you run those. `mobile-min-sdk` and
`app-size-budget-mb` are populated from the scaffolder's parameters, and
`crashlytics-enabled` follows the "Enable Firebase" option.

> **Two implementations, one contract.** These checks are computed twice: by
> `backstage/app/packages/backend/src/modules/idpTechInsights.ts` as Tech Insights
> *facts* (pushed to Prometheus via Pushgateway and visible in the Grafana QA
> dashboard), and by `backstage/app/packages/app/src/scorecard.ts` client-side for
> the entity page. The Scorecard tab does not read the backend facts. Change both
> together or they will drift.

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
