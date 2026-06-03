# Docker Desktop Recovery

When Docker Desktop restarts on macOS (update, crash, or sleep/wake), it shuffles the IP addresses assigned to Kind containers. This breaks `/etc/hosts` resolution, ingress routing, kubeconfig, and Backstage.

The `recover-docker-restart.sh` script automates the full recovery sequence.

---

## Symptoms

After Docker Desktop restarts you may see:

- `curl http://backstage.idp.local` → `Could not resolve host`
- `kubectl get pods` → `Unable to connect to the server`
- ArgoCD, Grafana, Prometheus — all returning `Connection refused`
- Kind nodes in `NotReady` state

---

## Recovery

```bash
# Full automated recovery (~2–3 minutes)
./scripts/recover-docker-restart.sh

# Skip Backstage Docker Compose restart (faster if Backstage is already up)
./scripts/recover-docker-restart.sh --skip-backstage

# Dry-run: print steps without executing
./scripts/recover-docker-restart.sh --dry-run
```

### What the script fixes

The script applies fixes in order:

| Step | Fix | Why |
|---|---|---|
| 1 | Patch `kubelet.conf` with the new API server IP | Kind's API server IP changes on restart |
| 2 | Restart `kindnet` and `kube-proxy` DaemonSets | Pod network routes become stale |
| 3 | Replace `ingress-nginx` pods | Nginx binds to the old node IP at startup |
| 4 | Fix Grafana PVC permissions | `chmod 700` on Grafana data subdirs (often reset after volume remount) |
| 5 | Patch Prometheus operator liveness probe | Operator may fail health checks on new IP |
| 6 | Restart Backstage Docker Compose stack | Backstage proxy config references cluster IP |
| 7 | Smoke-test all service URLs | Confirms recovery: Backstage, Grafana, ArgoCD, Prometheus, hello-service, and MCP servers |

---

## Manual Recovery (if the script fails)

If `recover-docker-restart.sh` fails on a specific step, you can run that step manually:

```bash
# 1. Get new Kind node IP
CLUSTER_IP=$(docker inspect idp-control-plane --format '{{.NetworkSettings.Networks.kind.IPAddress}}')

# 2. Update kubeconfig
kubectl config set-cluster kind-idp --server=https://${CLUSTER_IP}:6443

# 3. Restart ingress-nginx
kubectl rollout restart deployment/ingress-nginx-controller -n ingress-nginx

# 4. Restart Backstage
docker compose -f local/backstage/docker-compose.yml restart backstage

# 5. Verify
curl -s http://backstage.idp.local | grep -c "Backstage"
```

---

## Preventing IP Drift

Docker Desktop does not guarantee stable container IPs across restarts. There is no permanent fix, but you can reduce the frequency of disruption:

- Use **Rancher Desktop** (k3s) instead of Kind — Rancher Desktop uses a VM with a stable IP. Set `KUBERNETES_PROVIDER=rancher-desktop` in `local/.env`.
- Enable **"Use Rosetta for x86/amd64 emulation"** in Docker Desktop settings on Apple Silicon — this reduces the chance of crashes that trigger restarts.
- Prefer **sleep** over **restart** when taking breaks; sleep preserves container IPs.

---

## Related

- [Local Setup](local-setup.md) — initial cluster setup
- [Runbooks: Kind Node IP Mismatch](runbooks/kind-node-ip-mismatch.md) — deeper diagnosis for persistent IP-mismatch issues
- [TROUBLESHOOTING](TROUBLESHOOTING.md) — general troubleshooting checklist
