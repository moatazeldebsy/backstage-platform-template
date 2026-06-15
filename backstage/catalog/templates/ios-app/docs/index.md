# iOS App (Swift/SwiftUI)

Scaffold a production-ready iOS app with Swift, SwiftUI, Swift Package Manager, Fastlane CI/CD, SonarCloud, and Snyk integration.

## How to use

1. Open Backstage → **Create**
2. Find **iOS App (Swift/SwiftUI)** and click **Choose**
3. Fill in the parameters and click **Create**

## What gets scaffolded

- Swift + SwiftUI project using Swift Package Manager
- SwiftLint configuration (`.swiftlint.yml`) enforcing code style
- GitHub Actions CI: lint → unit tests → archive → TestFlight upload (main only)
- Fastlane `Fastfile` with `test`, `build`, and `distribute` lanes
- SonarCloud static analysis integration
- Snyk security scanning
- Backstage `catalog-info.yaml` with `spec.type: mobile`
- TechDocs (`mkdocs.yml` + `docs/`)

## Parameters

| Parameter | Description |
|-----------|-------------|
| App Name | Lowercase, hyphens only (e.g. `my-ios-app`) |
| Bundle ID | Reverse-domain iOS bundle identifier (e.g. `com.acme.myapp`) |
| Owner | Backstage group owning this app |

## Source

Template definition: [`template.yaml`](../template.yaml)
