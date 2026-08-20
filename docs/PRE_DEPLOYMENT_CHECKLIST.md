# Pre-Deployment Checklist — AWS Setup

**Last Updated:** 2026-05-24

---

## Quick Start

```bash
# 1. Set credentials (see below)
# 2. Verify everything is in place
./scripts/verify-secrets.sh
# Expected: ✅ All critical checks passed!

# 3. Deploy
./scripts/setup.sh
./scripts/bootstrap.sh
```

---

## What You Need Before Deploying

### Auto-generated — No Action Required

These are created automatically during bootstrap:

| Credential | How it's created |
|-----------|-----------------|
| `AUTH_SESSION_SECRET` | Terraform generates a 64-char random value |
| `BACKSTAGE_CATALOG_TOKEN` | bootstrap.sh generates and injects into Secrets Manager |
| `K8S_SERVICE_ACCOUNT_TOKEN` | bootstrap.sh reads from cluster, injects into Secrets Manager |
| `POSTGRES_HOST/PORT/USER/PASSWORD` | Terraform creates RDS and stores credentials |

### Required — You Must Set These

---

#### 1. GITHUB_TOKEN

**Why:** Backstage catalog refresh, ArgoCD repo sync, DORA metrics

**Scopes needed:** `repo`, `read:org`, `gist`

**Get it:** https://github.com/settings/tokens → Generate new token (classic)

```bash
# Set in local/.env
echo "GITHUB_TOKEN=ghp_YOUR_TOKEN" >> local/.env
```

Also update Secrets Manager after bootstrap:
```bash
# bootstrap.sh does this automatically if GITHUB_TOKEN is in local/.env
# To update manually:
aws secretsmanager get-secret-value --secret-id idp-mvp/backstage --region us-east-1 \
  --query SecretString --output text | python3 -c "
import sys,json,os; d=json.load(sys.stdin); d['GITHUB_TOKEN']=os.environ['GITHUB_TOKEN']; print(json.dumps(d))
" | aws secretsmanager put-secret-value --secret-id idp-mvp/backstage --secret-string file:///dev/stdin
```

**Status:** ☐ Set in `local/.env`

---

#### 2. GitHub OAuth App (for Backstage GitHub login)

**Why:** Enables GitHub sign-in in Backstage

**Get it:**
1. https://github.com/settings/developers → New OAuth App
2. Fill in:
   - **Application name:** `Backstage IDP`
   - **Homepage URL:** `http://localhost:3000` (update after deploy)
   - **Callback URL:** `http://YOUR_BACKSTAGE_ALB_URL/api/auth/github/handler/frame`  
     *(Use a placeholder — update after bootstrap prints the real ALB URL)*
3. Copy `Client ID` and generate `Client Secret`

```bash
# Set in local/backstage/.env
AUTH_GITHUB_CLIENT_ID=your-client-id
AUTH_GITHUB_CLIENT_SECRET=your-client-secret
```

**After bootstrap:** Update the OAuth app callback URL with the real ALB hostname.

**Status:** ☐ App created / ☐ Credentials set in `local/backstage/.env` / ☐ Callback URL updated post-deploy

---

#### 3. ANTHROPIC_API_KEY (optional — required for AI features)

**Why:** Powers KAgent AI agents and the idp-assistant chatbot

**Get it:** https://console.anthropic.com/settings/keys

```bash
# Set in local/.env
ANTHROPIC_API_KEY=sk-ant-YOUR_KEY

# Also create in Secrets Manager (bootstrap.sh reads from local/.env)
aws secretsmanager create-secret \
  --name idp-mvp/kagent \
  --secret-string "{\"ANTHROPIC_API_KEY\":\"sk-ant-YOUR_KEY\"}" \
  --region us-east-1
```

**Status:** ☐ Optional / ☐ Set if using AI features

---

#### 4. Slack Webhook (optional — for cost alerts)

**Why:** Budget alert notifications

**Get it:** https://api.slack.com/apps → Incoming Webhooks

```bash
aws secretsmanager create-secret \
  --name idp-mvp/slack-webhook \
  --secret-string "{\"SLACK_WEBHOOK_URL\":\"https://hooks.slack.com/services/YOUR/WEBHOOK\"}" \
  --region us-east-1
```

**Status:** ☐ Optional

---

#### 5. Datadog API/App Keys (optional — required for the Datadog Agent, dd-trace APM, and the Datadog catalog tab)

**Why:** Cluster-wide infra observability + APM (see
[docs/sre-reliability.md](sre-reliability.md#datadog-infra-observability-apm))

**Get it:** https://app.datadoghq.eu/organization-settings/api-keys (API key) and
https://app.datadoghq.eu/organization-settings/application-keys (App key)

```bash
# Set in terraform/terraform.tfvars before running terraform apply
datadog_api_key = "YOUR_DD_API_KEY"
datadog_app_key = "YOUR_DD_APP_KEY"
```

Populates both `idp-mvp/datadog` (Datadog Agent) and `idp-mvp/backstage` (Backstage `/datadog`
proxy + dd-trace) Secrets Manager secrets — `scripts/bootstrap.sh` installs the Agent
automatically once these are set.

### PagerDuty and Jira (optional)

**Why:** the Backstage On-Call and Issues entity tabs. Without these the tabs render
their empty state; nothing else breaks.

**Get it:** a read-only PagerDuty REST API key, and for Jira a Base64 encoding of
`email:api_token`.

```bash
# Set in terraform/terraform.tfvars before running terraform apply
pagerduty_token = "YOUR_PAGERDUTY_READ_ONLY_KEY"
jira_token      = "BASE64_OF_email:api_token"
jira_url        = "https://your-company.atlassian.net"
```

All three land in the `idp-mvp/backstage` Secrets Manager secret and reach Backstage
on EKS as `PAGERDUTY_TOKEN`, `JIRA_TOKEN` and `JIRA_URL`. `pagerduty_token` and
`jira_token` default to `REPLACE_ME`; `jira_url` defaults to empty, which leaves
`app-config.aws.yaml` pointing at an RFC 2606 `.invalid` host that never resolves.

**Status:** ☐ Optional / ☐ Set if using Datadog

---

## Pre-Deployment Checklist

```
Tools:
  [ ] aws sts get-caller-identity   → works, shows correct account
  [ ] terraform -version            → ≥ 1.5
  [ ] kubectl version               → installed
  [ ] helm version                  → ≥ 3.x
  [ ] docker info                   → running, buildx available
  [ ] gh auth status                → authenticated
  [ ] jq --version                  → installed
  [ ] python3 --version             → installed

AWS:
  [ ] AWS region confirmed (default: us-east-1)
  [ ] Sufficient EC2 quota: 4× t3.medium + 4× t3.large in your region
  [ ] S3 Terraform state bucket + DynamoDB lock table created BY HAND
      (nothing in the repo creates them — setup.sh does NOT, despite what
       this line used to claim. terraform/main.tf hardcodes the bucket name
       and table, so `terraform init` fails at Phase 1 without them.)

Credentials:
  [ ] GITHUB_TOKEN set in local/.env (scope: repo, read:org)
  [ ] AUTH_GITHUB_CLIENT_ID set in local/backstage/.env
  [ ] AUTH_GITHUB_CLIENT_SECRET set in local/backstage/.env
  [ ] ANTHROPIC_API_KEY in idp-mvp/kagent Secrets Manager (if using AI)
  [ ] datadog_api_key / datadog_app_key set in terraform.tfvars (if using Datadog)
  [ ] pagerduty_token set in terraform.tfvars (if using the On-Call tab)
  [ ] jira_token / jira_url set in terraform.tfvars (if using the Issues tab)

Verification:
  [ ] ./scripts/verify-secrets.sh passes with ✅ All critical checks passed!
```

---

## Common Errors Before Deployment

### `verify-secrets.sh` fails on GITHUB_TOKEN

```bash
# Check local/.env has the token
grep "^GITHUB_TOKEN=" local/.env
# Should print: GITHUB_TOKEN=ghp_...
```

### GitHub OAuth login fails after deploy

The OAuth callback URL must exactly match the Backstage ALB URL:

```bash
# Get the real URL
kubectl get ingress backstage -n backstage -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'

# Update your GitHub OAuth app at:
# https://github.com/settings/developers → your app → Edit
# Callback URL: http://<above-hostname>/api/auth/github/handler/frame
```

### KAgent "invalid_x-api-key"

```bash
aws secretsmanager get-secret-value --secret-id idp-mvp/kagent \
  --region us-east-1 --query SecretString --output text | jq .
# Verify ANTHROPIC_API_KEY value is correct (starts with sk-ant-)

# Update if needed:
aws secretsmanager put-secret-value \
  --secret-id idp-mvp/kagent \
  --secret-string '{"ANTHROPIC_API_KEY":"sk-ant-NEW_KEY"}' \
  --region us-east-1
kubectl rollout restart deployment/kagent-controller -n kagent
```

---

## Deployment Order

```bash
# 1. Personalise FIRST (first time only — replaces moatazeldebsy and the other
#    placeholders, creates the Terraform state bucket, writes .idp-config.env).
#    This has to come before verify-secrets.sh: that script looks secrets up by
#    "<cluster-name>/kagent" and friends, and the cluster name is one of the
#    values setup.sh substitutes. Run it the other way round on a fresh clone and
#    every check reports a missing secret under the template's default name.
./scripts/setup.sh
# → answer "skip" if you want to review before deploying

# 2. Verify secrets (now that the cluster name is yours)
./scripts/verify-secrets.sh

# 3. Deploy the core platform (~40–70 min). AI/ML is opt-in:
#      --with-ai  adds KAgent, MLflow, Langfuse and the MCP servers
#      --adp      implies --with-ai and adds the agentic development platform
#    Without them, no Langfuse RDS or MLflow/Langfuse S3 buckets are provisioned
#    either, so skipping the AI layer is a real cost saving rather than just
#    skipping the workloads.
./scripts/bootstrap.sh

# 4. Update the GitHub OAuth callback URL with the printed ALB hostname

# 5. Run validation
./scripts/validate-deployment.sh
```

To add the AI/ML stack after the fact, re-run with `--with-ai` (or `--adp`), or
call `bootstrap-ai.sh` directly. Note the `--aws` flag on the latter: without it
the script targets your local Kind context, not EKS.

```bash
./scripts/bootstrap.sh --with-ai        # or --adp
./scripts/bootstrap-ai.sh --aws --adp --region <region> --cluster <cluster-name>
```

Removing AI infrastructure is deliberately explicit. Omitting `--with-ai` on a
cluster that already has it **keeps** it — otherwise a forgotten flag would drop
the Langfuse database. Pass `--remove-ai-infra` to actually destroy it.

See `docs/DEPLOYMENT_GUIDE.md` for full details, known issues, and troubleshooting.
