# High CPU Usage Runbook

## Alert Description

**Alert:** `HighCPUUsage`
**Severity:** Warning at 80% of limit for 5 minutes.
**Expression:** Container CPU usage / CPU limit > 80%.

## Impact

The service is CPU-throttled. Requests are slower than normal. Under sustained throttling, health probes may time out and trigger restarts.

## Immediate Actions

### 1. Identify the high-CPU pods

```bash
# Top CPU consumers
kubectl top pods -n services --sort-by=cpu

# Check CPU usage vs limits
kubectl describe pod <pod-name> -n services | grep -A5 "Limits\|cpu"
```

### 2. Check if it's sustained throttling or a spike

```bash
# Grafana: IDP Services → CPU Throttling panel
# Look for cpu_throttled_seconds_total metric
# A short spike is usually a traffic burst; sustained > 5min is a capacity problem
```

### 3. Scale out to reduce per-pod CPU pressure

```bash
kubectl scale deployment/<service-name> -n services --replicas=<current+2>
kubectl get pods -n services -l app.kubernetes.io/instance=<service-name>
```

### 4. Check HPA

```bash
kubectl get hpa -n services
kubectl describe hpa <service-name> -n services
# If HPA exists but isn't scaling: check minReplicas, maxReplicas, and metrics server
kubectl top nodes
```

### 5. Is there a traffic spike? Check the load

```bash
# Look at request rate in Grafana (hello-service dashboard → HTTP RPS panel)
# If yes: scale out and monitor
# If no unexpected traffic: look for a hot loop in application code
```

## Root Cause Analysis

Common causes:
- Legitimate traffic growth (healthy — tune HPA or increase limits)
- CPU-intensive operation introduced in a recent deploy (check `helm history`)
- Infinite loop or hot loop in application code
- Background job / cron running expensive computation
- Excessive logging or serialisation

```bash
# Check if a recent deploy correlated with the CPU spike
helm history <service-name> -n services

# Get a CPU profile if the service exposes pprof (Go services)
kubectl port-forward deployment/<service-name> 6060:6060 -n services &
curl http://localhost:6060/debug/pprof/profile?seconds=30 > cpu.prof
go tool pprof cpu.prof
```

## Resolution Steps

1. Scale out immediately if throttling is causing visible latency
2. If a deploy caused it: roll back (see [Deployment Rollback](deployment-rollback.md))
3. If it's sustained legitimate growth: increase CPU limits in `helm-values.yaml` and/or expand the HPA `maxReplicas`
4. For a code-level fix: capture a CPU profile and share with the service team

## Escalation

- Scaling out doesn't reduce per-pod throttling → CPU limit is too low; increase and open PR
- Cannot identify root cause within 30 min → escalate to service owner

## Post-Incident

- Update `helm-values.yaml` CPU limits to reflect actual peak usage + 20% headroom
- If HPA wasn't scaling: verify `metrics-server` is running and HPA thresholds are sensible
- Document findings in the incident thread
