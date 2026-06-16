# Security Hub + GuardDuty — multi-region threat detection and findings aggregation.
#
# Architecture:
#   eu-central-1 (primary): Security Hub aggregator — receives findings from all regions
#   us-east-1 (standby):    Security Hub linked member — forwards findings to primary
#   Both regions:           GuardDuty enabled, findings exported to Security Hub
#
# This module must be applied ONCE with the global Terraform workspace.

# ── GuardDuty — primary region ────────────────────────────────────────────────

resource "aws_guardduty_detector" "primary" {
  enable = true

  datasources {
    s3_logs {
      enable = true
    }
    kubernetes {
      audit_logs {
        enable = true
      }
    }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes {
          enable = true
        }
      }
    }
  }

  tags = {
    Name   = "idp-mvp-guardduty-primary"
    Region = var.primary_region
  }
}

# ── GuardDuty — standby region ────────────────────────────────────────────────

resource "aws_guardduty_detector" "standby" {
  provider = aws.standby
  enable   = true

  datasources {
    s3_logs { enable = true }
    kubernetes { audit_logs { enable = true } }
    malware_protection {
      scan_ec2_instance_with_findings {
        ebs_volumes { enable = true }
      }
    }
  }

  tags = {
    Name   = "idp-mvp-guardduty-standby"
    Region = var.standby_region
  }
}

# ── Security Hub — primary region (aggregator) ────────────────────────────────

resource "aws_securityhub_account" "primary" {}

resource "aws_securityhub_standards_subscription" "aws_foundational_primary" {
  depends_on    = [aws_securityhub_account.primary]
  standards_arn = "arn:aws:securityhub:${var.primary_region}::standards/aws-foundational-security-best-practices/v/1.0.0"
}

resource "aws_securityhub_standards_subscription" "cis_primary" {
  depends_on    = [aws_securityhub_account.primary]
  standards_arn = "arn:aws:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.2.0"
}

# Aggregate findings from all linked regions into eu-central-1
resource "aws_securityhub_finding_aggregator" "primary" {
  depends_on   = [aws_securityhub_account.primary]
  linking_mode = "SPECIFIED_REGIONS"
  specified_regions = [var.standby_region]
}

# ── Security Hub — standby region (member/linked) ─────────────────────────────

resource "aws_securityhub_account" "standby" {
  provider   = aws.standby
  depends_on = [aws_securityhub_account.primary]
}

resource "aws_securityhub_standards_subscription" "aws_foundational_standby" {
  provider      = aws.standby
  depends_on    = [aws_securityhub_account.standby]
  standards_arn = "arn:aws:securityhub:${var.standby_region}::standards/aws-foundational-security-best-practices/v/1.0.0"
}

# ── EventBridge → Lambda: auto-remediation for critical findings ───────────────

resource "aws_cloudwatch_event_rule" "security_hub_critical" {
  name        = "idp-security-hub-critical"
  description = "Captures CRITICAL Security Hub findings for auto-notification"

  event_pattern = jsonencode({
    source      = ["aws.securityhub"]
    detail-type = ["Security Hub Findings - Imported"]
    detail = {
      findings = {
        Severity = {
          Label = ["CRITICAL", "HIGH"]
        }
        Workflow = {
          Status = ["NEW"]
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "security_hub_slack" {
  rule      = aws_cloudwatch_event_rule.security_hub_critical.name
  target_id = "SlackNotification"
  arn       = aws_sns_topic.security_alerts.arn
}

resource "aws_sns_topic" "security_alerts" {
  name = "idp-mvp-security-alerts"

  tags = {
    Name = "idp-mvp-security-alerts"
  }
}

resource "aws_sns_topic_subscription" "security_alerts_email" {
  count     = var.security_alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.security_alerts.arn
  protocol  = "email"
  endpoint  = var.security_alert_email
}
