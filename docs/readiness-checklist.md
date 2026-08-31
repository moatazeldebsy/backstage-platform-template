# Production Readiness Checklist

Use this checklist before promoting the IDP to a production environment.

> **Quick validation:** Run `./scripts/validate-deployment.sh` after deployment to verify all 50+ platform components are healthy. This automated check covers AWS infrastructure, Kubernetes, Backstage, observability, GitOps, AI/ML, security, networking, storage, and resource usage. See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for more.

---

## Security

### Secrets & Credentials
- [ ] `local/.env` and `local/backstage/.env` are **never committed** (gitignored by default)
- [x] `BACKSTAGE_AUTH_SECRET` is a generated random value. There is no default any more:
      Terraform generates it, `bootstrap.sh` backfills existing clusters, both Backstage
      deployments read it from `backstage-secrets`, and `setup.sh` generates one locally.
      An unset value now fails startup instead of falling back to a shared key.
- [ ] `ANTHROPIC_API_KEY` is stored as a GitHub Actions secret, not hardcoded anywhere
- [ ] All GitHub tokens (`GITHUB_TOKEN`, `GH_PAT`) are scoped to minimum required permissions
- [ ] ArgoCD auth token and Grafana token are rotated after initial bootstrap

### Authentication
- [ ] `auth.environment` in `app-config.yaml` is changed from `development` to `production` for prod deployments
- [ ] Guest auth (`dangerouslyAllowOutsideDevelopment`) is **not** enabled in production — it's only in `app-config.local.yaml`
- [ ] GitHub OAuth App is registered with the correct callback URL for your domain
- [ ] `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` are set in production environment

### Network & TLS

**Ingress TLS termination** — nothing on the cluster serves HTTPS by default. This is the largest open security gap; see [security.md](security.md#ingress-tls-is-not-configured) for the full remediation and [#310](https://github.com/moatazeldebsy/backstage-platform-template/issues/310) for tracking.

- [ ] `var.domain_name` is set in `terraform/terraform.tfvars` and a Route53 hosted zone exists for it
- [ ] The ACM wildcard certificate in `terraform/acm.tf` covers Backstage and ArgoCD, not just the monitoring ALBs
- [ ] Backstage is served through an ALB Ingress carrying `certificate-arn`, `listen-ports: [{"HTTPS":443}]` and `ssl-redirect: '443'` — not a bare `LoadBalancer` Service on port 80
- [ ] `APP_BASE_URL`, `app.baseUrl` and `backend.baseUrl` all use `https://`
- [ ] ArgoCD no longer runs with `--insecure` / `server.insecure: true`
- [ ] `curl -I http://<backstage-host>` returns a 301 to HTTPS, and the HTTPS URL returns 200
- [ ] The GitHub OAuth App callback URL was re-registered for the new hostname

**Other TLS settings**

- [ ] `skipTLSVerify: true` in Kubernetes config is replaced with a proper CA bundle for production clusters
- [ ] `ssl.rejectUnauthorized: false` for PostgreSQL is enabled (set to `true`) in production
- [ ] `upgrade-insecure-requests` is set to `true` when Backstage is served over HTTPS — **do this only after ingress TLS is live**, or the app breaks
- [ ] CSP `connect-src` is narrowed to specific upstream hostnames in production

### Infrastructure (AWS / Terraform)
- [ ] RDS `deletion_protection = true` ✅ (fixed)
- [ ] RDS `skip_final_snapshot = false` ✅ (fixed)
- [ ] RDS password uses `special = true` for full entropy ✅ (fixed)
- [ ] IAM roles follow least privilege — review and scope down `PowerUserAccess` to ECR + EKS + S3 only
- [ ] S3 buckets for TechDocs have bucket versioning and server-side encryption enabled
- [ ] RDS egress security group rule restricts to VPC CIDR, not `0.0.0.0/0`

### Infrastructure (Crossplane)
- [ ] Crossplane IRSA role attaches AWS-managed `*FullAccess` policies — tighten to least-privilege custom policies before prod
- [ ] All Crossplane-provisioned resources carry `idp:provisioner=crossplane`, `idp:owner`, `idp:cost-center` tags ✅ (enforced by Compositions)
- [ ] No naming collision between TF-managed and Crossplane-managed resources of the same kind (e.g. RDS instance names)
- [ ] `kubectl get providers.pkg.crossplane.io` shows all five providers `HEALTHY=True`
- [ ] Backstage `*-crossplane` scaffolder templates produce PRs that sync within ~60s of merge

### Container & Kubernetes
- [ ] Helm is installed from a pinned version with SHA256 checksum in Dockerfile ✅ (fixed)
- [ ] `ml-platform` and `kagent` namespace PSS changed from `privileged` to `baseline` ✅ (fixed)
- [ ] Backstage container does not run as root (runs as `node` user) ✅
- [ ] Docker socket bind-mount (`/var/run/docker.sock`) is only present in local dev compose — not in production

### GitHub Actions
- [ ] No `pull_request_target` trigger used with checkout of untrusted code
- [ ] Consider pinning actions to commit SHAs for supply-chain security (currently using `@v4`/`@v5`)
- [ ] `ANTHROPIC_API_KEY` secret is set in repository settings before running eval workflow

---

## Functionality

### Backstage Portal
- [ ] `setup.sh` was run **before** `bootstrap-local.sh` (required for `moatazeldebsy` placeholder replacement)
- [ ] ArgoCD has 3 apps synced: `hello-service-local`, `idp-mcp-server-local`, `qa-mcp-server-local` (run `kubectl get applications -n argocd`)
- [ ] `idp-mcp-server` and `qa-mcp-server` pods are running in `services-dev` namespace
- [ ] KAgent agents show `READY=True` for both `idp-assistant` and `qa-assistant` (run `kubectl get agents -n kagent`)
- [ ] All placeholder values replaced by running `./scripts/setup.sh`
- [ ] `yarn build:backend` run after any changes to `backstage/app/packages/`
- [ ] Backstage image rebuilt and pushed after backend changes
- [ ] All catalog locations resolve (no 404s in catalog import logs)
- [ ] TechDocs renders for at least one component
- [ ] Software templates scaffold successfully end-to-end
- [ ] GitHub OAuth login works (not just guest auth)

### Platform Services
- [ ] ArgoCD is accessible at http://argocd.idp.local and all 3 apps are Synced+Healthy (`kubectl get applications -n argocd`)
- [ ] Prometheus scrape targets are healthy
- [ ] Grafana dashboards load with data
- [ ] Pushgateway receives QA metrics from the seed job
- [ ] hello-service responds at `http://hello-service.idp.local/hello`

### AI Assistant (optional)
- [ ] `ANTHROPIC_API_KEY` is set in `local/.env`
- [ ] KAgent pods are running in `kagent` namespace
- [ ] IDP Assistant is reachable at `http://idp-assistant.idp.local`
- [ ] AI Assistant chat UI loads in Backstage at `/ai-assistant`
- [ ] DeepEval suite passes: `deepeval test run test-suites/test-deepeval/tests/test_idp_assistant.py`

---

## Operations

### Observability
- [ ] Alerting rules are configured in Prometheus for critical services
- [ ] Log aggregation is in place (Loki, CloudWatch, or equivalent)
- [ ] Uptime checks configured for Backstage, ArgoCD, and hello-service

### Backup & Recovery
- [ ] RDS automated backups verified (7-day retention) ✅
- [ ] Disaster recovery runbook documented in `docs/runbooks/`
- [ ] EKS cluster can be recreated from scratch with `bootstrap-local.sh` or Terraform

### Access Control
- [ ] RBAC reviewed — `github-actions` ClusterRole limited to required verbs/resources
- [ ] Backstage users are provisioned via GitHub org membership, not manual catalog entries
- [ ] ArgoCD RBAC policy restricts non-admins to read-only on production apps
- [ ] `permission.enabled: true` set in `backstage/app-config.aws.yaml`
- [ ] Permission backend plugin wired in `packages/backend/src/plugins/permission.ts`

### Team Isolation
- [ ] At least one team namespace provisioned via the **Provision Team Namespace** scaffold
- [ ] Per-team SecretStore is healthy: `kubectl get secretstore -A | grep team-`
- [ ] Per-team IRSA roles restricted to `/<team>/*` secret paths (verify in IAM console)
- [ ] Kyverno `crossplane-team-label-policy` is Enforcing: `kubectl get clusterpolicy crossplane-require-cost-tags`
- [ ] All Crossplane resources in `team-*` namespaces carry `idp:team` AWS tag
- [ ] DORA metrics have `team=` label: `curl <pushgateway>/metrics | grep 'dora_deploy.*team='`
- [ ] Catalog uses `all-templates.yaml` (not 49 individual URL entries): check `app-config.aws.yaml`

---

## Template Readiness (before sharing publicly)

- [ ] `moatazeldebsy` placeholder present in all catalog/template files ✅
- [ ] No personal tokens or credentials in git history (`git log --all -S "ghp_" --oneline`)
- [ ] `setup.sh` tested end-to-end on a clean clone
- [ ] `.env.example` files cover all required variables ✅
- [ ] GitHub repository marked as **Template repository** ✅
- [ ] Topics set: `template`, `backstage`, `idp`, `internal-developer-platform` ✅
- [ ] README accurately describes prerequisites and quick-start steps
