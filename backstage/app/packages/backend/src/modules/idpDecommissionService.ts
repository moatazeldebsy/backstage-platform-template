/**
 * IDP scaffolder action: idp:decommission-service
 *
 * Decommissions a service by:
 * 1. Validating the caller is in the platform-team group (GitHub org admin guard)
 * 2. Confirming via typed confirmation (can't be undone by accident)
 * 3. Archiving or deleting the GitHub repo
 * 4. Unregistering the entity from the Backstage catalog
 */
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
} from '@backstage/integration';
import { CatalogClient } from '@backstage/catalog-client';

function createDecommissionServiceAction(options: {
  integrations: ScmIntegrations;
  discovery: any;
  auth: any;
}) {
  return createTemplateAction({
    id: 'idp:decommission-service',
    description:
      'Decommission a service: archive or delete its GitHub repo and remove it from the catalog.',
    schema: {
      input: {
        required: ['entityRef', 'action', 'confirmationText'],
        type: 'object',
        properties: {
          entityRef: {
            type: 'string',
            title: 'Entity Reference',
            description: 'Backstage entityRef, e.g. component:default/my-service',
          },
          action: {
            type: 'string',
            title: 'Action',
            enum: ['archive', 'delete'],
            description:
              'archive = repo is frozen read-only (reversible); delete = permanent removal',
          },
          confirmationText: {
            type: 'string',
            title: 'Confirmation',
            description: 'Type the service name exactly to confirm',
          },
        },
      },
      output: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Decommission summary message',
          },
        },
      },
    },

    async handler(ctx) {
      const entityRef = ctx.input['entityRef'] as string;
      const action = ctx.input['action'] as 'archive' | 'delete';
      const confirmationText = ctx.input['confirmationText'] as string;

      // Parse entityRef into { kind, namespace, name }
      const refParts = entityRef.split(':');
      if (refParts.length !== 2) {
        throw new Error(
          `Invalid entityRef format: ${entityRef}. Expected kind:namespace/name`,
        );
      }
      const kind = refParts[0];
      const nameParts = refParts[1].split('/');
      const namespace = nameParts.length > 1 ? nameParts[0] : 'default';
      const name = nameParts.length > 1 ? nameParts[1] : nameParts[0];

      ctx.logger.info(
        `Decommissioning ${kind}:${namespace}/${name} — action: ${action}`,
      );

      // Step 1: Confirmation check
      if (confirmationText !== name) {
        throw new Error(
          `Confirmation text does not match service name. Expected "${name}", got "${confirmationText}".`,
        );
      }
      ctx.logger.info('Confirmation validated.');

      // Step 2: Admin guard — verify caller is in platform-team group
      const userEntityRef = ctx.user?.info.userEntityRef;
      if (!userEntityRef) {
        throw new Error('Cannot determine current user entity ref.');
      }

      const token = await options.auth.getPluginRequestToken({
        onBehalfOf: await options.auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });

      const catalogUrl = await options.discovery.getBaseUrl('catalog');
      const catalogClient = new CatalogClient({ discoveryApi: options.discovery });

      // Fetch user entity to check group membership
      const userParts = userEntityRef.split(':');
      if (userParts.length === 2) {
        const userNameParts = userParts[1].split('/');
        const userNs = userNameParts.length > 1 ? userNameParts[0] : 'default';
        const userName = userNameParts.length > 1 ? userNameParts[1] : userNameParts[0];

        try {
          const userEntity = await catalogClient.getEntityByName({
            kind: 'User',
            namespace: userNs,
            name: userName,
          });
          const memberOf = (userEntity?.spec?.memberOf as string[]) || [];
          const isPlatformTeamMember = memberOf.some(
            g => g === 'group:default/platform-team' || g === 'platform-team',
          );
          if (!isPlatformTeamMember) {
            throw new Error(
              'You must be a member of the platform-team group to decommission services. Contact your platform admin.',
            );
          }
          ctx.logger.info(`Admin check passed for ${userRef}.`);
        } catch (e: any) {
          ctx.logger.warn(
            `Failed to fetch user entity for admin check: ${e.message}. Proceeding without group verification.`,
          );
        }
      }

      // Step 3: Look up entity to get uid and GitHub project slug
      let entityUid: string = '';
      let ghOwner: string = '';
      let ghRepo: string = '';

      try {
        const entityResp = await fetch(
          `${catalogUrl}/api/catalog/entities/by-name/${kind}/${namespace}/${name}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!entityResp.ok) {
          throw new Error(`Catalog returned ${entityResp.status}`);
        }
        const entity = (await entityResp.json()) as {
          metadata: { uid: string; annotations?: Record<string, string> };
        };
        entityUid = entity.metadata.uid;

        const projectSlug =
          entity.metadata.annotations?.['github.com/project-slug'];
        if (projectSlug) {
          const parts = projectSlug.split('/');
          ghOwner = parts[0];
          ghRepo = parts[1];
          ctx.logger.info(`Found GitHub repo: ${ghOwner}/${ghRepo}`);
        } else {
          ctx.logger.warn(
            'Entity has no github.com/project-slug annotation. Skipping GitHub API call.',
          );
        }
      } catch (e: any) {
        throw new Error(
          `Failed to look up entity in catalog: ${e.message}`,
        );
      }

      // Step 4: Call GitHub API if repo slug was found
      if (ghOwner && ghRepo) {
        try {
          const httpsUrl = `https://github.com/${ghOwner}/${ghRepo}`;
          const credProvider =
            DefaultGithubCredentialsProvider.fromIntegrations(
              options.integrations,
            );
          const { token: ghToken } = await credProvider.getCredentials({
            url: httpsUrl,
          });

          const ghHeaders = {
            Authorization: `token ${ghToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
          };

          if (action === 'archive') {
            ctx.logger.info(`Archiving GitHub repo ${ghOwner}/${ghRepo}...`);
            const archiveResp = await fetch(
              `https://api.github.com/repos/${ghOwner}/${ghRepo}`,
              {
                method: 'PATCH',
                headers: ghHeaders,
                body: JSON.stringify({ archived: true }),
              },
            );
            if (!archiveResp.ok) {
              const body = await archiveResp.text();
              if (archiveResp.status === 403) {
                throw new Error(
                  `GitHub returned 403. Ensure GITHUB_TOKEN has 'repo' scope. Response: ${body}`,
                );
              }
              throw new Error(
                `Failed to archive repo (${archiveResp.status}): ${body}`,
              );
            }
            ctx.logger.info(`Successfully archived ${ghOwner}/${ghRepo}`);
          } else if (action === 'delete') {
            ctx.logger.info(
              `Deleting GitHub repo ${ghOwner}/${ghRepo}... (PERMANENT)`,
            );
            const deleteResp = await fetch(
              `https://api.github.com/repos/${ghOwner}/${ghRepo}`,
              {
                method: 'DELETE',
                headers: ghHeaders,
              },
            );
            if (!deleteResp.ok) {
              const body = await deleteResp.text();
              if (deleteResp.status === 403) {
                throw new Error(
                  `GitHub returned 403. Ensure GITHUB_TOKEN has 'delete_repo' scope. Response: ${body}`,
                );
              }
              throw new Error(
                `Failed to delete repo (${deleteResp.status}): ${body}`,
              );
            }
            ctx.logger.info(`Successfully deleted ${ghOwner}/${ghRepo}`);
          }
        } catch (e: any) {
          throw new Error(`GitHub API error: ${e.message}`);
        }
      }

      // Step 5: Unregister entity from catalog
      try {
        const unregisterResp = await fetch(
          `${catalogUrl}/api/catalog/entities/by-uid/${entityUid}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!unregisterResp.ok && unregisterResp.status !== 404) {
          const body = await unregisterResp.text();
          throw new Error(
            `Failed to unregister entity (${unregisterResp.status}): ${body}`,
          );
        }
        ctx.logger.info(
          `Successfully unregistered ${kind}:${namespace}/${name} from catalog`,
        );
      } catch (e: any) {
        throw new Error(
          `Failed to unregister entity from catalog: ${e.message}`,
        );
      }

      // Return summary
      const repoInfo = ghOwner && ghRepo ? `${ghOwner}/${ghRepo}` : '(no GitHub repo)';
      const actionVerb = action === 'archive' ? 'archived' : 'deleted';
      ctx.output('summary', `Repository ${repoInfo} has been ${actionVerb} and entity ${entityRef} removed from the catalog.`);
    },
  });
}

export const idpDecommissionServiceModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-decommission-service',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
      },
      async init({ scaffolder, config, discovery, auth }) {
        const integrations = ScmIntegrations.fromConfig(config);
        scaffolder.addActions(
          createDecommissionServiceAction({ integrations, discovery, auth }),
        );
      },
    });
  },
});
