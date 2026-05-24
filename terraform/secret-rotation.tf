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

resource "aws_secretsmanager_secret" "kagent_apikey" {
  name                    = "${var.cluster_name}/kagent"
  description             = "KAgent API keys and configuration"
  recovery_window_in_days = 7

  tags = {
    Name = "${var.cluster_name}-kagent-secrets"
  }
}

# Secret version with placeholder (replace with actual key)
resource "aws_secretsmanager_secret_version" "kagent_apikey" {
  secret_id = aws_secretsmanager_secret.kagent_apikey.id
  secret_string = jsonencode({
    ANTHROPIC_API_KEY = var.anthropic_api_key != "" ? var.anthropic_api_key : "REPLACE_ME"
  })
}

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
# Add CloudWatch alarm for failed secret rotation
resource "aws_cloudwatch_metric_alarm" "secret_rotation_failure" {
  alarm_name          = "${var.cluster_name}-secret-rotation-failure"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "1"
  metric_name         = "RotationFailure"
  namespace           = "AWS/SecretsManager"
  period              = "3600"
  statistic           = "Sum"
  threshold           = "1"
  alarm_description   = "Alert when secret rotation fails"
  treat_missing_data  = "notBreaching"

  dimensions = {
    SecretId = aws_secretsmanager_secret.kagent_apikey.id
  }

  # SNS notification
  # alarm_actions = [aws_sns_topic.alerts.arn]
}
