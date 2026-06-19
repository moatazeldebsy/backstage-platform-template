// ── TTL cache ─────────────────────────────────────────────────────────────

interface CacheEntry<T> { value: T; expiresAt: number; }

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) { this.store.delete(key); return undefined; }
    return e.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

// ── sanitizeUserId ────────────────────────────────────────────────────────
// Produces a valid K8s name segment: lowercase alphanumeric + hyphens, max 63 chars.

export function sanitizeUserId(userId: string): string {
  return userId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 63);
}

// ── normalizeRepoUrl ──────────────────────────────────────────────────────
// Ensures repoUrl is in Backstage RepoUrlPicker format: github.com?owner=X&repo=Y
// Three input forms:
//   1. Missing entirely      → auto-build from name + owner
//   2. Full HTTPS URL        → convert to picker format
//   3. Already picker format → return unchanged

export function normalizeRepoUrl(
  values: Record<string, unknown>,
  fallbackOrg?: string,
): string {
  const repoName = (values['name'] as string | undefined) ?? '';
  const rawOwner = (values['owner'] as string | undefined) ?? '';
  // Backstage group refs look like "group:default/platform-team" — use the last segment.
  const ghOwner = rawOwner.includes('/')
    ? rawOwner.split('/').pop()!
    : (rawOwner || process.env.GITHUB_ORG || fallbackOrg || 'moatazeldebsy');

  const existing = values['repoUrl'] as string | undefined;

  if (!existing) {
    return `github.com?owner=${encodeURIComponent(ghOwner)}&repo=${encodeURIComponent(repoName)}`;
  }
  if (existing.startsWith('https://github.com/')) {
    const parts = existing.replace('https://github.com/', '').split('/');
    const urlOwner = parts[0] ?? ghOwner;
    const urlRepo = parts[1] ?? repoName;
    return `github.com?owner=${encodeURIComponent(urlOwner)}&repo=${encodeURIComponent(urlRepo)}`;
  }
  return existing;
}

// ── parseTemplateRef ──────────────────────────────────────────────────────
// Accepts any of:
//   "template:default/nodejs-service"
//   "default/nodejs-service"
//   "nodejs-service"

export function parseTemplateRef(templateRef: string): { namespace: string; name: string } {
  const withoutPrefix = templateRef.replace(/^template:/, '');
  const slashIdx = withoutPrefix.indexOf('/');
  const namespace = slashIdx !== -1 ? withoutPrefix.slice(0, slashIdx) : 'default';
  const name      = slashIdx !== -1 ? withoutPrefix.slice(slashIdx + 1) : withoutPrefix;
  return { namespace, name };
}

// ── parseMemoryValue ──────────────────────────────────────────────────────
// Coerces a string value to the appropriate type for a user memory key.

export function parseMemoryValue(key: string, value: string): unknown {
  if (key === 'recentServices') {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (key === 'scaffoldCount') {
    return parseInt(value, 10) || 0;
  }
  return value;
}
