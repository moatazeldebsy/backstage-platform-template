# ${{ values.name }}

${{ values.description }}

Scaffolded via the IDP golden path — reusable Terraform module with tests, examples, and automated docs.

<!-- BEGIN_TF_DOCS -->
<!-- terraform-docs output injected here by CI -->
<!-- END_TF_DOCS -->

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

## Examples

- [Basic](examples/basic/)

## Tests

```bash
cd tests
go test -v -timeout 30m
```

## Contributing

1. Add/modify resources in `main.tf`
2. Update `variables.tf` and `outputs.tf`
3. Update or add an example under `examples/`
4. Run `terraform fmt -recursive` before opening a PR
