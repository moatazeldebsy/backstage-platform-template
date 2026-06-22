# AWS Transit Gateway — inter-region VPC connectivity over the AWS backbone.
#
# Why Transit Gateway over VPC Peering:
#   - Supports transitive routing (VPC A → TGW → VPC B → TGW → VPC C)
#   - Single attachment point per VPC; no full-mesh peering required as the
#     platform grows to more regions or shared-services accounts
#   - Built-in route tables for network segmentation
#
# Architecture:
#   eu-central-1 TGW ←→ inter-region peering ←→ us-east-1 TGW
#   Each TGW attaches to its local VPC (idp-eu-central-1-vpc / idp-us-east-1-vpc)
#   Route tables in each VPC forward cross-region CIDR to the local TGW attachment.

# ── Transit Gateway — eu-central-1 (primary) ─────────────────────────────────

resource "aws_ec2_transit_gateway" "primary" {
  description                     = "IDP platform inter-region TGW (eu-central-1)"
  amazon_side_asn                 = 64512
  auto_accept_shared_attachments  = "enable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  vpn_ecmp_support                = "enable"
  dns_support                     = "enable"

  tags = {
    Name   = "idp-mvp-tgw-eu-central-1"
    Region = var.primary_region
  }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "primary" {
  transit_gateway_id = aws_ec2_transit_gateway.primary.id
  vpc_id             = var.primary_vpc_id
  subnet_ids         = var.primary_private_subnet_ids

  dns_support  = "enable"
  ipv6_support = "disable"

  tags = {
    Name = "idp-mvp-tgw-attachment-eu-central-1"
  }
}

# ── Transit Gateway — us-east-1 (standby) ────────────────────────────────────

resource "aws_ec2_transit_gateway" "standby" {
  provider = aws.standby

  description                     = "IDP platform inter-region TGW (us-east-1)"
  amazon_side_asn                 = 64513 # different ASN — required for peering
  auto_accept_shared_attachments  = "enable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
  vpn_ecmp_support                = "enable"
  dns_support                     = "enable"

  tags = {
    Name   = "idp-mvp-tgw-us-east-1"
    Region = var.standby_region
  }
}

resource "aws_ec2_transit_gateway_vpc_attachment" "standby" {
  provider = aws.standby

  transit_gateway_id = aws_ec2_transit_gateway.standby.id
  vpc_id             = var.standby_vpc_id
  subnet_ids         = var.standby_private_subnet_ids

  dns_support  = "enable"
  ipv6_support = "disable"

  tags = {
    Name = "idp-mvp-tgw-attachment-us-east-1"
  }
}

# ── Inter-region peering ───────────────────────────────────────────────────────

resource "aws_ec2_transit_gateway_peering_attachment" "primary_to_standby" {
  transit_gateway_id      = aws_ec2_transit_gateway.primary.id
  peer_transit_gateway_id = aws_ec2_transit_gateway.standby.id
  peer_region             = var.standby_region

  tags = {
    Name = "idp-mvp-tgw-peering-eu-us"
  }
}

# Accept the peering from the standby side
resource "aws_ec2_transit_gateway_peering_attachment_accepter" "standby" {
  provider                      = aws.standby
  transit_gateway_attachment_id = aws_ec2_transit_gateway_peering_attachment.primary_to_standby.id

  tags = {
    Name = "idp-mvp-tgw-peering-eu-us-accepter"
  }
}

# ── Static routes for cross-region traffic ────────────────────────────────────

# Primary TGW: route us-east-1 CIDR (10.1.0.0/16) → peering attachment
resource "aws_ec2_transit_gateway_route" "primary_to_standby" {
  destination_cidr_block         = var.standby_vpc_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.primary_to_standby.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.primary.association_default_route_table_id

  depends_on = [aws_ec2_transit_gateway_peering_attachment_accepter.standby]
}

# Standby TGW: route eu-central-1 CIDR (10.0.0.0/16) → peering attachment
resource "aws_ec2_transit_gateway_route" "standby_to_primary" {
  provider = aws.standby

  destination_cidr_block         = var.primary_vpc_cidr
  transit_gateway_attachment_id  = aws_ec2_transit_gateway_peering_attachment.primary_to_standby.id
  transit_gateway_route_table_id = aws_ec2_transit_gateway.standby.association_default_route_table_id

  depends_on = [aws_ec2_transit_gateway_peering_attachment_accepter.standby]
}

# ── VPC route table entries ───────────────────────────────────────────────────
# Each private subnet route table in eu-central-1 needs a route:
#   10.1.0.0/16 → tgw-attachment-eu-central-1
# And vice versa in us-east-1.
# These are data-source lookups since the route tables were created by the
# per-region Terraform module (terraform/vpc.tf).

data "aws_route_tables" "primary_private" {
  vpc_id = var.primary_vpc_id
  filter {
    name   = "tag:Name"
    values = ["*private*"]
  }
}

data "aws_route_tables" "standby_private" {
  provider = aws.standby
  vpc_id   = var.standby_vpc_id
  filter {
    name   = "tag:Name"
    values = ["*private*"]
  }
}

resource "aws_route" "primary_to_standby" {
  for_each = toset(data.aws_route_tables.primary_private.ids)

  route_table_id         = each.value
  destination_cidr_block = var.standby_vpc_cidr
  transit_gateway_id     = aws_ec2_transit_gateway.primary.id

  depends_on = [aws_ec2_transit_gateway_vpc_attachment.primary]
}

resource "aws_route" "standby_to_primary" {
  provider = aws.standby
  for_each = toset(data.aws_route_tables.standby_private.ids)

  route_table_id         = each.value
  destination_cidr_block = var.primary_vpc_cidr
  transit_gateway_id     = aws_ec2_transit_gateway.standby.id

  depends_on = [aws_ec2_transit_gateway_vpc_attachment.standby]
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "transit_gateway_primary_id" {
  description = "Transit Gateway ID in eu-central-1"
  value       = aws_ec2_transit_gateway.primary.id
}

output "transit_gateway_standby_id" {
  description = "Transit Gateway ID in us-east-1"
  value       = aws_ec2_transit_gateway.standby.id
}

output "transit_gateway_peering_id" {
  description = "Inter-region TGW peering attachment ID"
  value       = aws_ec2_transit_gateway_peering_attachment.primary_to_standby.id
}
