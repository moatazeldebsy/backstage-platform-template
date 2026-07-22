# ACM certificate for the monitoring ALB ingresses (Grafana, Prometheus, Alertmanager).
#
# Opt-in: only provisioned when var.domain_name is set, since it requires a Route 53
# hosted zone that already exists for that domain (this repo doesn't create the zone
# itself — "Root domain name managed in Route 53" per variables.tf). DNS-01 validation
# via Route 53 record, which the AWS Load Balancer Controller ALB ingresses then
# reference via the alb.ingress.kubernetes.io/certificate-arn annotation (ALB
# terminates TLS from an ACM cert ARN, not a Kubernetes TLS Secret).
data "aws_route53_zone" "monitoring" {
  count = var.domain_name != "" ? 1 : 0
  name  = var.domain_name
}

resource "aws_acm_certificate" "monitoring" {
  count             = var.domain_name != "" ? 1 : 0
  domain_name       = "*.${var.domain_name}"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    "idp:component" = "monitoring-tls"
  }
}

resource "aws_route53_record" "monitoring_cert_validation" {
  for_each = var.domain_name != "" ? {
    for dvo in aws_acm_certificate.monitoring[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  } : {}

  zone_id = data.aws_route53_zone.monitoring[0].zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "monitoring" {
  count                   = var.domain_name != "" ? 1 : 0
  certificate_arn         = aws_acm_certificate.monitoring[0].arn
  validation_record_fqdns = [for r in aws_route53_record.monitoring_cert_validation : r.fqdn]
}

output "monitoring_acm_certificate_arn" {
  description = "ACM certificate ARN for the monitoring ALB ingresses (Grafana/Prometheus/Alertmanager). Empty when domain_name is unset."
  value       = var.domain_name != "" ? aws_acm_certificate_validation.monitoring[0].certificate_arn : ""
}
