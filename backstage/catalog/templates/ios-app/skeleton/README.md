# ${{ values.name }}

[![CI](https://github.com/${{ values.githubOrg }}/${{ values.repoName }}/actions/workflows/ci.yml/badge.svg)](https://github.com/${{ values.githubOrg }}/${{ values.repoName }}/actions/workflows/ci.yml)

${{ values.description }}

## Requirements

- Xcode 15+
- Swift 5.9+
- iOS ${{ values.minIosVersion }}+
- [Fastlane](https://fastlane.tools/) (for release automation)
- [SwiftLint](https://github.com/realm/SwiftLint) (for linting)

## Getting Started

```bash
# Clone the repo
git clone https://github.com/${{ values.githubOrg }}/${{ values.repoName }}.git
cd ${{ values.repoName }}

# Open in Xcode
open Package.swift

# Or build from command line
swift build
```

## Running Tests

```bash
swift test --parallel
```

## Linting

```bash
swiftlint lint
swiftlint --fix   # auto-fix violations
```

## Fastlane

### Run tests locally
```bash
fastlane test
```

### Upload to TestFlight
```bash
fastlane beta
```
Requires environment variables:
- `APPLE_ID` — your Apple ID email
- `APPLE_TEAM_ID` — your Apple Developer team ID
- `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` — app-specific password

### Release to App Store
```bash
fastlane release
```

## CI/CD

GitHub Actions runs on every push and pull request:

| Job   | What it does |
|-------|-------------|
| lint  | SwiftLint + Trivy secret scan + SonarCloud + Snyk |
| test  | `swift test --parallel` |
| build | `swift build -c release` |

## Required GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `SONAR_TOKEN` | SonarCloud quality gate (optional) |
| `SNYK_TOKEN` | Snyk dependency scan (optional) |
| `APPLE_ID` | Fastlane TestFlight / App Store uploads |
| `APPLE_TEAM_ID` | Fastlane signing |
| `FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD` | Fastlane auth |

## Architecture

This project uses Swift Package Manager. Source lives in `Sources/${{ values.name | replace('-', '_') }}/`, tests in `Tests/${{ values.name | replace('-', '_') }}Tests/`.

## Documentation

TechDocs are at [Backstage](${{ values.backstageUrl }}/catalog/default/component/${{ values.name }}/docs).
