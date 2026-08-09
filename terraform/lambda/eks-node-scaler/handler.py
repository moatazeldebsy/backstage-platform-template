"""
EKS Node Group Scaler Lambda
Triggered by EventBridge on a schedule to scale nodes down at night and up in the morning.

Deployed by terraform/cost-optimizer.tf, gated on var.enable_cost_optimizer.

The direction comes from the EventBridge target's input payload
({"action": "scale_down"}), so one function serves both schedules; the ACTION
env var remains a fallback for manual invocation.

Environment variables:
  CLUSTER_NAME      — EKS cluster name
  NODE_GROUP_NAME   — EKS managed node group name
  ACTION            — fallback when the event carries no action
  MIN_SIZE          — min nodes when scaling up (default: 2)
  DESIRED_SIZE      — desired nodes when scaling up (default: 2)
  MAX_SIZE          — max nodes (default: 5, kept unchanged on scale_down)
"""
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    eks = boto3.client("eks")

    cluster_name = os.environ["CLUSTER_NAME"]
    node_group_name = os.environ["NODE_GROUP_NAME"]
    action = (event or {}).get("action") or os.environ.get("ACTION")
    max_size = int(os.environ.get("MAX_SIZE", "5"))

    if action not in ("scale_down", "scale_up"):
        raise ValueError(
            f"action must be 'scale_down' or 'scale_up', got {action!r} "
            "(set it in the EventBridge target input or the ACTION env var)"
        )

    if action == "scale_down":
        scaling = {"minSize": 0, "maxSize": max_size, "desiredSize": 0}
    else:
        scaling = {
            "minSize": int(os.environ.get("MIN_SIZE", "2")),
            "maxSize": max_size,
            "desiredSize": int(os.environ.get("DESIRED_SIZE", "2")),
        }

    logger.info(
        "action=%s cluster=%s nodegroup=%s scaling=%s",
        action,
        cluster_name,
        node_group_name,
        scaling,
    )

    eks.update_nodegroup_config(
        clusterName=cluster_name,
        nodegroupName=node_group_name,
        scalingConfig=scaling,
    )

    return {"statusCode": 200, "action": action, "scaling": scaling}
