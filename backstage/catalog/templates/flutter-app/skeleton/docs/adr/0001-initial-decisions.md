# ADR 0001 — Initial Architecture Decisions

## Status

Accepted

## Context

New Flutter app scaffolded via the IDP golden path. This record captures the key technology choices made at inception so future contributors understand the rationale.

## Decisions

- **Language**: Dart — Flutter's only supported language; strong typing, null-safety, async/await via `Future`/`Stream`
- **UI framework**: Flutter with Material 3 — single codebase targeting Android, iOS, and Web from one source tree
- **Target platforms**: ${{ values.platforms | join(", ") }}
- **State management**: none prescribed at scaffold time — choose Riverpod, BLoC, or Provider when the app grows beyond 3 screens; avoid `setState` in production code
- **Package manager**: `pub` (via `pubspec.yaml`) — Flutter's standard; lockfile (`pubspec.lock`) must be committed to ensure reproducible builds
- **Code quality**: `flutter_lints` enforced via `analysis_options.yaml`; `dart format` is the canonical formatter (enforced in CI and pre-commit)
- **Release management**: Fastlane — automates signing, versioning, and distribution (Firebase App Distribution / App Store / Play Store)
- **Web deployment**: ${{ "Enabled — Flutter Web compiled to static assets, served by Nginx in a Docker container deployed to Kubernetes via the shared Helm service template" if values.enableWebDeploy else "Disabled at scaffold time — enable by running the Flutter Web K8s deploy scaffold" }}

## Consequences

- A single Dart codebase means platform-specific UI idioms (e.g. Cupertino widgets on iOS) must be explicitly handled; the scaffold defaults to Material 3 on all platforms
- `pubspec.lock` must be committed — un-committed lockfiles cause non-reproducible CI builds
- State management choice significantly impacts testability; document the chosen approach in ADR 0002 when decided
- Flutter Web has known performance limitations for animation-heavy UIs; evaluate `CanvasKit` vs `html` renderer based on use case
