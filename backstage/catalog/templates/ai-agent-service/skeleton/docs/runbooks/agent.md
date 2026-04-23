# ${{ values.name }} Agent Runbook

## Overview

**Service:** ${{ values.name }}  
**Owner:** ${{ values.owner }}  
**Cost Center:** ${{ values.costCenter }}  
**Repository:** https://github.com/${{ values.githubOrg }}/${{ values.repoName }}  
**LLM:** `${{ values.llmProvider }} / ${{ values.llmModel }}`

---

## Health Checks

```bash
# Check pod status
kubectl get pods -n services -l app.kubernetes.io/name=${{ values.name }}

# Check liveness
kubectl exec -n services deploy/${{ values.name }} -- wget -qO- http://localhost:${{ values.port }}/healthz

# Check readiness
kubectl exec -n services deploy/${{ values.name }} -- wget -qO- http://localhost:${{ values.port }}/ready

# View recent logs
kubectl logs -n services deploy/${{ values.name }} --tail=100 -f
```

---

## Test the Agent

```bash
curl -X POST http://${{ values.name }}.idp.local/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello, what can you do?", "session_id": "test-01"}'
```

---

## Common Issues

### Pod CrashLoopBackOff

1. Check logs: `kubectl logs -n services deploy/${{ values.name }} --previous`
2. Verify LLM env vars are set: `kubectl describe pod -n services -l app.kubernetes.io/name=${{ values.name }}`
3. For Ollama: confirm `ollama pull ${{ values.llmModel }}` has run and the model is available.

### Agent Returns Errors / Tool Failures

1. Check MLflow for trace details: [http://mlflow.idp.local](http://mlflow.idp.local)
2. Check Prometheus metrics: `agent_invocations_total{status="error"}`
3. View tool-call breakdown in Grafana: [http://grafana.idp.local/d/idp-ai-agent](http://grafana.idp.local/d/idp-ai-agent)

### High Latency

1. Check `agent_latency_seconds` p99 in Grafana.
2. Consider switching LLM model or provider via `LLM_MODEL` / `LLM_PROVIDER` env vars.

---

## Rollback

```bash
# View Helm release history
helm history ${{ values.name }} -n services

# Roll back to previous release
helm rollback ${{ values.name }} -n services
```

---

## Escalation

1. Check [Grafana AI Agent dashboard](http://grafana.idp.local/d/idp-ai-agent) for active alerts.
2. Check [MLflow](http://mlflow.idp.local) for failed runs.
3. Raise an incident and page the on-call: owner group `${{ values.owner }}`.
