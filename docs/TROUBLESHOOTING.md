# Troubleshooting

Issues you may hit on a first install, and how to fix them. **`setup.sh` must
finish before `bootstrap-local.sh` runs.** Most surprising failures (empty
catalog, no ArgoCD apps, OAuth loops) trace back to skipping it.

## Quick diagnosis

```bash
docker info > /dev/null && echo "Docker OK"                       # Docker running?
kind get clusters                                                 # cluster exists?
kubectl get pods -A --no-headers | grep -vE "Running|Completed"   # unhealthy pods
docker ps --filter "name=backstage" --format "{{.Names}} {{.Status}}"
grep -r "moatazeldebsy" backstage/catalog/ local/argocd/ && echo "PLACEHOLDERS NOT REPLACED"
```

---

## Personalisation (`setup.sh`)

| Symptom | Fix |
|---|---|
| ArgoCD shows no applications | `local/argocd/app-of-apps-local.yaml` still has the placeholder. Run `./scripts/setup.sh`, then `kubectl rollout restart deployment/argocd-application-controller -n argocd` |
| Catalog still shows `moatazeldebsy` URLs | Re-run `./scripts/setup.sh` (idempotent) |
| AWS `idp-services` ApplicationSet creates nothing | Same cause in `aws/argocd/app-of-apps.yaml`: run `setup.sh`, commit, let ArgoCD sync |

---

## Local bootstrap (`bootstrap-local.sh`)

| Symptom | Fix |
|---|---|
| `kind create cluster` fails | Start Docker; free port 80 (`lsof -i :80`); delete a stale cluster (`kind delete cluster --name idp-mvp`); on Rancher Desktop disable Traefik |
| nginx ingress pending, `*.idp.local` unreachable | Port 80/443 is taken. The preflight only checks on a *fresh* install, so on an existing cluster check `lsof -i :80 -sTCP:LISTEN` and `kubectl get pods -n ingress-nginx` |
| Many `*.idp.local` URLs return 503/504 at once | The Docker host is oversubscribed and the API server is timing out (look for `context deadline exceeded` to `10.96.0.1:443`). Give Docker more CPU/RAM (12 CPU / 24 GB is comfortable) or [run less](local-setup.md#running-on-less), then re-run the bootstrap |
| `/etc/hosts` entries missing | `sudo sh -c "cat local/hosts-append.txt >> /etc/hosts"`, then flush DNS (`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`) |
| Kind node `NotReady` / URLs dead after a Docker restart | Run `./scripts/recover-docker-restart.sh`. Details: [Kind Node IP Mismatch](runbooks/kind-node-ip-mismatch.md) |
| `kube-proxy` crash-loops with "too many open files" (Linux) | `sudo sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=655360`, persist in `/etc/sysctl.conf`, delete the kube-proxy pod |
| `ImagePullBackOff` after scaffolding | The image isn't in the local registry. See [ImagePullBackOff](runbooks/image-pull-backoff.md) |
| K8s tab shows "unknown" CPU/memory | metrics-server isn't running yet (the bootstrap installs it) |

---

## Backstage

### Catalog is empty

```bash
docker exec backstage-postgres-1 psql -U backstage backstage_plugin_catalog \
  -c "SELECT count(*) FROM refresh_state;" -c "SELECT count(*) FROM final_entities;"
```

- `refresh_state > 0` but `final_entities = 0`: the scaffolder plugin crashed at
  startup and stopped the refresh loop. Pull the latest code and rebuild
  (`docker compose -f local/backstage/docker-compose.yml build backstage && … up -d`).
- Otherwise wait 60–90 s for migrations, and check `GITHUB_TOKEN` is set in `local/.env`.

### GitHub OAuth login fails or loops

1. The OAuth app callback must be exactly
   `http://backstage.idp.local/api/auth/github/handler/frame` (on AWS, the real
   Backstage hostname printed by `bootstrap.sh`).
2. **Open `http://backstage.idp.local`, never `localhost:3000`.** The sign-in popup
   posts back to the opener's origin, which must match `app.baseUrl`.
3. `local/backstage/.env` needs `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`.
4. Restart with `./scripts/bootstrap-local.sh --start-backstage`. `docker compose restart`
   does **not** re-read `.env`.

### Other Backstage symptoms

| Symptom | Fix |
|---|---|
| `/kubernetes` page crashes | Disabled by design locally; use the Kubernetes tab on an entity |
| Cost Overview: "OpenCost returned 500" | Wait for `kubectl get pods -n opencost` |
| ArgoCD page shows demo data | `ARGOCD_AUTH_TOKEN` missing (cluster recreated): `--install-argocd`, then `--start-backstage` |
| `catalog-exporter` CronJob crash-loops | Expected while Backstage is down; start it |
| Tables crash with `reading 'v4'` | The `@material-table` patch is missing: `cd backstage/app && yarn install`, then rebuild |
| `BACKSTAGE_AUTH_SECRET is missing a value` | Intended — there is no default. `printf 'BACKSTAGE_AUTH_SECRET=%s\n' "$(openssl rand -hex 32)" >> local/backstage/.env` |
| Backstage URL dead after Docker restart | `./scripts/bootstrap-local.sh --update-backstage-ip` (or `--start-backstage`) |
| Scaffolded service missing from catalog | Check the `catalog:register` step output, then `kubectl get applications -n argocd \| grep <name>` |

---

## Observability

| Symptom | Fix |
|---|---|
| DORA metrics missing | The exporter runs every 15 min. Run it now: `kubectl create job dora-now --from=cronjob/dora-exporter -n monitoring`. On AWS it needs a valid `GITHUB_TOKEN` in Secrets Manager |
| QA dashboard empty | Expected until a service's CI publishes JUnit `test-results*` artifacts. `0/10 runs had artifacts` in the flaky-test exporter log means exactly that |
| Grafana 503s | Brief 503s during a pod restart are retried. If they persist, check for `OOMKilled` in `kubectl describe pod -n monitoring -l app.kubernetes.io/name=grafana` |
| Team Grafana folder missing | Check the ConfigMap exists (`kubectl get cm -n monitoring -l grafana_folder`) and the `grafana-sc-dashboard` sidecar is running |

### `team=unknown` on DORA metrics {#symptom-teamunknown-on-dora-prometheus-metrics}

The team couldn't be resolved. Add a `team:<name>` topic to the repo
(`gh repo edit <org>/<repo> --add-topic "team:payments"`) or add it to `TEAM_MAP` —
see [DORA & FinOps](dora-finops.md).

More: [Local Setup — observability](local-setup.md#troubleshooting-observability-after-bootstrap).

---

## AI/ML stack (`bootstrap-ai.sh`)

| Symptom | Fix |
|---|---|
| Agents show `READY=False` | Often transient at startup: `kubectl rollout restart deployment/kagent-controller -n kagent`. Otherwise `kubectl describe agent <name> -n kagent` |
| `*.idp.local` redirects to HTTPS | Browser HSTS cache. Chrome: delete the domain at `chrome://net-internals/#hsts` |
| AI Assistant returns 502 | Check `kubectl get ingress -n kagent`, the `idp-assistant` pod, and the `/etc/hosts` entry for `idp-assistant.idp.local` |
| `idp-mcp-server` / `qa-mcp-server` not deployed | The Helm fallback was interrupted: `helm upgrade --install <name> helm/service-template -n services-dev --values services/<name>/helm-values-local.yaml --wait` |

More in [AI Assistant — Troubleshooting](ai-assistant.md#troubleshooting).

---

## AWS (`bootstrap.sh`) {#phase-4-aws-setup-bootstrapsh}

Always run `./scripts/verify-secrets.sh` first.

### Terraform

| Symptom | Fix |
|---|---|
| `terraform init`: "Backend configuration required" / no bucket / no lock table | `terraform/backend.hcl` (gitignored) hasn't been generated. Run `./scripts/setup.sh` or `bootstrap.sh`, which create the file, the state bucket and the DynamoDB table. Init by hand with `terraform init -backend-config=backend.hcl` |
| `Error acquiring the state lock` | `cd terraform && terraform force-unlock <lock-id>` |
| `NodeCreationFailure` ~20 min in | VPC/quota issue. `availability_zones` needs at least 2 AZs |
| `InsufficientInstanceCapacity` / vCPU limit | Check quota `L-1216C47A` in Service Quotas, or lower `node_group_desired_size` |
| `CreateSecret`: "already scheduled for deletion" | medium/large keep deleted secrets for 7 days. Restore (`aws secretsmanager restore-secret`, then `terraform import`) or purge (`delete-secret --force-delete-without-recovery`) |
| `terraform destroy` fails, or charges continue after teardown | Use `./scripts/cleanup.sh`, never a bare destroy — ALBs, PVC disks and Crossplane resources are not in Terraform state. Read its verification summary |

### Cluster and Backstage

| Symptom | Fix |
|---|---|
| Nodes `NotReady` | Wait ~3 min for IAM propagation; the node role needs `AmazonEKSWorkerNodePolicy`, `AmazonEKS_CNI_Policy`, `AmazonEC2ContainerRegistryReadOnly` |
| ALB stuck `<pending>` > 10 min | Check the `aws-load-balancer-controller` pod and logs; a wrong IRSA trust means Terraform didn't finish — re-run `bootstrap.sh` |
| Backstage `CrashLoopBackOff` | `kubectl get externalsecret -n backstage` (READY=True?), `kubectl get clustersecretstore`, and logs for `YAMLException` |
| ClusterSecretStore `InvalidProviderConfig` | Re-annotate `external-secrets-sa` with `terraform output -raw external_secrets_role_arn`, then restart the `external-secrets` deployments |
| Kubernetes tab 401 | Refresh the token: `kubectl -n backstage create token backstage-sa --duration=8760h`, store it as `K8S_SERVICE_ACCOUNT_TOKEN` in `<cluster>/backstage`, restart Backstage |
| Scaffolder: "requires `--no-node-snapshot`" | `NODE_OPTIONS` must contain both `--no-node-snapshot` and `--require dd-trace/init` |
| `ImagePullBackOff` / `no match for platform` | Built on Apple Silicon: `docker buildx build --platform linux/amd64 … --push` |
| ArgoCD apps all `ComparisonError` | GitHub credentials expired: `argocd repo add https://github.com/<org>/<repo>.git --username … --password <token>` |
| Crossplane providers unhealthy | First pull takes 5–10 min; then check `kubectl describe provider <name>` |
| `bootstrap.sh` interrupted | Fix the cause and re-run it — phases skip what's already done |

### Fixed in earlier versions

If you're on an older checkout, these are already fixed on `main`:

| Symptom | Fixed by |
|---|---|
| Backstage 404 at `/` | `page:catalog: path: /` in `app-config.aws.yaml` |
| Every API call 401, guest login broken | `dangerouslyDisableDefaultAuthPolicy` moved under `backend.auth` |
| ClusterSecretStore can't find `external-secrets-sa` | `bootstrap.sh` creates and annotates the SA |
| DORA dashboard "No data" | Exporter pushes to Pushgateway with the dashboard's metric names |
| hello-service TechDocs 404 | Explicit `url:` techdocs-ref in its `catalog-info.yaml` |
| `idp-services` ApplicationSet never applied | Applied in bootstrap phase 4.6 |
| Tech Radar empty / "not allowed to read" | `backend.reading.allow` for GitHub hosts |
| No public URL for OpenCost / Pushgateway | Intentional: operator tools, reach them with `kubectl port-forward` |

Why each class of AWS failure was possible: [Known Failure Modes](aws-install-failure-modes.md).

---

## Team infrastructure

### Crossplane claim rejected — "owner is required" {#symptom-crossplane-claim-rejected-owner-is-required}

Kyverno's `crossplane-require-cost-tags` policy requires `spec.parameters.owner`
and `spec.parameters.costCenter` on every claim. Add them; during a migration you
can set the policy to `validationFailureAction: Audit` temporarily.

### `idp:team` tag missing on a Crossplane resource

Mutation only runs in `team-*` namespaces and only on claims created after Kyverno
was installed. Check `kubectl get policyreport -n <namespace>`; recreate older claims.

### ExternalSecret: "SecretStore not found: team-<name>-secrets" {#symptom-externalsecret-error-secretstore-not-found-team-secrets}

The team was scaffolded without an IAM role ARN, so no SecretStore was created.
Create the role (`terraform apply -var='team_eso_roles=[{name="<name>",cost_center="CC-1234"}]'`,
then `terraform output team_eso_role_arns`) and re-run the **Provision Team
Namespace** template with the ARN.

### Templates from `all-templates.yaml` not loading (AWS)

The file must be on `main` and readable through the GitHub integration. Check
`kubectl logs -n backstage deploy/backstage | grep -i "all-templates\|location.*error"`.

---

## Still stuck?

Check the [runbooks](runbooks/index.md), then
[open an issue](https://github.com/moatazeldebsy/backstage-platform-template/issues).
