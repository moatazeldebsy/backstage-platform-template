# Runbooks

Operational procedures for the Internal Developer Platform. Each runbook maps to a Prometheus alert and provides step-by-step remediation guidance.

> **First-time setup issues?** See [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md) — it covers fresh-clone failures like empty catalog, ArgoCD no apps, Backstage port conflicts, and the KAgent HSTS browser issue.

## Alert → Runbook Map

| Alert | Severity | Runbook |
|-------|----------|---------|
| `PodCrashLooping` | Critical | [Pod Crash Loop](pod-crash-loop.md) |
| `HighMemoryUsage` | Warning / Critical | [High Memory](high-memory.md) |
| `HighCPUUsage` | Warning | [High CPU](high-cpu.md) |
| `DeploymentReplicasMismatch` | Warning | [Deployment Rollback](deployment-rollback.md) |
| `HighHTTP5xxRate` | Critical | [Deployment Rollback](deployment-rollback.md) |
| RDS unavailable | Critical | [Database Recovery](db-recovery.md) |
| `ImagePullBackOff` (local) | Warning | [ImagePullBackOff](image-pull-backoff.md) |
| Kind node `NotReady` after crash (local) | Warning | [Kind Node IP Mismatch](kind-node-ip-mismatch.md) |
| Crossplane claim rejected by Kyverno | Warning | [TROUBLESHOOTING.md § Crossplane claim rejected](../TROUBLESHOOTING.md#symptom-crossplane-claim-rejected----owner-is-required) |
| `ExternalSecret` error — SecretStore not found | Warning | [TROUBLESHOOTING.md § ExternalSecret error](../TROUBLESHOOTING.md#symptom-externalsecret-error----secretstore-not-found-team-name-secrets) |
| `team=unknown` on DORA metrics | Info | [TROUBLESHOOTING.md § team=unknown](../TROUBLESHOOTING.md#symptom-teamunknown-on-dora-prometheus-metrics) |

## Local Dev Issues

These are not alert-driven but are common when running the platform locally with Kind or Rancher Desktop.

| Symptom | Runbook |
|---------|---------|
| Node `NotReady` + `*.idp.local` unreachable after Docker/Rancher crash | [Kind Node IP Mismatch](kind-node-ip-mismatch.md) |
| Pod stuck in `ImagePullBackOff` | [ImagePullBackOff](image-pull-backoff.md) |

## On-Call Escalation

1. **L1 — On-call engineer** (Slack alert fires) — follow the runbook, aim to resolve within 30 min
2. **L2 — Platform team** — escalate via Slack `#platform-oncall` if unresolved
3. **L3 — AWS Support** — for infrastructure-level failures (EKS control plane, RDS)

## Incident Process

1. Acknowledge the Slack alert (add 👀 reaction)
2. Open an incident thread in `#incidents` with: service name, start time, symptoms
3. Follow the relevant runbook
4. Post resolution summary + timeline to the incident thread
5. File a post-mortem within 48 hours for P1/P2 incidents
