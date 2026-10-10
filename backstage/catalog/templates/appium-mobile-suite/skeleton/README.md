# ${{ values.name }}

${{ values.description }}

Appium + WebdriverIO mobile test suite for `${{ values.targetService }}` on **${{ values.platform }}**.

## Quick start

```bash
npm install
npm run appium:drivers   # once per machine: installs the Appium driver(s) for your platform
APP_PATH=/path/to/your.app npm test
```

## Prerequisites

- Appium 3: bundled via npm — start with `npm run appium`. Platform drivers are
  installed separately with `npm run appium:drivers` (Appium's own `appium driver install`)
- Android: Android Studio + emulator, or a real device connected via USB
- iOS: Xcode + Simulator (macOS only)

Set `APP_PATH` to the path of your built `.apk` / `.app` file.
