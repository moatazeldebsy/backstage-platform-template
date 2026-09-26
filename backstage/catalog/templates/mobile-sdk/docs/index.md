# Shared Mobile SDK Library

Scaffold a shared mobile SDK library for Android (Kotlin), iOS (Swift Package), Flutter, or Kotlin Multiplatform — with GitHub Packages publishing built in

## What it does

1. **Fetch SDK Template** — `fetch:template`
2. **Publish to GitHub** — `publish:github`
3. **Register in Catalog** — `catalog:register`

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `name` | yes | Unique SDK name (lowercase, hyphens only) |
| `description` | yes | Description |
| `owner` | yes | Team or user owning this SDK |
| `platform` | yes | Platform — one of `android`, `ios`, `flutter`, `multiplatform`; default `android` |
| `repoUrl` | yes | GitHub Repository |

## How to use

1. Open Backstage → **Create**
2. Find **Shared Mobile SDK Library** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
