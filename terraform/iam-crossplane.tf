# IRSA role for Crossplane AWS providers.
#
# Crossplane's upbound AWS providers each run their own controller Pod with
# its own ServiceAccount in `crossplane-system`. The SA name pattern is
# `provider-aws-<family>-<hash>`, so the trust policy uses a StringLike
# wildcard rather than enumerating exact SA names.
#
# Each provider Pod assumes this role via IRSA and uses it to call AWS APIs.
# Resources actually created by Crossplane (RDS instances, S3 buckets, …)
# are tagged with `idp:provisioner=crossplane` so cost / audit reports can
# distinguish them from Terraform-managed resources.
#
# Each inline policy is scoped to the minimal set of actions the relevant
# Composition actually performs, restricted to resources prefixed with the
# cluster name or the `idp-` naming convention enforced by XRD patterns.

resource "aws_iam_role" "crossplane_aws" {
  name = "${var.cluster_name}-crossplane-aws"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = module.eks.oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${module.eks.oidc_provider}:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "${module.eks.oidc_provider}:sub" = "system:serviceaccount:crossplane-system:provider-aws-*"
        }
      }
    }]
  })

  tags = {
    "idp:component"   = "crossplane"
    "idp:cost-center" = "platform"
  }
}

# ── S3 ────────────────────────────────────────────────────────────────────────
resource "aws_iam_role_policy" "crossplane_s3" {
  name = "${var.cluster_name}-crossplane-s3"
  role = aws_iam_role.crossplane_aws.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "S3BucketLifecycle"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketVersioning",
          "s3:PutBucketVersioning",
          "s3:GetBucketTagging",
          "s3:PutBucketTagging",
          "s3:GetEncryptionConfiguration",
          "s3:PutEncryptionConfiguration",
          "s3:GetBucketPublicAccessBlock",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetLifecycleConfiguration",
          "s3:PutLifecycleConfiguration",
        ]
        Resource = "arn:aws:s3:::idp-*"
      },
      {
        Sid      = "S3List"
        Effect   = "Allow"
        Action   = ["s3:ListAllMyBuckets"]
        Resource = "*"
      },
    ]
  })
}

# ── RDS ───────────────────────────────────────────────────────────────────────
resource "aws_iam_role_policy" "crossplane_rds" {
  name = "${var.cluster_name}-crossplane-rds"
  role = aws_iam_role.crossplane_aws.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RDSInstanceLifecycle"
        Effect = "Allow"
        Action = [
          "rds:CreateDBInstance",
          "rds:DeleteDBInstance",
          "rds:DescribeDBInstances",
          "rds:ModifyDBInstance",
          "rds:RebootDBInstance",
          "rds:AddTagsToResource",
          "rds:ListTagsForResource",
          "rds:CreateDBSnapshot",
          "rds:DescribeDBSnapshots",
        ]
        Resource = [
          "arn:aws:rds:*:*:db:idp-*",
          "arn:aws:rds:*:*:snapshot:idp-*",
        ]
      },
      {
        Sid    = "RDSSubnetGroup"
        Effect = "Allow"
        Action = [
          "rds:CreateDBSubnetGroup",
          "rds:DeleteDBSubnetGroup",
          "rds:DescribeDBSubnetGroups",
          "rds:ModifyDBSubnetGroup",
        ]
        Resource = "arn:aws:rds:*:*:subgrp:idp-*"
      },
      {
        Sid    = "RDSDescribeGlobal"
        Effect = "Allow"
        Action = [
          "rds:DescribeDBEngineVersions",
          "rds:DescribeOrderableDBInstanceOptions",
        ]
        Resource = "*"
      },
      {
        Sid    = "EC2ForRDS"
        Effect = "Allow"
        Action = [
          "ec2:DescribeVpcs",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeAvailabilityZones",
        ]
        Resource = "*"
      },
    ]
  })
}

# ── MSK (Kafka) ───────────────────────────────────────────────────────────────
resource "aws_iam_role_policy" "crossplane_kafka" {
  name = "${var.cluster_name}-crossplane-kafka"
  role = aws_iam_role.crossplane_aws.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "MSKTopicLifecycle"
        Effect = "Allow"
        Action = [
          "kafka:CreateTopic",
          "kafka:DeleteTopic",
          "kafka:DescribeTopic",
          "kafka:UpdateTopic",
        ]
        # MSK Topics don't have individual ARNs; restrict at cluster level
        Resource = "arn:aws:kafka:*:*:cluster/idp-*/*"
      },
      {
        Sid    = "MSKClusterRead"
        Effect = "Allow"
        Action = [
          "kafka:DescribeCluster",
          "kafka:DescribeClusterV2",
          "kafka:GetBootstrapBrokers",
          "kafka:ListClusters",
          "kafka:ListClustersV2",
          "kafka:TagResource",
          "kafka:UntagResource",
          "kafka:ListTagsForResource",
        ]
        Resource = "*"
      },
    ]
  })
}

# ── DynamoDB ──────────────────────────────────────────────────────────────────
resource "aws_iam_role_policy" "crossplane_dynamodb" {
  name = "${var.cluster_name}-crossplane-dynamodb"
  role = aws_iam_role.crossplane_aws.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DynamoTableLifecycle"
        Effect = "Allow"
        Action = [
          "dynamodb:CreateTable",
          "dynamodb:DeleteTable",
          "dynamodb:DescribeTable",
          "dynamodb:UpdateTable",
          "dynamodb:TagResource",
          "dynamodb:UntagResource",
          "dynamodb:ListTagsOfResource",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:UpdateContinuousBackups",
          "dynamodb:DescribeTimeToLive",
        ]
        Resource = "arn:aws:dynamodb:*:*:table/idp-*"
      },
      {
        Sid      = "DynamoList"
        Effect   = "Allow"
        Action   = ["dynamodb:ListTables"]
        Resource = "*"
      },
    ]
  })
}

# ── SQS ───────────────────────────────────────────────────────────────────────
resource "aws_iam_role_policy" "crossplane_sqs" {
  name = "${var.cluster_name}-crossplane-sqs"
  role = aws_iam_role.crossplane_aws.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SQSQueueLifecycle"
        Effect = "Allow"
        Action = [
          "sqs:CreateQueue",
          "sqs:DeleteQueue",
          "sqs:GetQueueAttributes",
          "sqs:SetQueueAttributes",
          "sqs:TagQueue",
          "sqs:UntagQueue",
          "sqs:ListQueueTags",
        ]
        Resource = "arn:aws:sqs:*:*:idp-*"
      },
      {
        Sid      = "SQSList"
        Effect   = "Allow"
        Action   = ["sqs:ListQueues"]
        Resource = "*"
      },
    ]
  })
}

# ── Cross-service tagging ─────────────────────────────────────────────────────
# Tag-on-create + tag-read needed by every provider so the
# `idp:provisioner=crossplane` cost-attribution tag is applied uniformly.
resource "aws_iam_role_policy" "crossplane_tagging" {
  name = "${var.cluster_name}-crossplane-tagging"
  role = aws_iam_role.crossplane_aws.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "tag:GetResources",
        "tag:GetTagKeys",
        "tag:GetTagValues",
        "tag:TagResources",
        "tag:UntagResources",
      ]
      Resource = "*"
    }]
  })
}
