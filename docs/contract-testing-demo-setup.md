# Contract Testing Demo Setup Guide

A reproducible guide for spinning up the full contract testing demo environment from scratch. Follow this if you are presenting at a conference, running a team workshop, or want to reproduce the demo on a new machine.

**Time to first demo-ready state: ~25 minutes** (assuming fast internet and Docker already running).

---

## Prerequisites

Install these tools before starting:

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | 4.x+ | https://www.docker.com/products/docker-desktop |
| Kind | 0.20+ | `brew install kind` |
| kubectl | 1.28+ | `brew install kubectl` |
| Helm | 3.12+ | `brew install helm` |
| Node.js | 20+ | `brew install node@20` |
| curl | any | pre-installed on macOS/Linux |

> **Rancher Desktop alternative**: Works too. In Preferences → Kubernetes, disable Traefik (nginx-ingress needs ports 80/443). Set Container Engine to `dockerd`.

**Memory**: Allocate at least **8 GB RAM** to Docker Desktop (Preferences → Resources). The full stack uses ~6 GB at rest.

---

## Step 1: Clone the Repository

```bash
git clone https://github.com/moatazeldebsy/backstage-platform-template.git
cd backstage-platform-template
```

---

## Step 2: Add Local DNS Entries

The IDP uses `.idp.local` hostnames. Append them to `/etc/hosts` (requires sudo):

```bash
sudo bash -c "cat local/hosts-append.txt >> /etc/hosts"
```

This adds entries like:
```
127.0.0.1  backstage.idp.local
127.0.0.1  argocd.idp.local
127.0.0.1  contract-mcp-server.idp.local
127.0.0.1  payments-api.idp.local
# ... and more
```

Verify: `ping -c 1 backstage.idp.local` should resolve to `127.0.0.1`.

---

## Step 3: Bootstrap the Local Cluster

This creates a Kind cluster and installs the core IDP platform (nginx ingress, ArgoCD, Prometheus, Backstage):

```bash
./scripts/bootstrap-local.sh --full
```

This takes **10–15 minutes**. The `--full` flag runs cluster creation + platform install + Backstage in one shot.

**What gets installed:**
- Kind cluster (`idp-mvp`)
- nginx ingress controller
- ArgoCD (accessible at `http://argocd.idp.local`)
- Prometheus + Grafana (accessible at `http://grafana.idp.local`)
- Backstage (accessible at `http://backstage.idp.local`)

**Verify when done:**
```bash
./scripts/bootstrap-local.sh --print-urls
curl http://backstage.idp.local/healthcheck  # should return {"status":"ok"}
```

---

## Step 4: Deploy the Contract Testing Stack

Install the AI/MCP components including `contract-mcp-server` and the `contract-assistant` KAgent:

```bash
./scripts/bootstrap-ai.sh
```

This takes **5–8 minutes** and:
- Builds the `contract-mcp-server` Docker image
- Deploys it to the `services-dev` namespace
- Installs KAgent CRDs and the Helm chart
- Registers the `contract-mcp-server` as a `RemoteMCPServer`
- Deploys the `contract-assistant` KAgent agent

**Verify when done:**
```bash
curl http://contract-mcp-server.idp.local/healthz
# Expected: {"status":"ok","version":"2.0.0","storageType":"memory","discoveryMode":"kubernetes"}

kubectl get agents -n kagent
# Expected: contract-assistant   READY=True
```

---

## Step 5: Deploy the Demo Service (payments-api)

The `payments-api` is the demo provider service. Deploy it:

```bash
helm upgrade --install payments-api ./helm/service-template \
  -n services-dev \
  -f ./services/payments-api/helm-values-local.yaml \
  --create-namespace
```

**Verify when done:**
```bash
curl http://payments-api.idp.local/healthz
# Expected: {"status":"ok"}

curl http://payments-api.idp.local/openapi.json | python3 -m json.tool | head -20
# Expected: OpenAPI 3.1.0 spec with payments-api info
```

---

## Step 6: Register the payments-api Contract

Register the live contract in the IDP registry (the ArgoCD PostSync hook does this automatically after every deploy, but run it manually now for the first time):

```bash
curl -X POST http://contract-mcp-server.idp.local/api/contracts/payments-api/1.0.0 \
  -H "Content-Type: application/json" \
  -d "$(curl -s http://payments-api.idp.local/openapi.json)"
```

**Expected response:**
```json
{"registered":true,"service":"payments-api","version":"1.0.0","pathCount":6,"timestamp":"..."}
```

**Verify registration:**
```bash
curl http://contract-mcp-server.idp.local/api/contracts
# Expected: [{"serviceName":"payments-api","versions":["1.0.0"],...}]

curl http://contract-mcp-server.idp.local/api/can-i-deploy/payments-api/1.0.0
# Expected: {"safe":true,"service":"payments-api","blockingConsumers":[],...}
```

---

## Step 7: Open the Required Browser Tabs

Open these tabs before the demo. Load them in order — the first load may be slow as services warm up:

| Tab | URL | Used in |
|-----|-----|---------|
| Backstage home | `http://backstage.idp.local` | Beat 2 |
| Backstage Create | `http://backstage.idp.local/create` | Beat 2 |
| AI Assistant | `http://backstage.idp.local/ai-assistant` | Beats 2, 3, 3b |
| ArgoCD | `http://argocd.idp.local` | Beat 3 (if showing deploy gate) |
| payments-api spec | `http://payments-api.idp.local/openapi.json` | Beat 3 (break it here) |

ArgoCD default credentials: user `admin`, password from:
```bash
kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d
```

---

## Step 8: Verify the Full Demo Flow

Run through this checklist before going on stage:

- [ ] `curl http://contract-mcp-server.idp.local/healthz` → `{"status":"ok"}`
- [ ] `curl http://payments-api.idp.local/openapi.json` → full OpenAPI spec
- [ ] `curl http://contract-mcp-server.idp.local/api/contracts` → includes `payments-api`
- [ ] `curl http://contract-mcp-server.idp.local/api/can-i-deploy/payments-api/1.0.0` → `{"safe":true,...}`
- [ ] AI Assistant → `contract-assistant` responds → ask *"List all registered contracts"* → `payments-api` listed
- [ ] Backstage Create page shows **Enable Contract Testing** and **Contract Testing Suite** templates

If any check fails, see the [Troubleshooting section](contract-testing.md#troubleshooting) in the main guide.

---

## Demo Flow Reference

With the environment ready, follow the [Shift-Left Demo Cheatsheet](shift-left-demo-cheatsheet.md) Beat 3 for the full presenter script. The key sequence is:

1. **List contracts** via AI Assistant → show `payments-api` registered
2. **`can-i-deploy` check** → `safe: true`
3. **Break the API** → remove `currency` from `Account` model in `services/payments-api/src/main.py`
4. **Show PR comment** from `contract-check.yml` → breaking change detected
5. **`can-i-deploy` check** → `safe: false`
6. **Revert** → `safe: true` again

---

## Tear Down

To remove everything when done:

```bash
# Remove AI/ML stack only (keeps core cluster)
./scripts/bootstrap-ai.sh --destroy

# Remove the entire cluster
./scripts/bootstrap-local.sh --destroy

# Clean Docker resources
./scripts/bootstrap-local.sh --clean-docker
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `contract-mcp-server.idp.local` does not resolve | Re-run `sudo bash -c "cat local/hosts-append.txt >> /etc/hosts"` |
| `contract-mcp-server` returns 502 | Pod not ready — `kubectl get pods -n services-dev` then `kubectl logs -n services-dev deployment/contract-mcp-server` |
| `payments-api` OpenAPI returns 404 | Service not deployed or wrong ingress — `kubectl get ingress -n services-dev` |
| Backstage 500 after rebuild | Run `docker compose -f local/backstage/docker-compose.yml up -d backstage` |
| `contract-assistant` READY=False | `kubectl rollout restart deployment/kagent-controller -n kagent` |
| AI Assistant shows no agents | Run `scripts/bootstrap-ai.sh` to redeploy KAgent and register agents |

For more troubleshooting, see the [full guide](contract-testing.md#troubleshooting).
