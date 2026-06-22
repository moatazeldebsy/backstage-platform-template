# Per-team IAM role for External Secrets Operator (IRSA).
#
# One role per team, scoped to secretsmanager:GetSecretValue on /<team-name>/*.
# Usage:
#   terraform apply -var="team_eso_roles=[{name=\"payments\",cost_center=\"CC-1234\"}]"
#
# The role ARN output is what you paste into the Backstage "Provision Team Namespace"
# template as the "ESO IAM role ARN" parameter.

variable "team_eso_roles" {
  description = "List of teams that need a scoped ESO IAM role."
  type = list(object({
    name        = string
    cost_center = string
  }))
  default = []
}

# One role per team
resource "aws_iam_role" "team_eso" {
  for_each = { for t in var.team_eso_roles : t.name => t }

  name = "team-${each.key}-eso"

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
          "${module.eks.oidc_provider}:sub" = "system:serviceaccount:team-${each.key}:team-${each.key}-eso-sa"
        }
      }
    }]
  })

  tags = {
    Team       = each.key
    CostCenter = each.value.cost_center
    ManagedBy  = "terraform"
    Component  = "external-secrets"
  }
}

resource "aws_iam_role_policy" "team_eso_secrets" {
  for_each = { for t in var.team_eso_roles : t.name => t }

  name = "team-${each.key}-secrets-read"
  role = aws_iam_role.team_eso[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "TeamScopedSecrets"
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ]
      # Secrets must live under /<team-name>/ prefix — no cross-team access
      Resource = "arn:aws:secretsmanager:*:*:secret:${each.key}/*"
    }]
  })
}

output "team_eso_role_arns" {
  description = "Map of team name → ESO IAM role ARN. Paste the relevant ARN into the Backstage team-namespace template."
  value = {
    for name, role in aws_iam_role.team_eso : name => role.arn
  }
}
