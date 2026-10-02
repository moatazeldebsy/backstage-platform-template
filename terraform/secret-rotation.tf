# Secret Rotation Configuration for API Keys
# Enables automatic rotation of ANTHROPIC_API_KEY and other secrets

# ── Anthropic API Key Rotation (Manual rotation recommended) ──────────────────
# NOTE: Anthropic API keys don't have built-in rotation via AWS Secrets Manager Lambda
# Instead, follow this manual rotation process:
#
# 1. Generate a new API key in Anthropic Console (https://console.anthropic.com)
# 2. Update the secret:
#    aws secretsmanager update-secret \
#      --secret-id idp-mvp/kagent \
#      --secret-string '{"ANTHROPIC_API_KEY":"your-new-key"}'
# 3. Restart KAgent pods to pick up the new key:
#    kubectl rollout restart deployment/kagent-controller -n kagent
#
# For full automation, create a Lambda function that:
# - Validates the key with Anthropic API
# - Updates the secret only if valid
# - Notifies the team of rotation

# NOTE: the KAgent secret itself (idp-mvp/kagent) is managed by
# aws_secretsmanager_secret.kagent in secrets.tf — do not redeclare it here,
# AWS Secrets Manager names must be unique and a second resource targeting the
# same name will fail with ResourceExistsException.

# ── GitHub Token Rotation ─────────────────────────────────────────────────────
# GitHub tokens should be rotated monthly
# 1. Generate new Personal Access Token: https://github.com/settings/tokens
# 2. Update the secret:
#    aws secretsmanager update-secret \
#      --secret-id idp-mvp/backstage \
#      --secret-string '{"GITHUB_TOKEN":"your-new-token",...}'
# 3. Restart Backstage:
#    kubectl rollout restart deployment/backstage -n backstage

# ── RDS Master Password Rotation ──────────────────────────────────────────────
# AWS Secrets Manager can auto-rotate RDS passwords via Lambda
# To enable:
# 1. Uncomment the rotation configuration below
# 2. Create the rotation Lambda function (or use AWS-provided template)
# 3. Grant Lambda permission to call rds:ModifyDBInstance

# resource "aws_secretsmanager_secret_rotation" "rds_password" {
#   secret_id           = aws_secretsmanager_secret.rds_password.id
#   rotation_rules {
#     automatically_after_days = 30
#   }
# }

# ── Monitoring Secret Rotation ────────────────────────────────────────────────
# Removed: a CloudWatch alarm on AWS/SecretsManager RotationFailure for
# idp-mvp/kagent. That secret has no rotation configured, Secrets Manager does
# not publish such a metric (rotation failures arrive as EventBridge events),
# and the alarm had no alarm_actions — it could never fire or notify anyone,
# while looking like rotation was being watched.
#
# Current state, stated plainly: no secret in this stack rotates. The RDS master
# passwords are random_password values held in Terraform state (encrypted in the
# S3 backend). Moving them to manage_master_user_password (RDS-managed, rotated)
# changes how DATABASE_URLs are composed in rds.tf/grafana.tf and is tracked as
# a follow-up rather than done here.
