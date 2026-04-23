"""
RDS Scheduler Lambda
Triggered by EventBridge on a schedule to stop RDS at night and start it in the morning.
Environment variables:
  DB_INSTANCE_ID — RDS instance identifier
  ACTION         — "stop" or "start"
"""
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    rds = boto3.client("rds")
    db_id = os.environ["DB_INSTANCE_ID"]
    action = os.environ["ACTION"]

    logger.info("action=%s db_instance=%s", action, db_id)

    try:
        if action == "stop":
            rds.stop_db_instance(DBInstanceIdentifier=db_id)
            logger.info("Stopped RDS instance %s", db_id)
        else:
            rds.start_db_instance(DBInstanceIdentifier=db_id)
            logger.info("Started RDS instance %s", db_id)
    except rds.exceptions.InvalidDBInstanceStateFault as exc:
        # Already in target state — not an error
        logger.warning("RDS instance %s not actionable (state): %s", db_id, exc)

    return {"statusCode": 200, "action": action, "db_instance": db_id}
