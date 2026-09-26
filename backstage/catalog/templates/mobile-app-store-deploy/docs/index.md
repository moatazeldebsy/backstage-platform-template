# Mobile App Store Deployment

Add automated Google Play or App Store deployment via Fastlane to an existing mobile app repository

## What it does

1. **Fetch Store Deployment Files** — `fetch:template`
2. **Open Pull Request** — `publish:github:pull-request` against the repository you choose

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `targetService` | yes | The mobile app component to add store deployment to |
| `platform` | yes | Target Store — one of `google_play`, `app_store`, `both`; default `google_play` |
| `track` | yes | Release Track — one of `internal`, `alpha`, `beta`, `production`; default `internal` |
| `versionName` | yes | Semantic version string, e.g. 1.2.3 — default `1.0.0` |
| `versionCode` | yes | Integer build number (monotonically increasing) — default `1` |
| `repoUrl` | yes | Target Repository |

## How to use

1. Open Backstage → **Create**
2. Find **Mobile App Store Deployment** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
