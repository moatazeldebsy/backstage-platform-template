# FinOps: AWS Cost Anomaly Detection, Budgets, and SNS → Slack alerting
# Deployed alongside EKS cluster via: terraform apply -var "cluster_name=idp-mvp"

locals {
  budget_monthly_limit_usd = var.budget_monthly_limit_usd
  budget_alert_threshold   = 80 # percent — warning at 80%, critical at 100%
}

# ── SNS topic for budget and anomaly alerts ───────────────────────────────────

resource "aws_sns_topic" "cost_alerts" {
  name = "${var.cluster_name}-cost-alerts"

  tags = {
    Project    = var.cluster_name
    ManagedBy  = "terraform"
    CostCenter = "platform"
  }
}

# ── Lambda: SNS → Slack ───────────────────────────────────────────────────────

data "archive_file" "cost_alert_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/cost-alert-to-slack"
  output_path = "${path.module}/lambda/cost-alert-to-slack.zip"
}

resource "aws_lambda_function" "cost_alert_to_slack" {
  filename         = data.archive_file.cost_alert_lambda.output_path
  function_name    = "${var.cluster_name}-cost-alert-to-slack"
  role             = aws_iam_role.cost_alert_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  source_code_hash = data.archive_file.cost_alert_lambda.output_base64sha256

  environment {
    variables = {
      SLACK_WEBHOOK_SECRET = var.slack_webhook_secret_name
    }
  }

  tags = {
    Project    = var.cluster_name
    ManagedBy  = "terraform"
    CostCenter = "platform"
  }
}

resource "aws_iam_role" "cost_alert_lambda" {
  name = "${var.cluster_name}-cost-alert-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cost_alert_lambda_basic" {
  role       = aws_iam_role.cost_alert_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_sns_topic_subscription" "cost_alert_lambda" {
  topic_arn = aws_sns_topic.cost_alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.cost_alert_to_slack.arn
}

resource "aws_lambda_permission" "sns_invoke" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.cost_alert_to_slack.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.cost_alerts.arn
}

# ── AWS Budgets ───────────────────────────────────────────────────────────────

resource "aws_budgets_budget" "monthly" {
  name         = "${var.cluster_name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(local.budget_monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = local.budget_alert_threshold
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

# ── AWS Cost Anomaly Detection ────────────────────────────────────────────────

resource "aws_ce_anomaly_monitor" "cluster" {
  name              = "${var.cluster_name}-anomaly-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "cluster" {
  name      = "${var.cluster_name}-anomaly-subscription"
  frequency = "DAILY"

  monitor_arn_list = [aws_ce_anomaly_monitor.cluster.arn]

  subscriber {
    type    = "SNS"
    address = aws_sns_topic.cost_alerts.arn
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = ["20"]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
}
