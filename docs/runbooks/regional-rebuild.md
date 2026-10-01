# Regional Rebuild Runbook

## When to use this

The whole AWS region the platform runs in is unavailable, or is expected to be
for longer than you are willing to wait. This is the recovery path
[ADR-0009](../design/adr-0009-single-region-multi-az.md) accepts: **rebuild from
IaC in another region, RTO measured in hours.** There is no standby to fail over
to and no data replicated out of the region.

Not this runbook:

- One Availability Zone lost: the medium/large profiles recover from that
  automatically (per-AZ NAT, RDS Multi-AZ, zone-spread replicas).
- One component down: see [Database Recovery](db-recovery.md),
  [Pod Crash Loop](pod-crash-loop.md) and the rest of the [runbook index](index.md).

> **Never drilled.** The steps below come from reading the scripts, not from a
> timed rebuild, so the RTO is unmeasured. A full `bootstrap.sh` takes 45–60
> minutes on a healthy account. Budget a few hours in total.

## What survives, and what does not

| Thing | Where it lives | After losing the region |
|---|---|---|
| Platform repo: catalog, templates, `services/*/` values and claims, `kubernetes/` | GitHub | **Survives.** It is the source of truth the rebuild deploys from |
| IAM roles, GitHub Actions OIDC provider | IAM (global) | Survives, which is why a same-account rebuild collides with it (below) |
| GitHub OAuth app, repo secrets | GitHub | Survive. The OAuth callback URL must be updated |
| Terraform state bucket + lock table | S3 / DynamoDB in the region | **Unavailable.** The rebuild starts a fresh state |
| Secrets Manager (`idp-mvp/*`) | Region | **Lost.** Re-supply the inputs (step 4). Generated values are regenerated |
| Container images | ECR in the region | **Lost.** `bootstrap.sh` rebuilds Backstage and hello-service. Scaffolded services need a CI run (step 7) |
| Backstage DB | RDS + its automated backups, same region | **Lost.** The catalog re-ingests from git. Lost for good: scaffolder task history, Learning Center progress, Engineering Intelligence trend snapshots, compliance-watcher state. The RAG index rebuilds itself |
| Grafana DB | RDS, same region | **Lost.** Users and service-account tokens, incl. Backstage's `GRAFANA_TOKEN`. Dashboards are provisioned from git and come back |
| LiteLLM / Langfuse DBs (AI stack) | RDS, same region | **Lost.** Virtual keys, spend history, Langfuse users, projects, API keys, prompts |
| TechDocs, Velero, Loki, Tempo, MLflow, Langfuse buckets | S3 in the region | **Lost.** TechDocs republish from CI. Velero backups are same-region, so they do not help here. Log and trace history is gone |
| Team resources from Crossplane claims (S3, RDS, DynamoDB, SQS) | The region | **Data lost.** The claims recreate *empty* resources once their `region` is changed (step 1) |

If any of the "lost" rows is not acceptable, ADR-0009's escape hatch applies:
cross-region backup copies (AWS Backup for RDS, S3 replication). The
consequences section there explains why that is not built in.

## Before you start: two decisions

**1. Which region.** Any region where your EKS version is in standard support
(`aws eks describe-cluster-versions --region <new>`) and your account has
quota: VPCs, Elastic IPs, and On-Demand/Spot vCPUs for the node instance
families. Mind data residency if the platform holds EU data.

**2. Same account, or a different one.**

- **Different account:** simplest. Nothing collides, so skip the
  "same account only" parts below.
- **Same account:** three things are global or account-wide and still exist
  from the dead stack:
  1. **IAM role names.** They are all `${cluster_name}-…`, so use a **new
     `cluster_name`**, e.g. `idp-mvp-usw2`. That also gives the Terraform state
     bucket a new name.
  2. **S3 bucket names.** They are `idp-mvp-<purpose>-<account>`, with no
     cluster name and no region in them. Set **`s3_bucket_suffix`**, e.g.
     `"-usw2"`.
  3. **The GitHub Actions OIDC provider.** It is one per account. Import it
     into the new state rather than creating it (step 3).

> **If the dead region is us-east-1** (this repo's default `aws_region`): IAM is
> global, but its control plane, which serves every create and update, runs in
> us-east-1. While us-east-1 is impaired, creating the new stack's IAM roles
> can fail **whichever region you rebuild in**. Existing roles keep working.
> Waiting for IAM writes to recover may be the only option. A primary region
> other than us-east-1 removes this coupling.

## Steps

### 1. Point the repo at the new region

```bash
# terraform/terraform.tfvars
aws_region       = "us-west-2"
cluster_name     = "idp-mvp-usw2"   # same account: must differ from the old one
s3_bucket_suffix = "-usw2"          # same account only

# local/.env
AWS_REGION=us-west-2
```

Crossplane claims carry an explicit region and would keep targeting the dead
one. Update them and commit:

```bash
git grep -l "region: us-east-1" -- 'services/*/claims/*.yaml'
# edit each to the new region, then commit and push
```

### 2. Start a fresh Terraform state

`bootstrap.sh` creates the state bucket and `terraform/backend.hcl` **only when
`backend.hcl` is missing**, and re-initialises against whatever `.terraform/`
points at. Move the old stack's files aside. **Keep them**: step 8 needs them to
tear the old stack down.

```bash
mkdir -p ~/idp-old-stack
mv terraform/backend.hcl terraform/.terraform terraform/.idp-profile ~/idp-old-stack/ 2>/dev/null
```

### 3. Same account only: import the GitHub OIDC provider

From the repo root. `bootstrap.sh` would create the state backend in step 5.
Importing needs it first, so create it with the same helper (it writes to
`${ROOT_DIR}/terraform/backend.hcl`, hence `ROOT_DIR`):

```bash
( ROOT_DIR="$PWD"; source scripts/lib.sh; ensure_tf_state_backend us-west-2 idp-mvp-usw2 )
cd terraform
terraform init -backend-config=backend.hcl
terraform import aws_iam_openid_connect_provider.github_actions \
  "arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):oidc-provider/token.actions.githubusercontent.com"
cd ..
```

Step 5's bootstrap then finds `backend.hcl` and reuses this state.

### 4. Re-supply what Secrets Manager held

Everything below lived only in the lost region. The full list is under
[Required Credentials](../DEPLOYMENT_GUIDE.md#required-credentials).

| Input | Where it goes |
|---|---|
| `GITHUB_TOKEN` | `local/.env` |
| `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | `local/backstage/.env` (same OAuth app; only its callback URL changes, step 6) |
| `anthropic_api_key` (+ `litellm_master_key` for the AI stack) | `terraform/terraform.tfvars` or `TF_VAR_…`, which Terraform writes into `idp-mvp/kagent` |
| Datadog, PagerDuty, Jira, Slack, … (optional) | Their `terraform.tfvars` variables, as on first install |

Generated values are recreated by the bootstrap: `BACKSTAGE_CATALOG_TOKEN`,
`AUTH_SESSION_SECRET`, `BACKSTAGE_AUTH_SECRET`, the ArgoCD token and the RDS
passwords. Anything **outside** the cluster that held the old
`BACKSTAGE_CATALOG_TOKEN` (the catalog exporter, CI) needs the new one.

```bash
./scripts/verify-secrets.sh
```

### 5. Bootstrap

```bash
./scripts/bootstrap.sh --region us-west-2 --cluster-name idp-mvp-usw2 --profile medium
# + --with-ai if the AI stack was running
```

The bootstrap also re-points hello-service at the new region's ECR (it commits
`services/hello-service/helm-values-aws.yaml`), and sets the repo's
`AWS_ROLE_ARN` secret to the new GitHub Actions role.

### 6. Reconnect what points at the old URLs

- **GitHub OAuth callback:** set it to
  `http://<new-backstage-url>/api/auth/github/handler/frame`. The bootstrap prints the
  URL. See [Step 3 of the deployment guide](../DEPLOYMENT_GUIDE.md#step-3-update-github-oauth-callback-url).
- **`GRAFANA_TOKEN`:** mint a new Grafana service-account token and store it as
  on first install. The old one died with the Grafana DB.
- **AI stack:** LiteLLM virtual keys and Langfuse API keys are new. Reissue
  them to whatever used the old ones.

### 7. Bring team services back

Each scaffolded service's `helm-values-aws.yaml` still names an image in the
**old** region's ECR, so ArgoCD will show it `ImagePullBackOff`. Re-run each
service's CI (`build-and-deploy.yml`), for example with an empty commit to its
repo's `main`. That pushes to the new region's ECR and rewrites the values
file. Then republish TechDocs the same way.

```bash
./scripts/validate-deployment.sh
```

### 8. When the old region comes back: tear the old stack down

The old stack is still billing (EKS, NAT, nodes, RDS), and its state lives in
the old region. Restore its files, then clean up with **`--replaced-stack`**:

```bash
# 1. Park the NEW stack's Terraform files and tfvars
mkdir -p ~/idp-new-stack
mv terraform/backend.hcl terraform/.terraform terraform/terraform.tfvars ~/idp-new-stack/
mv terraform/.idp-profile ~/idp-new-stack/ 2>/dev/null

# 2. Bring back the OLD stack's, with a tfvars describing the OLD stack
#    (old aws_region and cluster_name, no s3_bucket_suffix)
mv ~/idp-old-stack/backend.hcl ~/idp-old-stack/.terraform terraform/
mv ~/idp-old-stack/.idp-profile terraform/ 2>/dev/null
cp ~/idp-new-stack/terraform.tfvars terraform/terraform.tfvars   # then edit it back to the old values

# 3. Tear the old stack down WITHOUT touching what the new one shares
./scripts/cleanup.sh --region us-east-1 --cluster-name idp-mvp --replaced-stack

# 4. Restore the new stack's files
rm -rf terraform/.terraform terraform/backend.hcl terraform/terraform.tfvars
mv ~/idp-new-stack/backend.hcl ~/idp-new-stack/.terraform ~/idp-new-stack/terraform.tfvars terraform/
mv ~/idp-new-stack/.idp-profile terraform/ 2>/dev/null
```

**Do not run `cleanup.sh` against the old stack without `--replaced-stack`.**
A plain run:

- **deletes every `services/<name>/` from git and pushes**, which removes the
  team services from the *new* cluster's GitOps source;
- clears the repo's `AWS_ROLE_ARN` secret, which now belongs to the new stack;
- destroys the GitHub OIDC provider, which a same-account rebuild shares.

`--replaced-stack` skips all three and still destroys everything else.

## Afterwards

Record the measured RTO, and anything this runbook got wrong, in
[ADR-0009](../design/adr-0009-single-region-multi-az.md). Until someone has done
that once, "RTO measured in hours" is an estimate.
