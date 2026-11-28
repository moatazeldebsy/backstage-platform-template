# Agentic platform: opportunities

**Status:** research, November 2026. The first slice (opportunities 1 and 2) has been built; the rest is a ranked backlog.

## The goal

Use the platform's AI to set up resources and run day-2 work, with agents acting as platform engineers next to humans. Anything risky waits for a human. Low-risk work runs on its own and leaves an audit trail. Over time, more work moves from "a human starts it" to "an agent starts it and a human supervises".

Autonomy is **risk-tiered**:

| Tier | Examples | What happens |
|---|---|---|
| Read | catalog search, metrics, cost, diffs | Runs freely |
| Low-risk write | PR on an existing repo, local Kind deploy, non-prod sync | Runs, audited; the PR review is the gate |
| High-risk write | AWS resources, IAM, new repos, namespaces, secrets, prod sync, rollback, PR approval | Waits for a human approval that carries a cost estimate and the exact parameters |

## What the platform already has

- **Agents.** Ten KAgent agents in `kubernetes/kagent/`, each with an allowlist of MCP tools. One agentgateway fronts all eight MCP servers ([ADR-0007](adr-0007-ai-gateway.md)) and model calls go through LiteLLM ([ADR-0008](adr-0008-litellm-multiprovider-gateway.md)).
- **Provisioning paths.** 60 golden-path templates, five of them Crossplane claims (RDS, S3, SQS, DynamoDB, Kafka) that open a PR with `services/<svc>/claims/<name>.yaml`. Agents reach the scaffolder through `scaffold_service` (idp-mcp-server) and `scaffold_test_suite` (qa-mcp-server).
- **Human in the loop.** `services/approval-service` stores approvals in the Backstage Postgres and evaluates a first-match policy (`kubernetes/kagent/policies/configmap.yaml`). The Backstage `/approvals` page records decisions under the verified user and refuses self-approval. Consent grants check that a user authorised an agent for a tool. See [Agent Approvals](../agent-approvals.md).
- **Events.** `services/agent-event-router` turns GitHub webhooks, Alertmanager alerts and ArgoCD OutOfSync/Degraded events into A2A messages to the right agent.
- **Signals.** OpenCost-backed cost tools (`get_team_spend`, `forecast_budget`, `list_budget_overruns`), per-team budgets, the Bronze/Silver/Gold Tech Insights scorecard, Prometheus guardrail alerts and `[AUDIT]` log lines.

## Gaps found

1. **Agents could provision infrastructure without approval.** `scaffold_service` accepted any template, including Crossplane RDS/S3, `eks-cluster`, and service templates that create ECR repos and IAM roles. Only consent applied, and consent is skipped when there is no verified user. Approval was enforced only on `sync_app`, `rollback_app` and `approve_pr`. *Fixed by the first slice.*
2. **The approval loop doesn't close.** Approvers aren't notified, and the agent isn't resumed after a decision; the user has to come back and say "it's approved".
3. **approval-service had no authentication.** Anything that could reach it could decide approvals or grant consent, and the self-approval check relied on the caller passing an honest `decided_by`. *Fixed: decide and consent changes now need a decider token that only Backstage holds ([Agent Approvals → Decider token](../agent-approvals.md#decider-token)). Creating and reading approvals is still open to anything that can reach the service.*
4. **Event-driven runs are fire-and-forget.** The event router discards the agent's reply, so a proposed fix goes nowhere unless the agent acts through its own tools.
5. **No durable audit store.** Audit lines go to stdout and Loki. Nothing answers "everything provisioning-agent did last month, and who approved it" without a log query.
6. **Shared credentials.** All agents scaffold with the MCP server's single `BACKSTAGE_TOKEN`, so the scaffolder sees the server, not the agent or the user.
7. **Identity is lost behind the KAgent controller** (found in the live test). Approvals record no requesting user and the agent as `Go-http-client/1.1`, so the self-approval and consent checks skip themselves. *Fixed: Backstage calls the agent pod directly and agents forward the headers to their tools ([Agent Approvals → Verified identity](../agent-approvals.md#verified-identity)). Locally this covers the built-in agents only.*
8. **Agent-run templates skip their parameter defaults** (found in the live test). The scaffolder API doesn't apply JSON-schema defaults, so omitted values render blank. *Fixed: `scaffold_service` fills in the template's defaults before it runs.*
9. **No cost gate.** Cost is now shown on the approval, but nothing stops a request that would push a team over budget. `terraform/policies/require-tags.rego` exists but isn't wired into CI.

## Opportunities, ranked

| # | Opportunity | Builds on | Effort | Status |
|---|---|---|---|---|
| 1 | **Risk-tiered approval on agent scaffolding.** Policy check, approval bound to template and a values hash, cost on the request. | approval-service, idp-mcp-server | S | Done |
| 2 | **Provisioning agent.** "I need a Postgres for orders-service" → right template → dry run → cost and team budget → approval → PR. | `scaffold_service`, Crossplane templates, cost tools | S | Done |
| 3 | **Harden the gate.** Service auth on approval-service (only Backstage may call `/decide`), a NetworkPolicy, per-agent Backstage tokens, an `agent_audit` table. | approval-service, `idpApprovalDecision.ts` | M | Decider token done; per-agent tokens and audit table next |
| 4 | **Close the loop.** Notify approvers (Slack via `send_notification`, Backstage notifications). On a decision, approval-service calls agent-event-router, which resumes the agent's A2A session (`contextId`) so it finishes the job. Self-service consent grants on `/approvals`. | agent-event-router, ApprovalsPage | M | Self-service consent done |
| 5 | **Closed-loop operations.** Keep agent replies. ArgoCD drift → release-agent proposes a sync with the diff → approval for prod → sync runs. Critical alert → incident-agent runs the matching runbook step behind an approval. | agent-event-router, release and incident agents | M | |
| 6 | **Day-2 platform-engineer agents that open PRs.** Cost-agent rightsizing PRs, security-agent secret rotation, a scorecard agent that moves services from Bronze to Silver, dependency bumps. A PR is the natural gate. | cost and security MCP, Tech Insights | M each | |
| 7 | **Backstage-native MCP actions.** Expose the scaffolder and catalog through the Actions Registry and `@backstage/plugin-mcp-actions-backend` instead of custom wrappers. Each action checks Backstage permissions for the real user. | Backstage 1.40+ | M | Watch upstream maturity |
| 8 | **Policy as code for agents.** Feed risk inputs (estimated cost, environment, IAM involvement, team budget headroom) into the policy instead of template names alone. Wire `require-tags.rego` into CI. | approval-service policy, OPA | M | |
| 9 | **Agent evals.** Langfuse traces plus promptfoo evals on template choice and parameter accuracy for the provisioning agent, run in CI when a prompt changes. | Langfuse, LiteLLM | S | |

## What the first slice does

- `scaffold_service` checks the policy before running. For a gated template it files the approval itself, with a summary, the agent's reason, the template's `idp.io/estimated-monthly-usd` annotation and the exact values, and returns `pending_approval` without creating anything.
- A retry with `approval_id` runs only if the approval is approved, is for the same template, and the SHA-256 of the values matches. An approval can't be replayed with different parameters.
- The policy auto-approves templates that only open a PR on an existing repo or deploy to local Kind. Everything else needs a human.
- `provisioning-agent` (`--agents provisioning`) drives the flow: template choice, dry run, cost and team budget, submit, approval link, retry.
- The `/approvals` page shows the summary, reason, cost and values instead of raw JSON.
- `idp-assistant` and `platform-assistant` can now request and check approvals for sync and rollback.

Details: [Agent Approvals → Scaffolding through an agent](../agent-approvals.md#scaffolding-through-an-agent).

## Patterns this follows

- **Block until approved, don't just notify.** The MCP server refuses the call; the agent can't route around it.
- **Bind the approval to the request.** The approval is tied to the tool, the target and a hash of the parameters, so it can't be reused for something else.
- **Risk-tiered, not all-or-nothing.** Approving every step trains people to click "approve" without reading. Gate what is hard to undo; let PR review cover the rest.
- **Leave a record.** Agent, requester, approver, time, target and parameters for every gated action.

KAgent also has a native `requireApproval` list that pauses an agent before a listed tool runs. It is useful for in-chat confirmation but lives in the agent, so a different agent or a direct MCP call skips it. This platform enforces the gate in the MCP server for that reason.

## Sources

- [kagent: Human-in-the-loop](https://kagent.dev/docs/kagent/examples/human-in-the-loop/)
- [Backstage: MCP Actions](https://backstage.io/docs/ai/mcp-actions)
- [Backstage v1.40 release notes](https://backstage.io/docs/releases/v1.40.0/)
- [Spotify Portal: Registering MCP tools](https://backstage.spotify.com/docs/portal/core-features-and-plugins/mcp/registering-tools)
- [Gravitee: Human-in-the-loop approval gates for high-risk AI agent actions](https://gravitee.io/corpus/gen-1696/at-the-end-of-the-rainbow/human-in-the-loop-approval-gates-for-high-risk-ai-agent-actions.html)
- [BetterCloud: What human in the loop means at enterprise scale](https://www.bettercloud.com/monitor/what-human-in-the-loop-means-at-enterprise-scale/)
