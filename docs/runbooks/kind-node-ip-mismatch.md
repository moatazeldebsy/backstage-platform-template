# Kind Node IP Mismatch After Crash Runbook

## Symptoms

- One or more nodes stuck in `NotReady` after Docker / Rancher Desktop crash and restart
- Pods stuck in `Terminating` or `Pending` state
- `ingress-nginx` controller unable to schedule a replacement pod — all `*.idp.local` URLs return 502 / unreachable
- `kubectl get nodes` shows a node as `NotReady` even though its Docker container is running
- Kubelet logs inside the node container show repeated connection errors to the old IP:

```
dial tcp 172.18.0.X:6443: connect: connection refused
```

## Root Cause

Kind runs each cluster node as a Docker container. When Docker or Rancher Desktop crashes and restarts, it may reassign container IPs — the control-plane node gets a **different IP** than what is baked into `/etc/kubernetes/kubelet.conf`. The kubelet then cannot reach the API server, so the node reports `NodeStatusUnknown` and stays `NotReady`.

This cascades to:
- Pods that were running on the affected node get evicted and enter `Terminating`
- Replacement pods that require a `NotReady` node (e.g. DaemonSets, ingress with node affinity) stay `Pending`
- inotify resource limits may also be exhausted after the restart, causing kube-proxy to crash

## Diagnosis

### 1. Confirm the IP mismatch

```bash
# Current Docker container IPs
for c in $(docker ps --filter "name=idp-mvp" --format "{{.Names}}"); do
  echo "$c: $(docker inspect $c --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')"
done

# IPs registered in Kubernetes
kubectl get nodes -o wide
```

If the control-plane's Docker IP differs from its `INTERNAL-IP` in kubectl, you have an IP mismatch.

### 2. Confirm the API server cert covers the new IP

```bash
docker exec idp-mvp-control-plane openssl x509 \
  -in /etc/kubernetes/pki/apiserver.crt -noout -ext subjectAltName
```

The new IP must appear in the `IP Address:` list. If it does not, a cluster recreate is required (see **Prevention** below).

### 3. Check kubelet.conf target

```bash
docker exec idp-mvp-control-plane grep server: /etc/kubernetes/kubelet.conf
```

It should match the **current** Docker IP of the control-plane.

## Fix

Replace `172.18.0.NEW` with the current Docker IP of the control-plane container (from step 1 above).

### Step 1 — Update kubelet.conf with the new IP

```bash
NEW_IP=$(docker inspect idp-mvp-control-plane \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')

docker exec idp-mvp-control-plane \
  sed -i "s|https://[0-9.]*:6443|https://${NEW_IP}:6443|g" \
  /etc/kubernetes/kubelet.conf
```

### Step 2 — Restart the kubelet

```bash
docker exec idp-mvp-control-plane systemctl restart kubelet
```

### Step 3 — Wait for the node to recover

```bash
kubectl get nodes -w
# Expect: idp-mvp-control-plane   Ready   control-plane   ...
```

### Step 4 — Fix inotify limits if kube-proxy is crash-looping

```bash
# Check
kubectl get pods -n kube-system -l k8s-app=kube-proxy

# If any pod shows Error / CrashLoopBackOff with "too many open files":
docker exec idp-mvp-control-plane sysctl -w fs.inotify.max_user_instances=1024
docker exec idp-mvp-control-plane sysctl -w fs.inotify.max_user_watches=655360

# Delete the crashing pod so the DaemonSet recreates it
kubectl delete pod -n kube-system <kube-proxy-pod-name>
```

### Step 5 — Verify full cluster health

```bash
# All nodes Ready
kubectl get nodes

# No non-Running pods (excluding expected failures like catalog-exporter)
kubectl get pods -A --no-headers | grep -v Running | grep -v Completed
```

ingress-nginx should reschedule and reach `Running` within ~60 seconds, restoring all `*.idp.local` URLs.

## Known Harmless Failure

`catalog-exporter` in the `monitoring` namespace will stay in `CrashLoopBackOff` whenever Backstage is **not** running via Docker Compose. It tries to reach `backstage.backstage.svc.cluster.local:7007` (in-cluster DNS), which does not exist. Start Backstage to resolve it:

```bash
./scripts/bootstrap-local.sh --start-backstage
```

## Prevention

- **Add a fixed IP subnet to Docker:** configure Docker Desktop / Rancher Desktop to use a stable subnet so container IPs do not change across restarts. Set this in Docker Desktop → Settings → Docker Engine:

  ```json
  {
    "default-address-pools": [
      { "base": "172.18.0.0/16", "size": 24 }
    ]
  }
  ```

  Kind still assigns IPs dynamically within that pool, but stability is improved on clean restarts.

- **Graceful shutdown:** use `./scripts/bootstrap-local.sh --destroy` before shutting down Docker / Rancher Desktop, then re-bootstrap on next use. This avoids IP drift entirely.

- **Cluster recreate (last resort):** if the API server cert does not cover the new IP, recreate the cluster:

  ```bash
  ./scripts/bootstrap-local.sh --destroy
  ./scripts/bootstrap-local.sh --full
  ```

## Related Runbooks

- [Pod Crash Loop](pod-crash-loop.md)
- [ImagePullBackOff](image-pull-backoff.md)
