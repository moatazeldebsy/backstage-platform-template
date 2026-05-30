# Setup Troubleshooting Guide

Fresh-clone setup issues are expected — this template bundles a lot of moving parts (Kind, nginx, ArgoCD, Prometheus, Backstage, Docker Compose) that must initialise in the right order. This guide covers the issues most commonly encountered on a first install and what to do about them.

**The single most important rule: `setup.sh` must complete successfully before `bootstrap-local.sh` runs.** Many downstream failures (empty catalog, ArgoCD generating no apps, GitHub OAuth loops) trace back to skipping or partially running `setup.sh`.

---

## Quick diagnosis checklist

Run this after any failure to orient yourself:

```bash
# 1. Docker running?
docker info > /dev/null && echo "Docker OK" || echo "Docker NOT running"

# 2. Kind cluster exists?
kind get clusters

# 3. All pods healthy?
kubectl get pods -A --no-headers | grep -vE "Running|Completed" | grep -v "0/0"

# 4. Backstage alive?
docker ps --filter "name=backstage" --format "{{.Names}} {{.Status}}"

# 5. Placeholders resolved?
grep -r "YOUR_GITHUB_ORG" backstage/catalog/ local/argocd/ 2>/dev/null && echo "PLACEHOLDERS NOT REPLACED" || echo "Placeholders OK"
```

---

## Phase 0 — Personalisation (`setup.sh`)

### Symptom: ArgoCD shows no applications

**Cause:** `setup.sh` was not run (or the `xargs` path was used on an older checkout), so `local/argocd/app-of-apps-local.yaml` still contains the `YOUR_GITHUB_ORG` placeholder. ArgoCD's git generator finds no matching directories and creates no apps.

**Fix:**

```bash
# Verify the placeholder is still in the file
grep "YOUR_GITHUB_ORG" local/argocd/app-of-apps-local.yaml

# If it is, run setup.sh to resolve all placeholders
./scripts/setup.sh

# After setup.sh completes, force a resync
kubectl rollout restart deployment/argocd-application-controller -n argocd
```

### Symptom: Services in catalog still show `moatazeldebsy` URLs

**Cause:** `setup.sh` was run but the find-replace scan missed some files (can happen if you ran an older version that used `xargs` instead of `while-read`).

**Fix:**

```bash
# Check which files still have the old placeholder
grep -rl "moatazeldebsy\|YOUR_GITHUB_ORG" \
  backstage/catalog/ backstage/app-config*.yaml \
  local/ kubernetes/ .github/workflows/ 2>/dev/null

# Re-run setup to re-apply substitutions (idempotent)
./scripts/setup.sh
```

---

## Phase 1 — Local bootstrap (`bootstrap-local.sh`)

### Symptom: `kind create cluster` fails immediately

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| Docker not running | Start Docker Desktop / Rancher Desktop and wait for it to be ready |
| Port 80 already bound | `lsof -i :80` — stop the conflicting process (another nginx, a web server, etc.) |
| Stale Kind cluster with same name | `kind delete cluster --name idp-mvp && ./scripts/bootstrap-local.sh` |
| Rancher Desktop Traefik still enabled | Disable in Preferences → Kubernetes → disable Traefik |

### Symptom: nginx ingress pods pending, `*.idp.local` not reachable

**Cause:** Port 80 or 443 is bound by another process on the host.

```bash
# Check what's using port 80
lsof -i :80 -sTCP:LISTEN

# Check ingress pods
kubectl get pods -n ingress-nginx

# If pending, describe for events
kubectl describe pod -n ingress-nginx -l app.kubernetes.io/component=controller
```

### Symptom: `/etc/hosts` entries missing after bootstrap

The bootstrap writes hosts entries automatically, but may fail silently if `/etc/hosts` is read-only or if the script was interrupted.

```bash
# Check if entries exist
grep "idp.local" /etc/hosts

# Add manually if missing (requires sudo)
sudo sh -c "cat local/hosts-append.txt >> /etc/hosts"

# Flush DNS cache (macOS)
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
```

### Symptom: Kind node `NotReady` after Docker crash/restart

This is covered fully in the runbook — see [Kind Node IP Mismatch](runbooks/kind-node-ip-mismatch.md).

Short version: Docker reassigned the container IP; the kubelet cannot reach the API server with the old IP baked into `/etc/kubernetes/kubelet.conf`. Fix by updating the kubelet.conf or recreating the cluster.

### Symptom: `kube-proxy` crash-loops, events show "too many open files" (Linux only)

Linux kernels have low default inotify limits that Kind clusters exhaust quickly.

```bash
# Fix for the current session
sudo sysctl -w fs.inotify.max_user_instances=1024
sudo sysctl -w fs.inotify.max_user_watches=655360

# Persist across reboots
echo "fs.inotify.max_user_instances=1024" | sudo tee -a /etc/sysctl.conf
echo "fs.inotify.max_user_watches=655360"  | sudo tee -a /etc/sysctl.conf

# Then delete the crashing pod so the DaemonSet recreates it
kubectl delete pod -n kube-system -l k8s-app=kube-proxy
```

> **macOS users:** this does not apply — the Docker VM manages its own kernel limits.

### Symptom: Pod stuck in `ImagePullBackOff`

A scaffolded service was registered but its Docker image was never pushed to the local registry, or the cluster was recreated and registry contents were lost.

See [ImagePullBackOff runbook](runbooks/image-pull-backoff.md) for the full fix.

Short version:

```bash
cd services/<name>
docker build -t localhost:5003/<name>:latest .
docker push localhost:5003/<name>:latest
kubectl rollout restart deployment/<name>-dev-service-template -n services-dev
```

---

## Phase 2 — Backstage

### Symptom: Catalog is empty (0 entities) after Backstage starts

**Most likely cause:** The scaffolderActionsExtensionPoint was imported from the wrong path in a backend module, causing the scaffolder plugin to crash on startup. The crash aborts the catalog refresh loop, leaving `final_entities` empty even though `refresh_state` may have rows.

Check if this is the issue:

```bash
docker logs backstage-backstage-1 2>/dev/null | grep -i "scaffolder\|extensionPoint\|error" | tail -20

# Also check DB directly
docker exec backstage-postgres-1 psql -U backstage backstage_plugin_catalog \
  -c "SELECT count(*) FROM refresh_state;" \
  -c "SELECT count(*) FROM final_entities;"
```

If `refresh_state > 0` but `final_entities = 0`: this is the scaffolder crash. The fix is already in the codebase — if you see this, your checkout may be on an older commit. Pull latest and rebuild.

```bash
git pull
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d
```

**Second most likely cause:** Backstage is still starting up (DB migrations run at startup). Wait 60–90 seconds and refresh.

**Third cause:** `GITHUB_TOKEN` is not set in `local/.env`. The catalog uses it to read entity files from GitHub. Without it, GitHub integration fails silently on many requests.

```bash
grep "GITHUB_TOKEN" local/.env
# If empty, add it: GITHUB_TOKEN=ghp_xxx
docker compose -f local/backstage/docker-compose.yml restart backstage
```

### Symptom: GitHub OAuth login fails / redirect loop

1. Check the OAuth app callback URL in GitHub — it must be exactly:
   ```
   http://backstage.idp.local/api/auth/github/handler/frame
   ```
   (Or `http://localhost:3000/api/auth/github/handler/frame` if accessing via localhost.)

2. Check `local/backstage/.env` has both `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET` set.

3. Restart Backstage after any change:
   ```bash
   docker compose -f local/backstage/docker-compose.yml restart backstage
   ```

### Symptom: `catalog-exporter` CronJob in `CrashLoopBackOff`

This CronJob runs inside the cluster and tries to reach `backstage.default.svc.cluster.local:3000`. It fails whenever Backstage is not running. This is **expected and harmless** when Backstage is down.

Fix: start Backstage.

```bash
./scripts/bootstrap-local.sh --start-backstage
```

### Symptom: DORA metrics not in Grafana / Pushgateway empty

The `dora-exporter` CronJob runs every 15 minutes. Metrics will not appear immediately after bootstrap.

Trigger a manual run:

```bash
kubectl create job dora-now --from=cronjob/dora-exporter -n monitoring
kubectl logs job/dora-now -n monitoring --follow
```

If the job fails with `python: can't open file '/scripts/dora-exporter.py'`, the ConfigMap was not populated:

```bash
kubectl create configmap dora-exporter-script \
  --from-file=dora-exporter.py=local/observability/dora/dora-exporter.py \
  -n monitoring --dry-run=client -o yaml | kubectl apply -f -
```

See also [docs/local-setup.md — Troubleshooting observability](local-setup.md#troubleshooting-observability-after-bootstrap) for Kubernetes tab CPU/Memory issues.

### Symptom: Catalog tables crash / blank on catalog, api-docs, or techdocs pages

This was caused by `uuid` v10 removing its default export, which broke `@material-table/core`. The fix (a yarn patch at `.yarn/patches/`) is committed to the repo and applied automatically by `yarn install`.

If you see `TypeError: Cannot read properties of undefined (reading 'v4')`:

```bash
cd backstage/app && yarn install  # re-applies the patch
# Verify:
grep "uuid.*v4" node_modules/@material-table/core/dist/utils/data-manager.js
# Expected: (_uuid["default"] || _uuid).v4()
```

Then rebuild the image:

```bash
docker compose -f local/backstage/docker-compose.yml build backstage
docker compose -f local/backstage/docker-compose.yml up -d
```

---

## Phase 3 — AI/ML stack (`bootstrap-ai.sh`)

### Symptom: KAgent agents show `READY=False`

```bash
kubectl get agents -n kagent
kubectl describe agent idp-assistant -n kagent  # check Conditions
kubectl logs -n kagent deployment/kagent-controller --tail=50 | grep -E "error|registered"
```

Built-in agents may show `READY=False` briefly at startup while the controller reconciles. Restart the controller to clear stale conditions:

```bash
kubectl rollout restart deployment/kagent-controller -n kagent
kubectl get agents -n kagent -w  # watch until READY=True
```

### Symptom: `kagent.idp.local` / `idp-assistant.idp.local` redirect to HTTPS, certificate error

**Cause:** Your browser cached HSTS for `*.idp.local` from a previous HTTPS setup.

**Fix (Chrome):**
1. Open `chrome://net-internals/#hsts`
2. Delete domain security policies for `kagent.idp.local` and `idp-assistant.idp.local`
3. Disable *Settings → Privacy → Always use secure connections* for local domains
4. Hard-reload (`Cmd+Shift+R`)

**Fix (Firefox):** Clear site data for the affected domains in Developer Tools → Storage → Clear.

### Symptom: AI Assistant returns 502 / cannot connect

```bash
# Check kagent ingress
kubectl get ingress -n kagent

# Check idp-assistant pod
kubectl get pods -n kagent -l app.kubernetes.io/name=idp-assistant

# Check proxy config in Backstage
grep -A5 "kagent" backstage/app-config.local.yaml
```

The Backstage proxy target (`/api/proxy/kagent`) must point to `http://idp-assistant.idp.local`. Verify the ingress exists and the `/etc/hosts` entry is present.

### Symptom: MCP server `idp-mcp-server` / `qa-mcp-server` not deployed on first install

On a first install, ArgoCD may not have registered the `idp-services` ApplicationSet before `bootstrap-ai.sh` runs. The script falls back to direct Helm, but if the fallback was interrupted, deploy manually:

```bash
helm upgrade --install idp-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/idp-mcp-server/helm-values-local.yaml --wait

helm upgrade --install qa-mcp-server helm/service-template \
  --namespace services-dev --create-namespace \
  --values services/qa-mcp-server/helm-values-local.yaml --wait
```

---

## Phase 4 — AWS setup (`bootstrap.sh`)

> For a comprehensive list of issues that were present in earlier versions and are now patched, see [docs/DEPLOYMENT_GUIDE.md — Known Issues & Fixes](DEPLOYMENT_GUIDE.md#known-issues--fixes). This section covers issues that can still occur on a fresh deployment.

### Pre-flight: always run `verify-secrets.sh` first

```bash
./scripts/verify-secrets.sh
# Expected: ✅ All critical checks passed!
```

If it shows failures, fix them before running `bootstrap.sh`. The script checks AWS credentials, required env vars, GitHub token validity, and quota.

---

### Terraform

#### Symptom: `terraform init` fails — no such bucket

`setup.sh` creates the Terraform state S3 bucket. If you skipped `setup.sh` or ran `terraform init` manually before it ran:

```bash
# Get the bucket name from the backend block
grep bucket terraform/main.tf

# Create it
aws s3 mb s3://<bucket-name> --region <region>
aws s3api put-bucket-versioning \
  --bucket <bucket-name> --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption \
  --bucket <bucket-name> \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

#### Symptom: `terraform init` fails — DynamoDB lock table not found

`setup.sh` creates both the S3 bucket and the DynamoDB table. If only the bucket was created manually:

```bash
# Get table name from the backend block
grep dynamodb_table terraform/main.tf

aws dynamodb create-table \
  --table-name <table-name> \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region <region>
```

#### Symptom: `Error acquiring the state lock` — stale lock from interrupted run

```bash
cd terraform
# Find the lock ID in the error message, then:
terraform force-unlock <lock-id>
```

#### Symptom: `Error: error creating EKS Node Group — NodeCreationFailure: Ec2SubnetInvalidConfiguration`

AWS requires at least 2 subnets in different AZs for managed node groups. This triggers when your region has fewer than 2 AZs (rare) or if `terraform.tfvars` has `availability_zones` set to a single AZ.

```bash
# Check available AZs
aws ec2 describe-availability-zones --region <region> --query 'AvailabilityZones[].ZoneName'
# terraform.tfvars must list at least 2
```

#### Symptom: EC2 quota exceeded — `InsufficientInstanceCapacity` or vCPU limit

The default quota for on-demand t3.medium is 32 vCPUs per region. 4 nodes × 2 vCPUs = 8 vCPUs, usually within quota. If not:

```bash
# Check current usage
aws service-quotas get-service-quota \
  --service-code ec2 --quota-code L-1216C47A --region <region>

# Request increase via AWS Console → Service Quotas → EC2 → Running On-Demand Standard instances
# Or reduce node count: edit terraform.tfvars → node_group_desired_size = 1
```

#### Symptom: `terraform destroy` fails — ECR repos not empty / Crossplane resources blocking

**Do not run `terraform destroy` directly.** Use the cleanup script which handles dependency ordering:

```bash
./scripts/cleanup.sh --cluster-name idp-mvp --force
```

The cleanup runs 7 ordered phases: delete ALBs → disable RDS deletion protection → delete Crossplane-tagged resources → empty S3/ECR → `terraform destroy` → verify. Skipping this causes Terraform to fail on resource dependencies.

If `cleanup.sh` itself fails mid-run and you need to retry from a specific phase:

```bash
# Manual ECR cleanup
aws ecr list-images --repository-name idp-mvp/hello-service --region us-east-1 \
  --query 'imageIds[*]' --output json \
  | xargs -I{} aws ecr batch-delete-image --repository-name idp-mvp/hello-service \
    --region us-east-1 --image-ids {}

# Then re-run
./scripts/cleanup.sh --cluster-name idp-mvp --force
```

---

### EKS cluster

#### Symptom: EKS nodes stuck in `NotReady`

Wait 3 minutes — the IAM role binding propagates asynchronously. If it persists:

```bash
kubectl get nodes
kubectl describe node <node-name> | grep -A10 "Conditions:"

# Check required managed policies on the node IAM role
aws iam list-attached-role-policies \
  --role-name <node-role-name> \
  --query 'AttachedPolicies[].PolicyName'
# Must include: AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy, AmazonEC2ContainerRegistryReadOnly
```

#### Symptom: `aws-load-balancer-controller` pod crash-loops, ALBs not provisioning

```bash
kubectl logs -n kube-system deployment/aws-load-balancer-controller --tail=30 | grep -i "error\|denied"
```

Common cause: the IRSA role (`AWSLoadBalancerControllerIAMRole`) trust policy does not match the OIDC provider URL. Terraform creates this automatically — if the trust policy is wrong, it means Terraform did not finish successfully. Re-run `bootstrap.sh`.

#### Symptom: ALB address stuck in `<pending>` for more than 10 minutes

```bash
kubectl describe ingress <name> -n <namespace>  # check Events section

# Check if load balancer controller is running
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller

# Check controller logs for the specific ingress
kubectl logs -n kube-system deployment/aws-load-balancer-controller | grep <ingress-name>
```

Normal wait: 3–5 minutes. If longer, the controller is likely not running or the IAM role is wrong.

---

### Backstage (AWS)

#### Symptom: Backstage pod in `CrashLoopBackOff` or `Error`

```bash
kubectl logs -n backstage deployment/backstage --tail=50
kubectl describe pod -n backstage -l app=backstage | grep -A15 "Events:"
```

Common causes:

| Cause | Fix |
|-------|-----|
| ExternalSecret not synced | `kubectl get externalsecret -n backstage` — check READY=True |
| ClusterSecretStore not ready | `kubectl get clustersecretstore` — see below |
| RDS not ready | `kubectl get pods -n backstage \| grep postgres` |
| Config YAML parse error | Check logs for `YAMLException` — usually an indentation issue in the ConfigMap |

#### Symptom: `ClusterSecretStore aws-secretsmanager` shows `InvalidProviderConfig`

The External Secrets Operator's IRSA trust policy must match the ESO service account. Check:

```bash
kubectl get clustersecretstore aws-secretsmanager -o yaml | grep -A5 "conditions:"
kubectl get sa external-secrets-sa -n external-secrets -o yaml | grep "eks.amazonaws.com"
```

The service account annotation must match the IRSA role ARN. `bootstrap.sh` creates and annotates the SA automatically. If it was created by the Helm chart before the annotation was applied:

```bash
# Re-annotate the SA
kubectl annotate sa external-secrets-sa -n external-secrets \
  eks.amazonaws.com/role-arn=<IRSA_ROLE_ARN> --overwrite

# Restart the operator to pick up the new annotation
kubectl rollout restart deployment/external-secrets -n external-secrets
kubectl rollout restart deployment/external-secrets-cert-controller -n external-secrets
```

Get the correct role ARN:

```bash
cd terraform && terraform output external_secrets_role_arn
```

#### Symptom: `K8S_SERVICE_ACCOUNT_TOKEN` expired — Backstage Kubernetes tab shows 401

EKS service account tokens expire. `bootstrap.sh` auto-populates the token, but it needs refreshing if the cluster was recreated or the token rolled:

```bash
# Get a fresh token
TOKEN=$(kubectl -n backstage create token backstage-sa --duration=8760h)

# Update Secrets Manager
SECRET=$(aws secretsmanager get-secret-value \
  --secret-id idp-mvp/backstage --query SecretString --output text)
echo "$SECRET" | python3 -c "
import sys,json; d=json.load(sys.stdin)
d['K8S_SERVICE_ACCOUNT_TOKEN']='$TOKEN'
print(json.dumps(d))" \
| aws secretsmanager put-secret-value \
  --secret-id idp-mvp/backstage --secret-string file:///dev/stdin

# Restart Backstage to pick up the new secret
kubectl rollout restart deployment/backstage -n backstage
```

#### Symptom: GitHub OAuth login redirect loop after deployment

The OAuth app callback URL must be updated with the **real ALB hostname** (only known after bootstrap finishes):

1. `kubectl get ingress backstage -n backstage -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`
2. Go to GitHub → Settings → Developer settings → OAuth Apps → your app → Edit
3. Update **Authorization callback URL** to: `http://<ALB-HOSTNAME>/api/auth/github/handler/frame`

#### Symptom: Apple Silicon Mac — pods show `ImagePullBackOff` / `no match for platform in manifest`

Images built on Apple Silicon (arm64) with `docker build` (no `--platform` flag) cannot run on EKS nodes (amd64). Always build for the target platform:

```bash
# For hello-service or any scaffolded service
docker buildx build --platform linux/amd64 \
  -t <ECR_URI>/<service-name>:latest --push .
```

Or use GitHub Actions CI (which runs on ubuntu-latest = amd64) to build and push automatically.

---

### Observability (AWS)

#### Symptom: DORA metrics missing in Grafana

The `dora-exporter` CronJob runs every 15 minutes and requires a valid `GITHUB_TOKEN` in Secrets Manager. Trigger manually:

```bash
kubectl create job dora-manual-$(date +%s) --from=cronjob/dora-exporter -n monitoring
kubectl logs -n monitoring -l "job-name=dora-manual-$(date +%s --date=1min ago)" --tail=30
```

If the job fails with an auth error, update the token in Secrets Manager (see GITHUB_TOKEN section in [PRE_DEPLOYMENT_CHECKLIST.md](PRE_DEPLOYMENT_CHECKLIST.md)).

#### Symptom: Pushgateway has no data / QA metrics dashboard empty

Re-seed metrics pointing at the ALB URL:

```bash
PUSHGATEWAY_URL=http://$(kubectl get ingress prometheus-pushgateway -n monitoring \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}') \
  ./scripts/seed-qa-metrics.sh
```

#### Symptom: Grafana returning 503 intermittently

With a single node cluster, Grafana pod restarts can cause brief 503s. The nginx proxy is configured with `proxy-next-upstream: http_503` so retries are automatic. If 503s persist more than 60 seconds:

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana
kubectl describe pod -n monitoring -l app.kubernetes.io/name=grafana | grep -A5 "Events:"
# OOMKilled = memory limit too low; restart with higher limit or reduce replicas to 1
```

---

### ArgoCD (AWS)

#### Symptom: `idp-services` ApplicationSet creates no applications

```bash
kubectl get applicationset -n argocd
kubectl describe applicationset idp-services -n argocd | grep -A10 "Status:"
```

Most common cause: `aws/argocd/app-of-apps.yaml` still has a `YOUR_GITHUB_ORG` placeholder (setup.sh was not run). Fix:

```bash
grep "YOUR_GITHUB_ORG" aws/argocd/app-of-apps.yaml
./scripts/setup.sh   # then re-commit and let ArgoCD sync
```

#### Symptom: ArgoCD GitHub credentials expired — all apps show `ComparisonError`

```bash
# Re-register GitHub credentials
argocd repo add https://github.com/<org>/<repo>.git \
  --username <github-user> --password <github-token>

# Or re-run the bootstrap phase that does this
./scripts/bootstrap-local.sh --install-argocd  # local
# For AWS: re-run the ArgoCD phase of bootstrap.sh
```

#### Symptom: Crossplane providers not healthy after bootstrap

Crossplane provider pods pull large images and may take 5–10 minutes on first install. Check:

```bash
kubectl get providers.pkg.crossplane.io
# Expected: INSTALLED=True HEALTHY=True for all five providers

# If HEALTHY=False after 10 min:
kubectl describe provider provider-aws-s3 | grep -A10 "Status:"
kubectl get pods -n crossplane-system | grep provider
```

A failing provider pod usually means the IRSA role (`CrossplaneAWSRole`) is not yet propagated. Wait 2 minutes and check again.

---

### bootstrap.sh interrupted mid-run

`bootstrap.sh` is idempotent for most phases. Re-run it after fixing the root cause:

```bash
./scripts/bootstrap.sh
```

If only a specific phase failed, you can run individual pieces:

```bash
# Re-run Terraform only (phases 1–1.5)
cd terraform && terraform apply -var "cluster_name=idp-mvp" -auto-approve

# Re-apply just ArgoCD
./scripts/bootstrap-local.sh --install-argocd

# Re-apply just Backstage to EKS
kubectl apply -f kubernetes/backstage/ -n backstage
kubectl rollout restart deployment/backstage -n backstage
```

---

## Day-2 issues

### Symptom: Backstage URL inaccessible after Docker restart

When Docker Desktop restarts, the Backstage container gets a new IP. The nginx ingress loses the upstream endpoint.

```bash
# Rewire the ingress endpoint (takes ~10 seconds)
./scripts/bootstrap-local.sh --update-backstage-ip

# Or do a full Backstage restart (also reseeds metrics and triggers catalog export)
./scripts/bootstrap-local.sh --start-backstage
```

### Symptom: Scaffolded service not appearing in catalog after template runs

1. Check the `catalog:register` step output in the Backstage scaffolder UI — it should show the registered URL.
2. Check ArgoCD has synced the new service:
   ```bash
   kubectl get applications -n argocd | grep <service-name>
   ```
3. Force a catalog refresh in Backstage: Settings → Refresh entity.
4. If the service repo's `catalog-info.yaml` has a `YOUR_GITHUB_ORG` placeholder (old template version), re-run `setup.sh` and re-scaffold.

### Symptom: `helm upgrade` fails — "release: already exists" or CRD conflict

```bash
# Check what's installed
helm list -A | grep <service-name>

# Force reinstall
helm uninstall <service-name> -n <namespace>
helm upgrade --install <service-name> helm/service-template \
  --namespace <namespace> --create-namespace \
  --values services/<service-name>/helm-values-local.yaml
```

---

## Getting help

If an issue is not covered here:

1. Check the [docs/runbooks/](runbooks/index.md) directory for alert-specific procedures.
2. Check [docs/local-setup.md](local-setup.md) for observability-specific troubleshooting.
3. Check recent commits — many issues have been fixed: `git log --oneline --since="3 months ago" | grep fix`.
4. File an issue at the [GitHub repository](https://github.com/moatazeldebsy/backstage-platform-template/issues).
