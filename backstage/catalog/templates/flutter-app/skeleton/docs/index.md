# ${{ values.name }}

${{ values.description }}

## Quick Start

### Prerequisites

- Flutter SDK 3.27+ ([install guide](https://docs.flutter.dev/get-started/install))
- Dart SDK (bundled with Flutter)
- VS Code or Android Studio with the Flutter extension
{%- if 'android' in values.platforms %}
- Android SDK + JDK 17 (for Android builds)
{%- endif %}
{%- if 'ios' in values.platforms %}
- macOS with Xcode (for iOS builds)
{%- endif %}

### Run Locally

```bash
# Install dependencies
flutter pub get

# Run on connected device / emulator
flutter run
{%- if 'web' in values.platforms %}

# Run in Chrome (web)
flutter run -d chrome
{%- endif %}
```

### Test & Build

```bash
# Run all tests
flutter test

# Analyze code
flutter analyze
{%- if 'android' in values.platforms %}

# Build Android APK (debug)
flutter build apk --debug
{%- endif %}
{%- if 'ios' in values.platforms %}

# Build iOS app (macOS + Xcode, no code signing)
flutter build ios --debug --no-codesign
{%- endif %}
{%- if 'web' in values.platforms %}

# Build Flutter Web
flutter build web --release
{%- endif %}
```

## Architecture

| Layer | Technology |
|-------|-----------|
| UI | Flutter Widgets + Material 3 |
| State | (add your state management: Riverpod, BLoC, Provider) |
| Testing | flutter_test + widget tests |
| CI/CD | GitHub Actions{% if 'android' in values.platforms %} + Fastlane (Android){% endif %} |

## CI/CD

| Branch | Jobs |
|--------|------|
| All branches | Analyze → Test{% if 'android' in values.platforms %} → Build APK{% endif %}{% if 'ios' in values.platforms %} → Build iOS (unsigned){% endif %}{% if 'web' in values.platforms %} → Build Web{% endif %} |
{%- if values.enableWebDeploy and 'web' in values.platforms %}
| `main` only | + Publish Flutter Web Docker image to GHCR |
{%- endif %}

{% if values.enableFirebase %}
## Firebase

Firebase Crashlytics and Analytics are enabled. Make sure to:
{%- if 'android' in values.platforms %}
- Download `google-services.json` from Firebase Console → place in `android/app/`
{%- endif %}
{%- if 'ios' in values.platforms %}
- Download `GoogleService-Info.plist` from Firebase Console → place in `ios/Runner/`
{%- endif %}
{% endif %}

## Owner

Team: **${{ values.owner }}**
