resource "aws_ecr_repository" "services" {
  for_each = toset(var.ecr_repositories)

  name                 = "${var.cluster_name}/${each.value}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 v* release images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Expire untagged images older than 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = { type = "expire" }
      },
      {
        # CI tags images with the short commit SHA (and `latest`), which the v*
        # rule never matched, so every pushed image was kept forever. The cap
        # is deliberately high: the prod overlay can pin an image several
        # promotions old, and expiring it would ImagePullBackOff the next
        # reschedule.
        rulePriority = 3
        description  = "Keep the newest 200 images of any tag"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 200
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = aws_ecr_repository.services
  repository = each.value.name
  policy     = local.ecr_lifecycle_policy
}

# ECR for Backstage
resource "aws_ecr_repository" "backstage" {
  name                 = "${var.cluster_name}/backstage"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# The backstage repo had no lifecycle policy at all.
resource "aws_ecr_lifecycle_policy" "backstage" {
  repository = aws_ecr_repository.backstage.name
  policy     = local.ecr_lifecycle_policy
}

output "ecr_registry_url" {
  description = "ECR registry URL"
  value       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
}

output "ecr_repository_urls" {
  description = "ECR repository URLs"
  value       = { for k, v in aws_ecr_repository.services : k => v.repository_url }
}
