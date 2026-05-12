# ${{ values.name }} Agent Runbook

**Owner:** ${{ values.owner }}  
**Model:** ${{ values.model }} via Anthropic Claude API  
**Namespace:** `kagent`

---

## Health checks

```bash
# Verify the Agent CRD is accepted
kubectl get agents -n kagent ${{ values.name }}

# Check KAgent controller logs
kubectl logs -n kagent deploy/kagent-controller --tail=50

# Check MCP server connectivity
kubectl get remotemcpservers -n kagent idp-mcp-server
```

---

## Common issues

### Agent not appearing in KAgent UI

1. Confirm the CRD was applied: `kubectl get agents -n kagent`
2. Check controller reconcile errors:
   `kubectl logs -n kagent deploy/kagent-controller | grep ${{ values.name }}`
3. Re-apply: `kubectl apply -f kubernetes/agent.yaml`

### Agent responds with authentication error

The Anthropic API key secret may be missing or have insufficient credits.

```bash
# Verify the secret exists
kubectl get secret kagent-anthropic -n kagent

# Check the ModelConfig secret hash (should be non-empty)
kubectl get modelconfig claude-anthropic -n kagent -o jsonpath='{.status.secretHash}'

# Re-create the secret from local/.env
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY local/.env | cut -d= -f2-)
kubectl create secret generic kagent-anthropic \
  --namespace kagent \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Agent responds with credit balance error

Add credits at [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing).
Claude Haiku costs ~$0.001 per message — $5 lasts a very long time for platform assistant use.

### Tool calls failing (`catalog_search`, `get_service_metrics`)

```bash
# Check MCP server is running
kubectl get pods -n services -l app.kubernetes.io/name=idp-mcp-server

# Test MCP server health
kubectl exec -n services deploy/idp-mcp-server -- wget -qO- http://localhost:8080/healthz

# Check MCP server logs
kubectl logs -n services deploy/idp-mcp-server --tail=50
```

### Switching to a different Claude model

Update `spec.model` in `kubernetes/agent.yaml`:

```yaml
spec:
  declarative:
    modelConfig: claude-anthropic   # uses whatever model is in the ModelConfig
```

Or update the `claude-anthropic` ModelConfig directly:

```bash
kubectl patch modelconfig claude-anthropic -n kagent \
  --type=merge -p '{"spec":{"model":"claude-sonnet-4-6"}}'
```

---

## Rollback

KAgent agents are stateless CRDs — rollback is a re-apply of the previous spec.

```bash
# Restore from git
git checkout HEAD~1 -- kubernetes/agent.yaml
kubectl apply -f kubernetes/agent.yaml
```

---

## Escalation

1. Check [KAgent UI](http://kagent.idp.local) for active agent errors
2. Check [Grafana](http://grafana.idp.local/d/idp-ai-agent) — `agent_invocations_total`, `agent_invocation_duration_seconds`
3. Page owner group: `${{ values.owner }}`
