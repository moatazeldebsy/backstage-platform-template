# Runbook: ${{ values.name }}

## Build Failures

### `flutter pub get` fails
- Check `pubspec.yaml` for version conflicts
- Run `flutter pub deps` to inspect the dependency graph
- Try `flutter clean && flutter pub get`

### Flutter analyze errors
- Run `flutter analyze` locally and fix flagged issues
- `dart format .` to fix formatting

### Android build fails
- Ensure JDK 17 is installed: `java -version`
- Run `./gradlew clean` in the `android/` directory

## Release Process

1. Bump `version` in `pubspec.yaml` (e.g. `1.1.0+2`)
2. Tag the commit: `git tag v1.1.0`
3. CI builds APK and Web automatically on `main`
4. For Firebase distribution: `fastlane distribute_android`

## Flutter Web in Kubernetes

If Flutter Web deploy is enabled, the web build runs in K8s as an Nginx container.
Check pod status:
```bash
kubectl get pods -n services-dev -l app=${{ values.name }}
kubectl logs -n services-dev -l app=${{ values.name }}
```

## Contacts

- Owner: ${{ values.owner }}
- Jira: ${{ values.jiraProjectKey }}
