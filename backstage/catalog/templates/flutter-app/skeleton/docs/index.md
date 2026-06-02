# ${{ values.name }}

${{ values.description }}

## Quick Start

### Prerequisites

- Flutter SDK 3.27+ ([install guide](https://docs.flutter.dev/get-started/install))
- Dart SDK (bundled with Flutter)
- Android Studio or VS Code with Flutter extension

### Run Locally

```bash
# Install dependencies
flutter pub get

# Run on connected device / emulator
flutter run

# Run in Chrome (web)
flutter run -d chrome
```

### Test & Build

```bash
# Run all tests
flutter test

# Analyze code
flutter analyze

# Build Android APK (debug)
flutter build apk --debug

# Build Flutter Web
flutter build web --release
```

## Architecture

| Layer | Technology |
|-------|-----------|
| UI | Flutter Widgets + Material 3 |
| State | (add your state management: Riverpod, BLoC, Provider) |
| Testing | flutter_test + widget tests |
| CI/CD | GitHub Actions + Fastlane |

## CI/CD

| Branch | Jobs |
|--------|------|
| All branches | Analyze → Test → Build APK → Build Web |
| `main` only | + Publish Flutter Web Docker image to GHCR |

{% if values.enableFirebase %}
## Firebase

Firebase Crashlytics and Analytics are enabled. Make sure to:
1. Download `google-services.json` from Firebase Console → place in `android/app/`
2. Download `GoogleService-Info.plist` → place in `ios/Runner/`
{% endif %}

## Owner

Team: **${{ values.owner }}**
