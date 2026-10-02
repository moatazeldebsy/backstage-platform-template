import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import type {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import {
  AuthorizeResult,
  PolicyDecision,
  isResourcePermission,
} from '@backstage/plugin-permission-common';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';

/**
 * Permission names that mutate state — blocked for unauthenticated (guest) users.
 * Guests can read the full catalog, browse templates, and view TechDocs,
 * but cannot run scaffolder templates or delete/refresh catalog entities.
 */
export const GUEST_BLOCKED_PERMISSIONS = new Set([
  'scaffolder.task.create',   // run a template
  'scaffolder.task.cancel',   // cancel a running task
  'catalog.entity.delete',    // delete a catalog entity
]);

/**
 * Members of this group may do anything. Same group idp:decommission-service
 * checks; it is synced from the GitHub org's platform-team team (ADR-0004).
 */
export const PLATFORM_ADMIN_GROUP = 'group:default/platform-team';

/**
 * Catalog permissions a signed-in user only gets on entities they own (#155):
 * an entity whose spec.owner is the user or one of their groups. Deleting
 * another team's component from the portal used to be open to every user.
 */
export const OWNER_SCOPED_PERMISSIONS = new Set(['catalog.entity.delete']);

/**
 * Platform-admin only. Unregistering a location removes every entity it
 * produced at once, so it is not something to scope by owner.
 */
export const ADMIN_ONLY_PERMISSIONS = new Set(['catalog.location.delete']);

export function isPlatformAdmin(user?: PolicyQueryUser): boolean {
  return user?.info?.ownershipEntityRefs?.includes(PLATFORM_ADMIN_GROUP) ?? false;
}

export function isGuest(user?: PolicyQueryUser): boolean {
  if (!user?.info?.userEntityRef) return true;
  const ref = user.info.userEntityRef;
  // Backstage guest provider issues refs like "user:default/guest"
  return ref === 'user:default/guest' || ref.endsWith('/guest');
}

export class IdpPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    const name = request.permission.name;
    if (isGuest(user) && GUEST_BLOCKED_PERMISSIONS.has(name)) {
      return { result: AuthorizeResult.DENY };
    }
    if (isPlatformAdmin(user)) {
      return { result: AuthorizeResult.ALLOW };
    }
    if (ADMIN_ONLY_PERMISSIONS.has(name)) {
      return { result: AuthorizeResult.DENY };
    }
    if (
      OWNER_SCOPED_PERMISSIONS.has(name) &&
      isResourcePermission(request.permission, 'catalog-entity')
    ) {
      // Conditional: the catalog evaluates it per entity, so the UI hides
      // "Unregister entity" on entities the user does not own.
      return createCatalogConditionalDecision(
        request.permission,
        catalogConditions.isEntityOwner({
          claims: user?.info?.ownershipEntityRefs ?? [],
        }),
      );
    }
    return { result: AuthorizeResult.ALLOW };
  }
}

/**
 * Backend module that replaces the default allow-all policy with the IDP policy:
 * - Guests: read-only (catalog browse, template view, TechDocs)
 * - platform-team members: full access
 * - Other signed-in users: full access, except deleting catalog entities they
 *   do not own and unregistering catalog locations
 *
 * Registered in src/index.ts instead of
 * @backstage/plugin-permission-backend-module-allow-all-policy.
 */
export const idpPermissionPolicyModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'idp-permission-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new IdpPermissionPolicy());
      },
    });
  },
});
