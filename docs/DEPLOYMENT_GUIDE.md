# AWS Deployment Guide

Deploy the platform to AWS EKS. Locally it costs nothing; on AWS budget roughly
**$45–50/day** while the cluster runs, and tear it down when you are done.

**Before you start:** work through the [Pre-Deployment Checklist](PRE_DEPLOYMENT_CHECKLIST.md)
(tools, credentials, GitHub OAuth app) and run `./scripts/verify-secrets.sh`.

---

## Deployment steps

### Step 1: Personalize configuration

```bash
./scripts/setup.sh
```

Replaces `moatazeldebsy` and the other placeholders, creates the `.env` files and
`terraform/terraform.tfvars`, and creates the Terraform state bucket.

### Step 2: Bootstrap AWS infrastructure

```bash
./scripts/bootstrap.sh                     # evaluation: one shared NAT gateway
./scripts/bootstrap.sh --profile medium    # production: per-AZ NAT + RDS Multi-AZ, Karpenter
```

`--profile small|medium|large` layers `terraform/profiles/<p>.tfvars` over
`terraform.tfvars` and is remembered for later runs (`--profile none` clears it).
`medium` and `large` also run ArgoCD in HA mode and two Backstage and Grafana
replicas spread across AZs. Without them, losing the AZ that hosts the single NAT
gateway cuts outbound traffic — see [ADR-0009](design/adr-0009-single-region-multi-az.md).

What it deploys (phase numbers match the timer labels the script prints):

| Phase | Duration | What |
|-------|----------|------|
| 1 — Terraform | 15–25 min | VPC, EKS, RDS (PostgreSQL), ECR, IAM/OIDC, Secrets Manager |
| 2 — kubectl config | <1 min | `aws eks update-kubeconfig`, connectivity check |
| 2.5 — Image builds | background | hello-service + Backstage images; skipped when unchanged |
| 3.x | 3–5 min | Namespaces, RBAC, External Secrets Operator, ClusterSecretStore |
| 4.x | 8–15 min | Prometheus + Grafana, Pushgateway, OpenCost, Gatekeeper + Kyverno, Rollouts, Loki, Tempo |
| 4.5–4.7 — GitOps | 3–5 min | ArgoCD, the `idp-services` ApplicationSet, Crossplane, tokens |
| 5.x — Backstage | 2–8 min | ExternalSecret, ConfigMaps, deployment, load balancer, catalog exporter |
| 6 — AI/ML | 8–20 min | Only with `--with-ai` / `--adp` |

**Total: ~40–70 minutes cold.** Re-runs skip anything unchanged. `IDP_FORCE=1`
disables the skips; `HELM_WAIT_SHORT/MED/LONG/XL` (default 5m/10m/15m/25m) raise
helm timeouts on a slow link — see
[Scripts Reference](scripts-reference.md#re-running-the-bootstrap-scripts-caching-and-parallelism).

### Step 3: Update GitHub OAuth callback URL

When bootstrap finishes it prints the Backstage URL. In your GitHub OAuth app
(<https://github.com/settings/developers>), set the callback URL to
`http://<BACKSTAGE_HOSTNAME>/api/auth/github/handler/frame`.

### Step 4: AI/ML stack (opt-in)

```bash
./scripts/bootstrap.sh --with-ai    # KAgent, MLflow, Langfuse, MCP servers
./scripts/bootstrap.sh --adp        # implies --with-ai, adds the agentic platform
```

Requires `ANTHROPIC_API_KEY` in Secrets Manager. `enable_ai` and `enable_langfuse`
also gate the Langfuse RDS instance and S3 buckets, so a core-only install never
provisions them. Omitting `--with-ai` later **keeps** existing AI infrastructure;
pass `--remove-ai-infra` to destroy it. To call the AI script directly, pass
`--aws` (without it, it targets your local Kind context):

```bash
./scripts/bootstrap-ai.sh --aws --adp --region <region> --cluster <cluster-name>
```

### Step 5: Provision team namespaces

Create the per-team External Secrets IAM role, then run the **Provision Team
Namespace** template in Backstage with the role ARN:

```bash
cd terraform
terraform apply -var='team_eso_roles=[{name="payments", cost_center="CC-1234"}]'
terraform output team_eso_role_arns
```

The template's PR adds `kubernetes/teams/<name>/` and
`backstage/catalog/groups/<name>.yaml`; once merged, the `idp-teams`
ApplicationSet applies it. Team services live under
`teams/<team>/services/<service>/` — see [Team Management](team-management.md).

### Step 6: GitHub Actions secrets

Services scaffolded with **Deployment Target: AWS** get their own `AWS_ROLE_ARN`
automatically (see [below](#adding-aws-cd-to-a-scaffolded-service)). Never give a
service repo the platform's `github_actions_role_arn`.

On the **platform repo**, add:

| Secret | Purpose |
|--------|---------|
| `APP_ID`, `APP_PRIVATE_KEY` | Auto-merge workflow via a GitHub App — see [GitHub App Setup](github-app-setup.md) |
| `DD_API_KEY` (optional) | Datadog deployment markers in `build-and-deploy.yml` |

### Rebuilding Backstage

`bootstrap.sh` already deployed Backstage. After changing it, re-run the
bootstrap: the image fingerprint changes, so only Backstage is rebuilt.

```bash
./scripts/bootstrap.sh --region <region> --cluster-name <name>
```

---

## Post-deployment validation

```bash
./scripts/validate-deployment.sh     # ~40 automated checks
```

Spot checks:

```bash
kubectl get pods -n services-dev               # hello-service, MCP servers
kubectl get clustersecretstore                 # aws-secretsmanager → Ready
kubectl get providers.pkg.crossplane.io        # all INSTALLED=True HEALTHY=True
curl -s http://<BACKSTAGE>/api/catalog/entities?limit=5 | jq length
```

### Service URLs

Backstage has its own load balancer. Every other UI is a **listener port on one
shared ALB** (IngressGroup `idp-platform`). `bootstrap.sh` prints them all; to
read one later:

```bash
source scripts/lib.sh
alb_ingress_url argocd-server argocd          # -> <shared-alb>:8080
```

| Service | URL |
|---------|-----|
| Backstage | `http://<backstage-nlb>` |
| ArgoCD | `http://<shared-alb>:8080` |
| Grafana | `http://<shared-alb>:3000` (`:443` with `domain_name`) |
| hello-service | `http://<shared-alb>:8081` |
| agent-event-router | `http://<shared-alb>:8082/webhook/github` (AI stack) |
| KAgent UI / IDP Assistant | `http://<internal-alb>:8083` / `:8084` — VPC only |
| MLflow / Langfuse / Argo Workflows | `http://<internal-alb>:5000` / `:3001` / `:2746` — VPC only |

The VPC-only tools have no authentication of their own, so they sit on an
**internal** ALB. Reach them over VPN/SSM or with `kubectl port-forward`.
Prometheus, Alertmanager, Pushgateway and OpenCost publish no ALB at all; the
bootstrap banner prints their port-forward commands.

---

## Adding AWS CD to a scaffolded service

Nothing to add. Scaffold with **Deployment Target: AWS** and the template:

1. creates the ECR repository `<cluster>/<service>` and a push-only IAM role that
   only that repo's `main` branch can assume;
2. writes the role ARN to the new repo as the `AWS_ROLE_ARN` secret;
3. opens a GitOps PR adding `services/<service>/helm-values-aws.yaml`.

The service's CI then pushes every `main` build to ECR and ArgoCD deploys it.

---

## Day-2 operations

```bash
# Force a catalog refresh (repopulates in ~60 s)
kubectl rollout restart deployment/backstage -n backstage

# Run DORA collection now
kubectl create job dora-manual-$(date +%s) --from=cronjob/dora-exporter -n monitoring

# Rotate a Backstage secret (GITHUB_TOKEN, PAGERDUTY_TOKEN, JIRA_TOKEN, JIRA_URL…)
aws secretsmanager get-secret-value --secret-id <cluster>/backstage \
  --query SecretString --output text \
  | jq '.GITHUB_TOKEN = "ghp_NEW"' \
  | aws secretsmanager put-secret-value --secret-id <cluster>/backstage --secret-string file:///dev/stdin
kubectl annotate externalsecret backstage-secrets -n backstage force-sync=$(date +%s) --overwrite
kubectl rollout restart deployment/backstage -n backstage
```

PagerDuty and Jira are optional; unset, their tabs show an empty state.
`JIRA_TOKEN` is `base64(email:api_token)`, not the raw token.

For anything that fails, see [Troubleshooting](TROUBLESHOOTING.md#phase-4-aws-setup-bootstrapsh).

---

## Cost

The fixed floor is **~$135/month** before any workload: EKS control plane (~$73),
one NAT gateway (~$33), RDS `db.t3.micro` (~$17), EBS/S3/ECR/Secrets (~$15).
Nodes are what actually move. For daily work use `./scripts/bootstrap-local.sh --full`
and deploy to AWS only for demos.

Rough us-east-1 on-demand estimates — the authoritative numbers are the AWS
budget alert and the OpenCost / Grafana FinOps dashboard the platform deploys:

| Config | Cost optimizer | AI/ML | Est. monthly |
|---|---|---|---|
| Default (`terraform.tfvars.example`) | On | Off | ~$280–310 |
| Always-on, no AI | Off | Off | ~$370–400 |
| Always-on + AI | Off | On | ~$430–490 |
| Production (`--profile medium`) | Off | Optional | ~$700–900 |

Not included: data transfer, LLM API spend (Anthropic/OpenAI/Voyage — can exceed
the infrastructure on an agent-heavy platform, see
[Langfuse](ai-assistant.md#llm-observability-langfuse)), Datadog, and your own services.

Ways to spend less, biggest first:

- **Destroy between sessions** with `./scripts/cleanup.sh` (~$1.60/month destroyed).
- **Keep `enable_cost_optimizer = true`** (default): Lambdas scale nodes to zero
  and stop RDS from 8 PM to 7 AM UTC (`cost_optimizer_scale_down_cron` /
  `_up_cron` to change), roughly halving the node and RDS lines.
- **Skip the AI/ML layer** — it adds a second RDS, S3 buckets and the internal ALB.
- **Spot nodes** are already the default for every non-`prod` install.
- **Keep `retentionSize`** on Prometheus (`aws/observability/prometheus-stack-values.yaml`).
  `retention` alone is a time cap, and a full volume silently stops ingestion.

A Terraform-managed budget (`budget_monthly_limit_usd`, default `$100`) alerts at
80% actual and 100% forecast; set `budget_alert_email` to receive it.

### Consolidating ALBs

**Done without a domain:** every platform Ingress carries
`alb.ingress.kubernetes.io/group.name: idp-platform` plus its own `listen-ports`,
so they share one ALB and differ by port. `validate-deployment.sh` flags any
internet-facing Ingress missing the group annotation. To add one, pick an unused
port, set both annotations, and read the URL with `alb_ingress_url`. Scaffolded
services ship `ingress.enabled: false` and publish no ALB unless you opt in.

Internal and internet-facing Ingresses cannot share a group (one ALB has one
scheme), so the floor is one public ALB plus the internal one.

**With a domain** (port-free URLs and TLS):

1. Set `domain_name` in `terraform.tfvars` (the Route 53 zone must exist);
   `terraform/acm.tf` then issues a wildcard certificate.
2. Give each internet-facing service a `host:` in its `helm-values-aws.yaml`.
3. Add `group.name`, `listen-ports: '[{"HTTP":80},{"HTTPS":443}]'` and
   `certificate-arn` annotations.
4. Point one wildcard `ALIAS` record (`*.idp.example.com`) at the ALB.

At organisation scale use [external-dns](https://github.com/kubernetes-sigs/external-dns)
on a **delegated** subdomain, with its IRSA role scoped to that zone and
`--txt-owner-id=<cluster-name>` so clusters sharing a zone don't overwrite each other.

---

## Production hardening

- **Capacity:** use `--profile medium` (or `large`), or set `node_group_min_size = 2`,
  `node_instance_types = ["t3.large"]` and `enable_cost_optimizer = false`.
- **RDS:** `environment = "prod"` enables deletion protection and a final snapshot;
  raise `backup_retention_period` in `terraform/rds.tf` from its default of 1.
- **Grafana replicas:** state lives in Postgres (`terraform/grafana.tf`), so
  sessions survive scaling.

---

## Cleanup & destroy {#cleanup-destroy}

```bash
./scripts/cleanup.sh --cluster-name idp-mvp --force
```

`cleanup.sh` runs ordered phases while EKS is still up, because a bare
`terraform destroy` leaves billing resources behind (see the table below):

| Phase | What it does |
|---|---|
| 0 — Stop the writers | Deletes ArgoCD ApplicationSets and Applications with cascade, so the load balancer controller removes its own ALBs; scales Loki's write path to zero |
| 1 — ALBs | Deletes orphaned `k8s-*` ALBs and security groups (they block VPC deletion) |
| 2 — RDS protection | Disables deletion protection |
| 3 — Scaffolded services | Deletes their ArgoCD apps and Helm releases, removes `services/<name>/`, commits |
| 4 — Crossplane resources | Deletes everything tagged `idp:provisioner=crossplane` |
| 5 — S3 + ECR | Empties buckets and `<cluster>`-prefixed ECR repos |
| 6 — Terraform destroy | Retried; falls back to targeted destroys if EKS is already gone |
| 7 — Leftovers | CloudWatch log groups, EBS volumes from PVCs, Karpenter launch templates |
| 8 — Verify | Tag sweep; refuses to report success while anything is left |

The Terraform state bucket and lock table are kept deliberately. KMS keys and
secrets are only *scheduled* for deletion by AWS (7–30 days) — expected, not a leak.

### What Terraform owns, and what it cannot destroy

| Resource | Created by | Cleaned up in |
|---|---|---|
| EKS, VPC, NAT, IAM/IRSA, RDS, KMS, Secrets Manager, ECR `<cluster>/<service>` | Terraform | Phase 6 |
| ALBs, target groups, `k8s-*` security groups | AWS Load Balancer Controller, from Ingresses | Phases 0–1 |
| S3/RDS/DynamoDB/SQS/MSK from Claims | Crossplane (`deletionPolicy: Orphan`) | Phase 4 |
| Bucket and repository contents | Runtime data | Phase 5 |
| EBS volumes behind PVCs | EBS CSI driver | Phase 7 |
| Karpenter nodes and launch templates | Karpenter | Phases 0, 5, 7 |
| AI/MCP ECR repos, Langfuse keys secret | `bootstrap-ai.sh` | Phase 5 |
| `/aws/eks/*`, `/aws/lambda/*` log groups | EKS / Lambda | Phase 7 |

To remove only the AI/ML layer: `./scripts/bootstrap-ai.sh --aws --destroy`.
Never run it without `--aws` while `KUBECONFIG` points at EKS — it would target
the wrong environment. Local teardown is `./scripts/bootstrap-local.sh --destroy`.
