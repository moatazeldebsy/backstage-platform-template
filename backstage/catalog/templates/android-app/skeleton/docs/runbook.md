# Runbook: ${{ values.name }}

## Build Failures

### Gradle sync fails
1. Check JDK version: `java -version` (must be 17)
2. Run `./gradlew clean` then retry
3. Check `gradle/libs.versions.toml` for version conflicts

### Lint errors
- Run `./gradlew lint` locally and check `app/build/reports/lint-results-debug.html`

## Release Process

1. Bump `versionCode` and `versionName` in `app/build.gradle.kts`
2. Tag the commit: `git tag v1.x.x`
3. CI builds the release APK automatically on `main`
4. Run `fastlane distribute` to upload to Firebase App Distribution

## Contacts

- Owner: ${{ values.owner }}
- Jira: ${{ values.jiraProjectKey }}
