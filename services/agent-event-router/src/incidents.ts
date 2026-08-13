/**
 * Incident state, severity vocabulary, and PagerDuty correlation.
 *
 * Storage decision: **GitHub issues are the source of truth.** The in-memory Map
 * this replaces was the only record of which alerts already had an issue, so a
 * router restart mid-incident re-filed a duplicate for every still-firing alert.
 *
 * The alternative — a ConfigMap or a CRD — was rejected. The router runs with
 * `readOnlyRootFilesystem: true` and no Kubernetes RBAC, `incident-mcp-server`
 * already reads incidents out of GitHub issues, and a second store would
 * immediately disagree with the first. Instead the Map becomes a cache in front
 * of GitHub, rehydrated at startup, and per-incident state rides in a
 * machine-readable marker in the issue body.
 */

export interface OpenIncident {
  issueNumber: number;
  alertname: string;
  startsAt: string;
}

/**
 * One severity vocabulary.
 *
 * There were four: Prometheus emits critical/warning/info, the issue labels used
 * `severity:<prometheus value>`, docs/postmortem-template.md and the Support page
 * use P1/P2/P3, and incident-agent's system prompt says "Sev-1". Alerts enter the
 * system in exactly one place, so that is where the mapping belongs.
 */
export type Priority = 'P1' | 'P2' | 'P3';

export const SEVERITY_MAP: Record<string, Priority> = {
  critical: 'P1',
  warning: 'P2',
  info: 'P3',
};

export function toPriority(severity: string): Priority {
  return SEVERITY_MAP[severity?.toLowerCase()] ?? 'P3';
}

/** Machine-readable state carried in the issue body. */
export interface IncidentMarker {
  v: 1;
  fingerprint: string;
  incidentId: string;
  severity: Priority;
  rawSeverity: string;
  service: string;
  startsAt: string;
  endsAt?: string;
  durationMinutes?: number;
  pagerdutyUrl?: string | null;
}

const MARKER_RE = /<!--\s*idp-incident:\s*(\{[\s\S]*?\})\s*-->/;

export function renderMarker(m: IncidentMarker): string {
  return `<!-- idp-incident: ${JSON.stringify(m)} -->`;
}

export function parseMarker(body: string | undefined | null): IncidentMarker | null {
  if (!body) return null;
  const match = MARKER_RE.exec(body);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as IncidentMarker;
    return parsed?.fingerprint ? parsed : null;
  } catch {
    // A hand-edited issue body should not take the router down.
    return null;
  }
}

/** Replaces an existing marker in-place, or appends one. */
export function upsertMarker(body: string, marker: IncidentMarker): string {
  const rendered = renderMarker(marker);
  return MARKER_RE.test(body) ? body.replace(MARKER_RE, rendered) : `${body}\n\n${rendered}`;
}

export interface IncidentStoreConfig {
  token: string;
  repo: string; // "owner/repo"
  fetchImpl?: typeof fetch;
}

export interface IncidentStore {
  rehydrate(): Promise<number>;
  get(fingerprint: string): Promise<OpenIncident | undefined>;
  put(fingerprint: string, record: OpenIncident): void;
  delete(fingerprint: string): void;
  size(): number;
}

function headers(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };
}

export class GitHubIncidentStore implements IncidentStore {
  private cache = new Map<string, OpenIncident>();

  constructor(private readonly config: IncidentStoreConfig) {}

  private get fetchImpl(): typeof fetch {
    return this.config.fetchImpl ?? fetch;
  }

  size(): number {
    return this.cache.size;
  }

  put(fingerprint: string, record: OpenIncident): void {
    this.cache.set(fingerprint, record);
  }

  delete(fingerprint: string): void {
    this.cache.delete(fingerprint);
  }

  /**
   * Rebuild the cache from open incident issues. Called once at startup, before
   * the first alert can be processed, so a restart mid-incident does not re-file.
   * Returns the number of incidents recovered.
   */
  async rehydrate(): Promise<number> {
    const url =
      `https://api.github.com/repos/${this.config.repo}/issues` +
      `?labels=incident:open&state=open&per_page=100`;
    const res = await this.fetchImpl(url, { headers: headers(this.config.token) });
    if (!res.ok) {
      throw new Error(`rehydrate failed: HTTP ${res.status}`);
    }
    const issues = (await res.json()) as Array<{ number: number; body?: string }>;
    let recovered = 0;
    for (const issue of issues) {
      const marker = parseMarker(issue.body);
      if (!marker) continue; // pre-marker issue: not deduped against, will re-file once
      this.cache.set(marker.fingerprint, {
        issueNumber: issue.number,
        alertname: marker.incidentId,
        startsAt: marker.startsAt,
      });
      recovered += 1;
    }
    return recovered;
  }

  /**
   * Cache first, then GitHub search. The search is what makes a cold cache safe:
   * without it, any fingerprint missing from memory reads as "new".
   *
   * GitHub's search index is eventually consistent (seconds to a minute), so two
   * alerts arriving inside that window can still double-file. The cache absorbs
   * the common case; the postmortem workflow tolerates duplicates.
   */
  async get(fingerprint: string): Promise<OpenIncident | undefined> {
    const cached = this.cache.get(fingerprint);
    if (cached) return cached;

    const q = encodeURIComponent(
      `repo:${this.config.repo} is:issue is:open label:"incident:open" "${fingerprint}"`,
    );
    try {
      const res = await this.fetchImpl(`https://api.github.com/search/issues?q=${q}`, {
        headers: headers(this.config.token),
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { items?: Array<{ number: number; body?: string }> };
      for (const item of json.items ?? []) {
        const marker = parseMarker(item.body);
        if (marker?.fingerprint === fingerprint) {
          const record: OpenIncident = {
            issueNumber: item.number,
            alertname: marker.incidentId,
            startsAt: marker.startsAt,
          };
          this.cache.set(fingerprint, record);
          return record;
        }
      }
    } catch {
      // A search outage must not cause a duplicate storm either way; treating it
      // as "not found" risks one duplicate, treating it as "found" would drop a
      // real incident. Prefer the duplicate.
      return undefined;
    }
    return undefined;
  }
}

// ── PagerDuty correlation ────────────────────────────────────────────────────

export interface PagerDutyConfig {
  token: string;
  serviceIds: string[];
  fetchImpl?: typeof fetch;
}

/**
 * Find the PagerDuty incident for this alert and cross-link it.
 *
 * Alertmanager owns the PagerDuty dedup key and will not let us set it, so there
 * is no shared identifier to join on. We match on the fields Alertmanager
 * templates into the PD payload — alertname via `class`, service via `component`
 * — and require **both**, because two services alerting with the same alertname
 * at the same time is exactly when a wrong link is most damaging. Ambiguous
 * matches are skipped rather than guessed.
 */
export async function correlatePagerDuty(
  opts: { alertname: string; service: string; startsAt: string },
  config: PagerDutyConfig,
): Promise<{ id: string; url: string } | null> {
  if (!config.token || config.serviceIds.length === 0) return null;
  const fetchImpl = config.fetchImpl ?? fetch;

  // Five minutes before the alert started: PD creates its incident on receipt,
  // which trails the alert's own startsAt.
  const since = new Date(new Date(opts.startsAt).getTime() - 5 * 60_000).toISOString();
  const params = new URLSearchParams({ since, statuses: 'triggered' });
  for (const id of config.serviceIds) params.append('service_ids[]', id);

  try {
    const res = await fetchImpl(`https://api.pagerduty.com/incidents?${params}`, {
      headers: {
        Authorization: `Token token=${config.token}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      incidents?: Array<{ id: string; html_url: string; title?: string; body?: { details?: unknown } }>;
    };
    const candidates = (json.incidents ?? []).filter(
      inc =>
        (inc.title ?? '').includes(opts.alertname) && (inc.title ?? '').includes(opts.service),
    );
    // Exactly one match, or nothing. Two candidates means we cannot tell them
    // apart, and a wrong backlink is worse than none.
    if (candidates.length !== 1) return null;
    return { id: candidates[0].id, url: candidates[0].html_url };
  } catch {
    return null;
  }
}

/** Best-effort note on the PagerDuty incident pointing at the GitHub issue. */
export async function addPagerDutyNote(
  incidentId: string,
  note: string,
  config: PagerDutyConfig,
): Promise<boolean> {
  if (!config.token) return false;
  const fetchImpl = config.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`https://api.pagerduty.com/incidents/${incidentId}/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token token=${config.token}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
      },
      body: JSON.stringify({ note: { content: note } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * In-memory store with no GitHub behind it.
 *
 * Used by tests, and as the degraded mode when GitHub is not configured — the
 * router still dedupes within a single process lifetime, it just cannot survive
 * a restart. That is exactly the old behaviour, kept deliberately rather than by
 * accident.
 */
export class MemoryIncidentStore implements IncidentStore {
  private cache = new Map<string, OpenIncident>();
  async rehydrate(): Promise<number> {
    return 0;
  }
  async get(fingerprint: string): Promise<OpenIncident | undefined> {
    return this.cache.get(fingerprint);
  }
  put(fingerprint: string, record: OpenIncident): void {
    this.cache.set(fingerprint, record);
  }
  delete(fingerprint: string): void {
    this.cache.delete(fingerprint);
  }
  size(): number {
    return this.cache.size;
  }
}
