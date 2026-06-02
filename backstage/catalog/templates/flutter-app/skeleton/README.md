# ${{ values.name }}

${{ values.description }}

**Framework:** Flutter (Dart)
**Package:** `${{ values.packageName }}`
**Owner:** ${{ values.owner }}

## Getting Started

```bash
# Install dependencies
flutter pub get

# Run on connected device
flutter run

# Run tests
flutter test

# Build Android APK
flutter build apk --debug

# Build Flutter Web
flutter build web --release
```

## CI/CD

| Branch | Jobs |
|--------|------|
| All branches | Analyze → Test → Build APK → Build Web |
| `main` only | + Push Flutter Web Docker image |

## Documentation

Full docs in Backstage: [Open in Catalog](https://backstage.idp.local/catalog/default/component/${{ values.name }})
