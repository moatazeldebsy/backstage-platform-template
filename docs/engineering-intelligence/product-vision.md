# Engineering Intelligence — Product Vision

> Help engineering organisations understand their Platform Engineering, Developer
> Experience, Quality, AI Engineering, Reliability and FinOps maturity — and give
> them actionable recommendations to improve.

An Internal Developer Platform tells an engineer how to ship a service.
Engineering Intelligence tells the organisation whether any of it is working.

---

## The questions it exists to answer

1. How healthy is our engineering organisation?
2. How mature is our platform?
3. Are developers actually benefiting from the platform?
4. Are our engineering practices improving?
5. Are we getting measurable value from AI?
6. Are our AI systems production-ready and governed?
7. Where are our biggest engineering risks?
8. What should engineering leadership focus on next?
9. Where can we save engineering time and infrastructure cost?

Today the platform can answer parts of 1, 2, 4, 6, 7 and 9 from real data. It
cannot yet answer 3 — Developer Experience has no data source — and it answers 5
only in terms of governance and trace volume, not value. The
[roadmap](roadmap.md) says which phase closes each gap, and why.

---

## Who it is for

| Audience | What they want | What they get |
|---|---|---|
| **CTO / VP Engineering** | Is engineering improving, and where is the risk? | The Engineering Health score, its trend, and the ranked risks behind it |
| **Engineering Manager** | Which of my teams needs help, and with what? | Per-dimension evidence, with the specific metric and the specific action |
| **Platform team** | Is the platform being adopted, and is it paying off? | Golden-path adoption, scorecard tiers, self-service usage |
| **Staff / Principal** | Where is the systemic problem, not the symptom? | Evidence rows tracing every score back to a source and a timestamp |

The dashboard (phase 3) is built for the first two. It has to be readable in
thirty seconds and defensible under a follow-up question — which is why every
score carries its evidence.

---

## Principles

**A score without evidence is an opinion.** Every dimension score decomposes into
evidence rows, each naming the metric, its raw value, the source, when it was
observed, and its weighted contribution. The contributions sum to the score. A
reader can add it up.

**Absence is not zero.** A dimension whose sources did not answer reports
`insufficient-evidence` and a null score. It is excluded from the overall score
rather than counted as failure. Every other dashboard in this platform falls back
to plausible demo data when a source is down; Engineering Intelligence does not,
because an organisation-wide health figure is the kind of number that ends up in
a board pack. See [ADR-0006](../design/adr-0006-engineering-intelligence.md).

**Say what you measured, not what you inferred.** The security dimension observes
whether scanning is *declared*, not whether any vulnerability exists, and every
piece of evidence it produces says so. A caveat that would embarrass the number
if it were omitted belongs on the number.

**Facts and recommendations are different objects.** Recommendations are derived
deterministically from evidence that exists. A metric nobody measured produces a
*gap*, reported separately — improving instrumentation is work on the platform,
not a finding about the organisation.

**Reuse before collect.** The first phase added no new exporter, no new
CronJob and no new dependency. It scores what four Python exporters, the catalog,
Tech Insights, OpenCost and Langfuse already produce.

---

## Open source and commercial

The open-source platform stays useful on its own. Everything needed to run
Engineering Intelligence for one organisation is in this repo and stays there:

- the Backstage platform, golden paths and 64 scaffolder templates
- the Bronze/Silver/Gold scorecard and Tech Insights facts
- the MCP servers, KAgent agents and Langfuse tracing
- the metrics model, the scoring engine, the collectors and the API
- the Engineering Health dashboard and executive report

Capabilities that only make sense across many organisations, or that carry an
operational burden a template cannot, are where a commercial offering would
eventually sit: anonymised cross-company benchmarking, multi-tenant hosting, SSO
and fine-grained RBAC beyond what [ADR-0004](../design/adr-0004-identity-and-access.md)
describes, audit logs, and enterprise governance reporting.

**No artificial limits are introduced into the open-source version.** Nothing
here is degraded to make a paid tier look better. The architecture is kept
multi-tenant-*capable* (see the roadmap's phase 12) so that a hosted service
would not require a fork — not so that the open version can be crippled.

---

## Related

- [Architecture](architecture.md) — how it is built, and what data exists
- [Maturity model](maturity-model.md) — the five levels
- [Scoring](scoring.md) — the evidence contract
- [Roadmap](roadmap.md) — the phases, and the data blocker on each
