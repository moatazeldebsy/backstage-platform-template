# FinOps — AWS Cost controls for the IDP platform
# Creates: Cost Anomaly Detection, Budgets, SNS alerts → Slack Lambda
#
# Variables needed in terraform.tfvars:
#   budget_monthly_limit_usd = "500"
#   budget_alert_email       = "platform-team@example.com"
#   slack_webhook_secret_name = "idp-mvp/slack-webhook"

# ── SNS topic for cost alerts ─────────────────────────────────────────────────
resource "aws_sns_topic" "cost_alerts" {
  name = "${var.cluster_name}-cost-alerts"

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_sns_topic_subscription" "cost_alerts_email" {
  count     = var.budget_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.cost_alerts.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

resource "aws_sns_topic_subscription" "cost_alerts_lambda" {
  topic_arn = aws_sns_topic.cost_alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.cost_alert_to_slack.arn
}

# Allow SNS to invoke the Lambda
resource "aws_lambda_permission" "allow_sns_cost_alerts" {
  statement_id  = "AllowSNSTrigger"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_alert_to_slack.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.cost_alerts.arn
}

# ── SNS topic policy — allow Budget and CE services to publish ────────────────
resource "aws_sns_topic_policy" "cost_alerts" {
  arn = aws_sns_topic.cost_alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = ["budgets.amazonaws.com", "costalerts.amazonaws.com"] }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.cost_alerts.arn
      }
    ]
  })
}

# ── Lambda: SNS → Slack ───────────────────────────────────────────────────────
data "archive_file" "cost_alert_to_slack" {
  type        = "zip"
  source_file = "${path.module}/lambda/cost-alert-to-slack/handler.py"
  output_path = "${path.module}/lambda/cost-alert-to-slack/handler.zip"
}

resource "aws_iam_role" "cost_alert_lambda" {
  name = "${var.cluster_name}-cost-alert-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_iam_role_policy_attachment" "cost_alert_lambda_basic" {
  role       = aws_iam_role.cost_alert_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "cost_alert_lambda_secrets" {
  name = "read-slack-webhook-secret"
  role = aws_iam_role.cost_alert_lambda.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${var.slack_webhook_secret_name}*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "cost_alert_to_slack" {
  name              = "/aws/lambda/${var.cluster_name}-cost-alert-to-slack"
  retention_in_days = 30

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_lambda_function" "cost_alert_to_slack" {
  function_name    = "${var.cluster_name}-cost-alert-to-slack"
  filename         = data.archive_file.cost_alert_to_slack.output_path
  source_code_hash = data.archive_file.cost_alert_to_slack.output_base64sha256
  role             = aws_iam_role.cost_alert_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 30

  environment {
    variables = {
      SLACK_WEBHOOK_SECRET_NAME = var.slack_webhook_secret_name
      AWS_REGION_NAME           = var.aws_region
    }
  }

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ── AWS Budget — monthly cap ───────────────────────────────────────────────────
resource "aws_budgets_budget" "platform_monthly" {
  name         = "${var.cluster_name}-monthly"
  budget_type  = "COST"
  limit_amount = var.budget_monthly_limit_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$${var.cluster_name}"]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.cost_alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.cost_alerts.arn]
  }
}

# ── Cost Anomaly Detection ────────────────────────────────────────────────────
resource "aws_ce_anomaly_monitor" "platform" {
  name              = "${var.cluster_name}-anomaly-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_ce_anomaly_subscription" "platform" {
  name      = "${var.cluster_name}-anomaly-subscription"
  frequency = "IMMEDIATE" # SNS/Lambda subscribers require IMMEDIATE; DAILY/WEEKLY are email-only

  monitor_arn_list = [aws_ce_anomaly_monitor.platform.arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.cost_alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_PERCENTAGE"
      values        = ["20"]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }

  tags = {
    Project     = var.cluster_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# ── Outputs ───────────────────────────────────────────────────────────────────
output "cost_alerts_sns_topic_arn" {
  description = "SNS topic ARN for cost alerts"
  value       = aws_sns_topic.cost_alerts.arn
}

output "cost_alert_lambda_arn" {
  description = "Lambda ARN for cost-alert-to-slack"
  value       = aws_lambda_function.cost_alert_to_slack.arn
}
