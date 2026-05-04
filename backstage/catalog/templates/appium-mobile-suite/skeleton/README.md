# ${{ values.name }}

${{ values.description }}

Appium + WebdriverIO mobile test suite for `${{ values.targetService }}` on **${{ values.platform }}**.

## Quick start

```bash
npm install
APP_PATH=/path/to/your.app npm test
```

## Prerequisites

- Appium 2: bundled via npm — start with `npm run appium`
- Android: Android Studio + emulator, or a real device connected via USB
- iOS: Xcode + Simulator (macOS only)

Set `APP_PATH` to the path of your built `.apk` / `.app` file.
