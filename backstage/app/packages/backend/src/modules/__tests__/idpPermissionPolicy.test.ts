import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  GUEST_BLOCKED_PERMISSIONS,
  IdpPermissionPolicy,
  isGuest,
} from '../idpPermissionPolicy';

// PolicyQueryUser also carries token/identity/credentials, which the policy
// never reads — isGuest() looks only at info.userEntityRef. Building real
// credentials here would add noise without adding coverage, so the stub is
// narrowed once, in one place, rather than cast at every call site.
function makeUser(userEntityRef?: string): PolicyQueryUser {
  return {
    info: { userEntityRef: userEntityRef ?? '', ownershipEntityRefs: [] },
  } as unknown as PolicyQueryUser;
}

function makeQuery(permissionName: string): PolicyQuery {
  return { permission: { name: permissionName, attributes: {} } } as PolicyQuery;
}

const policy = new IdpPermissionPolicy();

// ── isGuest ───────────────────────────────────────────────────────────────────

describe('isGuest', () => {
  it('returns true when user is undefined', () => {
    expect(isGuest(undefined)).toBe(true);
  });

  it('returns true when userEntityRef is missing', () => {
    expect(
      isGuest({ info: { ownershipEntityRefs: [] } } as unknown as PolicyQueryUser),
    ).toBe(true);
  });

  it('returns true for exact user:default/guest ref', () => {
    expect(isGuest(makeUser('user:default/guest'))).toBe(true);
  });

  it('returns true for any ref ending in /guest', () => {
    expect(isGuest(makeUser('user:production/guest'))).toBe(true);
    expect(isGuest(makeUser('user:staging/guest'))).toBe(true);
  });

  it('returns false for a real authenticated user', () => {
    expect(isGuest(makeUser('user:default/alice'))).toBe(false);
  });

  it('returns false for a user whose name contains guest but does not end in /guest', () => {
    expect(isGuest(makeUser('user:default/guesthouse'))).toBe(false);
    expect(isGuest(makeUser('user:default/my-guest-user'))).toBe(false);
  });

  it('returns false for a group entity ref', () => {
    expect(isGuest(makeUser('group:default/team-platform'))).toBe(false);
  });
});

// ── GUEST_BLOCKED_PERMISSIONS ─────────────────────────────────────────────────

describe('GUEST_BLOCKED_PERMISSIONS', () => {
  it('blocks scaffolder.task.create', () => {
    expect(GUEST_BLOCKED_PERMISSIONS.has('scaffolder.task.create')).toBe(true);
  });

  it('blocks scaffolder.task.cancel', () => {
    expect(GUEST_BLOCKED_PERMISSIONS.has('scaffolder.task.cancel')).toBe(true);
  });

  it('blocks catalog.entity.delete', () => {
    expect(GUEST_BLOCKED_PERMISSIONS.has('catalog.entity.delete')).toBe(true);
  });

  it('does not block catalog read permissions', () => {
    expect(GUEST_BLOCKED_PERMISSIONS.has('catalog.entity.read')).toBe(false);
  });
});

// ── IdpPermissionPolicy.handle ────────────────────────────────────────────────

describe('IdpPermissionPolicy', () => {
  describe('guest user', () => {
    const guest = makeUser('user:default/guest');

    it.each([...GUEST_BLOCKED_PERMISSIONS])(
      'denies %s for guest',
      async permission => {
        const result = await policy.handle(makeQuery(permission), guest);
        expect(result.result).toBe(AuthorizeResult.DENY);
      },
    );

    it('allows catalog.entity.read for guest', async () => {
      const result = await policy.handle(makeQuery('catalog.entity.read'), guest);
      expect(result.result).toBe(AuthorizeResult.ALLOW);
    });

    it('allows techdocs.entity.read for guest', async () => {
      const result = await policy.handle(makeQuery('techdocs.entity.read'), guest);
      expect(result.result).toBe(AuthorizeResult.ALLOW);
    });

    it('allows scaffolder.template.read for guest (browse templates)', async () => {
      const result = await policy.handle(makeQuery('scaffolder.template.read'), guest);
      expect(result.result).toBe(AuthorizeResult.ALLOW);
    });
  });

  describe('unauthenticated (no user)', () => {
    it('denies blocked permissions when user is undefined', async () => {
      const result = await policy.handle(makeQuery('scaffolder.task.create'), undefined);
      expect(result.result).toBe(AuthorizeResult.DENY);
    });

    it('allows read permissions when user is undefined', async () => {
      const result = await policy.handle(makeQuery('catalog.entity.read'), undefined);
      expect(result.result).toBe(AuthorizeResult.ALLOW);
    });
  });

  describe('authenticated user', () => {
    const alice = makeUser('user:default/alice');

    it.each([...GUEST_BLOCKED_PERMISSIONS])(
      'allows %s for authenticated user',
      async permission => {
        const result = await policy.handle(makeQuery(permission), alice);
        expect(result.result).toBe(AuthorizeResult.ALLOW);
      },
    );

    it('allows catalog.entity.delete for authenticated user', async () => {
      const result = await policy.handle(makeQuery('catalog.entity.delete'), alice);
      expect(result.result).toBe(AuthorizeResult.ALLOW);
    });
  });
});
