# ADR-0007: One gateway for MCP tools and model traffic

**Status:** Accepted · **Date:** 2026-09-02

## Context

The agent layer had grown two separate addressing problems, and neither was
visible as a problem until you counted the places the same fact was written down.

**Tools.** Eight MCP servers were registered as eight `RemoteMCPServer` CRs, and
each of the nine agents named the ones it used. That knowledge also existed a
second time, partially, in the `langgraph-agent` skeleton's `mcp_tools.py`, whose
endpoint map listed **four of the eight** — `contract`, `argocd`, `incident` and
`security` were simply unreachable from any scaffolded LangGraph agent, and
nothing reported it. Nothing authenticated a call to `/mcp` either; the boundary
was NetworkPolicy alone, and that allowlist had never been updated for ports
3008 and 3010, so the two ADP-phase servers were outside it.

**Models.** There was no central egress at all. KAgent went straight to
`api.anthropic.com` via `ModelConfig`; the LangGraph skeleton constructed its own
`ChatAnthropic`; `llm-app-langfuse` constructed its own `anthropic.Anthropic()`;
`idpRagSearch.ts` called Voyage; the DeepEval suite called Anthropic directly.
Every one of them resolved its own credential, and **every scaffolded LLM app
told the developer to create their own `sk-ant-` secret before it would answer**.
There was no rate limit, no budget, no fallback, and cost attribution was
inferred after the fact in `aiCost.ts` by matching a Langfuse trace name to a
catalog component — which is why that module reports an `ai.costAttributedRatio`
at all.

Bedrock (#168–#177) and vLLM (#184) were deferred in
[ADR-0005](adr-0005-llm-serving-and-agent-frameworks.md). Adopting either meant
editing every `ModelConfig` and every app skeleton.

## Decision

**One gateway — [agentgateway](https://agentgateway.dev/) in standalone mode —
fronts both the MCP servers and the model providers.**
`kubernetes/ml-platform/ai-gateway.yaml`, deployed by default.

### 1. agentgateway, not Envoy AI Gateway

Both are credible and both do MCP multiplexing plus token-aware traffic control.
Envoy AI Gateway is CNCF proper, built on CNCF Envoy Gateway. It loses on one
specific constraint: it requires Envoy Gateway plus Gateway API CRDs plus a
control plane, and this repo ingresses through nginx locally and ALB on AWS — so
adopting it means adopting Gateway API as a side effect, on a local cluster
[measured](../local-setup.md) to have no headroom.

agentgateway standalone is a single Rust binary reading one config file: no CRDs,
no second control plane, and **~9 MiB working set / ~20 MiB RSS measured on a
real cluster** with all eight targets configured and 40 concurrent MCP requests
in flight. It also speaks all three protocols this platform actually uses — MCP
streamable-HTTP, A2A, and LLM — and comes from the same ecosystem as the KAgent
already running here (Solo.io donated kagent to CNCF; agentgateway is under the
Linux Foundation's Agentic AI Foundation and is the data plane for the
CNCF-sandbox kgateway).

Switching later is a rewrite of one ConfigMap, not of the platform.

### 2. Standalone mode, not the Helm/CRD install

The Kubernetes install path pulls in Gateway API CRDs and a kgateway control
plane. Standalone is a Deployment, a Service and a ConfigMap — the same shape as
`kubernetes/ml-platform/ollama.yaml`, and reviewable in one file.

### 3. Default-on, not opt-in

Ollama and Langfuse are opt-in because they are expensive and additive. The
gateway is neither: at well under 100 MiB it is a rounding error against Langfuse's ~2.2 GB,
and every agent's single `RemoteMCPServer` **and** every `ModelConfig` now point
at it. An opt-in gateway would have meant maintaining two topologies — two sets
of agent manifests, two endpoint maps in the skeleton — which is precisely the
duplication this ADR exists to remove.

`--skip-gateway` exists for debugging the MCP servers directly. It leaves agents
with no tools and no model, and the bootstrap says so.

### 4. `prefixMode: never`

The default (`conditional`) namespaces tool names with the target name the moment
a second target exists: `sync_app` becomes `argocd_sync_app`. That would have
rewritten the `toolNames:` allowlist *and* the tool documentation inside the
`systemMessage` of all nine agents.

`never` is safe only while tool names are unique across servers. They are — 54
tools, zero collisions — and `scripts/validate-mcp-tool-names.py` is the standing
guard, because a collision does not error: the gateway routes by name lookup and
one server silently wins.

### 5. `failureMode: failOpen`, and per-target timeouts

The default `failClosed` fails the whole session if any target is unreachable.
`incident` and `security` only exist behind `--adp`, so that default would take
the gateway down on every base install. `failOpen` skips unhealthy targets.

The consequence is that **Ready does not mean complete** — a gateway can serve
fewer tools than expected and look healthy. Both `bootstrap-ai.sh` and
`validate-deployment.sh` therefore report how many targets resolve.

Collapsing eight CRs into one also collapsed eight `timeout` values (30s–300s)
into one. Forcing 300s everywhere would let a wedged 30s tool hold a slot for
five minutes, so the real values moved into the gateway as per-target
`policies.http.requestTimeout`; the CR's 300s is only an outer bound.

### 6. Anthropic stays Anthropic

KAgent's pinned CRD (v0.9.4) exposes `anthropic.baseUrl`, not just
`openAI.baseUrl`, and agentgateway serves `/v1/messages` natively. So model
traffic is redirected without protocol translation and without changing a single
model id — `provider: Anthropic` throughout, just a different host.

Only Anthropic is routed. `openai-prod` and `ollama-local` exist as ModelConfigs
but no agent references them (ADR-0005 decision 4), and routing them would mean
shipping config nothing exercises. Each is one more entry in the `llm:` block.

### 7. The admin UI is on locally, and not ingressed on AWS

agentgateway's admin listener serves `/ui` (routes, MCP targets, model list) and
`/config_dump`. This was originally `off`, which turned out to be the wrong
default: it removed the only view into what the gateway is doing, and cost a
manifest edit *plus a pod restart* before anyone could look — `adminAddr` is read
at startup, not on config reload.

It now binds `0.0.0.0:15000`, with `local/ml-platform/ai-gateway-ingress.yaml`
publishing `ai-gateway.idp.local` — the same shape kagent, mlflow and langfuse
already have locally. **No AWS counterpart**: an ALB in front of an
unauthenticated admin interface is precisely the pattern this change removed from
the MCP servers, so on EKS the port stays reachable in-cluster and unexposed.

The exposure is topology — MCP target hosts and ports, and which models are
served. Not credentials: `/config_dump` renders provider keys as
`{"key":{"value":"<redacted>"}}`, verified against v1.5.0.

### 8. Credentials live in the gateway, not in services

`ai-gateway-llm-keys` in `ml-platform` — created imperatively by the bootstrap so
a first install works, and kept in sync on AWS by an ExternalSecret against the
existing `idp-mvp/kagent` Secrets Manager entry (the cluster-scoped
`aws-secretsmanager` store, so no new ServiceAccount or IRSA role).

Mounted `optional: true`: a cluster with no key still gets a fully working MCP
gateway, and model calls fail with the provider's own 401 rather than a startup
error. That is what keeps a key-free evaluation cluster usable.

The scaffolded LLM templates now hold **no provider key at all**. That deletes a
required manual step — "create your own `sk-ant-` secret" — from every LLM app
the platform generates.

## Consequences

| | Local (Kind) | AWS (EKS) |
|---|---|---|
| Gateway | default, ~9 MiB | default, ~9 MiB |
| Provider key | bootstrap-created Secret | ExternalSecret from `idp-mvp/kagent` |
| Bedrock | n/a | not wired — needs an IRSA role |
| Multi-region | n/a | one gateway **per region**, spoke-local |

- **The gateway is a single point of failure for the agent layer.** It was
  already true of every individual MCP server; it is now concentrated. It has no
  PDB and one replica, which is right for a component whose dependents are all
  best-effort, and wrong the day an agent becomes load-bearing.
- **Multi-region:** never a hub singleton. A standby-region agent calling the
  primary's gateway is a cross-region hop on every token and every tool call.
- **Bedrock becomes cheap** — `provider: bedrock` with `auth.aws` on an
  IRSA-annotated ServiceAccount, one entry in the `llm:` block. Deliberately not
  wired here: it needs a Terraform IAM role that cannot be exercised without a
  cluster, and a half-wired install path is a failure mode this repo has already
  paid for.

### Not yet done, and why it matters

**Inbound auth is not enabled.** Both halves are ready — agentgateway takes
`keyHash: sha256:…` so no secret need be committed, and KAgent's CRD has
`headersFrom` with a `secretKeyRef`.

An earlier revision of this ADR deferred the work on the grounds that
"NetworkPolicy is not enforced on either target", and that was **half wrong**.

**Local: it is enforced.** Kind v1.33.1's kindnet implements NetworkPolicy, and
this was not a paper finding — on 2026-09-04 the `services-dev` policy blocked
the gateway outright. `ml-platform` was missing from the allowlist, every
upstream failed with `Connect: deadline has elapsed`, and the `ai-gateway`
`RemoteMCPServer` sat at `Accepted: False` until the policy in
`kubernetes/network-policies/default-deny.yaml` was applied. So locally the
boundary is real, and gateway auth can be built and tested against it today.

**AWS: it is not.** `terraform/eks.tf` still installs `vpc-cni` with
`{ most_recent = true }` and no `enableNetworkPolicy`, so on EKS any pod can
reach `idp-mcp-server:3001/mcp` directly and gateway auth alone would be a
control that reads real and enforces nothing. Turning that flag on is the
prerequisite there, and it is a cluster-affecting Terraform change.

Enabling enforcement is still its own change on both targets: the `backstage`
namespace was never in the allowlist, so tightening further would break the
Backstage → `contract-mcp-server` proxy. That should land before, or with,
gateway auth — not after.

**Cost attribution is not yet authoritative.** The gateway already emits the
`gen_ai.*` attributes needed for it (`gen_ai.provider.name`,
`gen_ai.request.model`, per-server and per-tool MCP counters). The open question
is double counting: if both the gateway and an app's own `telemetry.py` report
usage for the same call, Langfuse `/api/public/metrics` counts it twice, and
`aiCost.ts` would read the doubled figure. One side must own usage and the other
emit spans only. That decision belongs with the change that makes it, not here.

## See also

- [ADR-0005](adr-0005-llm-serving-and-agent-frameworks.md) — the mock/Ollama/vLLM
  split and the KAgent/LangGraph division this builds on
- [agentic-platform.md](../agentic-platform.md) — the agent topology diagram
- [scripts-reference.md](../scripts-reference.md#bootstrap-aish-flags) —
  `--gateway` / `--skip-gateway`
