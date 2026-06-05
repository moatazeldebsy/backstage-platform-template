import { createBackendModule } from '@backstage/backend-plugin-api';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import type {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import { AuthorizeResult, PolicyDecision } from '@backstage/plugin-permission-common';

/**
 * Permission names that mutate state — blocked for unauthenticated (guest) users.
 * Guests can read the full catalog, browse templates, and view TechDocs,
 * but cannot run scaffolder templates or delete/refresh catalog entities.
 */
const GUEST_BLOCKED_PERMISSIONS = new Set([
  'scaffolder.task.create',   // run a template
  'scaffolder.task.cancel',   // cancel a running task
  'catalog.entity.delete',    // delete a catalog entity
]);

function isGuest(user?: PolicyQueryUser): boolean {
  if (!user?.info?.userEntityRef) return true;
  const ref = user.info.userEntityRef;
  // Backstage guest provider issues refs like "user:default/guest"
  return ref === 'user:default/guest' || ref.endsWith('/guest');
}

class IdpPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    if (isGuest(user) && GUEST_BLOCKED_PERMISSIONS.has(request.permission.name)) {
      return { result: AuthorizeResult.DENY };
    }
    return { result: AuthorizeResult.ALLOW };
  }
}

/**
 * Backend module that replaces the default allow-all policy with the IDP policy:
 * - Guests: read-only (catalog browse, template view, TechDocs)
 * - Authenticated users: full access
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
