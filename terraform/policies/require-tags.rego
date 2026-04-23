# Conftest policy: all Terraform AWS resources must declare mandatory cost tags.
# Run via: conftest test terraform/ --policy terraform/policies/
#
# Add to CI (terraform.yml):
#   - name: Check Terraform tag policy
#     run: conftest test terraform/ --policy terraform/policies/
package main

# Mandatory tags for every AWS resource
mandatory_tags := {"Project", "Environment", "ManagedBy"}

# Resource types that are tag-aware and must carry mandatory tags
taggable_resource_types := {
  "aws_instance",
  "aws_eks_cluster",
  "aws_rds_cluster",
  "aws_db_instance",
  "aws_s3_bucket",
  "aws_lambda_function",
  "aws_iam_role",
  "aws_sns_topic",
  "aws_budgets_budget",
  "aws_ecr_repository",
  "aws_vpc",
  "aws_subnet",
  "aws_security_group",
}

deny[msg] {
  resource := input.resource[resource_type][resource_name]
  taggable_resource_types[resource_type]
  missing := mandatory_tags - {tag | resource.tags[tag]}
  count(missing) > 0
  msg := sprintf(
    "Resource '%s.%s' is missing mandatory tags: %v. Add Project, Environment, and ManagedBy tags.",
    [resource_type, resource_name, missing]
  )
}
