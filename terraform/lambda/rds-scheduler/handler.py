"""
RDS Scheduler Lambda
Triggered by EventBridge on a schedule to stop RDS at night and start it in the morning.

Deployed by terraform/cost-optimizer.tf, gated on var.enable_cost_optimizer.

The direction comes from the EventBridge target's input payload
({"action": "stop"}), so one function serves both schedules; the ACTION env var
remains a fallback for manual invocation.

Environment variables:
  DB_INSTANCE_ID — RDS instance identifier
  ACTION         — fallback when the event carries no action
"""
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    rds = boto3.client("rds")
    db_id = os.environ["DB_INSTANCE_ID"]
    action = (event or {}).get("action") or os.environ.get("ACTION")

    if action not in ("stop", "start"):
        raise ValueError(
            f"action must be 'stop' or 'start', got {action!r} "
            "(set it in the EventBridge target input or the ACTION env var)"
        )

    logger.info("action=%s db_instance=%s", action, db_id)

    try:
        if action == "stop":
            rds.stop_db_instance(DBInstanceIdentifier=db_id)
            logger.info("Stopped RDS instance %s", db_id)
        else:
            rds.start_db_instance(DBInstanceIdentifier=db_id)
            logger.info("Started RDS instance %s", db_id)
    except rds.exceptions.InvalidDBInstanceStateFault as exc:
        # Already in target state, or mid-transition — not an error. AWS also
        # force-starts any instance left stopped for 7 days, so finding it
        # already running at stop time is expected.
        logger.warning("RDS instance %s not actionable (state): %s", db_id, exc)

    return {"statusCode": 200, "action": action, "db_instance": db_id}
