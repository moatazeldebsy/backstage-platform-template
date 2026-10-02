import { AuthorizeResult } from '@backstage/plugin-permission-common';
import type { PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  ADMIN_ONLY_PERMISSIONS,
  GUEST_BLOCKED_PERMISSIONS,
  IdpPermissionPolicy,
  OWNER_SCOPED_PERMISSIONS,
  PLATFORM_ADMIN_GROUP,
  isGuest,
  isPlatformAdmin,
} from '../idpPermissionPolicy';

// PolicyQueryUser also carries token/identity/credentials, which the policy
// never reads — isGuest() looks only at info.userEntityRef. Building real
// credentials here would add noise without adding coverage, so the stub is
// narrowed once, in one place, rather than cast at every call site.
function makeUser(userEntityRef?: string, groups: string[] = []): PolicyQueryUser {
  return {
    info: {
      userEntityRef: userEntityRef ?? '',
      ownershipEntityRefs: userEntityRef ? [userEntityRef, ...groups] : groups,
    },
  } as unknown as PolicyQueryUser;
}

// catalog.entity.* permissions are resource permissions in the real catalog
// (resourceType 'catalog-entity'); the owner-scoped branch only fires for those.
function makeQuery(permissionName: string): PolicyQuery {
  const resourceType = permissionName.startsWith('catalog.entity.') ? 'catalog-entity' : undefined;
  return {
    permission: resourceType
      ? { type: 'resource', resourceType, name: permissionName, attributes: {} }
      : { type: 'basic', name: permissionName, attributes: {} },
  } as PolicyQuery;
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
    const alice = makeUser('user:default/alice', ['group:default/team-payments']);

    it.each([...GUEST_BLOCKED_PERMISSIONS].filter(p => !OWNER_SCOPED_PERMISSIONS.has(p)))(
      'allows %s for authenticated user',
      async permission => {
        const result = await policy.handle(makeQuery(permission), alice);
        expect(result.result).toBe(AuthorizeResult.ALLOW);
      },
    );

    // #155: deleting someone else's entity is no longer open to every user.
    it('scopes catalog.entity.delete to entities the user or their groups own', async () => {
      const result = await policy.handle(makeQuery('catalog.entity.delete'), alice);
      expect(result.result).toBe(AuthorizeResult.CONDITIONAL);
      expect(result).toMatchObject({
        pluginId: 'catalog',
        resourceType: 'catalog-entity',
        conditions: {
          rule: 'IS_ENTITY_OWNER',
          params: { claims: ['user:default/alice', 'group:default/team-payments'] },
        },
      });
    });

    it.each([...ADMIN_ONLY_PERMISSIONS])('denies %s for a non-admin user', async permission => {
      const result = await policy.handle(makeQuery(permission), alice);
      expect(result.result).toBe(AuthorizeResult.DENY);
    });

    it('still allows catalog.entity.refresh', async () => {
      const result = await policy.handle(makeQuery('catalog.entity.refresh'), alice);
      expect(result.result).toBe(AuthorizeResult.ALLOW);
    });
  });

  describe('platform admin', () => {
    const admin = makeUser('user:default/bob', [PLATFORM_ADMIN_GROUP]);

    it.each([...OWNER_SCOPED_PERMISSIONS, ...ADMIN_ONLY_PERMISSIONS])(
      'allows %s unconditionally',
      async permission => {
        const result = await policy.handle(makeQuery(permission), admin);
        expect(result.result).toBe(AuthorizeResult.ALLOW);
      },
    );
  });

  describe('guest user and admin-only permissions', () => {
    it.each([...ADMIN_ONLY_PERMISSIONS])('denies %s for guest', async permission => {
      const result = await policy.handle(makeQuery(permission), makeUser('user:default/guest'));
      expect(result.result).toBe(AuthorizeResult.DENY);
    });
  });
});

describe('isPlatformAdmin', () => {
  it('is true only for members of the platform-team group', () => {
    expect(isPlatformAdmin(makeUser('user:default/bob', [PLATFORM_ADMIN_GROUP]))).toBe(true);
    expect(isPlatformAdmin(makeUser('user:default/alice', ['group:default/team-payments']))).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });
});
