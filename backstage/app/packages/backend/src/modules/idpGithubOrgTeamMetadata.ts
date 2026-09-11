/**
 * Overlays platform-specific annotations (cost budget, cost namespace) onto
 * Group entities synced from GitHub Org Teams by
 * `@backstage/plugin-catalog-backend-module-github-org`.
 *
 * That provider fully owns every Group entity it emits — anything hand-added
 * to the synced entity would be wiped on the next sync (30 min on AWS). The
 * only supported hook is a custom `TeamTransformer` passed through
 * `githubOrgEntityProviderTransformsExtensionPoint`, so this module wraps the
 * library's own `defaultOrganizationTeamTransformer` and merges in
 * annotations from `catalog.teamMetadata` (app-config.yaml — shared across
 * local/AWS since budgets aren't environment-specific), keyed by GitHub team
 * slug. Teams with no entry in `catalog.teamMetadata` sync unchanged.
 *
 * This keeps the Budget entity tab (queries
 * idp_team_actual_cost_usd_monthly{team=...}) working the same way it did
 * when these annotations were hand-written into catalog-info.yaml.
 */
import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { githubOrgEntityProviderTransformsExtensionPoint } from '@backstage/plugin-catalog-backend-module-github-org';
import { defaultOrganizationTeamTransformer } from '@backstage/plugin-catalog-backend-module-github';
import type { Config } from '@backstage/config';
import type { GroupEntity } from '@backstage/catalog-model';

export function buildTeamMetadataTransformer(config: Config) {
  const metadataConfig = config.getOptionalConfig('catalog.teamMetadata');

  return async (...args: Parameters<typeof defaultOrganizationTeamTransformer>) => {
    const entity = await defaultOrganizationTeamTransformer(...args);
    if (!entity) return entity;

    const slug = entity.metadata.name;
    const teamConfig = metadataConfig?.getOptionalConfig(slug);
    if (!teamConfig) return entity;

    const group = entity as GroupEntity;
    group.metadata.annotations = {
      ...group.metadata.annotations,
      ...(teamConfig.getOptionalString('costBudgetMonthlyUsd')
        ? { 'idp.io/cost-budget-monthly-usd': teamConfig.getString('costBudgetMonthlyUsd') }
        : {}),
      ...(teamConfig.getOptionalString('costNamespace')
        ? { 'idp.io/cost-namespace': teamConfig.getString('costNamespace') }
        : {}),
    };
    return group;
  };
}

export const idpGithubOrgTeamMetadataModule = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'idp-github-org-team-metadata',
  register(env) {
    env.registerInit({
      deps: {
        githubOrgTransforms: githubOrgEntityProviderTransformsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ githubOrgTransforms, config }) {
        githubOrgTransforms.setTeamTransformer(buildTeamMetadataTransformer(config));
      },
    });
  },
});
