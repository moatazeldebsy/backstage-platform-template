# AWS Global Accelerator — static anycast IPs in front of both ALBs.
# Provides sub-30s failover (vs. Route 53 TTL-based ~60s), TCP/UDP acceleration
# via the AWS backbone, and consistent IPs for IP-allowlist use cases.
#
# Use for: Backstage portal, internal gRPC APIs, WebSocket connections.
# Use Route 53 failover (route53.tf) for: standard HTTPS/REST APIs where TTL lag is acceptable.

resource "aws_globalaccelerator_accelerator" "platform" {
  name            = "idp-mvp-platform"
  ip_address_type = "IPV4"
  enabled         = true

  attributes {
    flow_logs_enabled   = true
    flow_logs_s3_bucket = var.logs_s3_bucket
    flow_logs_s3_prefix = "global-accelerator/"
  }

  tags = {
    Name = "idp-mvp-platform-ga"
  }
}

# ── Listener ──────────────────────────────────────────────────────────────────

resource "aws_globalaccelerator_listener" "https" {
  accelerator_arn = aws_globalaccelerator_accelerator.platform.id
  protocol        = "TCP"

  port_range {
    from_port = 443
    to_port   = 443
  }
}

# ── Endpoint groups (one per region) ─────────────────────────────────────────

resource "aws_globalaccelerator_endpoint_group" "primary" {
  listener_arn                  = aws_globalaccelerator_listener.https.id
  endpoint_group_region         = var.primary_region
  traffic_dial_percentage       = 100   # primary receives 100% by default
  health_check_path             = var.health_check_path
  health_check_protocol         = "HTTPS"
  health_check_interval_seconds = 30
  threshold_count               = 3

  endpoint_configuration {
    endpoint_id                    = var.primary_alb_arn
    weight                         = 100
    client_ip_preservation_enabled = true
  }
}

resource "aws_globalaccelerator_endpoint_group" "standby" {
  listener_arn                  = aws_globalaccelerator_listener.https.id
  endpoint_group_region         = var.standby_region
  traffic_dial_percentage       = 0     # standby receives 0% until failover
  health_check_path             = var.health_check_path
  health_check_protocol         = "HTTPS"
  health_check_interval_seconds = 30
  threshold_count               = 3

  endpoint_configuration {
    endpoint_id                    = var.standby_alb_arn
    weight                         = 100
    client_ip_preservation_enabled = true
  }
}
