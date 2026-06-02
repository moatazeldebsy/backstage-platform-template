# Code Signing Setup Guide

This guide explains how to configure the required secrets for automated mobile code signing.

## iOS (Fastlane Match via S3)

Fastlane Match stores certificates and provisioning profiles encrypted in an S3 bucket.

### Prerequisites

1. An AWS account with an S3 bucket named `${{ values.codeSignS3Bucket }}` (or your preferred bucket).
2. An Apple Developer account with admin access.
3. An app-specific password for your Apple ID ([appleid.apple.com](https://appleid.apple.com/)).

### AWS Setup

Create an IAM policy allowing access to the Match S3 bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${{ values.codeSignS3Bucket }}",
        "arn:aws:s3:::${{ values.codeSignS3Bucket }}/*"
      ]
    }
  ]
}
```

Attach this policy to the IAM role used by GitHub Actions (`AWS_ROLE_ARN`).

### First-time certificate generation

```bash
bundle exec fastlane match ${{ values.environment }} --generate-apple-certs
```

### Required GitHub Secrets

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | IAM role ARN for OIDC auth |
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `CODE_SIGN_S3_BUCKET` | S3 bucket name for Match storage |
| `MATCH_GIT_URL` | Override: `s3://<bucket>/match` |
| `APPLE_ID` | Apple ID email used for signing |
| `MATCH_PASSWORD` | Encryption password for Match repository |

---

## Android (Keystore via AWS Secrets Manager)

The Android keystore is stored in AWS Secrets Manager and downloaded at CI time.

### Creating the secret

```bash
# Base64-encode your keystore
KEYSTORE_B64=$(base64 -i release.keystore)

# Store in AWS Secrets Manager
aws secretsmanager create-secret \
  --name "mobile/${{ values.packageName | default('your.package.name') }}/${{ values.environment }}/keystore" \
  --secret-string "$KEYSTORE_B64"
```

### Required GitHub Secrets

| Secret | Value |
|--------|-------|
| `AWS_ROLE_ARN` | IAM role ARN for OIDC auth |
| `AWS_REGION` | AWS region (default: `us-east-1`) |
| `KEYSTORE_STORE_PASSWORD` | Keystore store password |
| `KEYSTORE_KEY_ALIAS` | Signing key alias |
| `KEYSTORE_KEY_PASSWORD` | Key password |

### IAM policy for Secrets Manager

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:*:*:secret:mobile/*"
    }
  ]
}
```

---

## Triggering the Workflow

Once secrets are configured, trigger manually from the Actions tab:

```
Actions → Code Signing → Run workflow → action: sync
```
