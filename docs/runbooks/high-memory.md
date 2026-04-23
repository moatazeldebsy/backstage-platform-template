# High Memory Usage Runbook

## Alert Description

**Alert:** `HighMemoryUsage`
**Severity:** Warning at 80% of limit, Critical at 95%
**Expression:** Container memory usage / memory limit > threshold for 5 minutes.

## Impact

- **Warning (80%):** Service is approaching its limit. Risk of OOMKill if load increases.
- **Critical (95%):** OOMKill is imminent. Pod may be killed and restarted at any moment.

## Immediate Actions

### 1. Identify the high-memory pods

```bash
# Top memory consumers in services namespace
kubectl top pods -n services --sort-by=memory

# Check memory usage vs limits
kubectl describe pod <pod-name> -n services | grep -A5 "Limits\|Requests\|Memory"
```

### 2. Check for a memory leak pattern

```bash
# Is memory climbing steadily (leak) or spiked (load)?
# Check the Grafana dashboard: IDP Services → memory graph
# Look for a sawtooth pattern (GC) vs a steady upward slope (leak)
kubectl top pods -n services -l app.kubernetes.io/instance=<service-name> --containers
```

### 3. Scale out to reduce per-pod pressure (immediate relief)

```bash
# Scale up replicas
kubectl scale deployment/<service-name> -n services --replicas=<current+2>

# Verify pods are running
kubectl get pods -n services -l app.kubernetes.io/instance=<service-name>
```

### 4. If HPA is configured — check its status

```bash
kubectl get hpa -n services
kubectl describe hpa <service-name> -n services
```

### 5. Increase memory limit (temporary emergency fix)

```bash
kubectl set resources deployment/<service-name> \
  -n services \
  --limits=memory=<new-limit>Mi \
  --requests=memory=<new-request>Mi
```

Update `helm-values.yaml` with the new values and open a PR to make this permanent.

## Root Cause Analysis

```bash
# Check if recent deploy introduced the memory growth
helm history <service-name> -n services

# Compare memory usage before/after the deploy time in Grafana
# Panel: "Container Memory Usage" → annotate with deploy timestamp
```

Common causes:
- Memory leak in application code (objects not released)
- Unbounded in-memory cache or queue
- Too many goroutines / threads accumulating
- JVM heap not tuned (Java services)

## Resolution Steps

1. Scale out immediately if at critical threshold
2. If a specific deploy caused the spike: roll back (see [Deployment Rollback](deployment-rollback.md))
3. If it's a gradual leak: page the service owner to profile and fix
4. Update `helm-values.yaml` with a higher memory limit as a short-term mitigation
5. Track the fix in a GitHub issue labelled `memory-leak`

## Escalation

- Critical and scaling out doesn't help → page service owner immediately
- Service is OOMKilled in a loop → follow [Pod Crash Loop](pod-crash-loop.md) runbook

## Post-Incident

- Add memory profiling results to the incident thread
- Verify memory limits in `helm-values.yaml` reflect actual usage patterns + 30% headroom
- Consider adding memory-based HPA if load is bursty
