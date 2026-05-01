import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  techInsightsFactRetrieversExtensionPoint,
  type TechInsightFact,
  type FactRetriever,
} from '@backstage/plugin-tech-insights-node';
import { CatalogClient } from '@backstage/catalog-client';
import { RELATION_OWNED_BY } from '@backstage/catalog-model';

const entityFactRetriever: FactRetriever = {
  id: 'idp-entity-facts',
  version: '0.1.0',
  title: 'IDP Entity Facts',
  description: 'Collects Bronze/Silver/Gold scorecard facts from catalog entities',
  entityFilter: [{ kind: 'Component' }],
  schema: {
    'has-owner': {
      type: 'boolean',
      description: 'Entity has an owner defined in spec.owner',
    },
    'has-techdocs': {
      type: 'boolean',
      description: 'Entity has a backstage.io/techdocs-ref annotation',
    },
    'has-health-probes': {
      type: 'boolean',
      description: 'Entity has backstage.io/kubernetes-id annotation (implies probes via Helm chart)',
    },
    'has-runbook-url': {
      type: 'boolean',
      description: 'Entity has a backstage.io/runbook-url annotation',
    },
    'has-api-definition': {
      type: 'boolean',
      description: 'Entity has at least one providesApis relation',
    },
    'uses-pinned-image-tag': {
      type: 'boolean',
      description: 'Entity image tag annotation is not "latest"',
    },
  },
  handler: async ({ entities, discovery, auth }) => {
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const catalogClient = new CatalogClient({ discoveryApi: discovery });

    const facts: TechInsightFact[] = [];

    for (const entity of entities) {
      const annotations = entity.metadata.annotations ?? {};
      const relations   = entity.relations ?? [];

      const hasOwner = Boolean(
        entity.spec?.owner &&
        relations.some(r => r.type === RELATION_OWNED_BY),
      );
      const hasTechDocs      = Boolean(annotations['backstage.io/techdocs-ref']);
      const hasHealthProbes  = Boolean(annotations['backstage.io/kubernetes-id']);
      const hasRunbookUrl    = Boolean(annotations['backstage.io/runbook-url']);
      const hasApiDefinition = relations.some(r => r.type === 'providesApi');
      const imageTag         = annotations['backstage.io/image-tag'] ?? '';
      const usesPinnedTag    = imageTag !== '' && imageTag !== 'latest';

      facts.push({
        entity: {
          namespace: entity.metadata.namespace ?? 'default',
          kind:      entity.kind,
          name:      entity.metadata.name,
        },
        facts: {
          'has-owner':             hasOwner,
          'has-techdocs':          hasTechDocs,
          'has-health-probes':     hasHealthProbes,
          'has-runbook-url':       hasRunbookUrl,
          'has-api-definition':    hasApiDefinition,
          'uses-pinned-image-tag': usesPinnedTag,
        },
      });
    }

    return facts;
  },
};

export const idpTechInsightsModule = createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'idp-entity-facts',
  register(env) {
    env.registerInit({
      deps: {
        factRetrievers: techInsightsFactRetrieversExtensionPoint,
      },
      async init({ factRetrievers }) {
        factRetrievers.addFactRetrievers({
          [entityFactRetriever.id]: entityFactRetriever,
        });
      },
    });
  },
});
