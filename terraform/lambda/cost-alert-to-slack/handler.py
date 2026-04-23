"""
Lambda: Forward AWS cost alerts (Budget + Cost Anomaly Detection) to Slack.

Triggered by SNS. Reads the Slack webhook URL from AWS Secrets Manager.
Set SLACK_WEBHOOK_SECRET_NAME env var to the Secrets Manager secret name.
"""
import json
import os
import urllib.request
import boto3

SLACK_WEBHOOK_SECRET_NAME = os.environ["SLACK_WEBHOOK_SECRET_NAME"]
AWS_REGION = os.environ.get("AWS_REGION_NAME", "us-east-1")

_webhook_url_cache: str | None = None


def _get_slack_webhook_url() -> str:
    global _webhook_url_cache
    if _webhook_url_cache:
        return _webhook_url_cache
    client = boto3.client("secretsmanager", region_name=AWS_REGION)
    secret = client.get_secret_value(SecretId=SLACK_WEBHOOK_SECRET_NAME)
    data = json.loads(secret["SecretString"])
    _webhook_url_cache = data["url"]
    return _webhook_url_cache


def _post_to_slack(text: str) -> None:
    webhook_url = _get_slack_webhook_url()
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
