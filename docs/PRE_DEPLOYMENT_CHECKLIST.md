# Pre-Deployment Secrets Verification — AWS Setup

**Last Updated:** 2026-05-23  
**Purpose:** Prevent deployment failures due to missing or invalid credentials

---

## Quick Start

```bash
# 1. Set your credentials (see below for details)
# 2. Run the verification script
./scripts/verify-secrets.sh

# 3. If all ✅, proceed with deployment
./scripts/setup.sh
./scripts/bootstrap.sh
```

---

## Required Credentials

### 1️⃣ ANTHROPIC_API_KEY (Critical for KAgent)

**Why needed:** Powers AI agents and the idp-assistant chatbot in Backstage

**Get it:**
1. Visit https://console.anthropic.com/settings/keys
2. Generate or copy existing API key (format: `sk-ant-...`)

**Set it in AWS:**
```bash
# Create the secret for the first time
aws secretsmanager create-secret \
  --name idp-mvp/kagent \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-YOUR_ACTUAL_KEY"}' \
  --region us-east-1

# Update an existing secret
aws secretsmanager update-secret \
  --secret-id idp-mvp/kagent \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-YOUR_ACTUAL_KEY"}' \
  --region us-east-1

# Verify it was set correctly
aws secretsmanager get-secret-value \
  --secret-id idp-mvp/kagent \
  --region us-east-1 --query SecretString --output text | jq .
```

**Status:** ☐ Created / ☐ Updated / ☐ Verified

---

### 2️⃣ GITHUB_TOKEN (Required)

**Why needed:** 
- GitHub Actions CI/CD authentication
- ArgoCD syncing with GitHub repos
- Backstage catalog refresh

**Get it:**
1. Visit https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Scopes needed: `repo`, `read:org`, `gist`
4. Copy the token (you only see it once)

**Set it in local/.env:**
```bash
# Edit local/.env
GITHUB_TOKEN=ghp_YOUR_TOKEN_HERE
```

**Verify:**
```bash
grep "^GITHUB_TOKEN=" local/.env
# Should show: GITHUB_TOKEN=ghp_...
```

**Status:** ☐ Set in local/.env / ☐ Verified

---

### 3️⃣ GitHub OAuth Credentials (Required for Backstage Login)

**Why needed:** Enable GitHub sign-in for Backstage portal

**Get it:**
1. Visit https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: `Backstage IDP`
   - Authorization callback URL: `http://YOUR_BACKSTAGE_ALB_URL/api/auth/github/handler/frame`
   
   ⚠️ **Note:** Use the ALB URL from `./scripts/bootstrap.sh` output, or use temporary URL like `http://localhost:3000/api/auth/github/handler/frame`

4. Copy `Client ID` and `Client Secret`

**Set it in local/backstage/.env:**
```bash
# Edit local/backstage/.env
AUTH_GITHUB_CLIENT_ID=your-client-id-here
AUTH_GITHUB_CLIENT_SECRET=your-client-secret-here
```

**Verify:**
```bash
grep "^AUTH_GITHUB_CLIENT" local/backstage/.env
# Should show both CLIENT_ID and CLIENT_SECRET
```

**Status:** ☐ OAuth app created / ☐ Set in local/backstage/.env / ☐ Verified

---

### 4️⃣ Slack Webhook (Optional - for Cost Alerts)

**Why needed:** Get Slack notifications for cost budget alerts

**Get it:**
1. Create Slack app: https://api.slack.com/apps
2. Enable "Incoming Webhooks"
3. Click "Add New Webhook to Workspace"
4. Copy the webhook URL (format: `https://hooks.slack.com/services/...`)

**Set it in AWS:**
```bash
aws secretsmanager create-secret \
  --name idp-mvp/slack \
  --secret-string '{"SLACK_WEBHOOK_URL":"https://hooks.slack.com/services/YOUR/WEBHOOK"}' \
  --region us-east-1
```

**Status:** ☐ Optional / ☐ Created / ☐ Verified

---

## Verification Script

Run this to check all secrets before deployment:

```bash
./scripts/verify-secrets.sh
```

**Expected output when everything is correct:**
```
🔍 Verifying AWS Secrets & Configuration...
   Region: us-east-1
   Cluster: idp-mvp

┌─────────────────────────────────────────────────────────┐
│ 1. ANTHROPIC_API_KEY (KAgent AI Agents)                │
└─────────────────────────────────────────────────────────┘
✅ ANTHROPIC_API_KEY found and valid

┌─────────────────────────────────────────────────────────┐
│ 2. GITHUB_TOKEN (local/.env)                            │
└─────────────────────────────────────────────────────────┘
✅ GITHUB_TOKEN found in local/.env

┌─────────────────────────────────────────────────────────┐
│ 3. GitHub OAuth Credentials (local/backstage/.env)      │
└─────────────────────────────────────────────────────────┘
✅ GitHub OAuth credentials found in local/backstage/.env

...

✅ All critical checks passed!

You can now proceed with:
  ./scripts/setup.sh
  ./scripts/bootstrap.sh
  ./scripts/validate-deployment.sh
```

---

## File Locations

| Credential | Location | Stored in |
|-----------|----------|-----------|
| ANTHROPIC_API_KEY | AWS Secrets Manager | `idp-mvp/kagent` |
| GITHUB_TOKEN | `local/.env` | Local file (git-ignored) |
| AUTH_GITHUB_CLIENT_ID | `local/backstage/.env` | Local file (git-ignored) |
| AUTH_GITHUB_CLIENT_SECRET | `local/backstage/.env` | Local file (git-ignored) |
| SLACK_WEBHOOK_URL | AWS Secrets Manager | `idp-mvp/slack` (optional) |
| RDS Password | AWS Secrets Manager | Auto-created by Terraform |

---

## Common Issues & Fixes

### ❌ KAgent returns "Error code: 401 - invalid_x-api-key"

**Cause:** ANTHROPIC_API_KEY is missing, invalid, or secret is malformed JSON

**Fix:**
```bash
# 1. Verify secret exists
aws secretsmanager get-secret-value --secret-id idp-mvp/kagent --region us-east-1

# 2. Check JSON format
aws secretsmanager get-secret-value --secret-id idp-mvp/kagent --region us-east-1 \
  --query SecretString --output text | jq .

# 3. Update with correct key
aws secretsmanager update-secret \
  --secret-id idp-mvp/kagent \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-YOUR_KEY"}' \
  --region us-east-1

# 4. Restart KAgent
kubectl rollout restart deployment/kagent-controller -n kagent
```

---

### ❌ Backstage shows "GitHub login unavailable"

**Cause:** GitHub OAuth credentials missing or callback URL mismatch

**Fix:**
```bash
# 1. Verify credentials in local/backstage/.env
grep "^AUTH_GITHUB" local/backstage/.env

# 2. Update GitHub OAuth app with correct callback URL
# Visit https://github.com/settings/developers and update the callback URL to match:
# http://YOUR_ACTUAL_BACKSTAGE_ALB_URL/api/auth/github/handler/frame

# 3. Restart Backstage
./scripts/bootstrap-local.sh --start-backstage
# OR for AWS:
kubectl rollout restart deployment/backstage -n backstage
```

---

### ❌ "Secret not found" during bootstrap

**Cause:** Secret created in wrong region or under wrong name

**Fix:**
```bash
# List all secrets in your region
aws secretsmanager list-secrets --region us-east-1

# Check if secret exists with correct name
aws secretsmanager describe-secret --secret-id idp-mvp/kagent --region us-east-1

# Recreate if needed
aws secretsmanager create-secret \
  --name idp-mvp/kagent \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-YOUR_KEY"}' \
  --region us-east-1
```

---

## Pre-Deployment Checklist

Before running `./scripts/setup.sh`:

- [ ] AWS credentials configured (`aws sts get-caller-identity` works)
- [ ] AWS region set correctly (default: us-east-1)
- [ ] ANTHROPIC_API_KEY obtained from https://console.anthropic.com/settings/keys
- [ ] ANTHROPIC_API_KEY created in AWS Secrets Manager (`idp-mvp/kagent`)
- [ ] GITHUB_TOKEN obtained from https://github.com/settings/tokens
- [ ] GITHUB_TOKEN set in `local/.env`
- [ ] GitHub OAuth app created at https://github.com/settings/developers
- [ ] GitHub OAuth credentials set in `local/backstage/.env`
- [ ] Slack webhook (optional) created and set in AWS Secrets Manager
- [ ] Verification script passes: `./scripts/verify-secrets.sh` → All ✅
- [ ] Required tools installed: aws, terraform, kubectl, helm, docker, jq

---

## Deployment Order

```bash
# 1. Verify all secrets
./scripts/verify-secrets.sh
# Expected: ✅ All critical checks passed!

# 2. Personalize configuration (first time only)
./scripts/setup.sh
# When prompted for environment, choose "aws"

# 3. Deploy to AWS (~45-60 minutes)
./scripts/bootstrap.sh
# Monitor output, note the Backstage ALB URL

# 4. Validate all components
./scripts/validate-deployment.sh
# Expected: ✅ DEPLOYMENT VALIDATION PASSED

# 5. (Optional) Deploy AI/ML stack
./scripts/bootstrap-ai.sh

# 6. Access Backstage
# Update GitHub OAuth callback URL if needed (see above)
# Open the ALB URL in browser and sign in with GitHub
```

---

## Support

**For detailed deployment guide:** See `docs/DEPLOYMENT_GUIDE.md`  
**For troubleshooting:** See `docs/DEPLOYMENT_GUIDE.md` → Troubleshooting  
**For production hardening:** See `docs/DEPLOYMENT_GUIDE.md` → Production Hardening  

Questions? Check the verification script output for specific fix commands.
