# ADR 0001 — Initial Architecture Decisions

## Status

Accepted

## Context

New Android app scaffolded via the IDP golden path. This record captures the key technology choices made at inception so future contributors understand the rationale.

## Decisions

- **Language**: Kotlin — official first-class language for Android; full Jetpack Compose support, null-safety, and coroutines built in
- **UI framework**: Jetpack Compose — declarative UI that replaces XML layouts; requires `minSdk` ≥ 21 (set to ${{ values.minSdk }})
- **Architecture**: MVVM (Model-View-ViewModel) — recommended by Google; `ViewModel` survives config changes, `StateFlow` drives UI state
- **Build system**: Gradle with Kotlin DSL (`build.gradle.kts`) — type-safe, IDE-friendly, version catalog via `gradle/libs.versions.toml`
- **Dependency injection**: none at scaffold time — add Hilt when the codebase grows beyond 3 screens
- **Min SDK**: API ${{ values.minSdk }} — covers $(if ${{ values.minSdk }} == 26)~90%(else)~95%(endif) of active Android devices
- **Release management**: Fastlane — automates signing, versioning, and distribution (Firebase App Distribution / Play Store)

## Consequences

- Jetpack Compose requires familiarity with reactive programming; XML layout experience does not transfer directly
- MVVM + StateFlow means all UI mutations must go through `ViewModel`; direct view manipulation is not permitted
- `libs.versions.toml` must be the single source of truth for all dependency versions — no hardcoded versions in `build.gradle.kts`
- When adding Hilt, apply the Hilt Gradle plugin to `build.gradle.kts` and annotate `Application` with `@HiltAndroidApp`
