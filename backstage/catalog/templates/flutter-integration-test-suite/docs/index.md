# Flutter Integration Test Suite

Add Flutter integration tests to an existing Flutter app. Tests run on Firebase Test Lab via GitHub Actions.

## What it does

1. **Fetch Integration Test Files** — `fetch:template`
2. **Open Pull Request on Flutter App Repo** — `publish:github:pull-request` against the repository you choose
3. **Inject GCP credentials into repo secrets** — `idp:repo:set-secrets` _(only when `${{ parameters.testRunner === 'firebase-test-lab' }}`)_

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `name` | yes | Unique name for this test suite (lowercase, hyphens only) |
| `description` | yes | Description |
| `owner` | yes | Owner |
| `targetService` | no | The Flutter app this test suite targets |
| `targetRepoUrl` | no | The existing Flutter app repo to open the PR against |
| `testRunner` | no | Test Runner — one of `local-emulator`, `firebase-test-lab`; default `local-emulator` |
| `firebaseProjectId` | no | Required for Firebase Test Lab. Find in Firebase Console → Project Settings. |
| `jiraProjectKey` | no | Optional. |

## How to use

1. Open Backstage → **Create**
2. Find **Flutter Integration Test Suite** and click **Choose**
3. Fill in the parameters above and click **Create**

## Source

Template definition: `template.yaml` in this template's folder under `backstage/catalog/templates/`.
