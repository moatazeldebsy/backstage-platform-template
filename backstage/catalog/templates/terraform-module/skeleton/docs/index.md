# ${{ values.name }}

${{ values.description }}

## Usage

```hcl
module "${{ values.name | replace("-", "_") }}" {
  source = "github.com/${{ values.githubOrg }}/${{ values.repoName }}"

  name   = "my-${{ values.name }}"
  create = true

  tags = {
    Environment = "dev"
    ManagedBy   = "terraform"
  }
}
```

## Requirements

| Name | Version |
|------|---------|
| terraform | >= 1.5.0 |
| ${{ values.provider }} | >= 5.0 |

## Inputs

See `variables.tf` for the full variable list.

## Outputs

See `outputs.tf` for the full output list.

## Examples

- [Basic](../examples/basic/)

## Tests

```bash
cd tests
go test -v -timeout 30m
```
