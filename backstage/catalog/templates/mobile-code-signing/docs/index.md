# Mobile Code Signing Setup

Add automated code signing for iOS (Fastlane Match via S3) or Android (keystore via AWS Secrets Manager) to an existing mobile app repository

## What it does

1. **Fetch Code Signing Files** — `fetch:template`
2. **Open Pull Request** — `publish:github:pull-request` against the repository you choose

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `targetService` | yes | The mobile app component to add code signing to |
| `platform` | yes | Platform — one of `ios`, `android`, `both`; default `ios` |
| `bundleId` | no | Required for iOS. Reverse-domain bundle ID (e.g. com.mycompany.myapp) |
| `packageName` | no | Required for Android. Reverse-domain package name (e.g. com.mycompany.myapp) |
| `environment` | yes | Environment — one of `development`, `staging`, `production`; default `development` |
| `codeSignS3Bucket` | no | S3 bucket name where Fastlane Match certificates are stored — default `your-org-code-signing` |
| `repoUrl` | yes | Target Repository |

## How to use

1. Open Backstage → **Create**
2. Find **Mobile Code Signing Setup** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
