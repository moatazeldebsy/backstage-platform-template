# Multi-region KMS key — same key material replicated across both regions.
# Used for Secrets Manager encryption, EBS volumes, and RDS storage so
# the standby region can decrypt data written by the primary without
# cross-region KMS API calls during a failover.

resource "aws_kms_key" "primary" {
  description             = "IDP platform multi-region CMK (primary — eu-central-1)"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  multi_region            = true

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Enable IAM User Permissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "Allow Secrets Manager"
        Effect = "Allow"
        Principal = {
          Service = "secretsmanager.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt"
        ]
        Resource = "*"
      }
    ]
  })

  tags = {
    Name = "idp-mvp-cmk-primary"
  }
}

resource "aws_kms_alias" "primary" {
  name          = "alias/idp-mvp-cmk"
  target_key_id = aws_kms_key.primary.key_id
}

# Replica key in the standby region — same key ID, different ARN
resource "aws_kms_replica_key" "standby" {
  provider = aws.standby

  description             = "IDP platform multi-region CMK (replica — us-east-1)"
  deletion_window_in_days = 7
  primary_key_arn         = aws_kms_key.primary.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Enable IAM User Permissions"
        Effect = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
      {
        Sid    = "Allow Secrets Manager"
        Effect = "Allow"
        Principal = {
          Service = "secretsmanager.amazonaws.com"
        }
        Action = [
          "kms:GenerateDataKey",
          "kms:Decrypt"
        ]
        Resource = "*"
      }
    ]
  })

  tags = {
    Name = "idp-mvp-cmk-replica"
  }
}

resource "aws_kms_alias" "standby" {
  provider = aws.standby

  name          = "alias/idp-mvp-cmk"
  target_key_id = aws_kms_replica_key.standby.key_id
}
