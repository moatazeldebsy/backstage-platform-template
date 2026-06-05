variable "primary_region" {
  description = "Primary AWS region (eu-central-1)"
  type        = string
  default     = "eu-central-1"
}

variable "standby_region" {
  description = "Standby AWS region (us-east-1)"
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Root domain for the IDP platform (e.g. idp.example.com)"
  type        = string
}

variable "primary_alb_dns" {
  description = "DNS name of the ALB in the primary region (output from per-region Terraform apply)"
  type        = string
}

variable "standby_alb_dns" {
  description = "DNS name of the ALB in the standby region (output from per-region Terraform apply)"
  type        = string
}

variable "primary_alb_zone_id" {
  description = "Route 53 hosted zone ID of the ALB in the primary region"
  type        = string
}

variable "standby_alb_zone_id" {
  description = "Route 53 hosted zone ID of the ALB in the standby region"
  type        = string
}

variable "health_check_path" {
  description = "HTTP path used by Route 53 health checks to probe each ALB"
  type        = string
  default     = "/healthcheck"
}
