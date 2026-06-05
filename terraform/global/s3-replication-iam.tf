# Shared IAM role for S3 Cross-Region Replication.
# All S3Bucket claims with crossRegionReplication: true reference this role via the
# metadata.annotations["idp.platform/s3-replication-role-arn"] annotation, which is
# populated by the Crossplane EnvironmentConfig or set manually in the claim.
#
# The role is permissive by design (any bucket in the account) — teams cannot
# mis-configure the trust relationship since role ARN is injected by the platform.

data "aws_iam_policy_document" "s3_replication_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "s3_replication" {
  statement {
    sid    = "SourceBucketRead"
    effect = "Allow"
    actions = [
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
    ]
    resources = ["arn:aws:s3:::*"]
  }

  statement {
    sid    = "SourceObjectRead"
    effect = "Allow"
    actions = [
      "s3:GetObjectVersionForReplication",
      "s3:GetObjectVersionAcl",
      "s3:GetObjectVersionTagging",
    ]
    resources = ["arn:aws:s3:::*/*"]
  }

  statement {
    sid    = "DestinationBucketWrite"
    effect = "Allow"
    actions = [
      "s3:ReplicateObject",
      "s3:ReplicateDelete",
      "s3:ReplicateTags",
    ]
    resources = ["arn:aws:s3:::*/*"]
  }
}

resource "aws_iam_role" "s3_replication" {
  name               = "idp-s3-replication"
  assume_role_policy = data.aws_iam_policy_document.s3_replication_assume.json

  tags = {
    Name = "idp-s3-replication"
  }
}

resource "aws_iam_role_policy" "s3_replication" {
  name   = "idp-s3-replication-policy"
  role   = aws_iam_role.s3_replication.id
  policy = data.aws_iam_policy_document.s3_replication.json
}
