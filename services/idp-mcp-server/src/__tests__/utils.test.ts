import { TtlCache, sanitizeUserId, normalizeRepoUrl, parseTemplateRef, parseMemoryValue } from '../utils.js';

// ── TtlCache ──────────────────────────────────────────────────────────────

describe('TtlCache', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('returns undefined for a key that was never set', () => {
    const cache = new TtlCache<string>();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('returns the stored value before TTL expires', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'hello', 5000);
    expect(cache.get('k')).toBe('hello');
  });

  it('returns undefined after TTL expires', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'hello', 5000);
    jest.advanceTimersByTime(5001);
    expect(cache.get('k')).toBeUndefined();
  });

  it('does not expire before TTL elapses', () => {
    const cache = new TtlCache<number>();
    cache.set('n', 42, 1000);
    jest.advanceTimersByTime(999);
    expect(cache.get('n')).toBe(42);
  });

  it('overwrites an existing key with a new value and TTL', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'first', 10000);
    cache.set('k', 'second', 10000);
    expect(cache.get('k')).toBe('second');
  });

  it('handles multiple independent keys', () => {
    const cache = new TtlCache<number>();
    cache.set('a', 1, 5000);
    cache.set('b', 2, 5000);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
  });

  it('evicts only the expired key, not others with longer TTL', () => {
    const cache = new TtlCache<string>();
    cache.set('short', 'gone', 1000);
    cache.set('long', 'here', 10000);
    jest.advanceTimersByTime(2000);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('here');
  });

  it('stores and retrieves arrays', () => {
    const cache = new TtlCache<string[]>();
    cache.set('list', ['a', 'b', 'c'], 5000);
    expect(cache.get('list')).toEqual(['a', 'b', 'c']);
  });

  it('stores and retrieves objects', () => {
    const cache = new TtlCache<Record<string, number>>();
    cache.set('obj', { x: 1 }, 5000);
    expect(cache.get('obj')).toEqual({ x: 1 });
  });
});

// ── sanitizeUserId ────────────────────────────────────────────────────────

describe('sanitizeUserId', () => {
  it('lowercases all characters', () => {
    expect(sanitizeUserId('ALICE')).toBe('alice');
  });

  it('replaces spaces with hyphens', () => {
    expect(sanitizeUserId('John Doe')).toBe('john-doe');
  });

  it('replaces @ and . with hyphens (email format)', () => {
    expect(sanitizeUserId('alice@example.com')).toBe('alice-example-com');
  });

  it('collapses consecutive hyphens into one', () => {
    expect(sanitizeUserId('user--name')).toBe('user-name');
  });

  it('collapses hyphens produced by multiple replaced chars', () => {
    expect(sanitizeUserId('user@domain.com')).toBe('user-domain-com');
  });

  it('truncates to 63 characters', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeUserId(long)).toHaveLength(63);
  });

  it('preserves alphanumeric and existing hyphens', () => {
    expect(sanitizeUserId('user-123')).toBe('user-123');
  });

  it('handles an empty string', () => {
    expect(sanitizeUserId('')).toBe('');
  });

  it('handles a string of only special characters', () => {
    expect(sanitizeUserId('!@#$%')).toBe('-');
  });

  it('produces a valid K8s name segment for a typical Backstage user ref', () => {
    // Backstage user refs look like "user:default/john.doe"
    const result = sanitizeUserId('user:default/john.doe');
    expect(result).toMatch(/^[a-z0-9-]+$/);
    expect(result.length).toBeLessThanOrEqual(63);
  });
});

// ── normalizeRepoUrl ──────────────────────────────────────────────────────

describe('normalizeRepoUrl', () => {
  describe('when repoUrl is absent', () => {
    it('auto-builds from name and plain owner', () => {
      const result = normalizeRepoUrl({ name: 'my-service', owner: 'acme' });
      expect(result).toBe('github.com?owner=acme&repo=my-service');
    });

    it('extracts owner from a Backstage group ref (group:default/platform-team)', () => {
      const result = normalizeRepoUrl({ name: 'svc', owner: 'group:default/platform-team' });
      expect(result).toBe('github.com?owner=platform-team&repo=svc');
    });

    it('extracts owner from a user ref (user:default/john)', () => {
      const result = normalizeRepoUrl({ name: 'svc', owner: 'user:default/john' });
      expect(result).toBe('github.com?owner=john&repo=svc');
    });

    it('uses fallbackOrg when owner is missing', () => {
      const result = normalizeRepoUrl({ name: 'svc' }, 'my-org');
      expect(result).toBe('github.com?owner=my-org&repo=svc');
    });

    it('URL-encodes owner and repo names with special chars', () => {
      const result = normalizeRepoUrl({ name: 'my service', owner: 'my org' });
      expect(result).toContain('owner=my%20org');
      expect(result).toContain('repo=my%20service');
    });
  });

  describe('when repoUrl is a full HTTPS GitHub URL', () => {
    it('converts to picker format', () => {
      const result = normalizeRepoUrl({
        name: 'svc',
        owner: 'acme',
        repoUrl: 'https://github.com/acme-corp/my-service',
      });
      expect(result).toBe('github.com?owner=acme-corp&repo=my-service');
    });

    it('uses owner from URL, not from values.owner', () => {
      const result = normalizeRepoUrl({
        name: 'svc',
        owner: 'ignored',
        repoUrl: 'https://github.com/real-owner/real-repo',
      });
      expect(result).toContain('owner=real-owner');
      expect(result).toContain('repo=real-repo');
    });
  });

  describe('when repoUrl is already in picker format', () => {
    it('returns it unchanged', () => {
      const picker = 'github.com?owner=acme&repo=my-service';
      const result = normalizeRepoUrl({ name: 'svc', owner: 'acme', repoUrl: picker });
      expect(result).toBe(picker);
    });
  });
});

// ── parseTemplateRef ──────────────────────────────────────────────────────

describe('parseTemplateRef', () => {
  it('parses the full form with template: prefix', () => {
    expect(parseTemplateRef('template:default/nodejs-service')).toEqual({
      namespace: 'default',
      name: 'nodejs-service',
    });
  });

  it('parses without the template: prefix', () => {
    expect(parseTemplateRef('default/go-service')).toEqual({
      namespace: 'default',
      name: 'go-service',
    });
  });

  it('defaults namespace to "default" when only name is given', () => {
    expect(parseTemplateRef('my-template')).toEqual({
      namespace: 'default',
      name: 'my-template',
    });
  });

  it('handles a custom namespace', () => {
    expect(parseTemplateRef('template:production/java-service')).toEqual({
      namespace: 'production',
      name: 'java-service',
    });
  });

  it('handles template: prefix with no namespace segment', () => {
    expect(parseTemplateRef('template:my-template')).toEqual({
      namespace: 'default',
      name: 'my-template',
    });
  });
});

// ── parseMemoryValue ──────────────────────────────────────────────────────

describe('parseMemoryValue', () => {
  describe('recentServices', () => {
    it('splits a comma-separated list into an array', () => {
      expect(parseMemoryValue('recentServices', 'svc-a,svc-b,svc-c')).toEqual(['svc-a', 'svc-b', 'svc-c']);
    });

    it('trims whitespace around each entry', () => {
      expect(parseMemoryValue('recentServices', ' svc-a , svc-b ')).toEqual(['svc-a', 'svc-b']);
    });

    it('filters out empty strings from trailing commas', () => {
      expect(parseMemoryValue('recentServices', 'svc-a,')).toEqual(['svc-a']);
    });

    it('returns empty array for an empty string', () => {
      expect(parseMemoryValue('recentServices', '')).toEqual([]);
    });
  });

  describe('scaffoldCount', () => {
    it('parses a numeric string to an integer', () => {
      expect(parseMemoryValue('scaffoldCount', '7')).toBe(7);
    });

    it('returns 0 for a non-numeric string', () => {
      expect(parseMemoryValue('scaffoldCount', 'not-a-number')).toBe(0);
    });

    it('returns 0 for an empty string', () => {
      expect(parseMemoryValue('scaffoldCount', '')).toBe(0);
    });

    it('truncates decimals (parseInt behaviour)', () => {
      expect(parseMemoryValue('scaffoldCount', '3.9')).toBe(3);
    });
  });

  describe('other keys', () => {
    it('returns the raw string for preferredLanguage', () => {
      expect(parseMemoryValue('preferredLanguage', 'TypeScript')).toBe('TypeScript');
    });

    it('returns the raw string for defaultTeam', () => {
      expect(parseMemoryValue('defaultTeam', 'group:default/platform')).toBe('group:default/platform');
    });

    it('returns an empty string as-is', () => {
      expect(parseMemoryValue('defaultOwner', '')).toBe('');
    });
  });
});
