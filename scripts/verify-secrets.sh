#!/usr/bin/env bash
# verify-secrets.sh — Check all required secrets before AWS deployment
# Usage: ./scripts/verify-secrets.sh

set -euo pipefail

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

AWS_REGION="${AWS_REGION:-us-east-1}"
CLUSTER_NAME="${CLUSTER_NAME:-idp-mvp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo ""
echo "🔍 Verifying AWS Secrets & Configuration..."
echo "   Region: $AWS_REGION"
echo "   Cluster: $CLUSTER_NAME"
echo ""

PASS=0
FAIL=0
WARN=0

# Helper functions
check_pass() {
    echo -e "${GREEN}✅${NC} $1"
    ((PASS++))
}

check_fail() {
    echo -e "${RED}❌${NC} $1"
    ((FAIL++))
}

check_warn() {
    echo -e "${YELLOW}⚠️ ${NC} $1 (optional)"
    ((WARN++))
}

echo "┌─────────────────────────────────────────────────────────┐"
echo "│ 1. ANTHROPIC_API_KEY (KAgent AI Agents)                │"
echo "└─────────────────────────────────────────────────────────┘"

if aws secretsmanager get-secret-value --secret-id "${CLUSTER_NAME}/kagent" --region "$AWS_REGION" &>/dev/null; then
    key=$(aws secretsmanager get-secret-value --secret-id "${CLUSTER_NAME}/kagent" --region "$AWS_REGION" --query SecretString --output text 2>/dev/null | jq -r '.ANTHROPIC_API_KEY' 2>/dev/null || echo "")
    if [[ "$key" == "sk-ant-"* ]]; then
        check_pass "ANTHROPIC_API_KEY found and valid"
    else
        check_fail "ANTHROPIC_API_KEY exists but is invalid (should start with sk-ant-)"
        echo "         Fix: aws secretsmanager update-secret --secret-id ${CLUSTER_NAME}/kagent --secret-string '{\"ANTHROPIC_API_KEY\":\"sk-ant-YOUR_KEY\"}' --region $AWS_REGION"
    fi
else
    check_fail "ANTHROPIC_API_KEY not found in Secrets Manager"
    echo "         Fix: aws secretsmanager create-secret --name ${CLUSTER_NAME}/kagent --secret-string '{\"ANTHROPIC_API_KEY\":\"sk-ant-YOUR_KEY\"}' --region $AWS_REGION"
    echo "         Get key from: https://console.anthropic.com/settings/keys"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ 2. GITHUB_TOKEN (local/.env)                            │"
echo "└─────────────────────────────────────────────────────────┘"

if [ -f "$REPO_ROOT/local/.env" ]; then
    if grep -q "^GITHUB_TOKEN=ghp_" "$REPO_ROOT/local/.env"; then
        check_pass "GITHUB_TOKEN found in local/.env"
    else
        check_fail "GITHUB_TOKEN missing or invalid format in local/.env (should start with ghp_)"
        echo "         Fix: Get token from https://github.com/settings/tokens"
        echo "              Then add to local/.env: GITHUB_TOKEN=ghp_YOUR_TOKEN"
    fi
else
    check_fail "local/.env file not found"
    echo "         Fix: ./scripts/setup.sh (creates local/.env)"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ 3. GitHub OAuth Credentials (local/backstage/.env)      │"
echo "└─────────────────────────────────────────────────────────┘"

if [ -f "$REPO_ROOT/local/backstage/.env" ]; then
    has_id=false
    has_secret=false

    if grep -q "^AUTH_GITHUB_CLIENT_ID=" "$REPO_ROOT/local/backstage/.env"; then
        has_id=true
    fi

    if grep -q "^AUTH_GITHUB_CLIENT_SECRET=" "$REPO_ROOT/local/backstage/.env"; then
        has_secret=true
    fi

    if [ "$has_id" = true ] && [ "$has_secret" = true ]; then
        check_pass "GitHub OAuth credentials found in local/backstage/.env"
    else
        check_fail "GitHub OAuth credentials missing from local/backstage/.env"
        echo "         Fix: Get credentials from https://github.com/settings/developers"
        echo "              Create OAuth App with Callback URL:"
        echo "              http://YOUR_BACKSTAGE_ALB_URL/api/auth/github/handler/frame"
    fi
else
    check_fail "local/backstage/.env file not found"
    echo "         Fix: ./scripts/setup.sh (creates local/backstage/.env)"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ 4. Slack Webhook (optional)                             │"
echo "└─────────────────────────────────────────────────────────┘"

if aws secretsmanager get-secret-value --secret-id "${CLUSTER_NAME}/slack" --region "$AWS_REGION" &>/dev/null; then
    check_pass "Slack webhook configured"
else
    check_warn "Slack webhook not configured (optional for cost alerts)"
    echo "         To add: aws secretsmanager create-secret --name ${CLUSTER_NAME}/slack --secret-string '{\"SLACK_WEBHOOK_URL\":\"https://hooks.slack.com/...\"}' --region $AWS_REGION"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ 5. Backstage Secrets Manager entry (idp-mvp/backstage)  │"
echo "└─────────────────────────────────────────────────────────┘"

BACKSTAGE_SECRET_ID="idp-mvp/backstage"
if aws secretsmanager get-secret-value --secret-id "$BACKSTAGE_SECRET_ID" --region "$AWS_REGION" &>/dev/null; then
    SECRET_JSON=$(aws secretsmanager get-secret-value --secret-id "$BACKSTAGE_SECRET_ID" --region "$AWS_REGION" --query SecretString --output text 2>/dev/null || echo "{}")

    # Check GITHUB_TOKEN (legacy PAT)
    gh_token=$(echo "$SECRET_JSON" | jq -r '.GITHUB_TOKEN // ""' 2>/dev/null || echo "")
    app_id=$(echo "$SECRET_JSON" | jq -r '.GITHUB_APP_ID // ""' 2>/dev/null || echo "")

    if [[ -n "$app_id" && "$app_id" != "null" ]]; then
        check_pass "GitHub App ID found in idp-mvp/backstage (GITHUB_APP_ID=$app_id)"
        # Check remaining App keys
        for key in GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET GITHUB_APP_PRIVATE_KEY; do
            val=$(echo "$SECRET_JSON" | jq -r ".${key} // \"\"" 2>/dev/null || echo "")
            if [[ -n "$val" && "$val" != "null" && "$val" != "REPLACE_ME" ]]; then
                check_pass "$key present in idp-mvp/backstage"
            else
                check_fail "$key missing from idp-mvp/backstage"
                echo "         Fix: See docs/github-app-setup.md for setup instructions"
            fi
        done
        check_warn "GITHUB_APP_WEBHOOK_SECRET (optional — only needed if App webhook is active)"
    elif [[ -n "$gh_token" && "$gh_token" != "REPLACE_ME" ]]; then
        check_pass "GITHUB_TOKEN (PAT) found in idp-mvp/backstage"
        check_warn "Consider migrating to GitHub App for higher rate limits (docs/github-app-setup.md)"
    else
        check_fail "Neither GITHUB_TOKEN nor GITHUB_APP_ID found in idp-mvp/backstage"
        echo "         Fix: bootstrap.sh Phase 3.7 populates this, or run manually:"
        echo "              export GITHUB_TOKEN=ghp_YOUR_TOKEN && ./scripts/bootstrap.sh"
    fi

    # Check AUTH_GITHUB_CLIENT_ID
    oauth_id=$(echo "$SECRET_JSON" | jq -r '.AUTH_GITHUB_CLIENT_ID // ""' 2>/dev/null || echo "")
    if [[ -n "$oauth_id" && "$oauth_id" != "REPLACE_ME" ]]; then
        check_pass "AUTH_GITHUB_CLIENT_ID present in idp-mvp/backstage"
    else
        check_fail "AUTH_GITHUB_CLIENT_ID missing from idp-mvp/backstage"
        echo "         Fix: Create OAuth App at github.com/settings/developers"
    fi
else
    check_fail "idp-mvp/backstage secret not found in Secrets Manager"
    echo "         Fix: Run terraform apply first — it creates the secret placeholder"
    echo "              Then run bootstrap.sh to populate the values"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ 6. GitHub App — Actions secrets (auto-merge CI)         │"
echo "└─────────────────────────────────────────────────────────┘"

# Check if gh CLI is available to inspect repo secrets
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    REPO_SLUG=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||;s|\.git$||' || echo "")
    if [[ -n "$REPO_SLUG" ]]; then
        if gh secret list -R "$REPO_SLUG" 2>/dev/null | grep -q "^APP_ID"; then
            check_pass "APP_ID secret present in $REPO_SLUG (GitHub App for auto-merge)"
        else
            check_warn "APP_ID not set in repo secrets — auto-merge CI will fall back to GH_PAT or skip approval"
            echo "         Fix: See docs/github-app-setup.md → 'Configure for GitHub Actions'"
        fi
        if gh secret list -R "$REPO_SLUG" 2>/dev/null | grep -q "^APP_PRIVATE_KEY"; then
            check_pass "APP_PRIVATE_KEY secret present in $REPO_SLUG"
        else
            check_warn "APP_PRIVATE_KEY not set in repo secrets"
        fi
    else
        check_warn "Could not determine repo slug — skipping GitHub Actions secrets check"
    fi
else
    check_warn "gh CLI not available or not authenticated — skipping GitHub Actions secrets check"
    echo "         Install: https://cli.github.com  |  Auth: gh auth login"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ AWS Credentials & Connectivity                          │"
echo "└─────────────────────────────────────────────────────────┘"

if aws sts get-caller-identity &>/dev/null; then
    account=$(aws sts get-caller-identity --query Account --output text)
    user=$(aws sts get-caller-identity --query Arn --output text)
    check_pass "AWS credentials configured"
    echo "         Account: $account"
    echo "         User: $user"
else
    check_fail "AWS credentials not configured"
    echo "         Fix: aws configure (or aws sso login)"
fi

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ Required Tools                                          │"
echo "└─────────────────────────────────────────────────────────┘"

# Check for required tools
tools=("aws" "terraform" "kubectl" "helm" "docker" "jq")
for tool in "${tools[@]}"; do
    if command -v "$tool" &>/dev/null; then
        version=$($tool --version 2>&1 | head -1)
        check_pass "$tool: $version"
    else
        check_fail "$tool: not installed"
    fi
done

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│ SUMMARY                                                 │"
echo "├─────────────────────────────────────────────────────────┤"
echo -e "│ ${GREEN}Passed:${NC}   $PASS"
echo -e "│ ${RED}Failed:${NC}   $FAIL"
echo -e "│ ${YELLOW}Warnings:${NC} $WARN"
echo "└─────────────────────────────────────────────────────────┘"

echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}✅ All critical checks passed!${NC}"
    echo ""
    echo "You can now proceed with:"
    echo "  ./scripts/setup.sh"
    echo "  ./scripts/bootstrap.sh"
    echo "  ./scripts/validate-deployment.sh"
    echo ""
    exit 0
else
    echo -e "${RED}❌ Some critical checks failed${NC}"
    echo ""
    echo "Please fix the issues above before running setup.sh"
    echo ""
    exit 1
fi
