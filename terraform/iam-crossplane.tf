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
# Policies attached here are AWS-managed and broad. A production tightening
# pass should replace each `*FullAccess` with a least-privilege custom policy
# scoped to the resources the relevant Composition actually creates.

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

# Per-service AWS-managed policies. One attachment per provider family so the
# blast radius of each is auditable in the AWS console.

resource "aws_iam_role_policy_attachment" "crossplane_s3" {
  role       = aws_iam_role.crossplane_aws.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3FullAccess"
}

resource "aws_iam_role_policy_attachment" "crossplane_rds" {
  role       = aws_iam_role.crossplane_aws.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonRDSFullAccess"
}

resource "aws_iam_role_policy_attachment" "crossplane_kafka" {
  role       = aws_iam_role.crossplane_aws.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonMSKFullAccess"
}

resource "aws_iam_role_policy_attachment" "crossplane_dynamodb" {
  role       = aws_iam_role.crossplane_aws.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
}

resource "aws_iam_role_policy_attachment" "crossplane_sqs" {
  role       = aws_iam_role.crossplane_aws.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSQSFullAccess"
}

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
