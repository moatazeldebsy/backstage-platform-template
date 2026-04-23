terraform {
  required_version = ">= 1.5.0"

  required_providers {
    ${{ values.provider }} = {
      source  = "hashicorp/${{ values.provider }}"
      version = ">= 5.0"
    }
  }
}
