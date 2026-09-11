# GitHub App Setup

The IDP uses a **GitHub App** in two places:

1. **Backstage scaffolder integration** (`app-config.aws.yaml`) — all catalog fetching,
   Pull-Request creation, and scaffolder API calls use per-installation tokens instead
   of a shared PAT. Rate limit: 5 000 req/hr **per installation** vs 5 000/hr total for a PAT.

2. **Auto-merge CI** (`.github/workflows/auto-merge-onboarding.yml`) — short-lived token
   from `actions/create-github-app-token@v2` approves onboarding PRs without self-approval.

---

## GitHub App vs PAT comparison

| | Personal Access Token (PAT) | GitHub App |
|---|---|---|
| Rate limit | 5 000 req/hr (shared) | 5 000 req/hr per installation |
| Expiry | 90 days (classic), 1 year (fine-grained) | Never — private key rotates independently |
| Scope | User-level (all repos the user can access) | Installation-level (only repos you install on) |
| Works on personal account | ✅ | ✅ |
| Works on org account | ✅ | ✅ |
| CI approval of own PRs | ❌ (GitHub blocks self-approval) | ✅ (App is a different identity) |

---

## Create the GitHub App (personal account)

1. Go to **github.com/settings/apps/new**

2. Fill in:
   - **GitHub App name**: `idp-backstage-<yourname>` (must be globally unique)
   - **Homepage URL**: your Backstage URL or repo URL
   - **Webhook**: uncheck "Active" (not needed for scaffolding)

3. Set **Permissions** (Repository):
   | Permission | Level |
   |---|---|
   | Contents | Read & write |
   | Pull requests | Read & write |
   | Metadata | Read-only (auto-selected) |
   | Members | Read-only |

4. Click **Create GitHub App**

5. Note the **App ID** (numeric) from the app page

6. Scroll to **Private keys** → **Generate a private key** → download the `.pem` file

7. Note the **Client ID** and generate a **Client secret** under "OAuth App" section

8. Click **Install App** → install on your platform repo (and any team repos Backstage should access)

---

## For organisation accounts

Go to **github.com/organizations/\<org\>/settings/apps/new** — same steps as above.
Install the App on the organisation to give it access to all org repos.

---

## Configure for GitHub Actions (auto-merge)

Add two **repository secrets** in the platform repo (`Settings → Secrets → Actions`):

| Secret | Value |
|---|---|
| `APP_ID` | Numeric App ID from step 5 above |
| `APP_PRIVATE_KEY` | Full contents of the downloaded `.pem` file |

The `auto-merge-onboarding.yml` workflow uses `actions/create-github-app-token@v2` with
these secrets. It falls back to `GH_PAT` if they are absent.

To complete the migration, **remove the `GH_PAT` secret** from repository secrets once
the App is confirmed working.

---

## Configure for Backstage (production / AWS)

Add five keys to AWS Secrets Manager under `idp-mvp/backstage`:

```bash
# Fetch current secret
CURRENT=$(aws secretsmanager get-secret-value \
  --secret-id idp-mvp/backstage --query SecretString --output text)

# Merge in GitHub App credentials
echo "$CURRENT" | python3 -c "
import json, sys
s = json.load(sys.stdin)
s['GITHUB_APP_ID']             = 'YOUR_APP_ID'
s['GITHUB_APP_CLIENT_ID']      = 'YOUR_CLIENT_ID'
s['GITHUB_APP_CLIENT_SECRET']  = 'YOUR_CLIENT_SECRET'
s['GITHUB_APP_PRIVATE_KEY']    = open('path/to/app.private-key.pem').read()
s['GITHUB_APP_WEBHOOK_SECRET'] = ''   # leave empty if webhook is inactive
print(json.dumps(s))
" | aws secretsmanager update-secret \
    --secret-id idp-mvp/backstage \
    --secret-string file:///dev/stdin
```

The `bootstrap.sh` Phase 3.7 now handles this automatically if the env vars
`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET` are set before running the script.

The `app-config.aws.yaml` `integrations.github.apps` block reads these five values at
Backstage startup. Remove `GITHUB_TOKEN` from Secrets Manager once the App is confirmed.

---

## Configure for Backstage (local dev)

For local development the PAT (`GITHUB_TOKEN` in `local/.env`) is sufficient and recommended.
The GitHub App is production-only. If you want to test it locally, add the five keys to
`local/backstage/.env` (see `local/backstage/.env.example` for the field names).

---

## Verify the App is working

```bash
# Backstage (check logs for "GitHub App" instead of "token auth")
kubectl logs -n backstage deploy/backstage | grep -i "github app\|appId\|installation"

# GitHub Actions (check auto-merge workflow run logs)
# The "Generate GitHub App token" step should show: "Token generated"

# Rate limit check (should show higher limit for App vs PAT)
curl -H "Authorization: Bearer $(gh auth token)" \
  https://api.github.com/rate_limit | jq '.rate'
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Token generation failed` in CI | Wrong `APP_ID` or `APP_PRIVATE_KEY` format | Verify secret values; `APP_PRIVATE_KEY` must include `-----BEGIN RSA PRIVATE KEY-----` header |
| Backstage scaffolder `401 Unauthorized` | App not installed on the target repo | Install App on the repo in GitHub App settings |
| `Rate limit exceeded` after migration | App not replacing PAT — both in use | Remove `GITHUB_TOKEN` from Secrets Manager after App confirmed |
| Auto-merge approval step skipped | Neither App nor PAT configured | Add `APP_ID` + `APP_PRIVATE_KEY` repo secrets |

---

## GitHub OAuth sign-in and Org/Team sync

This is a **third, separate** use of GitHub credentials — distinct from both the
scaffolder integration (PAT/App above) and CI. See
`docs/design/adr-0004-identity-and-access.md` for the design rationale.

**What it does:** the `github` auth provider (`auth.providers.github` in
`app-config.yaml`/`app-config.local.yaml`/`app-config.aws.yaml`) lets users sign in
with their GitHub account. Separately, `catalog.providers.githubOrg.idpOrgSync`
syncs every member and team of a GitHub Org into the catalog as `User`/`Group`
entities (via `@backstage/plugin-catalog-backend-module-github-org`, on a
30-minute schedule).

Sign-in only succeeds for users with a matching `User` entity
(`dangerouslyAllowSignInWithoutUserInCatalog: false`) — since that entity only
exists for real org members, **sign-in is effectively restricted to the org**.

### Setup

1. **OAuth App** (not the GitHub App above — a separate credential type):
   github.com/settings/developers → New OAuth App.
   - Homepage URL: your Backstage URL
   - Callback URL: `http://backstage.idp.local/api/auth/github/handler/frame`
     (local) or your production ALB URL equivalent
   - Set `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` in
     `local/backstage/.env` (local) or Secrets Manager (AWS)

2. **Org sync token**: `GITHUB_TOKEN` (`local/.env` / AWS Secrets Manager) needs
   `read:org` scope in addition to whatever scaffolder integration already
   requires it for. It also needs **`read:user`** (or `user:email`) —
   `catalog-backend-module-github-org` always requests each member's email in
   its GraphQL query when using a classic PAT, regardless of any local
   config, and GitHub rejects the *entire* query (not just the email field)
   if that scope is missing. Symptom: `GithubMultiOrgEntityProvider:*
   refresh failed, GraphqlResponseError: ... INSUFFICIENT_SCOPES` in the
   backend logs, and zero synced Users/Groups. Add the scope at
   github.com/settings/tokens.

3. **`GITHUB_ORG`**: set in `local/.env` — the org whose members/teams get
   synced locally. AWS has the org name inline in `app-config.aws.yaml`
   (`catalog.providers.githubOrg.idpOrgSync.orgs`).

4. **One-time rollout step**: every scaffolder template defaults
   `spec.owner` to a team slug (`platform-team`, `qa-platform-team`, etc.) — these must
   exist as real Teams in the org, or ownership references dangle. Create them
   once via github.com/orgs/`<org>`/teams or the GitHub CLI
   (`gh api orgs/<org>/teams -f name=platform-team -f privacy=closed`); new
   teams created afterwards via the `team-namespace` Backstage template are
   handled automatically.

### Verify

```bash
# Confirm the org-sync provider ran (local)
docker logs backstage-backstage-1 2>&1 | grep -i githuborg

# Confirm real Users/Groups landed in the catalog (not the old static demo ones)
# — open http://backstage.idp.local/catalog?filters%5Bkind%5D=group
```

A user outside the org attempting sign-in gets a resolution failure, not a
silent unauthenticated session — that's the intended behavior, not a bug.
