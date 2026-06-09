# Post-Mortem Template

> **Instructions:** Complete this document within 48 hours of resolving a P1 or P2 incident. Keep it blameless — focus on systems, processes, and conditions, not individuals. Share in `#incidents` once drafted and schedule a review within 5 business days.

---

## Incident Summary

| Field | Value |
|-------|-------|
| **Incident ID** | INC-YYYY-NNN |
| **Severity** | P1 / P2 / P3 |
| **Service(s) affected** | e.g. hello-service, backstage |
| **Start time** | YYYY-MM-DD HH:MM UTC |
| **End time** | YYYY-MM-DD HH:MM UTC |
| **Total duration** | X hours Y minutes |
| **Incident commander** | @handle |
| **Scribe** | @handle |
| **Reviewers** | @handle, @handle |

---

## Impact

_Describe the user-visible impact. Be specific: what was broken, for how many users, in which regions._

- **Affected users / requests:** e.g. 100% of EU-WEST-1 users, ~3,000 req/min dropped
- **Error rate peak:** e.g. 42% HTTP 5xx
- **Data loss / corruption:** Yes / No (if yes, describe scope)
- **SLO breach:** Yes / No — error budget consumed: X minutes of 43 min/month

---

## Timeline

_List events in UTC chronological order. Include both detection and action events._

| Time (UTC) | Event |
|------------|-------|
| HH:MM | Alert fired: `HighHTTP5xxRate` in `#platform-alerts` |
| HH:MM | On-call acknowledged alert |
| HH:MM | Incident thread opened in `#incidents` |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied (e.g. helm rollback) |
| HH:MM | Error rate returned to normal |
| HH:MM | Incident resolved, monitoring for 30 min |
| HH:MM | All-clear declared |

---

## Root Cause

_One clear paragraph. What was the technical root cause? Avoid "human error" as a root cause — describe the condition that made the error possible._

Example: *A Helm values change removed the readiness probe path override, causing all pods to report Ready immediately after container start before the application had initialized its database connection pool. Kubernetes routed traffic to these pods, which returned 503 for all requests until they warmed up (~90 seconds). Because `minReadySeconds` was not set on this service's overlay, there was no protection against premature traffic reception.*

---

## Contributing Factors

_List 3–5 factors that allowed this incident to happen or made it harder to detect / recover._

- [ ] No staging environment to catch the config change before production
- [ ] Alert threshold (5%) was too high to catch early degradation
- [ ] Runbook did not cover readiness probe misconfiguration
- [ ] On-call engineer was unfamiliar with the affected service
- [ ] No automated rollback on error-rate spike

---

## Detection

_How was the incident detected? Was it faster or slower than expected?_

- **Detected by:** Prometheus alert / customer report / synthetic monitor / manual observation
- **Time to detect (TTD):** X minutes from first impact
- **Was TTD acceptable?** Yes / No — if no, why?

---

## Response

_What happened during response? Was the runbook useful? What slowed things down?_

- **Runbook used:** [link]
- **Runbook accuracy:** Accurate / Partially accurate / Missing steps
- **Time to mitigate (TTM):** X minutes from detection
- **What worked well:**
- **What slowed response:**

---

## Remediation Actions

_Concrete tasks with owners and due dates. These become Jira tickets or GitHub Issues._

| Action | Owner | Due Date | Priority |
|--------|-------|----------|----------|
| Add `minReadySeconds: 30` to service Helm values overlay | @handle | YYYY-MM-DD | P1 |
| Update runbook to include readiness probe verification step | @handle | YYYY-MM-DD | P2 |
| Lower `HighHTTP5xxRate` alert threshold from 5% to 1% | @handle | YYYY-MM-DD | P2 |
| Add staging smoke test for Helm values changes | @handle | YYYY-MM-DD | P2 |
| Add automated rollback AnalysisTemplate to Argo Rollouts | @handle | YYYY-MM-DD | P3 |

---

## What Went Well

_List things that worked: fast detection, clear runbook, good team communication, etc._

- Alert fired promptly (< 2 min from impact)
- On-call responded within SLO (< 30 min)
- `helm rollback` was fast and effective

---

## Lessons Learned

_What systemic improvements does this incident suggest beyond the immediate action items?_

1. 
2. 
3. 

---

## Metrics

| Metric | Value |
|--------|-------|
| Time to detect (TTD) | X min |
| Time to mitigate (TTM) | X min |
| Time to resolve (TTR / MTTR) | X min |
| Error budget consumed | X min of Y min/month |
| Customers impacted | X |

---

## References

- Incident Slack thread: [link]
- Prometheus alert: [link]
- ArgoCD deployment history: [link]
- Relevant PR / commit: [link]
- Runbook used: [link]
