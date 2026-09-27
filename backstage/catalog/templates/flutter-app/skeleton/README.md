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

## CI/CD

| Branch | Jobs |
|--------|------|
| All branches | Analyze → Test{% if 'android' in values.platforms %} → Build APK{% endif %}{% if 'ios' in values.platforms %} → Build iOS (unsigned){% endif %}{% if 'web' in values.platforms %} → Build Web{% endif %} |
{%- if values.enableWebDeploy and 'web' in values.platforms %}
| `main` only | + Push Flutter Web Docker image |
{%- endif %}

## Documentation

Full docs in Backstage: [Open in Catalog](https://backstage.idp.local/catalog/default/component/${{ values.name }})
