# The module's standard inputs, passed through. Every input has to be used, or
# tflint's recommended preset fails CI with terraform_unused_declarations — which
# it did on every freshly scaffolded module while the resources below were still
# commented out. Keep these, and add outputs for what the module creates.
output "enabled" {
  description = "Whether the module creates its resources (var.create)"
  value       = var.create
}

output "name" {
  description = "Base name applied to the module's resources"
  value       = var.name
}

output "tags" {
  description = "Tags applied to the module's resources"
  value       = var.tags
}

# Example for a resource the module creates:
#
# output "id" {
#   description = "ID of the created resource"
#   value       = try(aws_s3_bucket.this[0].id, null)
# }
