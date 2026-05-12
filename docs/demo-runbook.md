# IDP MVP — Leadership Demo Runbook

A step-by-step guide for running a 15-minute live demo of the Internal Developer Platform.

---

## Pre-Demo Setup (T-30 min)

Run these steps **before** the audience arrives. All commands from the repo root.

### Step 1 — Build Backstage bundle *(one-time per machine, ~5 min)*

Required once after any backend source change. Skip if the bundle is already built and `dist/bundle.tar.gz` exists.

```bash
cd backstage/app
yarn install
yarn build:backend
cd ../..
```

### Step 2 — Bootstrap the local platform *(~15 min)*

Starts a Kind cluster with nginx, metrics-server, Prometheus/Grafana, ArgoCD, OPA/Gatekeeper, DORA exporter, and deploys `hello-service`.

```bash
./scripts/bootstrap-local.sh
```

Faster option (skips observability — use only if Grafana is not part of the demo):

```bash
./scripts/bootstrap-local.sh --skip-obs
```

### Step 3 — Start Backstage *(~2 min)*

Builds the image, starts Docker Compose, wires nginx routing, seeds QA metrics, and triggers catalog export:

```bash
./scripts/bootstrap-local.sh --start-backstage
```

### Step 4 — Verify everything is green

```bash
# Backstage portal
curl -sf http://localhost:3000 > /dev/null && echo "Backstage OK"

# hello-service in Kind
kubectl rollout status deploy/hello-service -n services --timeout=60s
kubectl get pods -n services

# Grafana
curl -sf http://grafana.idp.local > /dev/null && echo "Grafana OK"
```

### Step 5 — Open browser tabs in advance

| Tab | URL |
|-----|-----|
| Backstage portal | http://backstage.idp.local |
| Backstage catalog | http://backstage.idp.local/catalog |
| Backstage create | http://backstage.idp.local/create |
| Tech Radar | http://backstage.idp.local/tech-radar |
| Grafana — hello-service | http://grafana.idp.local/d/idp-services |
| Grafana — DORA | http://grafana.idp.local/d/dora-metrics-idp |
| ArgoCD | http://argocd.idp.local |

---

## Demo Flow (15 min)

### 1 — Platform Story (2 min)

> **"The platform's job is to turn 'I have an idea' into 'it's running in production' — without the developer needing to know Kubernetes, Terraform, or CI/CD."**

- Open `README.md` or `docs/architecture.md`
- Show the architecture layers: Developer → Backstage → GitHub Actions → Helm → EKS/Kind → CloudWatch/Grafana

### 2 — Developer Portal (3 min)

- Open **Backstage catalog** → show existing services, systems, APIs
- Click **Tech Radar** → highlight ADOPT ring (Go, Python, ArgoCD, Helm, Prometheus) vs TRIAL (OpenTelemetry, KEDA) vs HOLD (Java, Monorepo)
- Point out: "43 entries — this drives technology decisions across all teams"

### 3 — Golden Path Live (4 min)

> **"Watch a developer go from zero to a working service with CI/CD in under 2 minutes."**

- Click **Create** → choose **Node.js Service**
- Fill in: name=`demo-service`, description, owner=`platform-team`
- Submit → show the scaffolded GitHub repo (or show `hello-service` as pre-built output)
- Open the GitHub Actions tab → show CI running (test → build → smoke test)
- Show the generated files: `Dockerfile`, `helm-values-local.yaml`, `catalog-info.yaml`, `ci.yml`

### 4 — Observability (3 min)

> **"Every service gets metrics, dashboards, and alerting pre-wired — zero configuration."**

- Open **Grafana — hello-service** → show HTTP request rate, latency, error rate
- Open **Grafana — DORA** → point to deploy frequency and lead time panels
- Say: "DORA metrics are how we measure platform success — not just uptime"

---

## Key Talking Points

| Theme | Message |
|-------|---------|
| **Developer Experience** | From idea to production without Kubernetes knowledge |
| **Zero Friction** | Bootstrap runs on a laptop — no AWS account needed for local demo |
| **Consistency** | 8 golden-path templates, one Helm chart, one CI pattern |
| **Observability First** | Prometheus + Grafana + DORA metrics are defaults, not afterthoughts |
| **Platform KPIs** | DORA metrics track platform impact — deploy frequency, lead time, CFR, MTTR |
| **Tech Radar** | Drives technology standardisation — 43 entries across adopt/trial/assess/hold |

---

## Fallback Options

| What breaks | Fallback |
|-------------|----------|
| Backstage won't start | Show the GitHub repo directly + CI results |
| Kind cluster not ready | Use screenshots of Grafana dashboards; explain architecture verbally |
| Scaffold fails | Show pre-scaffolded `hello-service` as the reference output |
| Grafana blank | Say "data populates once services send traffic" — show the dashboard structure |

---

## Teardown

```bash
./scripts/bootstrap-local.sh --destroy
docker compose -f local/backstage/docker-compose.yml down -v
```
