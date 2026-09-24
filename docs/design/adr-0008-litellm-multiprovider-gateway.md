# ADR-0008: LiteLLM as the central multi-provider model backend

**Status:** Accepted · **Date:** 2026-09-13

## Context

[ADR-0007](adr-0007-ai-gateway.md) put one gateway in front of both MCP tools
and model traffic, and routed model traffic to Anthropic directly — the only
provider any agent actually used. Its own Consequences table flagged Bedrock as
"not wired — needs an IRSA role" and named agentgateway's native path to close
that gap: `provider: bedrock` with `auth.aws` on an IRSA-annotated
ServiceAccount, "one entry in the `llm:` block."

That native path was evaluated here and rejected — not because it doesn't work,
but because it only solves half the actual problem. Bedrock *connectivity*
was never really the ask; the ask was centralized access to multiple providers
with **virtual keys, per-team budget enforcement, and spend tracking**, none of
which agentgateway has. agentgateway's own cost visibility is per-request
telemetry for its console and, separately, Langfuse traces — neither is a
budget *enforced at the proxy*, and neither hands out scoped credentials per
consumer. Wiring `provider: bedrock` directly would have closed the
connectivity gap while leaving the actual capability gap open, and then
required a second migration later to add a budget layer on top.

## Decision

**LiteLLM sits behind agentgateway as the model backend for both Anthropic and
Bedrock.** agentgateway keeps everything ADR-0007 gave it — MCP multiplexing,
`failOpen`, `prefixMode: never`, the admin console — untouched. Only its
`llm.models` upstream changes, from `api.anthropic.com` directly to LiteLLM's
Service (`kubernetes/ml-platform/litellm.yaml`).

### 1. `provider: anthropic` + `baseUrl`, not `provider: openAI`

This was **validated empirically against a live LiteLLM instance**, not
assumed from documentation. Two shapes were tried in an isolated scratch
namespace, agentgateway unmodified in production:

- `provider: openAI` with `params.baseUrl` pointed at LiteLLM — **fails**. A
  `/v1/messages` call through agentgateway reached LiteLLM's internal
  `anthropic_messages()` compatibility handler but silently dropped
  `max_tokens`, producing a 500:
  `"anthropic_messages() missing 1 required positional argument: 'max_tokens'"`.
- `provider: anthropic` with `params.baseUrl` pointed at LiteLLM's own native
  `/v1/messages` passthrough — **works cleanly**. A raw `/v1/messages` POST
  round-tripped to a byte-for-byte valid Anthropic Messages response, with zero
  protocol translation anywhere in the chain.

**Consequence: ADR-0007 Decision 6's substance was not reversed.** Agents still
speak Anthropic's native protocol end to end — nothing is translated into an
OpenAI shape. Only the upstream *host* changed. `kubernetes/kagent/modelconfig*.yaml`
needed zero changes: they still say `provider: Anthropic`, `anthropic.baseUrl`
pointed at agentgateway, exactly as before.

### 2. Bedrock is a LiteLLM `model_list` entry, not a separate code path

`kubernetes/ml-platform/litellm.yaml`'s `model_list` carries both Anthropic
direct entries (`anthropic/claude-*`) and Bedrock-backed entries
(`bedrock/anthropic.claude-*`). agentgateway adds one more `llm.models` entry
per Bedrock model name — still `provider: anthropic`, still the same LiteLLM
`baseUrl` — because LiteLLM normalizes the Bedrock response back into Anthropic
Messages shape before it reaches agentgateway. agentgateway's side of the
config is identical for both providers; only LiteLLM's `litellm_params.model`
differs between entries.

### 3. Bedrock access is IRSA, on AWS only

`terraform/iam-litellm-bedrock.tf` grants a new `litellm` ServiceAccount
(`aws/ml-platform/litellm-serviceaccount.yaml`) `bedrock:InvokeModel` /
`bedrock:InvokeModelWithResponseStream`, scoped to
`arn:aws:bedrock:*::foundation-model/anthropic.claude-*` — not `*`, same
least-privilege convention as every other IRSA role in this repo
(`terraform/iam-crossplane.tf`). This is the exact role ADR-0007 said didn't
exist yet.

No static AWS credentials for Bedrock exist anywhere in this platform,
including locally. Kind has no OIDC provider to federate an IRSA role against,
so on local the Bedrock `model_list` entries are present (one file for both
environments) but unreachable — a call to one fails with a Bedrock auth error,
not a routing error. This matches the platform's existing IRSA-over-static-keys
convention (Crossplane, External Secrets); local Bedrock testing is a manual,
undocumented-by-default path (export real AWS credentials into the pod), not a
first-class flag.

### 4. Opt-in on local, on by default on AWS

> **Amended 2026-09-24: now on by default locally too.** Running the local
> default (no `--litellm`) showed two things this section got wrong. First,
> agentgateway v1.5.0 refuses to start when `$LITELLM_MASTER_KEY` is unset, so
> the gateway crash-looped and agents lost their tools as well as their model.
> The "MCP tools still work" claim below never held. Second, even with the
> gateway up, every model entry points at LiteLLM, so the default local install
> had an AI Assistant that could never answer. `bootstrap-ai.sh` now defaults
> `--litellm` on for both targets, generates a local `LITELLM_MASTER_KEY` if
> none is set, and under `--skip-litellm` creates a placeholder `litellm-keys`
> Secret so the gateway starts. The memory cost (~768Mi requested) is accepted;
> `--skip-langfuse` is the bigger lever when a laptop is tight.
> Testing that placeholder also showed that agentgateway expands dollar-prefixed
> variables inside YAML comments: a comment in `ai-gateway.yaml` naming the
> Anthropic key made it a required env var. Those comments no longer use the
> dollar form, and the config now warns about it.

`bootstrap-ai.sh --litellm` (tri-state, same pattern as `--langfuse`): unset
resolves to `false` on local Kind, `true` on `--aws`. Local stays opt-in
because LiteLLM is a second proxy process — Python/Uvicorn, not agentgateway's
64Mi Rust binary — on a cluster [docs/local-setup.md](../local-setup.md)
measures to have roughly 1.2–1.5GB of headroom once the full stack is running.
AWS has no such constraint, and Bedrock only exists there, so there's nothing
to gate.

Without `--litellm` on local, the AI Gateway still deploys and MCP tools still
work — only `/v1/messages` fails, now upstream against LiteLLM's absence rather
than against a missing `ANTHROPIC_API_KEY` (that failure mode still exists too,
independently: `ANTHROPIC_API_KEY` remains a hard requirement regardless of
`--litellm`, because LiteLLM's own config reads it, and other direct consumers —
the `langgraph-agent` and `llm-app-langfuse` skeletons, DeepEval — still exist
per ADR-0007's Context).

### 5. Credentials: one Secrets Manager entry, reused

`LITELLM_MASTER_KEY` (LiteLLM's own inbound auth) was added as a second key
inside the existing `idp-mvp/kagent` Secrets Manager entry
(`terraform/secrets.tf`), rather than a new secret — same reuse decision
ADR-0007 made for the Anthropic key sync. `aws/ml-platform/litellm-external-secret.yaml`
syncs both `ANTHROPIC_API_KEY` and `LITELLM_MASTER_KEY` from it into a
`litellm-keys` Secret in `ml-platform`.

The old `ai-gateway-llm-keys` Secret and its ExternalSecret
(`aws/ml-platform/ai-gateway-external-secret.yaml`) are deleted, not left as a
one-cycle no-op: agentgateway no longer reads `ANTHROPIC_API_KEY` directly, and
a stale Secret sitting next to the real one is a worse failure mode than a
clean cutover.

### 6. A database is required, not optional — discovered post-deploy

Not anticipated when this ADR was first written: LiteLLM's `/ui` login fails
outright ("Authentication Error, Not connected to DB!") and its budget
enforcement is silently a no-op without a Postgres `DATABASE_URL` — confirmed
against BerriAI's own docs and a live deploy. Since virtual keys and budget
enforcement are this ADR's actual rationale (Decision above), a DB is not
optional infrastructure here the way it might be for a pure routing proxy.

Local gets a dedicated Postgres pod (`local/ml-platform/litellm-postgres.yaml`,
plaintext local-only credentials, same pragmatism as `backstage-postgres` in
docker-compose). AWS gets a dedicated RDS instance (`terraform/rds.tf`,
`aws_db_instance.litellm`, gated behind `var.enable_litellm`) — same
dedicated-per-component pattern Langfuse already uses, not shared with
Backstage's instance. This also raised LiteLLM's measured memory floor
further: DB-connected mode (Prisma client) needs more than DB-less mode did.

## Consequences

| | Before (ADR-0007) | After (ADR-0008) |
|---|---|---|
| Model providers | Anthropic only | Anthropic + Bedrock |
| Protocol translation | None (native `/v1/messages`) | Still none — validated, not assumed |
| Budget/virtual keys | None | LiteLLM (per-key, per-team) |
| Network hops per model call | agentgateway → Anthropic | agentgateway → LiteLLM → Anthropic/Bedrock |
| Local default | N/A | On since 2026-09-24 (was `--litellm` opt-in); `--skip-litellm` opts out |
| AWS default | N/A | On |
| New IRSA role | — | `litellm-bedrock`, scoped to `InvokeModel*` on Claude ARNs |
| Database | dedicated Postgres pod | dedicated RDS (`aws_db_instance.litellm`) |

- **One added network hop, one new uptime dependency.** A model call now
  depends on LiteLLM being up in addition to agentgateway. No protocol risk
  (validated), but a real availability dependency that didn't exist before.
- **LiteLLM's resource footprint is an unmeasured placeholder as of this
  writing** — `kubernetes/ml-platform/litellm.yaml` starts from mlflow's tier
  (256Mi/512Mi) explicitly labeled as such. Re-measure after first deploy and
  replace with real numbers, per this repo's own convention
  (`ai-gateway.yaml`, `mlflow.yaml` are both measured, not guessed).
- **Cost-attribution double-counting risk grows, not shrinks.** ADR-0007
  already flagged an open question about the gateway's own telemetry
  double-counting against Langfuse. LiteLLM adds a *third* place usage could be
  recorded (its own spend dashboard). Not resolved here — flagging it so it
  isn't rediscovered independently.
- **Bedrock model coverage requires two files to agree.** A model added to
  LiteLLM's `model_list` but not to agentgateway's `llm.models` (or vice versa)
  fails at call time, not at deploy time — same shape as the existing
  `scripts/validate-mcp-tool-names.py` problem for MCP tools, without an
  equivalent validator yet.

## See also

- [ADR-0007](adr-0007-ai-gateway.md) — the gateway this amends
- [ADR-0005](adr-0005-llm-serving-and-agent-frameworks.md) — Bedrock originally
  deferred here
- [local-setup.md](../local-setup.md) — the memory-ceiling numbers behind the
  opt-in decision
- [scripts-reference.md](../scripts-reference.md#bootstrap-aish-flags) —
  `--litellm` / `--skip-litellm`
