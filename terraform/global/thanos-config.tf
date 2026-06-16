# Thanos object store config — stored in Secrets Manager so the ExternalSecret
# in aws/observability/thanos/thanos-sidecar-patch.yaml can create the
# thanos-objstore-config Secret with the real (account-ID-suffixed) bucket name.
#
# After `terraform apply`, the ExternalSecret refreshes the Secret automatically.

resource "aws_secretsmanager_secret" "thanos_objstore" {
  name                    = "idp-mvp/thanos/objstore-config"
  description             = "Thanos S3 object store config — bucket name injected by Terraform"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "thanos_objstore" {
  secret_id = aws_secretsmanager_secret.thanos_objstore.id

  secret_string = jsonencode({
    "objstore.yml" = <<-YAML
      type: S3
      config:
        bucket: ${aws_s3_bucket.thanos_metrics.id}
        region: ${var.primary_region}
        sse_config:
          type: SSE-S3
    YAML
  })
}
