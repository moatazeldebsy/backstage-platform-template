import { createBackendModule, coreServices } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { Config } from '@backstage/config';

/**
 * Resolve the platform's own URLs for whichever environment Backstage is running in.
 *
 * 71 template files hardcoded `http://grafana.idp.local`, `http://argocd.idp.local`
 * and friends, so every service scaffolded on AWS got catalog links, runbook links
 * and README links pointing at DNS that only resolves on a laptop. Backstage
 * already knows the right values — `bootstrap.sh` and `bootstrap-ai.sh` write them
 * into `externalLinks.*` per environment — but a scaffolder template cannot read
 * app config. The backend can, hence this action.
 *
 * The defaults are the local hostnames, so a cluster with no `externalLinks`
 * configured behaves exactly as the hardcoded values did.
 */

/** Key in externalLinks -> the local default it falls back to. */
const LINKS: Record<string, string> = {
  grafana: 'http://grafana.idp.local',
  argocd: 'http://argocd.idp.local',
  backstage: 'http://backstage.idp.local',
  kagent: 'http://kagent.idp.local',
  mlflow: 'http://mlflow.idp.local',
  langfuse: 'http://langfuse.idp.local',
  prometheus: 'http://prometheus.idp.local',
};

function createPlatformUrlsAction(config: Config) {
  return createTemplateAction({
    id: 'idp:platform-urls',
    description:
      "Resolve the platform's Grafana / ArgoCD / Backstage / KAgent / MLflow / Langfuse / Prometheus URLs for the current environment, so generated catalog links point at the cluster the service actually runs on rather than at *.idp.local.",
    schema: {
      input: {},
      output: {
        grafana: z => z.string().describe('Grafana base URL'),
        argocd: z => z.string().describe('ArgoCD base URL'),
        backstage: z => z.string().describe('Backstage base URL'),
        kagent: z => z.string().describe('KAgent UI base URL'),
        mlflow: z => z.string().describe('MLflow base URL'),
        langfuse: z => z.string().describe('Langfuse base URL'),
        prometheus: z => z.string().describe('Prometheus base URL'),
      },
    },

    async handler(ctx) {
      for (const [key, fallback] of Object.entries(LINKS)) {
        // app.baseUrl is the authoritative Backstage URL; externalLinks.backstage
        // exists only in the local config.
        const value =
          key === 'backstage'
            ? config.getOptionalString('app.baseUrl') ??
              config.getOptionalString('externalLinks.backstage') ??
              fallback
            : config.getOptionalString(`externalLinks.${key}`) ?? fallback;

        // Strip a trailing slash so templates can append paths without doubling it.
        ctx.output(key as never, value.replace(/\/+$/, '') as never);
      }

      ctx.logger.info(
        'Resolved platform URLs from config — generated links will target this environment.',
      );
    },
  });
}

export const idpPlatformUrlsModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'idp-platform-urls',
  register(env) {
    env.registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ scaffolder, config }) {
        scaffolder.addActions(createPlatformUrlsAction(config));
      },
    });
  },
});
