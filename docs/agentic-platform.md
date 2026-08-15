# Agentic Development Platform (ADP)

> **Available on `main`** — opt-in.
>
> ADP extends the existing AI/ML platform (KAgent + MCP servers, see [ai-assistant.md](ai-assistant.md))
> from a chat assistant into a first-class, agent-driven layer for both the developer workflow
> (scaffold/code/test/review) and platform operations (cost/incidents/scaling/security). Teams that
> don't opt in see no behavior change — every phase below is additive to the platform already deployed
> by `bootstrap-ai.sh`. To pull in ADP components, run `./scripts/bootstrap-ai.sh --adp` instead of the
> bare invocation.

## Why

The platform already has substantial agent infrastructure — six KAgent agents and MCP servers, an
event bus reacting to GitHub/AlertManager/ArgoCD webhooks, RAG search, and an AI/ML scaffolder category
— but it wasn't documented, branded, or architected as a coherent whole, and agents had no safe way to
take real mutating action autonomously (no approval gate existed anywhere). ADP closes both gaps: it
gives the existing capability a clear identity, and it adds the missing pieces — ops coverage for
incidents/security, and a human-in-the-loop approval layer — needed to trust agents with real actions.

## Architecture

```
Backstage — chat UI (/ai-assistant), semantic search (/ai-search), approval UI (/approvals)
        │  A2A protocol (JSON-RPC)                 │  /api/proxy/approval-service (list/decide)
        ▼                                          ▼
┌──────────────────┐                    ┌────────────────────────────┐
│ platform-assistant│ ← entry point,    │       approval-service*      │
│ (all tools)        │   routes by intent│  Policy-as-Prompt (ConfigMap) │
└────────┬───────────┘                   │  + agent_approvals (Postgres) │
         │                               └───────────────┬────────────┘
         │  A2A                                           ▲
         ▼                                                 │ check_policy / request_approval /
┌────────────────────────────────────────────────────┐    │ get_approval_status
│ Specialist agents (also reachable directly)          │────┘
│  idp-assistant · qa-assistant · contract-assistant   │
│  cost-agent · release-agent · incident-agent*        │
│  security-agent* · onboarding-agent*                 │
└───────────────────────┬──────────────────────────────┘
                         │ MCP/HTTP
                         ▼
  idp-mcp :3001   qa-mcp :3002   contract-mcp :3003   github-mcp :3005
  cost-mcp :3007  argocd-mcp :3006   incident-mcp :3008*   security-mcp :3010*

  Real (non-dry-run) sync_app / rollback_app / approve_pr calls are rejected by their MCP
  server unless they carry an approval_id whose status is "approved" — enforced in code, not
  just a system-prompt convention. No-op unless APPROVAL_SERVICE_URL is set (bootstrap-ai.sh
  --adp); without --adp these tools behave exactly as before.

                              ▲
                              │  budget alerts → cost-agent
                              │  critical alerts → incident-agent* (+ tracked GitHub issue)
                              │  ArgoCD OutOfSync/Degraded → release-agent
                    agent-event-router :3004
              (GitHub / AlertManager / ArgoCD webhooks)

  * new in ADP — Phase 3: incident-agent, incident-mcp-server · Phase 4: approval-service ·
    Phase 5: security-agent, security-mcp-server, onboarding-agent
```

---

## What's in the Branch

### Phase 0 — Branding & Epic Scaffolding

| Component | Path |
|-----------|------|
| This doc | `docs/agentic-platform.md` |
| `--adp` bootstrap flag | `scripts/bootstrap-ai.sh` |
| README / docs index callouts | `README.md`, `docs/index.md` |

### Phase 1 — Documentation Consolidation

| Component | Path |
|-----------|------|
| Corrected architecture doc (adds cost-agent, release-agent, cost-mcp-server, argocd-mcp-server) | `docs/ai-assistant.md` |
| Event-bus routing documentation (budget alert → cost-agent, ArgoCD degraded → release-agent) | `docs/ai-assistant.md` § Event Bus |
| Restored missing deployable scaffolding for `github-mcp-server`, `cost-mcp-server`, `argocd-mcp-server` (Dockerfile, package.json, index.ts, tsconfig.json, helm-values) — deleted by a prior cleanup commit (`5230b9c`), leaving the tool logic in `server.ts` orphaned with no way to build/deploy it. Also fixed a pre-existing bug in their restored `helm-values-aws.yaml` (hardcoded `ACCOUNT_ID.dkr.ecr.AWS_REGION.amazonaws.com` instead of the `ECR_REGISTRY_PLACEHOLDER` token `bootstrap-ai.sh` substitutes) | `services/{github,cost,argocd}-mcp-server/` |

### Phase 2 — Dev Workflow Agents Hardening

| Component | Path |
|-----------|------|
| `approve_pr` / `request_changes` tools | `services/github-mcp-server/src/index.ts` |
| Code-review rule set (shift-left + contract-testing checklists) | `kubernetes/kagent/qa-agent.yaml` |

Note: `approve_pr`/`request_changes` are dry-run/stubbed until Phase 4's approval gate lands — no
auto-merge before then.

### Phase 3 — Ops Agents Wave 1 + RAG Fix

| Component | Path |
|-----------|------|
| `incident-mcp-server` (get_open_incidents, get_alert_history, get_runbook, post_incident_update, send_notification) | `services/incident-mcp-server/` |
| `incident-agent` + toolserver | `kubernetes/kagent/incident-agent.yaml`, `kubernetes/kagent/incident-toolserver.yaml` |
| AlertManager routing: critical non-budget alerts → incident-agent | `services/agent-event-router/src/router.ts` |
| RAG fix: index rendered TechDocs pages via the techdocs-backend's per-entity `search_index.json` (portable across local filesystem and S3 publishers), replacing a dead-end raw filesystem walk of `/catalog` (the Backstage catalog-definitions mount, not the docs mount) | `backstage/app/packages/backend/src/modules/idpRagSearch.ts` |

### Phase 4 — HiTL Approval Layer & Policy-as-Prompt

Operator/user guide: [Agent Approvals](agent-approvals.md) — policy rules, approval API, the Backstage
UI, how to test the gate, and troubleshooting.

| Component | Path |
|-----------|------|
| `approval-service` — REST API, `agent_approvals` table on the existing Backstage Postgres (Aurora/RDS in AWS, docker-compose pgvector image locally, reached via `host.docker.internal` from Kind pods) | `services/approval-service/` |
| Policy-as-Prompt rules (e.g. "sync_app on `prod-*` requires approval; rollback_app always does") | `kubernetes/kagent/policies/configmap.yaml`, evaluated by `services/approval-service/src/policy.ts` |
| `check_policy`/`request_approval`/`get_approval_status` tools (proxy to approval-service) | `services/idp-mcp-server/src/server.ts` |
| Tool-server-level enforcement — `sync_app`/`rollback_app`/`approve_pr` reject a real call without an `approval_id` whose recorded status is `approved`, once `APPROVAL_SERVICE_URL` is set (opt-in via `bootstrap-ai.sh --adp`) | `services/argocd-mcp-server/src/server.ts`, `services/github-mcp-server/src/server.ts` |
| System-prompt updates (request approval before a real mutating call, wait for the human decision) | `kubernetes/kagent/release-agent.yaml`, `kubernetes/kagent/qa-agent.yaml` |
| Approval UI (list pending/all, approve/deny) at `/approvals`, proxied via `/api/proxy/approval-service` | `backstage/app/packages/app/src/extensions.tsx` (`ApprovalsPage`) |
| Audit log: approval-service emits its own `[AUDIT]` lines (`approval_requested`/`approval_auto_approved`/`approval_decided`) with `approval_id`, `decision`, `decided_by`; gated tools' own `[AUDIT]` entries now carry `approval_id` too | `docs/ai-assistant.md` § Structured audit log |

This formalizes the dry-run-then-confirm convention already used by `release-agent.yaml` into a real,
auditable gate enforced at the tool-server layer (not just a system-prompt convention) — this phase
ships **before** Phase 5 so every new agent that follows is safe-by-construction. Note `request_changes`
is policy-exempt (it blocks merge rather than enabling it) and `sync_app` only requires approval for
`prod-*`-named apps by default — both configurable in the policy ConfigMap.

### Phase 5 — Security & Onboarding Agents

| Component | Path |
|-----------|------|
| `security-mcp-server` — `list_vulnerable_deps` (GitHub Dependabot alerts, not a live Snyk API query — Dependabot is what this repo's own security remediation actually uses), `get_secret_rotation_status` (reads the GitHub issues the `secret-rotation` scaffolder template's reminder workflow opens), `list_policy_violations` (Kyverno PolicyReport/ClusterPolicyReport via the K8s API) | `services/security-mcp-server/` |
| RBAC for reading cluster-wide PolicyReports | `kubernetes/kagent/security-mcp-server-rbac.yaml` |
| `security-agent` — read-only, no remediation tools | `kubernetes/kagent/security-agent.yaml` |
| `onboarding-agent` — reuses `idp-mcp-server`'s existing catalog/RAG tools, no new MCP server | `kubernetes/kagent/onboarding-agent.yaml` |

security-agent has no mutating tools, so it isn't gated by Phase 4 — it's read-only by design.

### Phase 6 — Golden Path Promotion & Tech Radar Cleanup

| Component | Path |
|-----------|------|
| AI/ML top billing in README/docs (doc-level only — no retagging in `all-templates.yaml`) | `README.md`, `docs/index.md` |
| `langgraph` promoted from *under evaluation* to built — see below | `backstage/catalog/templates/langgraph-agent/` |

### KAgent or LangGraph

Both are now available, and they are not competing:

| | KAgent | LangGraph |
|---|---|---|
| Defined as | Kubernetes resources (`kind: Agent`) | Application code you own |
| Owned by | The platform team | The service team |
| Control flow | Declarative | Imperative — branching and state in code |
| Reach for it when | A prompt plus tools is enough | The agent must loop, branch, or hold state |

Both consume the same eight MCP servers, and both trace to the same Langfuse. The
`langgraph-agent` template propagates the W3C `traceparent` on every MCP call, so a
run appears as one nested trace spanning the agent and the servers it called rather
than several unrelated ones.

---

## Opting In

1. Pull `main` — ADP scripts and templates are included; nothing runs until you opt in.
2. Run `./scripts/bootstrap-ai.sh --adp` (in addition to the base local/AWS bootstrap) to deploy the
   ADP-phase agents/toolservers on top of the existing AI/ML stack.
3. Existing AI/ML deployments without `--adp` are fully unaffected — `cost-agent`/`release-agent` and
   the original four assistants keep working exactly as before.

## See Also

- [design/adr-0005-llm-serving-and-agent-frameworks.md](design/adr-0005-llm-serving-and-agent-frameworks.md)
  — the reasoning behind the KAgent/LangGraph split above, and behind the mock/Ollama/vLLM model-server choice
- [ai-assistant.md](ai-assistant.md) — full agent/MCP server reference (Sprint 1-3 delivered history)
- [runbooks/kagent-guardrails.md](runbooks/kagent-guardrails.md) — existing guardrails this epic extends
- [multi-region.md](multi-region.md) — the V2 epic this doc's structure mirrors
