# Chaos Engineering Suite (Chaos Mesh)

Scaffold Chaos Mesh experiment definitions for resilience testing — pod failure, network latency, and stress scenarios

## How to use

1. Open Backstage → **Create**
2. Find **Chaos Engineering Suite (Chaos Mesh)** and click **Choose**
3. Fill in the required parameters and click **Create**

## After scaffolding: give it a cluster

Chaos experiments need a cluster to run against. Until one is configured, CI stays
green and shows a notice, *"Chaos experiments skipped: No cluster configured"*,
instead of failing.

Add either a **`KUBECONFIG`** secret (base64-encoded kubeconfig) or
**`EKS_CLUSTER_NAME`** + **`AWS_REGION`** secrets, then re-run the workflow.

## Source

Template definition: [`template.yaml`](../template.yaml)
