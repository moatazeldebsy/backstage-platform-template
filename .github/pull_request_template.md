## Description

<!-- What does this PR do? Why is it needed? -->

## Type of Change

- [ ] Bug fix
- [ ] New software template
- [ ] Improvement to existing template or script
- [ ] Documentation update
- [ ] Infrastructure / Terraform change

## Testing Done

- [ ] Ran `./scripts/bootstrap-local.sh` — local platform boots successfully
- [ ] Ran `helm lint ./helm/service-template` — no errors
- [ ] Template verified end-to-end (if adding/modifying a template)
- [ ] `grep -r YOUR_GITHUB_ORG .` returns only expected placeholder occurrences

## Template Verification Matrix (if applicable)

If you added or modified a software template, fill in this matrix:

| Template | CI workflow | /healthz | /ready | /metrics |
|----------|-------------|----------|--------|---------|
| your-template | ✓ / — | ✓ / — | ✓ / — | ✓ / — |

## Checklist

- [ ] PR title is descriptive
- [ ] No hardcoded org names, account IDs, or secrets introduced
- [ ] Documentation updated if behaviour changed
