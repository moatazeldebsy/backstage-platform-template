# CloudFront distribution — caches static assets and TechDocs, accelerates the SPA.
# Uses origin failover: if eu-central-1 ALB returns 5xx, CloudFront retries on us-east-1.
#
# ACM certificate must be in us-east-1 (CloudFront requirement) — provisioned below.

resource "aws_acm_certificate" "platform_cf" {
  provider = aws.us_east_1

  domain_name               = "idp.${var.domain_name}"
  subject_alternative_names = ["*.idp.${var.domain_name}"]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "idp-mvp-cloudfront-cert"
  }
}

resource "aws_acm_certificate_validation" "platform_cf" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.platform_cf.arn
}

# ── WAF Web ACL (us-east-1 — required for CloudFront) ─────────────────────────

resource "aws_wafv2_web_acl" "platform" {
  provider = aws.us_east_1

  name  = "idp-mvp-platform"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # AWS managed rule groups — covers OWASP Top 10 + known bad IPs
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesCommonRuleSetMetric"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsMetric"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimit"
    priority = 3
    action { block {} }
    statement {
      rate_based_statement {
        limit              = 2000    # requests per 5-minute window per IP
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitMetric"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "idpMvpWAF"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "idp-mvp-waf"
  }
}

# ── CloudFront distribution ────────────────────────────────────────────────────

locals {
  primary_origin_id = "alb-eu-central-1"
  standby_origin_id = "alb-us-east-1"
}

resource "aws_cloudfront_distribution" "platform" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "IDP platform — Backstage + TechDocs"
  default_root_object = "index.html"
  aliases             = ["idp.${var.domain_name}"]
  web_acl_id          = aws_wafv2_web_acl.platform.arn
  price_class         = "PriceClass_100"   # US + Europe only — cheapest for GDPR scope

  # Origin group with failover: primary (eu-central-1) → secondary (us-east-1)
  origin_group {
    origin_id = "alb-failover-group"

    failover_criteria {
      status_codes = [500, 502, 503, 504]
    }

    member {
      origin_id = local.primary_origin_id
    }
    member {
      origin_id = local.standby_origin_id
    }
  }

  origin {
    origin_id   = local.primary_origin_id
    domain_name = var.primary_alb_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-CF-Origin"
      value = "eu-central-1"
    }
  }

  origin {
    origin_id   = local.standby_origin_id
    domain_name = var.standby_alb_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-CF-Origin"
      value = "us-east-1"
    }
  }

  # Default behavior — API + dynamic content (no caching)
  default_cache_behavior {
    target_origin_id       = "alb-failover-group"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Host", "Origin", "Accept"]
      cookies {
        forward = "all"
      }
    }

    min_ttl     = 0
    default_ttl = 0     # no caching for dynamic API content
    max_ttl     = 0
  }

  # TechDocs and static assets — aggressive caching
  ordered_cache_behavior {
    path_pattern           = "/docs/*"
    target_origin_id       = "alb-failover-group"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 86400    # 1 day
    max_ttl     = 604800   # 7 days
  }

  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = "alb-failover-group"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 604800   # 7 days
    max_ttl     = 2592000  # 30 days
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.platform_cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "idp-mvp-cloudfront"
  }
}
