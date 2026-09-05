# ADR 0001 — Initial decisions

- **Status:** Accepted
- **Context:** Scaffolded from the IDP `llm-app-langfuse` golden path.

These are the choices the template made on your behalf. Revisit any of them — this record exists
so you know what you are overturning.

## Raw OpenTelemetry, not the Langfuse SDK

The Langfuse SDK depends on the same OpenTelemetry packages and adds, in practice, a span
processor that sets a static auth header — three lines in `src/telemetry.py`. Plain OTEL also
produces the same span envelope as KAgent, which is what allows an agent's trace and this
service's spans to nest into one waterfall.

**Consequence:** you own the span attributes. The `langfuse.*` keys are the contract with
Langfuse's ingest; renaming them turns a typed generation into an untyped span with no cost or
token accounting.

## Tracing is disabled by default

With `LANGFUSE_OTLP_ENDPOINT` unset, `init_tracing()` installs no provider and `with_generation()`
calls straight through. Zero overhead, no configuration required.

**Consequence:** the service can be deployed before Langfuse credentials reach the namespace, and
a Langfuse outage cannot take the service down. The cost is that "no traces" and "tracing
correctly disabled" look the same from outside — `/ready` reports which it is.

## Both secrets are `optional: true`

Model calls route through the platform's AI Gateway, so this service holds no provider key; a missing `langfuse-otel` disables tracing.
Neither blocks the pod from starting.

**Consequence:** a misconfiguration surfaces as a specific failing endpoint rather than a
crashloop whose real cause is buried in events. The trade is that a broken deployment looks
"Running" in `kubectl get pods` — hence `/ready` reporting configuration explicitly.

## Prompt and completion capture is off

`LANGFUSE_CAPTURE_IO` defaults to `${{ values.captureIo }}`. Anyone with Langfuse access can read
whatever is captured, and the platform's Langfuse is shared.

**Consequence:** traces show latency, tokens and cost but not content until someone deliberately
opts in. Debugging a bad answer means turning capture on for a window, not reading history.

## One shared Langfuse project, not one per service

Every service reports into the `idp-agents` project, distinguished by the OTEL `service.name`
resource attribute and a trace tag. That tag is what the Backstage entity tab filters on.

**Consequence:** no per-service project or key pair to manage, but no hard isolation between
services' traces either. Per-service projects would need an org-scoped admin credential and a
provisioning step; the platform chose not to carry that.

## `/ready` does not call the model API

A readiness probe that made a real model call would bill a token per check and fail the pod on any
provider blip.

**Consequence:** readiness means "this process is configured and serving", not "the model API is
reachable". Provider availability shows up as 429/503 from `/chat`, where it belongs.

## Effort level over prompt engineering for reasoning depth

`ANTHROPIC_EFFORT` is the first lever for how hard the model works, ahead of adding
"think carefully" instructions to the system prompt.

**Consequence:** raising effort also raises latency and token spend, and `ANTHROPIC_MAX_TOKENS`
must move with it — it caps thinking and response text together.
