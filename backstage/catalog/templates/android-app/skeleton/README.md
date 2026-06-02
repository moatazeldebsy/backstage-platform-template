# ${{ values.name }}

${{ values.description }}

**Platform:** Android (Kotlin + Jetpack Compose)
**Min SDK:** ${{ values.minSdk }}
**Owner:** ${{ values.owner }}

## Getting Started

```bash
# Clone and open in Android Studio
git clone https://github.com/${{ values.githubOrg }}/${{ values.repoName }}.git
cd ${{ values.repoName }}

# Build debug APK
./gradlew assembleDebug

# Run unit tests
./gradlew test
```

## CI/CD

| Branch | Action |
|--------|--------|
| All branches | Lint + unit tests |
| `main` | + Release APK build |

Artifacts are uploaded to GitHub Actions for 14 days (debug APK) / 30 days (release APK).

## Documentation

Full docs available in Backstage: [Open in Catalog](https://backstage.idp.local/catalog/default/component/${{ values.name }})
