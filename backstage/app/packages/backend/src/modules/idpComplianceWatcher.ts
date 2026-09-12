import { createBackendPlugin, coreServices, RootConfigService } from '@backstage/backend-plugin-api';
import { ensureSchema, getState, saveState, detectRegressions } from './complianceWatcher/store';
import { postSlackRegression, createJiraIssue } from './complianceWatcher/notify';

// Compliance watcher — reacts to catalog/scorecard state, closing the
// "service becomes non-compliant -> notify owner -> ticket" loop from the
// Port.io-style gap analysis (roadmap item 2).
//
// Deliberately reads the `idp-entity-facts` Tech Insights retriever
// (idpTechInsights.ts) rather than recomputing anything: this platform
// already has three drifted implementations of the Bronze/Silver/Gold
// scorecard (scorecard.ts, idpTechInsights.ts, tech-insights-exporter.py —
// see engineeringIntelligence/techInsights.ts's comment on the same
// landmine). A fourth would make it worse, so this watcher never computes a
// tier — it reacts to individual boolean checks flipping true->false, which
// is also more actionable than "the tier dropped" on its own.
//
// Same scheduled-collector shape as idpEngineeringIntelligence.ts
// (coreServices.scheduler, service-to-service tokens via auth), with its
// own tiny Postgres-backed state table (backstage_plugin_idp-compliance-watcher)
// so a restart does not replay every fact as a fresh regression.

const DEFAULT_REFRESH_MINUTES = 30;

interface EntitySummary {
  ref: string;
  name: string;
  owner?: string;
  jiraProjectKey?: string;
}

interface CatalogEntityRow {
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string> };
  spec?: { owner?: string };
}

interface FactsResponse {
  [retrieverId: string]: { facts?: Record<string, unknown> } | undefined;
}

const RETRIEVER_ID = 'idp-entity-facts';

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T | undefined> {
  const res = await fetch(url, { headers });
  if (!res.ok) return undefined;
  return (await res.json()) as T;
}

// `${SLACK_WEBHOOK_URL}`/`${JIRA_TOKEN}` in app-config.yaml resolve to a
// literal empty string when the env var is unset (no `:-default` given,
// unlike jira.baseUrl's `:-https://jira.invalid`), and Backstage's config
// reader treats an empty string as an invalid `string` type rather than as
// "absent" — `getOptionalString` throws instead of returning undefined,
// which took the whole backend down at startup with SLACK_WEBHOOK_URL
// unset. Treat both "unset" and "" as the same "not configured" case.
function optionalNonEmptyString(config: RootConfigService, key: string): string | undefined {
  try {
    const value = config.getOptionalString(key);
    return value || undefined;
  } catch {
    return undefined;
  }
}

export const complianceWatcherPlugin = createBackendPlugin({
  pluginId: 'idp-compliance-watcher',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        database: coreServices.database,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
      },
      async init({ config, database, logger, scheduler, discovery, auth }) {
        const db = await database.getClient();
        await ensureSchema(db as any);

        const refreshMinutes =
          config.getOptionalNumber('complianceWatcher.refreshMinutes') ?? DEFAULT_REFRESH_MINUTES;
        const slackWebhookUrl = optionalNonEmptyString(config, 'complianceWatcher.slack.webhookUrl');
        const jiraBaseUrl = optionalNonEmptyString(config, 'complianceWatcher.jira.baseUrl');
        const jiraToken = optionalNonEmptyString(config, 'complianceWatcher.jira.token');

        async function serviceToken(targetPluginId: string): Promise<string> {
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId,
          });
          return token;
        }

        async function listComponents(): Promise<EntitySummary[]> {
          const base = await discovery.getBaseUrl('catalog');
          const token = await serviceToken('catalog');
          const fields = encodeURIComponent(
            'kind,metadata.name,metadata.namespace,metadata.annotations,spec.owner',
          );
          const rows = await getJson<CatalogEntityRow[]>(
            `${base}/entities?filter=kind=component&fields=${fields}&limit=10000`,
            { Authorization: `Bearer ${token}` },
          );
          return (rows ?? []).map(entity => ({
            ref: `component:${entity.metadata.namespace ?? 'default'}/${entity.metadata.name}`,
            name: entity.metadata.name,
            owner: entity.spec?.owner,
            jiraProjectKey: entity.metadata.annotations?.['jira/project-key'],
          }));
        }

        async function factsFor(entityRef: string): Promise<Record<string, boolean>> {
          const base = await discovery.getBaseUrl('tech-insights');
          const token = await serviceToken('tech-insights');
          const body = await getJson<FactsResponse>(
            `${base}/facts/latest?entity=${encodeURIComponent(entityRef)}&ids[]=${RETRIEVER_ID}`,
            { Authorization: `Bearer ${token}` },
          );
          const facts = body?.[RETRIEVER_ID]?.facts ?? {};
          const boolFacts: Record<string, boolean> = {};
          for (const [key, value] of Object.entries(facts)) {
            if (typeof value === 'boolean') boolFacts[key] = value;
          }
          return boolFacts;
        }

        async function refresh(): Promise<void> {
          const entities = await listComponents();
          let checked = 0;
          let regressed = 0;

          for (const entity of entities) {
            const current = await factsFor(entity.ref);
            if (Object.keys(current).length === 0) continue; // no facts recorded yet
            checked += 1;

            const previous = await getState(db as any, entity.ref);
            const failedChecks = detectRegressions(previous, current);

            if (failedChecks.length > 0) {
              regressed += 1;
              const event = {
                entityRef: entity.ref,
                entityName: entity.name,
                owner: entity.owner,
                failedChecks,
                jiraProjectKey: entity.jiraProjectKey,
              };
              const [slackSent, jiraIssue] = await Promise.all([
                postSlackRegression(event, { webhookUrl: slackWebhookUrl }),
                createJiraIssue(event, { baseUrl: jiraBaseUrl, token: jiraToken }),
              ]);
              logger.info(
                `Compliance regression on ${entity.ref}: ${failedChecks.join(', ')} ` +
                  `(slack=${slackSent}, jira=${jiraIssue?.key ?? 'skipped'})`,
              );
            }

            await saveState(db as any, entity.ref, current);
          }

          logger.info(
            `Compliance watcher refreshed: ${checked}/${entities.length} entities had facts, ` +
              `${regressed} regression(s) detected`,
          );
        }

        // Mirrors idpEngineeringIntelligence.ts's initial delay: let the
        // idp-entity-facts retriever produce its first pass before this
        // watcher reads it, or the first tick sees every entity as
        // fact-less and skips them all.
        await scheduler.scheduleTask({
          id: 'compliance-watcher-refresh',
          frequency: { minutes: refreshMinutes },
          initialDelay: { minutes: 3 },
          timeout: { minutes: 5 },
          fn: async () => {
            await refresh();
          },
        });
      },
    });
  },
});
