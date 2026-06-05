# Route 53 — health-check-based failover routing for the IDP platform.
#
# Traffic flow (active-standby):
#   User → Route 53 (idp.<domain_name>)
#     ├── PRIMARY   → ALB in eu-central-1  (serves traffic when healthy)
#     └── SECONDARY → ALB in us-east-1    (activated automatically when primary fails health check)
#
# Failover is automatic: Route 53 health check polls /healthcheck on the primary ALB
# every 30 seconds. If 3 consecutive checks fail, all traffic shifts to the standby ALB.

data "aws_route53_zone" "platform" {
  name         = var.domain_name
  private_zone = false
}

# ── Health checks ─────────────────────────────────────────────────────────────

resource "aws_route53_health_check" "primary" {
  fqdn              = var.primary_alb_dns
  port              = 443
  type              = "HTTPS"
  resource_path     = var.health_check_path
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name   = "idp-primary-eu-central-1"
    Region = var.primary_region
  }
}

resource "aws_route53_health_check" "standby" {
  fqdn              = var.standby_alb_dns
  port              = 443
  type              = "HTTPS"
  resource_path     = var.health_check_path
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name   = "idp-standby-us-east-1"
    Region = var.standby_region
  }
}

# ── Failover DNS records ───────────────────────────────────────────────────────

resource "aws_route53_record" "primary" {
  zone_id = data.aws_route53_zone.platform.zone_id
  name    = "idp.${var.domain_name}"
  type    = "A"

  failover_routing_policy {
    type = "PRIMARY"
  }

  set_identifier  = "primary-eu-central-1"
  health_check_id = aws_route53_health_check.primary.id

  alias {
    name                   = var.primary_alb_dns
    zone_id                = var.primary_alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "standby" {
  zone_id = data.aws_route53_zone.platform.zone_id
  name    = "idp.${var.domain_name}"
  type    = "A"

  failover_routing_policy {
    type = "SECONDARY"
  }

  set_identifier  = "standby-us-east-1"
  health_check_id = aws_route53_health_check.standby.id

  alias {
    name                   = var.standby_alb_dns
    zone_id                = var.standby_alb_zone_id
    evaluate_target_health = true
  }
}

# ── Latency-based records (optional — enable once both regions are validated) ──
# Uncomment to add latency routing on top of failover for additional optimization.
#
# resource "aws_route53_record" "primary_latency" {
#   zone_id = data.aws_route53_zone.platform.zone_id
#   name    = "api.${var.domain_name}"
#   type    = "A"
#
#   latency_routing_policy {
#     region = var.primary_region
#   }
#
#   set_identifier = "api-eu-central-1"
#   alias {
#     name                   = var.primary_alb_dns
#     zone_id                = var.primary_alb_zone_id
#     evaluate_target_health = true
#   }
# }
