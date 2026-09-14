# IRSA role for LiteLLM's Bedrock access.
#
# LiteLLM (kubernetes/ml-platform/litellm.yaml, ADR-0008) is the only workload
# in this platform that calls Bedrock — Bedrock auth is SigV4/IAM, not a static
# key, so it cannot go through the ANTHROPIC_API_KEY-style Secrets Manager sync
# that covers Anthropic. Modeled on aws_iam_role.crossplane_aws in
# iam-crossplane.tf, but scoped to exactly one ServiceAccount rather than a
# StringLike wildcard: LiteLLM runs as a single Deployment with one SA
# (aws/ml-platform/litellm-serviceaccount.yaml), unlike Crossplane's one-SA-per-provider-Pod
# shape.
#
# ADR-0007 flagged this exact role as the reason Bedrock stayed "not wired": it
# "needs a Terraform IAM role that cannot be exercised without a cluster." This
# is that role.

resource "aws_iam_role" "litellm_bedrock" {
  name = "${var.cluster_name}-litellm-bedrock"

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
          # Exact match, not StringLike: exactly one ServiceAccount needs this
          # role, unlike Crossplane's provider-aws-* wildcard.
          "${module.eks.oidc_provider}:sub" = "system:serviceaccount:ml-platform:litellm"
        }
      }
    }]
  })

  tags = {
    "idp:component"   = "litellm"
    "idp:cost-center" = "platform"
  }
}

# Scoped to specific Claude-on-Bedrock model ARNs, not "*" — least privilege,
# same convention as every other IRSA policy in this repo. Update this list as
# kubernetes/ml-platform/litellm.yaml's model_list gains more Bedrock-backed
# models; a model referenced in one but not the other fails at call time with
# AccessDeniedException, not at deploy time.
resource "aws_iam_role_policy" "litellm_bedrock_invoke" {
  name = "${var.cluster_name}-litellm-bedrock-invoke"
  role = aws_iam_role.litellm_bedrock.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "BedrockInvokeClaudeModels"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        ]
      },
    ]
  })
}
