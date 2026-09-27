# Appium Mobile Test Suite

Scaffold an Appium + WebdriverIO mobile test suite for iOS and Android

## How to use

1. Open Backstage → **Create**
2. Find **Appium Mobile Test Suite** and click **Choose**
3. Fill in the required parameters and click **Create**

## After scaffolding: point it at your app

The suite drives an app build, which only your team can provide. Until you do,
CI stays green and shows a notice, *"Mobile tests skipped: No app to test yet"*,
instead of failing.

1. Set the **`APP_PATH`** repository variable (*Settings → Secrets and variables →
   Actions → Variables*) to the `.apk`/`.ipa` path or URL, or to your device
   farm's app id.
2. For a cloud device farm, also add its credentials as secrets
   (`BROWSERSTACK_*`, `SAUCE_*` or `LT_*`).
3. Re-run the workflow.

With **local emulator**, the runner also needs an emulator; a cloud device farm
is the simpler choice in CI.

## Source

Template definition: [`template.yaml`](../template.yaml)
