# Agent Approvals

Human-in-the-loop (HiTL) gate for agent-initiated mutating actions — powered by `approval-service`, a policy ConfigMap, and enforcement inside the MCP tool servers themselves.

Shipped as ADP Phase 4. See [Agentic Development Platform](agentic-platform.md) for how it fits the wider agent architecture.

---

## The Problem

Agents that can only read are safe and not very useful. The moment an agent can sync an ArgoCD app, roll back a deployment, or approve a pull request, "the system prompt tells it to ask first" stops being a control — it's a suggestion the model is free to skip, and nothing in the platform records that it did.

## The Solution

A mutating tool call fails unless it carries an `approval_id` whose recorded status is `approved`. The check lives in the tool server's own code path, not in the prompt, so an agent cannot talk its way past it. Which actions need a human is data (a ConfigMap), not code — and every request, auto-approval, and human decision lands in an audit log.

---

## How it works

```
 agent (release-agent, qa-agent)
   │
   │ 1. check_policy(action, target)              ─┐
   │ 2. request_approval(action, target, context)  ├─ idp-mcp-server → approval-service
   │ 3. get_approval_status(approval_id)          ─┘
   │
   │ 4. sync_app(app_name, dry_run:false, approval_id)
   ▼
 argocd-mcp-server / github-mcp-server
   │  requireApproval() → GET /approvals/:id on approval-service
   │  rejects unless status == "approved" AND action+target match
   ▼
 real ArgoCD sync / GitHub review

 human
   │  Backstage → Agent Approvals (/approvals)
   └─ approve / deny → POST /approvals/:id/decide
```

| Piece | Path |
|---|---|
| REST API + `agent_approvals` table | `services/approval-service/` |
| Policy rules | `kubernetes/kagent/policies/configmap.yaml` → `src/policy.ts` |
| Agent-facing tools (`check_policy`, `request_approval`, `get_approval_status`) | `services/idp-mcp-server/src/server.ts` |
| Enforcement on `sync_app` / `rollback_app` | `services/argocd-mcp-server/src/server.ts` (`requireApproval`) |
| Enforcement on `approve_pr` | `services/github-mcp-server/src/server.ts` |
| Approvals UI | `backstage/app/packages/app/src/extensions.tsx` (`ApprovalsPage`) |

The `agent_approvals` table lives on the **existing Backstage Postgres** — Aurora/RDS on AWS, the docker-compose pgvector container locally (reached from Kind pods via `host.docker.internal`). No new database.

### Enforcement is opt-in, and silent when off

`requireApproval()` returns immediately if `APPROVAL_SERVICE_URL` is unset. That is deliberate — the tool servers ship in every install, but the gate only activates once `bootstrap-ai.sh --adp` deploys `approval-service` and patches the env var into `idp-`, `argocd-`, and `github-mcp-server`. **An unset `APPROVAL_SERVICE_URL` means mutating tools run ungated with no warning**, so it is the first thing to check when the gate appears not to work.

### What the gate actually verifies

Beyond "is it approved", `requireApproval()` rejects a mismatched `action`/`target` pair — an approval issued for `sync_app` on `dev-hello-service` cannot be replayed against `prod-payments-api`. Without that check the gate would be a rubber stamp.

---

## Policy

`kubernetes/kagent/policies/configmap.yaml` is mounted at `/etc/approval-service/policy.json`. Rules are evaluated **top to bottom, first match wins**, so specific patterns must precede `*`:

| Action | Target pattern | Requires approval | Rationale |
|---|---|---|---|
| `sync_app` | `prod-*` | yes | Production sync always needs a human |
| `sync_app` | `*` | no | Non-prod sync is reversible by another sync |
| `rollback_app` | `*` | yes | Reverts a live deployment regardless of environment |
| `approve_pr` | `*` | yes | Merge-enabling action |
| `request_changes` | `*` | no | Blocks merge rather than enabling it |

`targetPattern` supports exact match, a `prefix-*` glob, and `*`. **An action with no matching rule fails safe** — it requires approval (`matchedRule: "default-fallback"`). Adding a new mutating tool therefore defaults to gated, not open.

`src/policy.ts` also carries a `DEFAULT_POLICY` used only when the ConfigMap isn't mounted (local `npm run dev`, unit tests). It is stricter than the shipped policy — every `sync_app` requires approval. Don't read it as the deployed behaviour.

Policy is cached at first read. **Editing the ConfigMap requires a pod restart** to take effect:

```bash
kubectl apply -f kubernetes/kagent/policies/configmap.yaml
kubectl rollout restart deployment/approval-service -n services-dev
```

---

## Using it from Backstage

Open **<http://backstage.idp.local/approvals>** (nav item: **Agent Approvals**). The page lists pending approvals by default, with an **All (last 100)** toggle for history, and shows each request's action, target, requesting agent, and the free-form `context` the agent supplied — its stated reason for wanting the action.

Approve or deny writes `decided_by` from your Backstage identity. The agent's next `get_approval_status` call sees the decision and either retries or reports the denial.

The page requires `bootstrap-ai.sh --adp` to have run: it reveals the route in the generated `local/backstage/app-config.ai.yaml`, and Backstage reads config **only at startup**, so restart it afterwards with `./scripts/bootstrap-local.sh --start-backstage`. Without that, the route is disabled; with the route on but `approval-service` down, the page shows `HTTP … — is approval-service deployed?`. See [AI Assistant § Where the AI pages come from](ai-assistant.md#where-the-ai-pages-come-from-and-why-theyre-hidden) for how that gating works.

---

## API reference

Base URL: `http://approval-service.idp.local` (local) · `http://approval-service.services-dev.svc.cluster.local:3009` (in-cluster) · `/api/proxy/approval-service` (through Backstage).

| Method | Path | Body / query | Returns |
|---|---|---|---|
| `POST` | `/policy/check` | `{action, target}` | `{requires_approval, reason, matched_rule}` |
| `POST` | `/approvals` | `{action, agent, target, context?}` | 201 — the approval, already `approved` if policy auto-approves |
| `GET` | `/approvals` | `?status=pending` | `{total, approvals[]}` (unfiltered: last 100) |
| `GET` | `/approvals/:id` | — | the approval, or 404 |
| `POST` | `/approvals/:id/decide` | `{decision: approved\|denied, decided_by}` | the updated approval, or 409 |
| `GET` | `/healthz` · `/ready` · `/metrics` | — | health, readiness, Prometheus metrics |

`decide` is guarded by `WHERE status = 'pending'`, so a second decision on the same approval returns **409** rather than overwriting the first — decisions are immutable once made.

### Audit log

`approval-service` emits `[AUDIT]` JSON lines for `approval_requested`, `approval_auto_approved`, and `approval_decided`, each carrying `approval_id`; gated tools' own `[AUDIT]` entries carry the `approval_id` they were given. Together they reconstruct who authorised what, when, and on whose behalf.

```bash
kubectl logs -n services-dev deployment/approval-service | grep AUDIT
```

See [AI Assistant § Structured audit log](ai-assistant.md).

---

## Testing the gate

### Unit tests

```bash
cd services/approval-service && npm ci && npm test   # policy rules + all five endpoints (store mocked)
cd services/argocd-mcp-server && npm ci && npm test  # approval-gate.test.ts
```

### End-to-end, local

```bash
./scripts/bootstrap-ai.sh --adp
./scripts/bootstrap-local.sh --start-backstage        # reveal /approvals

# 0. the gate is actually wired in
kubectl get deploy argocd-mcp-server -n services-dev -o jsonpath='{..env}' | tr ',' '\n' | grep APPROVAL

# 1. policy says prod needs a human
curl -s http://approval-service.idp.local/policy/check \
  -H 'content-type: application/json' \
  -d '{"action":"sync_app","target":"prod-payments-api"}'

# 2. agent requests approval → pending
ID=$(curl -s http://approval-service.idp.local/approvals \
  -H 'content-type: application/json' \
  -d '{"action":"sync_app","agent":"release-agent","target":"prod-payments-api",
       "context":{"reason":"deploy v1.4.2 after green CI"}}' | jq -r .id)

# 3. approve it (or use the Backstage UI)
curl -s http://approval-service.idp.local/approvals/$ID/decide \
  -H 'content-type: application/json' \
  -d '{"decision":"approved","decided_by":"your.name"}'
```

Cases worth asserting, because each is a different failure mode:

| Case | Expected |
|---|---|
| `sync_app` on `dev-*` | created already `approved`, `decided_by: policy:auto-approve` |
| unknown action (`delete_cluster`) | `requires_approval: true` (fail-safe) |
| deciding the same ID twice | 409 |
| `sync_app` real call, no `approval_id` | rejected: "Approval required for …" |
| replaying an approval on a different app | rejected: "requested for a different action/target" |
| retry after a **denial** | rejected: "is not approved (status: denied)" |

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Mutating tools succeed with no approval | `APPROVAL_SERVICE_URL` unset on that tool server — re-run `bootstrap-ai.sh --adp` |
| `/approvals` 404s or is missing from the nav | AI overlay written with the layer off, or Backstage not restarted since |
| Approvals page shows an HTTP error | `approval-service` not running, or the proxy target in `app-config.local.yaml` / `app-config.aws.yaml` unreachable |
| Pod crash-loops on start | Postgres unreachable — locally the compose Postgres must be up and reachable at `host.docker.internal:5432`; on AWS `approval-service-db` is copied from `backstage-secrets`, which requires `bootstrap.sh` to have run |
| Policy edits have no effect | Policy is cached — `kubectl rollout restart deployment/approval-service -n services-dev` |
| `409` on every decide | The approval was already decided; decisions are one-shot by design |
