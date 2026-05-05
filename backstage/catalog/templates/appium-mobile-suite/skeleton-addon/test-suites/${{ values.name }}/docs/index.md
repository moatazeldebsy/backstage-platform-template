# ${{ values.name }}

${{ values.description }}

## Overview

Appium + WebdriverIO mobile test suite for **${{ values.targetService }}** on **${{ values.platform }}**.

- **Appium Server:** `${{ values.appiumServer }}`

## Running locally

```bash
npm install
APP_PATH=/path/to/app npm test
```

## CI

The GitHub Actions workflow starts the Appium server, waits for it to be ready, then runs the WebdriverIO test suite. Set the `APP_PATH` repository variable to point to a pre-built artefact.

## Adding tests

Add new `.spec.ts` files under `tests/`. Each file gets the full WebdriverIO `browser` global. Use the [Appium element selectors](https://appium.io/docs/en/commands/element/find-elements/) appropriate for your platform.
