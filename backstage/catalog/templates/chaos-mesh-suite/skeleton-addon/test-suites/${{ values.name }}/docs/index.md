# ${{ values.name }}

${{ values.description }}

## Overview

Chaos Mesh resilience experiment suite for **${{ values.targetService }}** in namespace `${{ values.namespace }}`.

| Parameter | Value |
|-----------|-------|
| Target namespace | `${{ values.namespace }}` |
| Duration | `${{ values.duration }}` per experiment |

## Experiments

| Experiment | Type | What it tests |
|-----------|------|--------------|
| pod-failure | PodChaos | Service recovers when a pod is killed |
| network-latency | NetworkChaos | Service handles 100ms+ network delay |
| cpu-stress | StressChaos | Service remains responsive under CPU pressure |
| memory-stress | StressChaos | Service handles memory pressure gracefully |

## Running

Experiments are triggered manually via `workflow_dispatch` in GitHub Actions, or on a weekly schedule (Wednesday 03:00 UTC). They require a `KUBECONFIG` secret with access to the target cluster and Chaos Mesh installed.

## Safety

Always run chaos experiments in a non-production environment first. The experiments auto-cleanup after the configured duration. The CI workflow also runs `kubectl delete -f experiments/` in an `if: always()` step as a safety net.
