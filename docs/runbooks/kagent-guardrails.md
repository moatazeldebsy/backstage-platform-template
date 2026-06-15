# Runbook: ScaffoldServiceHighRate / McpToolErrorRateHigh

**Alert:** `ScaffoldServiceHighRate` or `McpToolErrorRateHigh`  
**Severity:** Warning  
**Category:** ai-ops

## ScaffoldServiceHighRate — possible agent loop

### What is happening

`scaffold_service` has been called more than 5 times in 10 minutes. Normal usage is 0–2
calls per developer session. A high rate suggests a runaway agent loop or an API key being
used to bulk-create services automatically.

### Triage

```bash
# Check the audit log in Loki (if deployed)
# Grafana Explore → Loki → run:
{app="idp-mcp-server"} |= "[AUDIT]" | json | action="scaffold_service_requested"

# Or directly from pod logs:
kubectl logs -n services-dev deployment/idp-mcp-server --tail=200 | grep "\[AUDIT\]" | jq .

# Which agent is calling? (agent label in mcp_agent_tool_calls_total)
kubectl exec -n monitoring deploy/prometheus-operator -c prometheus -- \
  curl -s localhost:9090/api/v1/query \
  --data-urlencode 'query=increase(mcp_agent_tool_calls_total{tool="scaffold_service"}[10m])' \
  | jq '.data.result[] | {agent: .metric.agent, count: .value[1]}'
```

### Remediation

1. **Identify the agent** from the audit log — look for the `agent` field.
2. **Check created repos** in GitHub — `gh repo list <org> --limit 20 --json name,createdAt`.
3. **Delete spurious repos** if created accidentally:
   ```bash
   gh repo delete <org>/<repo-name> --yes
   ```
4. **Restart the KAgent controller** to clear stale agent sessions:
   ```bash
   kubectl rollout restart deployment/kagent-controller -n kagent
   ```

## McpToolErrorRateHigh — tool call error spike

### What is happening

More than 50 % of recent MCP tool calls on a given server/tool are returning errors.

### Triage

```bash
# Which tool is failing?
kubectl exec -n monitoring deploy/prometheus-operator -c prometheus -- \
  curl -s localhost:9090/api/v1/query \
  --data-urlencode 'query=rate(mcp_tool_calls_total{outcome="error"}[5m])' | jq .

# Check MCP server logs
kubectl logs -n services-dev deployment/idp-mcp-server --tail=100 | grep -E "Error|error"
kubectl logs -n services-dev deployment/contract-mcp-server --tail=100 | grep -E "Error|error"
```

### Common causes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Backstage API error 401` | `BACKSTAGE_TOKEN` expired | Rotate token in `backstage-catalog-exporter-token` secret |
| `K8s API error 403` | ServiceAccount RBAC gap | Check `kubernetes/rbac/` + re-apply |
| `Prometheus error 503` | Prometheus pod OOM restarted | `kubectl rollout restart deployment/prometheus-k8s -n monitoring` |
| `fetch_service_contract timeout` | Target service not reachable from MCP pod | Verify network policy + service DNS |
