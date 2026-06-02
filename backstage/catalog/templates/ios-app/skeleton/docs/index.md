# ${{ values.name }}

${{ values.description }}

## Overview

This is an iOS app built with Swift and SwiftUI, scaffolded via the IDP golden-path template.

- **Bundle ID**: `${{ values.bundleId }}`
- **Minimum iOS**: ${{ values.minIosVersion }}
- **Owner**: ${{ values.owner }}

## Architecture

Source code lives in `Sources/${{ values.name | replace('-', '_') }}/`. Tests are in `Tests/${{ values.name | replace('-', '_') }}Tests/`.

## Running Locally

```bash
swift build
swift test --parallel
```

## CI/CD

GitHub Actions runs lint, test, and build on every push. Fastlane handles TestFlight and App Store releases.

## Runbook

See [runbook.md](https://github.com/${{ values.githubOrg }}/${{ values.repoName }}/blob/main/docs/runbook.md) for operational procedures.
