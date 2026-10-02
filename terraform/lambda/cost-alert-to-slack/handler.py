"""
Lambda: Forward AWS cost alerts (Budget + Cost Anomaly Detection) to Slack.

Triggered by SNS. Reads the Slack webhook URL from AWS Secrets Manager.
SLACK_WEBHOOK_SECRET_NAME (set by terraform/finops.tf) is the secret's name or
ARN; the secret is terraform/secrets.tf's idp-mvp/slack-webhook.
"""
import json
import os
import urllib.request
import boto3

SLACK_WEBHOOK_SECRET_NAME = os.environ.get("SLACK_WEBHOOK_SECRET_NAME", "")

_webhook_url_cache: str | None = None


def _get_slack_webhook_url() -> str:
    """The webhook URL, or "" when none is configured.

    secrets.tf stores it under SLACK_WEBHOOK_URL; "url" is accepted for secrets
    written by hand from this handler's old docstring.
    """
    global _webhook_url_cache
    if _webhook_url_cache is not None:
        return _webhook_url_cache
    if not SLACK_WEBHOOK_SECRET_NAME:
        _webhook_url_cache = ""
        return _webhook_url_cache
    # No region_name: the Lambda runtime sets AWS_REGION, which boto3 reads.
    client = boto3.client("secretsmanager")
    secret = client.get_secret_value(SecretId=SLACK_WEBHOOK_SECRET_NAME)
    data = json.loads(secret["SecretString"])
    _webhook_url_cache = data.get("SLACK_WEBHOOK_URL") or data.get("url") or ""
    return _webhook_url_cache


def _post_to_slack(text: str) -> None:
    webhook_url = _get_slack_webhook_url()
    if not webhook_url or webhook_url == "REPLACE_ME":
        # Not an error: Slack is optional (budget_alert_email is the other
        # channel). Raising would only make SNS retry a delivery that can
        # never succeed.
        print("cost-alert-to-slack: no Slack webhook configured; dropping: " + text.splitlines()[0])
        return
    payload = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status != 200:
            raise RuntimeError(f"Slack returned HTTP {resp.status}: {resp.read()}")


def _format_budget_alert(message: dict) -> str:
    account = message.get("accountId", "unknown")
    budget_name = message.get("budgetName", "unknown")
    alert_type = message.get("notificationType", "ACTUAL")
    current = message.get("budgetedAndActualAmounts", {}).get("actualAmount", {})
    limit = message.get("budgetedAndActualAmounts", {}).get("budgetedAmount", {})
    current_usd = current.get("amount", "?")
    limit_usd = limit.get("amount", "?")
    return (
        f":money_with_wings: *AWS Budget Alert*\n"
        f"*Budget:* `{budget_name}` (account `{account}`)\n"
        f"*Type:* {alert_type}\n"
        f"*Spend:* ${current_usd} of ${limit_usd} limit\n"
        f"Check the AWS Cost Explorer for details."
    )


def _format_anomaly_alert(message: dict) -> str:
    anomaly = message.get("anomalyDetails", {})
    service = anomaly.get("rootCauses", [{}])[0].get("service", "unknown")
    impact = anomaly.get("impact", {})
    total_impact = impact.get("totalImpact", "?")
    return (
        f":rotating_light: *AWS Cost Anomaly Detected*\n"
        f"*Service:* `{service}`\n"
        f"*Estimated extra spend:* ${total_impact}\n"
        f"Check the AWS Cost Anomaly Detection console for details."
    )


def lambda_handler(event: dict, context) -> dict:  # noqa: ANN001
    for record in event.get("Records", []):
        sns_message_raw = record.get("Sns", {}).get("Message", "{}")
        subject = record.get("Sns", {}).get("Subject", "")

        try:
            message = json.loads(sns_message_raw)
        except json.JSONDecodeError:
            message = {}

        # Detect alert type from subject or message structure
        if "Budget" in subject or "budgetName" in message:
            text = _format_budget_alert(message)
        elif "anomaly" in subject.lower() or "anomalyDetails" in message:
            text = _format_anomaly_alert(message)
        else:
            # Generic fallback
            text = f":bell: *AWS Cost Alert*\n```{sns_message_raw[:500]}```"

        _post_to_slack(text)

    return {"statusCode": 200, "body": "ok"}
