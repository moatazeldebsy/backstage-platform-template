# Contributing to backstage-idp-starter

Thank you for your interest in contributing! This project is a community-maintained GitHub template for building Internal Developer Platforms with Backstage, Helm, and AWS EKS.

## Ways to Contribute

- **Bug reports** — open an issue using the bug report template
- **Feature requests** — open an issue using the feature request template
- **Pull requests** — improvements to templates, scripts, documentation, or new software templates
- **Documentation** — corrections, clarifications, new guides

## Local Setup

1. Clone the repo and run the one-time setup:

```bash
git clone https://github.com/YOUR_GITHUB_ORG/backstage-idp-starter.git
cd backstage-idp-starter
./scripts/setup.sh
```

2. Start the local platform:

```bash
./scripts/bootstrap-local.sh
```

See `README.md` for the full getting-started guide.

## Adding a New Software Template

1. Create a directory under `backstage/catalog/templates/<template-name>/`
2. Add `template.yaml` following the Backstage Software Templates spec
3. Add a `skeleton/` directory with the generated code
4. Register the template in `backstage/app-config.yaml` under `catalog.locations`
5. Open a PR with a brief description of what the template generates

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Run `./scripts/bootstrap-local.sh` to verify local platform still boots
- Update documentation if your change affects user-facing behaviour
- Fill in the PR template checklist

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
