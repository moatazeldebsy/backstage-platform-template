module "${{ values.name | replace("-", "_") }}" {
  source = "../../"

  name   = "example"
  create = true

  tags = {
    Environment = "dev"
    ManagedBy   = "terraform"
  }
}
