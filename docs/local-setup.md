# Local Setup (Kind)

Run the full platform on your laptop. No AWS account needed.

## Prerequisites

```bash
brew install kind kubectl helm docker
kind version    # >= 0.27
helm version    # >= 3.14
docker info     # Docker running
```

The cluster is pinned to Kubernetes 1.33.1 (`kindest/node:v1.33.1`). Rancher
Desktop also works: disable Traefik, use the dockerd engine, and set
`KUBERNETES_PROVIDER=rancher-desktop` in `local/.env`.

## Machine requirements — and what to do if you don't have them {#machine-requirements-and-what-to-do-if-you-dont-have-them}

Measured with `kubectl top` on an 8 CPU / 13 GB VM:

| Layer | Installed by | CPU | Memory |
|---|---|---:|---:|
| Kubernetes itself (`kube-system`, ingress, storage) | always | ~630m | ~1.5 GB |
| Observability (Prometheus, Grafana, OpenCost) | `bootstrap-local.sh` | ~280m | ~1.2 GB |
| GitOps + policy (ArgoCD, Kyverno, Gatekeeper, Argo Rollouts) | `bootstrap-local.sh` | ~170m | ~1.1 GB |
| Services + MCP servers (`services-dev`) | `bootstrap-local.sh` | ~105m | ~0.35 GB |
| VM overhead | — | — | ~2.3 GB |
| **Langfuse (6 pods)** | `bootstrap-ai.sh` | ~400m | **~2.2 GB** |
| KAgent runtime + 1 agent | `bootstrap-ai.sh` | ~40m | ~0.5 GB |
| ↳ each additional agent | `--agents` | ~5m | ~200 MB |
| MLflow | `bootstrap-ai.sh` | ~50m | ~0.4 GB |
| LiteLLM | `bootstrap-ai.sh` | 150m req. | 768 Mi req. |
| Argo Workflows | `bootstrap-ai.sh` | ~30m | ~0.15 GB |

Loki, Promtail and Tempo are installed but scaled to zero — see
[below](#loki-and-tempo-ship-disabled). Prometheus keeps 24 hours of history locally.

### Adding it up

| Selection | Memory | Fits in a 13 GB VM? |
|---|---:|---|
| Core only (`bootstrap-local.sh`) | ~6.9 GB | yes |
| \+ Langfuse | ~9.1 GB | yes |
| \+ Langfuse + KAgent with 1 agent | ~9.6 GB | yes, ~3.3 GB spare |
| Everything (all agents, MLflow, Argo Workflows) | ~11.8 GB | **no** — too little headroom |

### VM sizing

Set this in Docker Desktop → Settings → Resources (or Rancher Desktop → Virtual
Machine). The VM gets about 80% of physical RAM.

| Setup | VM CPU | VM memory | Physical RAM |
|---|---:|---:|---:|
| Everything | 8 | 16 GB | 24 GB |
| Full stack without Langfuse (`--skip-langfuse`) | 8 | 13 GB | 16 GB |
| Core + one AI component | 8 | 13 GB | 16 GB |
| Without AI/ML | 4 | 8 GB | 12 GB |
| Core only (`--skip-obs --skip-policies`) | 2 | 6 GB | 8 GB |

**A 16 GB Mac can't run the full platform.** Install a subset instead.
`kubectl get nodes` reports the whole VM against each Kind node, so two nodes on a
12 GB VM look like 24 GB; they aren't.

**Warning signs:** watch *available* memory (`docker exec idp-mvp-worker free -m`).
Below ~1.5 GB, stop adding components; below ~200 MB, etcd and the API server
time out and every `*.idp.local` URL fails. Sustained CPU above ~75% of the VM
leaves pods stuck in `Terminating` and controllers crash-looping on liveness
probes. CPU is the limit during install, memory at rest, so install incrementally
on a tight machine.

### Running on less

```bash
./scripts/bootstrap-local.sh                         # skip bootstrap-ai.sh entirely: saves ~3.2 GB
./scripts/bootstrap-ai.sh --skip-langfuse            # the most expensive AI piece: saves ~2.2 GB
./scripts/bootstrap-ai.sh --agents idp               # one agent pod (--agents list, all, none)
./scripts/bootstrap-local.sh --skip-obs              # no metrics stack: saves ~1.6 GB (Grafana/DORA/FinOps tabs go blank)
./scripts/bootstrap-local.sh --skip-policies         # no Kyverno/Gatekeeper: saves ~0.6 GB
./scripts/bootstrap-local.sh --skip-obs --skip-policies --skip-dora   # leanest: Backstage + ArgoCD + hello-service
```

`bootstrap-ai.sh` installs six agents by default (`idp`, `qa`, `release`, `cost`,
`platform`, `contract`); `incident`, `security` and `onboarding` need
`--agents all` or an explicit list. `--agents` **prunes**: re-running with a
shorter list removes the others. If memory is tight, drop Langfuse before
LiteLLM — without LiteLLM, agents can call tools but get no model replies.

### Loki and Tempo ship disabled

They run zero pods locally because a single-node Kind cluster already overcommits
CPU, and adding them starves the control plane. To enable them, give the VM more
resources first, then:

| Component | Where | Change |
|---|---|---|
| Tempo | `local/observability/tempo/tempo-values.yaml` | `replicas: 0` → `1` |
| Promtail | `local/observability/loki/promtail-values.yaml` | delete the `nodeSelector: {idp/disabled}` block |
| Loki | `scripts/bootstrap-local.sh` (step 5c) | remove the `kubectl scale statefulset loki --replicas=0` line |

## Bootstrap (~10–15 min)

**First time, run only `setup.sh`** and choose "local":

```bash
./scripts/setup.sh
```

It personalises the placeholders, creates the `.env` files, runs
`bootstrap-local.sh` and offers to start Backstage. Use `bootstrap-local.sh`
directly only for day-2 work, such as recreating the cluster after `--destroy`:

```bash
./scripts/bootstrap-local.sh                  # cluster + platform
./scripts/bootstrap-local.sh --full           # + Backstage in one go
./scripts/bootstrap-local.sh --start-backstage
```

It creates a local registry (`localhost:5003`), the Kind cluster, namespaces and
RBAC, nginx ingress, metrics-server, Prometheus/Grafana/Alertmanager, OpenCost,
ArgoCD, Gatekeeper and Kyverno, the Pushgateway and exporter CronJobs, and the
`idp-services` ApplicationSet, which deploys `hello-service`, `idp-mcp-server` and
`qa-mcp-server` to `services-dev`. It also writes the `*.idp.local` entries to
`/etc/hosts`. All flags are in the [Scripts Reference](scripts-reference.md).

### Environment files

`setup.sh` creates both from their `.env.example` files:

| File | Fill in |
|---|---|
| `local/.env` | `GITHUB_TOKEN`; for AI, `ANTHROPIC_API_KEY` (and optionally `OPENAI_API_KEY`) |
| `local/backstage/.env` | `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET` for GitHub sign-in |

`K8S_*`, `ARGOCD_AUTH_TOKEN` and `GRAFANA_TOKEN` are filled in by the bootstrap.

## Start Backstage

```bash
./scripts/bootstrap-local.sh --start-backstage
```

Builds the image, starts Docker Compose, wires the ingress to the container,
triggers a catalog export and prints every URL. Open
**http://backstage.idp.local** (not `localhost:3000` — GitHub sign-in only works
on the configured base URL).

After changing code under `backstage/app/packages/`, run the same command again;
config-only changes need just `docker compose -f local/backstage/docker-compose.yml restart backstage`.
If you restart Docker Compose yourself, `--update-backstage-ip` rewires the ingress.

## Access services

| Service | URL | Credentials |
|---------|-----|-------------|
| Backstage | http://backstage.idp.local | guest or GitHub |
| hello-service | http://hello-service.idp.local | — |
| Grafana | http://grafana.idp.local | `admin` / `admin` |
| ArgoCD | http://argocd.idp.local | `admin` / see below |
| Prometheus · Alertmanager | http://prometheus.idp.local · http://alertmanager.idp.local | — |
| Argo Rollouts | http://argo-rollouts.idp.local | — |
| OpenCost · Pushgateway | http://opencost.idp.local · http://pushgateway.idp.local | — |
| KAgent UI | http://kagent.idp.local | AI stack |
| AI Gateway console | http://ai-gateway.idp.local | AI stack |
| LiteLLM | http://litellm.idp.local | AI stack |
| Langfuse | http://langfuse.idp.local | AI stack; password in the `langfuse-init` Secret |
| MLflow | http://mlflow.idp.local | AI stack |
| MCP servers | `http://<name>-mcp-server.idp.local/healthz` | AI stack |
| Approval Service · Event Router | http://approval-service.idp.local · http://agent-event-router.idp.local | `bootstrap-ai.sh --adp` |
| Local registry | `localhost:5003` | — |

AI pages in Backstage stay hidden until `bootstrap-ai.sh` has run — see
[why](ai-assistant.md#where-the-ai-pages-come-from-and-why-theyre-hidden).

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

## Optional third-party integrations

**No third-party account is required.** Each integration fails soft: the tab shows
an empty state instead of an error. Set credentials in `local/backstage/.env`
locally (documented in `.env.example`), or in Secrets Manager on AWS.

| Integration | What you need | Without it |
|---|---|---|
| **GitHub** | `GITHUB_TOKEN` (scopes `repo`, `read:org`, `workflow`, `delete_repo`) | No catalog import or scaffolding to real repos. The one worth setting |
| GitHub OAuth | `AUTH_GITHUB_CLIENT_ID` / `_SECRET` | Guest mode only |
| SonarCloud / Snyk | `SONAR_TOKEN` / `SNYK_TOKEN` | Security tab empty; scaffolded CI skips those steps |
| Datadog | `DD_API_KEY` + `DD_APP_KEY` | Datadog tab empty |
| PagerDuty | `PAGERDUTY_TOKEN` | On-Call tab empty |
| Jira | `JIRA_URL` + `JIRA_TOKEN` = base64(`email:api_token`) | Jira tab empty |
| Voyage AI | `VOYAGE_API_KEY` | `/ai-search` returns 503 |
| Firebase Test Lab | `GCP_SERVICE_ACCOUNT_KEY` | Mobile test templates scaffold, but their CI can't authenticate |
| LambdaTest / BrowserStack / Sauce Labs | `LT_*` / `BROWSERSTACK_*` / `SAUCE_*` | Device-farm CI can't authenticate |

## Deploy a service

Scaffold one from **Create** in Backstage (or with `idp scaffold service --name my-svc --type nodejs`;
add `--local` to generate offline). Merged GitOps changes are deployed by ArgoCD.

To deploy an image by hand, push it to the local registry and run the
**Deploy Service to local Kind cluster** template, or:

```bash
docker build -t localhost:5003/<name>:latest services/<name> && docker push localhost:5003/<name>:latest
helm upgrade --install <name> ./helm/service-template -n services --create-namespace \
  --set image.repository=localhost:5003/<name> --set image.tag=latest \
  --values services/<name>/helm-values-local.yaml
```

### Local vs AWS

| Concern | Local | AWS |
|---------|-------|-----|
| Ingress | `nginx`, `*.idp.local` | `alb` (off by default for scaffolded services) |
| Images | `localhost:5003/<name>` | ECR `<cluster>/<name>` |
| CD trigger | ArgoCD / `idp:deploy-local` | CI push to ECR + ArgoCD |
| Values file | `helm-values-local.yaml` | `helm-values-aws.yaml` |

The Helm chart (`helm/service-template`) is the same on both.

## AI/ML stack (optional)

```bash
./scripts/bootstrap-ai.sh   # needs ANTHROPIC_API_KEY in local/.env
```

Installs KAgent and its agents, the eight MCP servers behind the AI Gateway,
LiteLLM, Langfuse, MLflow and Argo Workflows. Then restart Backstage
(`--start-backstage`) to reveal the AI pages. Skip flags and agent selection are
covered [above](#running-on-less) and in the [Scripts Reference](scripts-reference.md#bootstrap-aish-flags);
usage is in [AI Assistant](ai-assistant.md). Remove just the AI layer with
`./scripts/bootstrap-ai.sh --destroy`.

## Troubleshooting observability after bootstrap

| Symptom | Fix |
|---|---|
| DORA metrics missing | The exporter runs every 15 min: `kubectl create job dora-now --from=cronjob/dora-exporter -n monitoring` |
| K8s tab shows "unknown" CPU/memory | `kubectl get pods -n kube-system \| grep metrics-server`; `kubectl top nodes` |
| `catalog-exporter` crash-loops | Expected while Backstage is down; start it |

Everything else: [Troubleshooting](TROUBLESHOOTING.md).

## Teardown

```bash
./scripts/bootstrap-local.sh --destroy
```

In order: removes the AI layer, cleans up scaffolded services (deletes their
ArgoCD apps and Helm releases, removes `services/<name>/` and commits), deletes
the cluster, stops and prunes the Docker Compose stack, and removes the
`/etc/hosts` entries. `kubernetes/teams/`, scaffolded GitHub repos and
`test-suites/` are left alone.
