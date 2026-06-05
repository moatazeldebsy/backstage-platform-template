# ECR cross-region replication — account-level rule (only one replication config allowed per account).
# Every image pushed to eu-central-1 is automatically replicated to us-east-1.
# The standby EKS cluster pulls from its local ECR, avoiding cross-region pull costs and latency.

resource "aws_ecr_replication_configuration" "cross_region" {
  replication_configuration {
    rule {
      destination {
        region      = var.standby_region
        registry_id = data.aws_caller_identity.current.account_id
      }

      # Replicate all repositories — no filter means every repo in the account is included.
      # To limit scope, add repository_filter blocks:
      #   repository_filter {
      #     filter      = "idp-mvp/"
      #     filter_type = "PREFIX_MATCH"
      #   }
    }
  }
}
