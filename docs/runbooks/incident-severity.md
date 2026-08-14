# Incident severity

One vocabulary, mapped at the single point where alerts enter the platform.

There used to be four. Prometheus rules emit `critical` / `warning` / `info`; the
GitHub issue labels used those same values; `docs/postmortem-template.md` and the
Support page use `P1` / `P2` / `P3`; and `incident-agent`'s system prompt said
"Sev-1". Nothing translated between them, so a P1 in one place was a `critical` in
another and a Sev-1 in a third.

## The mapping

| Prometheus `severity` | Priority | Response | Gets a tracked issue? |
|---|---|---|---|
| `critical` | **P1** | Pages on-call via PagerDuty. Acknowledge within 15 min. | Yes |
| `warning` | **P2** | Slack `#platform-alerts`. Handle within the working day. | Only if `INCIDENT_SEVERITIES` includes `warning` |
| `info` | **P3** | Slack. Next working day. | No |

Anything unrecognised maps to **P3** rather than failing — an alert with a typo'd
severity should still be routed, just not paged on.

Defined once in `services/agent-event-router/src/incidents.ts` (`SEVERITY_MAP`).
Change it there, not in the four places that used to disagree.

## Where each value appears

- **Alert rules** — `observability/alertmanager/prometheus-rules.yaml` sets
  `severity:` on every rule. That label is what drives routing.
- **Routing** — `observability/alertmanager/alertmanager-config.yaml`. Critical
  goes to PagerDuty *and* Slack; warning to Slack; both also reach
  `agent-event-router` for triage and record-keeping.
- **Issue labels** — records carry **both** `severity:P1` and
  `severity:critical` during the transition, so `get_open_incidents` filters
  correctly whichever you ask for.
- **Postmortems** — `docs/postmortem-template.md` uses the P-form. A postmortem
  is required for P1 and P2 within 48 hours of resolution; the draft is opened
  automatically (see `.github/workflows/postmortem.yml`).

## Which issues get filed

`INCIDENT_SEVERITIES` on `agent-event-router` controls this, and defaults to
`critical` alone. Filing for warnings on a noisy cluster buries the repository —
turn it on deliberately, once the warning volume is known:

```yaml
- name: INCIDENT_SEVERITIES
  value: "critical,warning"
```

## A caveat on SLO burn-rate alerts

The SLO alerts (`SLOErrorBudgetFastBurn`, `SLOErrorBudgetSlowBurn`) depend on
Sloth recording rules. **No Sloth operator runs in-cluster** — the
`PrometheusServiceLevel` CRD is inert and the rules are vendored, so editing an
SLO source file without the `sloth` binary on PATH silently changes nothing. See
[SRE & Reliability](../sre-reliability.md) for the full explanation. A burn-rate
alert that never fires is not the same as an error budget that is healthy.

## See also

- [SRE & Reliability](../sre-reliability.md) — SLOs, error budgets, the postmortem process
- [`docs/postmortem-template.md`](../postmortem-template.md)
- [Runbook index](index.md)
