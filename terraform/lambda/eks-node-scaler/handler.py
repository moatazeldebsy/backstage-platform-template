"""
EKS Node Group Scaler Lambda
Triggered by EventBridge on a schedule to scale nodes down at night and up in the morning.
Environment variables:
  CLUSTER_NAME      — EKS cluster name
  NODE_GROUP_NAME   — EKS managed node group name
  ACTION            — "scale_down" or "scale_up"
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
    action = os.environ["ACTION"]
    max_size = int(os.environ.get("MAX_SIZE", "5"))

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
