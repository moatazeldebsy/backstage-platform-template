# ml-platform resilience (raac)

`raac.yaml` files declaring what ai-gateway and LiteLLM must tolerate, checked, generated and tested by [raac](https://github.com/moatazeldebsy/raac) v0.2.1+ (v0.2.0 generates latency chaos that never takes effect). The manifests they are checked against live in `kubernetes/ml-platform/`.

This folder is deliberately outside `kubernetes/`: `raac-generated/chaos/` holds Chaos Mesh experiments, and those must never be picked up by ArgoCD or a `kubectl apply -R`.

| File | What it says |
|---|---|
| `ai-gateway/raac.yaml` | 2 replicas + PDB; depends on LiteLLM (120s); SLO 99% available and p95 within 5s, measured from agentgateway's own metrics; two chaos scenarios |
| `litellm/raac.yaml` | 2 replicas + PDB; depends on the Anthropic API (external). No SLO: this LiteLLM version only serves `/metrics` with a key, so LiteLLM is tested from ai-gateway's side |

## Check and generate (no cluster)

```bash
raac check resilience --manifests kubernetes/ml-platform
raac generate resilience --manifests kubernetes/ml-platform
```

`check` currently reports 4 errors, and they are real: ai-gateway and LiteLLM each run 1 replica with no PodDisruptionBudget, so a node drain or a single pod crash takes model traffic down. (AWS has `aws/ml-platform/litellm-pdb.yaml`; local does not.)

`raac-generated/deploy/` holds the PDBs and a Sloth SLO for ai-gateway. Nothing applies them yet; wire them in once the replica counts are raised.

## Test (local Kind cluster)

`raac test` breaks LiteLLM on purpose while sending traffic through ai-gateway, then asks Prometheus whether ai-gateway's SLO held.

Traffic asks for the `raac-test` model, which LiteLLM answers by itself (`mock_response` in `kubernetes/ml-platform/litellm.yaml`): **no Anthropic calls, no cost, no API key needed.**

1. **AI stack up**, including LiteLLM: `./scripts/bootstrap-ai.sh` (not `--skip-litellm`). If LiteLLM was already running before the `raac-test` model was added, reload its config:
   ```bash
   kubectl apply -f kubernetes/ml-platform/litellm.yaml
   kubectl -n ml-platform rollout restart deployment/litellm
   ```
2. **Chaos Mesh**, once per cluster (Kind runs containerd):
   ```bash
   helm repo add chaos-mesh https://charts.chaos-mesh.org
   helm upgrade --install chaos-mesh chaos-mesh/chaos-mesh -n chaos-mesh --create-namespace --version 2.8.8 \
     --set chaosDaemon.runtime=containerd --set chaosDaemon.socketPath=/run/containerd/containerd.sock
   ```
3. **Smoke test the route** (should print a message containing `pong`):
   ```bash
   kubectl -n ml-platform run raac-smoke --rm -i --restart=Never --image=curlimages/curl:8.11.1 -- \
     curl -s http://ai-gateway.ml-platform.svc:3000/v1/messages -H 'Content-Type: application/json' \
     -d '{"model":"raac-test","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}'
   ```
4. **Plan, then run** (about 5½ minutes):
   ```bash
   raac test resilience --manifests kubernetes/ml-platform --context kind-idp-mvp \
     --prometheus-service monitoring/prometheus-kube-prometheus-prometheus:9090 --dry-run
   raac test resilience --manifests kubernetes/ml-platform --context kind-idp-mvp \
     --prometheus-service monitoring/prometheus-kube-prometheus-prometheus:9090
   ```
   Use your own context name if `CLUSTER_NAME` isn't `idp-mvp`.

### What to expect

| Window | Expected | Why |
|---|---|---|
| `baseline` | pass | the mock answers in well under a second |
| `slow-litellm` (+2s to every LiteLLM call) | pass | the gateway still answers inside 5s and doesn't time out |
| `kill-litellm-pod` | **fail** | LiteLLM runs one replica, so killing it means 5xx until the new pod is ready |

The failure is the point: it goes green once LiteLLM runs 2 replicas behind a PDB, which is what `check` already asks for.

`raac test` removes every experiment and load Job it created when it ends, including on errors and Ctrl-C. If a run is killed hard, `raac test --cleanup --context kind-idp-mvp` removes the leftovers.
