resource "random_password" "rds" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "backstage" {
  name       = "${var.cluster_name}-backstage"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Name = "${var.cluster_name}-backstage-db-subnet-group"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.cluster_name}-rds"
  description = "Allow PostgreSQL from EKS nodes"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "PostgreSQL from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.cluster_name}-rds-sg"
  }
}

resource "aws_db_instance" "backstage" {
  identifier        = "${var.cluster_name}-backstage"
  engine            = "postgres"
  engine_version    = "17"
  instance_class    = var.rds_instance_class
  allocated_storage = 20

  db_name  = var.rds_db_name
  username = var.rds_username
  password = random_password.rds.result

  db_subnet_group_name   = aws_db_subnet_group.backstage.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = 7
  storage_encrypted       = true
  skip_final_snapshot     = true
  deletion_protection     = false

  tags = {
    Name = "${var.cluster_name}-backstage-db"
  }
}
