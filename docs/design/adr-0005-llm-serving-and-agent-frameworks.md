# ADR-0005: LLM serving and agent frameworks

**Status:** Accepted · **Date:** 2026-08-15

## Context

Two questions had been deferred rather than decided, and both were recorded in
`docs/agentic-platform.md` as "under evaluation" — which meant the code shipped
one answer while the docs implied none had been chosen.

**Model serving.** `idpDeployModelServer.ts` had a single code path, and its
builder was called `buildOllamaYaml()`. It did not deploy Ollama. It deployed a
~50MB Python Alpine stub serving canned responses, tagging the result
`served_by: ollama-mock`. The name was the whole problem: a reader auditing the
platform for "do we self-host models" found a function called `buildOllamaYaml`
and reasonably concluded yes.

Every agent therefore required a hosted API key. `ANTHROPIC_API_KEY` was a hard
prerequisite for the AI layer to do anything at all, which is a poor default for
an open-source template — an adopter evaluating the platform had to hand over a
paid credential before a single agent would answer.

**Agent frameworks.** KAgent gives declarative `kind: Agent` resources. It has no
answer for an agent that must branch, loop, or hold state across turns, and
LangGraph is the obvious complement — but adding it raised a placement question
this repo has a standing rule about: CLAUDE.md says agent capabilities belong in
MCP servers, not new services.

## Decision

### 1. The mock stays, renamed, and is no longer the only option

`buildOllamaYaml` was renamed to `buildMockYaml`, byte-for-byte otherwise. It
keeps its `ThreadingHTTPServer` fix, which is a real bug fix and not incidental.

`modelServerType` is now `mock | ollama | vllm`, and a genuine `buildOllamaYaml()`
was written alongside: pinned `ollama/ollama:0.13.0`, a PVC for model storage,
a `startupProbe` on `/api/tags`, and hard memory limits.

The PVC is not optional. Without it `ollama pull` re-downloads the model on every
restart, which on a laptop reads as a hang rather than a download.

### 2. Refuse rather than degrade, on both constrained targets

Two guards, both of which fail loudly at scaffold time instead of leaving a
broken pod:

- **Ollama on Kind** is refused unless `IDP_ALLOW_LOCAL_OLLAMA=true`, and the
  error prints the memory arithmetic. An 8-CPU/16GB Mac already running Kind,
  Backstage, Prometheus, ArgoCD and KAgent has no room for a 2.7GB image plus a
  resident model. That is an eviction, not a tuning exercise.
- **vLLM** preflights `kubectl get nodes -l accelerator` and fails with a message
  naming issue #184 (GPU nodegroup) if no node carries the label. Previously this
  would have produced a `Pending` pod with an unhelpful scheduling event.

A refusal that explains itself is more useful than a deployment that technically
succeeds and then dies.

### 3. One shared Ollama, not one per app

`kubernetes/ml-platform/ollama.yaml` deploys a single platform-wide Ollama
(`qwen2.5:1.5b`) that KAgent and LangGraph apps both point at, rather than each
scaffolded app carrying its own.

The resident model is the expensive part. Several copies of the same 1.5B model
serving a handful of agents wastes exactly the memory that is scarce.

`kubernetes/kagent/modelconfig-ollama.yaml` exposes it to KAgent. `provider: Ollama`
and the `ollama.host` field were **verified against the pinned KAgent CRD** rather
than assumed — the CRD's provider enum is
`[Anthropic, OpenAI, AzureOpenAI, Ollama, Gemini, GeminiVertexAI, AnthropicVertexAI]`.
The fallback plan, had `Ollama` been absent, was `provider: OpenAI` against
Ollama's `/v1` endpoint.

### 4. Existing agents are not repointed

The Ollama ModelConfig ships as *available*, not as a new default. No existing
agent was moved onto it.

A 1.5B model cannot drive `incident-agent`'s multi-tool loop. Repointing the
agents would have made the platform look key-free while quietly making it worse
at its job — the failure would show up as bad triage, not as an error.

### 5. LangGraph is a scaffolder template, not a platform service

`backstage/catalog/templates/langgraph-agent/` — no new `services/*` app.

A graph runtime is an *application*, owned by the team that writes the graph.
MCP servers are platform capabilities, owned by the platform team. Adding
`services/langgraph-runtime/` would have inverted that ownership and put the
platform team on the hook for every team's agent logic.

The skeleton loads its tools from the existing eight MCP servers via
`langchain-mcp-adapters`. **No tool is reimplemented.** It propagates the W3C
`traceparent` on every MCP call, so a run appears in Langfuse as one nested trace
spanning the agent and the servers it called. Using the Langfuse SDK directly
would have broken that nesting — the skeleton copies the raw-OTEL/protobuf
approach the MCP servers already use, for the same reason KAgent's exporter
protocol must be `http/protobuf`.

`modelBackend` defaults to `anthropic`, not `ollama`, so the golden path works
before anyone tunes a small model.

### 6. KAgent and LangGraph are complementary, and that is documented

|  | KAgent | LangGraph |
|---|---|---|
| Defined as | Kubernetes resources (`kind: Agent`) | Application code you own |
| Owned by | Platform team | Service team |
| Control flow | Declarative | Imperative — branching and state in code |
| Reach for it when | A prompt plus tools is enough | The agent must loop, branch, or hold state |

Both consume the same MCP servers; both trace to the same Langfuse.

## Consequences

Defaults per target:

| Component | Local (8CPU/16GB) | AWS |
|---|---|---|
| Mock model server | default | available |
| Ollama + 1.5B | opt-in, warned | default with the AI layer |
| vLLM + GPU | blocked, clear error | blocked until #184 |
| LangGraph app | default (hosted keys) | default |

Ollama is opt-in on both targets via `bootstrap-ai.sh --ollama`; it is not
installed by the base AI layer.

The platform can now run agents with no hosted API key, which matters for
evaluation. It is not the recommended configuration for the agents that do real
work — see decision 4.

## Deferred

- **Bedrock** as a managed alternative — issues #168–#177. Worth retriaging now
  that a self-hosted path exists.
- **GPU nodegroup** — #184. vLLM stays blocked until it lands.
- **Larger self-hosted models.** `qwen2.5:1.5b` was chosen to fit alongside the
  platform, not on quality. A GPU nodegroup changes that calculation.

## References

- `backstage/app/packages/backend/src/modules/idpDeployModelServer.ts`
- `kubernetes/ml-platform/ollama.yaml`
- `kubernetes/kagent/modelconfig-ollama.yaml`
- `backstage/catalog/templates/langgraph-agent/`
- `scripts/bootstrap-ai.sh` — `--ollama`
- `docs/agentic-platform.md` — the KAgent/LangGraph split, user-facing
