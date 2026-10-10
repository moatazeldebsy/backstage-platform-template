# Post-Mortem: [INCIDENT] etcdInsufficientMembers — prometheus-kube-prometheus-kube-etcd (INC-20261010110333)

> **Draft** — generated from incident issue [#707](https://github.com/moatazeldebsy/backstage-platform-template/issues/707) when it was
> labelled `incident:needs-postmortem`. The identifiers, timeline and MTTR below are
> filled in from the incident record; **every section marked _TODO_ needs a human**.
> Keep it blameless: systems, processes and conditions, not individuals.

---

## Incident Summary

| Field | Value |
|-------|-------|
| **Incident ID** | INC-20261010110333 |
| **Severity** | P1 |
| **Service(s) affected** | prometheus-kube-prometheus-kube-etcd |
| **Start time** | 2026-10-10 11:03 UTC |
| **End time** | 2026-10-10 11:19 UTC |
| **Total duration** | 16 minutes |
| **Incident commander** | _TODO_ |
| **Scribe** | _TODO_ |
| **Reviewers** | _TODO_ |

---

## Impact

_TODO — what was broken, for how many users, in which regions._

- **Affected users / requests:** _TODO_
- **Error rate peak:** _TODO_
- **Data loss / corruption:** _TODO_
- **SLO breach:** _TODO_

---

## Timeline

_Reconstructed from the incident issue and its comments. Add anything that
happened outside GitHub — Slack decisions, manual mitigations, the moment
somebody understood the cause._

| Time (UTC) | Event |
|------------|-------|
| 11:03 | Alert fired — `INC-20261010110333` opened as issue #707 |
| 12:28 | @moatazeldebsy: Alert `etcdInsufficientMembers` resolved at 2026-10-10T11:19:33.027Z (16 min after it started firing). Comp... |
| 11:19 | Alert resolved |

---

## Root Cause

_TODO — the condition that made this possible, not the trigger that exposed it._

---

## Contributing Factors

_TODO_

---

## Detection

_TODO — how was it noticed, and how long did that take? Was the alert the first
signal, or did someone notice before it fired?_

---

## Response

_TODO_

---

## Remediation Actions

| Action | Owner | Issue | Due |
|--------|-------|-------|-----|
| _TODO_ | _TODO_ | _TODO_ | _TODO_ |

---

## What Went Well

_TODO_

---

## Lessons Learned

_TODO_

---

## Metrics

| Metric | Value |
|--------|-------|
| Time to detect (TTD) | _TODO_ |
| Time to mitigate (TTM) | _TODO_ |
| Time to resolve (TTR / MTTR) | 16 min |
| Error budget consumed | _TODO_ |
| Customers impacted | _TODO_ |

---

## References

- Incident record: https://github.com/moatazeldebsy/backstage-platform-template/issues/707
- PagerDuty incident: _n/a_
- Repository: https://github.com/moatazeldebsy/backstage-platform-template
- Runbook used: _TODO_
- Relevant PR / commit: _TODO_
