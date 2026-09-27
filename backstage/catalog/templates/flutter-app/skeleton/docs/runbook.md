# Runbook: ${{ values.name }}

## Build Failures

### `flutter pub get` fails
- Check `pubspec.yaml` for version conflicts
- Run `flutter pub deps` to inspect the dependency graph
- Try `flutter clean && flutter pub get`

### Flutter analyze errors
- Run `flutter analyze` locally and fix flagged issues
- `dart format .` to fix formatting

{%- if 'android' in values.platforms %}

### Android build fails
- Ensure JDK 17 is installed: `java -version`
- Run `./gradlew clean` in the `android/` directory
{%- endif %}
{%- if 'ios' in values.platforms %}

### iOS build fails
- Build on macOS with Xcode installed: `xcodebuild -version`
- Run `flutter clean && flutter pub get`, then retry `flutter build ios --debug --no-codesign`
- CI builds unsigned; add signing with the mobile-code-signing template
{%- endif %}

## Release Process

1. Bump `version` in `pubspec.yaml` (e.g. `1.1.0+2`)
2. Tag the commit: `git tag v1.1.0`
3. CI builds every target platform automatically on `main`
{%- if 'android' in values.platforms %}
4. For Firebase distribution: `fastlane distribute_android`
{%- endif %}

{%- if values.enableWebDeploy and 'web' in values.platforms %}

## Flutter Web in Kubernetes

The web build runs in K8s as an Nginx container.
Check pod status:
```bash
kubectl get pods -n services-dev -l app=${{ values.name }}
kubectl logs -n services-dev -l app=${{ values.name }}
```
{%- endif %}

## Contacts

- Owner: ${{ values.owner }}
- Jira: ${{ values.jiraProjectKey }}
