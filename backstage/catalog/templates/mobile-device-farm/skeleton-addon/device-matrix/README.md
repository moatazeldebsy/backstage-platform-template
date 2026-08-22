# Device matrices

One directory per provider, because the four device farms genuinely disagree on
both file format and device naming — a single shared matrix would have to be
translated for three of them anyway.

| Provider | Location | Format | Device naming |
|---|---|---|---|
| Firebase Test Lab | `firebase/*.yml` | YAML — required by `gcloud ... --device-spec` | model codes (`oriole`, `a10s`) |
| LambdaTest | `lambdatest/*.json` | JSON — read with `jq` | no manufacturer (`Pixel 6-13`) |
| BrowserStack | `browserstack/*.json` | JSON — read with `jq` | manufacturer-prefixed (`Google Pixel 6-13`) |
| Sauce Labs | *(none — see below)* | — | — |

JSON for the two REST-driven providers because `jq` is preinstalled on
GitHub-hosted runners and needs no extra dependency; YAML for Firebase because
`gcloud` requires that format.

**Sauce Labs has no matrix file here on purpose.** Its supported path for
Espresso/XCUITest is the `saucectl` CLI, which owns the device list inside
`.sauce/config.yml`. Splitting that list into a second file the CLI never reads
would be a matrix that looks authoritative and isn't — so the devices live in
`.sauce/config.yml`, and that file is the one to edit.

An unrecognised device name makes the build request fail with a 400, so keep to
each provider's own convention when editing.

Coverage tiers match the labels in the scaffolder wizard:

| Tier | Devices | Rough wall-clock |
|---|---|---|
| `low` | 1 | ~5 min |
| `medium` | 3 | ~15 min |
| `high` | 5, incl. a tablet | ~30 min |
