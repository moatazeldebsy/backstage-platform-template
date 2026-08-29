import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import {
  DIMENSIONS,
  DimensionId,
  AiCostReport,
  EvaluationReport,
  MetricSample,
  WeightOverrides,
  AdvisorQuestion,
  answer as answerQuestion,
  buildAdvisorContext,
  costRecommendations,
  dimensionChanges,
  evidenceGaps,
  overallChange,
  scoreAiReadiness,
} from '@internal/engineering-intelligence-core';
import express, { NextFunction, Request, Response, Router } from 'express';
import { collectAndScore, CollectionOutcome } from './engineeringIntelligence/collect';
import {
  collectCatalog,
  CatalogEntity,
  PlatformFacts,
} from './engineeringIntelligence/catalog';
import {
  collectScaffolder,
  TaskOutcome,
} from './engineeringIntelligence/scaffolder';
import { collectMlflow } from './engineeringIntelligence/mlflow';
import { collectLangfuseScores } from './engineeringIntelligence/langfuseScores';
import { collectAiCost } from './engineeringIntelligence/aiCost';
import { collectLangfuse } from './engineeringIntelligence/langfuse';
import { collectOpenCost } from './engineeringIntelligence/opencost';
import { collectPrometheus } from './engineeringIntelligence/prometheus';
import { collectTechInsights } from './engineeringIntelligence/techInsights';
import { getJson } from './engineeringIntelligence/source';
import {
  ensureSchema,
  latestSnapshot,
  listSnapshots,
  saveSnapshot,
} from './engineeringIntelligence/store';

// Engineering Intelligence — the API over the scoring engine.
//
// The scoring itself lives in @internal/engineering-intelligence-core, which
// imports nothing from Backstage. This plugin only collects samples, hands them
// to the engine, persists the result and serves it. Keeping that split is what
// lets the phase-3 dashboard and the phase-9 AI Advisor consume the same scores
// instead of each growing their own copy — the failure mode this repo already
// has three instances of in its Bronze/Silver/Gold logic.
//
// See docs/engineering-intelligence/architecture.md.

/**
 * Wrap an async route so a rejected promise reaches Express.
 *
 * Express 4 does not await async handlers, so a rejection inside one is never
 * turned into a response — the request hangs open until the client times out,
 * and Node logs an unhandled rejection. That is exactly what an unauthenticated
 * request did here: `httpAuth.credentials()` rejects with AuthenticationError,
 * and the caller waited forever instead of being told 401.
 *
 * Forwarding to `next` hands the error to Backstage's own error middleware,
 * which maps AuthenticationError to 401 and anything else to 500.
 */
export function route(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

const DEFAULT_REFRESH_MINUTES = 30;
const MAX_SNAPSHOTS = 200;

function parseWeights(raw: unknown): WeightOverrides | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const known = new Set(DIMENSIONS.map(d => d.id as string));
  const out: WeightOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    out[key as DimensionId] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const engineeringIntelligencePlugin = createBackendPlugin({
  pluginId: 'engineering-intelligence',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
        database: coreServices.database,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
      },
      async init({
        httpRouter,
        config,
        database,
        logger,
        scheduler,
        discovery,
        auth,
        httpAuth,
      }) {
        const db = await database.getClient();
        await ensureSchema(db as any);

        const refreshMinutes =
          config.getOptionalNumber('engineeringIntelligence.refreshMinutes') ??
          DEFAULT_REFRESH_MINUTES;
        const weights = parseWeights(
          config.getOptional('engineeringIntelligence.weights'),
        );
        const enabled = (source: string) =>
          config.getOptionalBoolean(
            `engineeringIntelligence.sources.${source}`,
          ) ?? true;

        // ── Service-to-service access ────────────────────────────────────────

        async function serviceToken(targetPluginId: string): Promise<string> {
          const { token } = await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId,
          });
          return token;
        }

        /**
         * Component refs, needed by the Tech Insights collector to know what to
         * ask facts for. Fetched once per refresh and shared, rather than each
         * collector paging the catalog for itself.
         */
        async function componentRefs(): Promise<string[]> {
          const base = await discovery.getBaseUrl('catalog');
          const token = await serviceToken('catalog');
          const body = await getJson<CatalogEntity[]>(
            `${base}/entities?filter=kind=component` +
              `&fields=${encodeURIComponent('kind,metadata.name')}&limit=10000`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!Array.isArray(body)) return [];
          return body
            .map(e => e.metadata?.name)
            .filter((n): n is string => !!n)
            .map(name => `component:default/${name}`);
        }

        // ── Refresh ──────────────────────────────────────────────────────────

        const ctx = { config, logger };

        // The Platform Health breakdown from the most recent collection. Held in
        // memory rather than persisted: it is a current-state view, not a trend,
        // and the snapshot table exists for the numbers that need history.
        //
        // The consequence is that a restart which reuses an existing snapshot
        // has no breakdown until the next collection, so `/platform` collects
        // once on demand. `collectedThisProcess` stops that becoming a refresh
        // on every request when the catalog source is switched off.
        let platform: { facts?: PlatformFacts; tasks?: TaskOutcome } = {};
        let collectedThisProcess = false;

        // The raw samples from the most recent collection. AI readiness is a
        // second scoring pass over the *same* samples rather than a second
        // collection — running the collectors twice would double the load on
        // every source and could return two different answers for one question.
        let lastSamples: MetricSample[] = [];

        // The evaluation breakdown from the most recent collection, for
        // /evaluation. Held alongside the samples for the same reason the
        // platform facts are: a current-state view, not a trend.
        let lastEvaluation: EvaluationReport | undefined;
        let lastCost: AiCostReport | undefined;

        // Component name → owner, refreshed by the catalog collector and read by
        // the AI cost collector. Held rather than re-fetched so attribution uses
        // the same catalog snapshot the platform figures came from.
        let owners: Record<string, string> = {};

        async function refresh(): Promise<CollectionOutcome> {
          const collectors = [
            enabled('prometheus') ? () => collectPrometheus(ctx) : undefined,
            enabled('opencost') ? () => collectOpenCost(ctx) : undefined,
            enabled('langfuse') ? () => collectLangfuse(ctx) : undefined,
            enabled('catalog')
              ? async () => {
                  const result = await collectCatalog({
                    baseUrl: () => discovery.getBaseUrl('catalog'),
                    token: () => serviceToken('catalog'),
                  });
                  platform = { ...platform, facts: result.facts };
                  owners = result.owners ?? owners;
                  return result;
                }
              : undefined,
            enabled('mlflow') ? () => collectMlflow(ctx) : undefined,
            enabled('langfuse')
              ? async () => {
                  const result = await collectLangfuseScores(ctx);
                  lastEvaluation = result.evaluation;
                  return result;
                }
              : undefined,
            enabled('langfuse')
              ? async () => {
                  // Runs after the catalog collector in declaration order, but
                  // Promise.all makes that no guarantee — `owners` may still be
                  // the previous refresh's map on the very first collection.
                  // Attribution is then simply lower for one cycle, which is
                  // preferable to serialising every collector to fix it.
                  const result = await collectAiCost(ctx, { owners: () => owners });
                  lastCost = result.cost;
                  return result;
                }
              : undefined,
            enabled('scaffolder')
              ? async () => {
                  const result = await collectScaffolder({
                    baseUrl: () => discovery.getBaseUrl('scaffolder'),
                    token: () => serviceToken('scaffolder'),
                  });
                  platform = { ...platform, tasks: result.outcome };
                  return result;
                }
              : undefined,
            enabled('techInsights')
              ? () =>
                  collectTechInsights({
                    baseUrl: () => discovery.getBaseUrl('tech-insights'),
                    token: () => serviceToken('tech-insights'),
                    entityRefs: componentRefs,
                  })
              : undefined,
          ].filter((c): c is () => Promise<any> => !!c);

          const outcome = await collectAndScore(collectors, { weights });
          lastSamples = outcome.samples;
          collectedThisProcess = true;
          await saveSnapshot(db as any, outcome.report);

          const scored = Object.values(outcome.report.dimensions).filter(
            d => d.score !== null,
          ).length;
          logger.info(
            `Engineering Intelligence refreshed: ${scored}/${DIMENSIONS.length} dimensions scored, ` +
              `${outcome.unavailable.length} source(s) unavailable, ` +
              `maturity ${outcome.report.maturity.summary}`,
          );
          for (const u of outcome.unavailable) {
            logger.warn(`Engineering Intelligence source ${u.source}: ${u.reason}`);
          }
          return outcome;
        }

        // The initial delay lets the catalog and the tech-insights retriever
        // finish their own startup first; collecting immediately would record a
        // snapshot of an empty catalog as the platform's first data point.
        await scheduler.scheduleTask({
          id: 'engineering-intelligence-refresh',
          frequency: { minutes: refreshMinutes },
          initialDelay: { minutes: 2 },
          timeout: { minutes: 5 },
          fn: async () => {
            await refresh();
          },
        });

        // ── HTTP router ──────────────────────────────────────────────────────

        const router = Router();
        router.use(express.json());

        /** Latest persisted report, or a fresh collection if none exists yet. */
        async function currentReport() {
          const snapshot = await latestSnapshot(db as any);
          if (snapshot) return snapshot.report;
          return (await refresh()).report;
        }

        // GET /api/engineering-intelligence/health
        router.get('/health', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          res.json({
            ...report,
            // Named separately from `recommendations` throughout: a dimension we
            // cannot measure is work to do on the platform's instrumentation,
            // not a finding about the engineering organisation.
            evidenceGaps: evidenceGaps(report.dimensions),
          });
        }));

        // GET /api/engineering-intelligence/dimensions/:id
        router.get('/dimensions/:id', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const id = req.params.id as DimensionId;
          if (!DIMENSIONS.some(d => d.id === id)) {
            res.status(404).json({
              error: `Unknown dimension '${id}'.`,
              known: DIMENSIONS.map(d => d.id),
            });
            return;
          }
          const report = await currentReport();
          res.json(report.dimensions[id]);
        }));

        // GET /api/engineering-intelligence/report/executive
        //
        // The periodic summary: score, what moved, what is at risk, what to do.
        // Built entirely from the snapshot history and the current report — no
        // new collection, and no figure that is not already on another endpoint.
        router.get('/report/executive', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          const snapshots = await listSnapshots(db as any, 60);
          const summaries = snapshots.map(s => ({
            capturedAt: s.capturedAt,
            overallScore: s.report.overallScore,
            dimensions: Object.fromEntries(
              Object.entries(s.report.dimensions).map(([k, v]) => [k, v.score]),
            ),
          }));

          const changes = dimensionChanges(summaries);
          const movement = overallChange(summaries);

          res.json({
            generatedAt: report.generatedAt,
            overallScore: report.overallScore,
            status: report.status,
            maturity: report.maturity.summary,
            // Split rather than a signed list, because "what improved" and "what
            // declined" are read by different people for different reasons.
            improved: changes.filter(c => c.delta > 0),
            declined: changes.filter(c => c.delta < 0),
            // Absent, not zero, until there are two collections to compare.
            trend: movement
              ? { delta: movement.delta, sinceDays: movement.sinceDays, since: movement.since }
              : null,
            trendUnavailableReason: movement
              ? undefined
              : 'Fewer than two scored snapshots. Snapshots begin at first install and cannot be back-filled.',
            topRisks: report.recommendations.slice(0, 5).map(r => ({
              severity: r.severity,
              title: r.title,
              action: r.action,
              evidence: r.evidence[0]
                ? `${r.evidence[0].metric} = ${r.evidence[0].value} (${r.evidence[0].source})`
                : undefined,
            })),
            // Reported separately from risks throughout: a dimension nobody can
            // measure is work on the platform's instrumentation, not a finding
            // about the engineering organisation.
            cannotMeasure: evidenceGaps(report.dimensions),
            snapshotsAvailable: summaries.length,
          });
        }));

        // POST /api/engineering-intelligence/advisor
        //
        // Answers are computed from the report, not generated. Every question
        // below is a lookup or a subtraction, and a model asked the same thing
        // could only agree with the arithmetic or contradict it. The context is
        // returned alongside so a caller can see exactly what the answer was
        // derived from — and, if they choose to hand it to a model, exactly what
        // that model would be given.
        router.post('/advisor', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const question = String(
            (req.body ?? {}).question ?? '',
          ) as AdvisorQuestion;

          const known: AdvisorQuestion[] = [
            'biggest-risks',
            'why-changed',
            'focus-next',
            'teams-needing-attention',
            'ai-readiness',
            'reduce-cost',
          ];
          if (!known.includes(question)) {
            res.status(400).json({
              error: `Unknown question '${question}'.`,
              known,
            });
            return;
          }

          const report = await currentReport();
          const snapshots = await listSnapshots(db as any, 30);
          const summaries = snapshots.map(s => ({
            capturedAt: s.capturedAt,
            overallScore: s.report.overallScore,
            dimensions: Object.fromEntries(
              Object.entries(s.report.dimensions).map(([k, v]) => [k, v.score]),
            ),
          }));

          const context = buildAdvisorContext(report, {
            gaps: evidenceGaps(report.dimensions),
            cost: lastCost,
            snapshots: summaries,
          });

          res.json({
            ...answerQuestion(question, context, {
              changes: dimensionChanges(summaries),
            }),
            context,
          });
        }));

        // GET /api/engineering-intelligence/ai-cost
        router.get('/ai-cost', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          if (!lastCost && !collectedThisProcess) {
            await refresh();
          }
          if (!lastCost || lastCost.totalUsd <= 0) {
            res.json({
              generatedAt: report.generatedAt,
              available: false,
              reason:
                'No AI spend recorded in the window. Langfuse has to be deployed and receiving traces before cost can be attributed.',
            });
            return;
          }
          res.json({
            available: true,
            ...lastCost,
            recommendations: costRecommendations(lastCost),
          });
        }));

        // GET /api/engineering-intelligence/evaluation
        router.get('/evaluation', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          if (!lastEvaluation && !collectedThisProcess) {
            await refresh();
          }
          if (!lastEvaluation || lastEvaluation.assertions === 0) {
            res.json({
              generatedAt: report.generatedAt,
              available: false,
              reason:
                'No evaluation results recorded. push_to_langfuse.py only reaches a publicly reachable Langfuse, so CI runs against a cluster-local instance push nothing.',
            });
            return;
          }
          res.json({ available: true, ...lastEvaluation });
        }));

        // GET /api/engineering-intelligence/ai-readiness
        router.get('/ai-readiness', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          if (lastSamples.length === 0 && !collectedThisProcess) {
            await refresh();
          }
          res.json(scoreAiReadiness(lastSamples, report.generatedAt));
        }));

        // GET /api/engineering-intelligence/platform
        router.get('/platform', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          if (!platform.facts && !collectedThisProcess) {
            await refresh();
          }
          const facts = platform.facts;

          if (!facts) {
            res.json({
              generatedAt: report.generatedAt,
              available: false,
              reason:
                'The catalog has not been collected yet, or holds no Components.',
            });
            return;
          }

          res.json({
            generatedAt: report.generatedAt,
            available: true,
            services: facts.serviceCount,
            owned: facts.ownedCount,
            scaffolded: facts.scaffoldedCount,
            // Ratios are repeated from the dimension score so a reader does not
            // have to recompute them, but they come from the same facts — there
            // is one source of truth, not two.
            ownershipCoverage: facts.serviceCount
              ? facts.ownedCount / facts.serviceCount
              : null,
            goldenPathAdoption: facts.serviceCount
              ? facts.scaffoldedCount / facts.serviceCount
              : null,
            templateUsage: facts.templateUsage,
            // The actionable half: which services to actually move.
            notOnGoldenPath: {
              count: facts.serviceCount - facts.scaffoldedCount,
              named: facts.unscaffolded,
              truncated:
                facts.serviceCount - facts.scaffoldedCount > facts.unscaffolded.length,
            },
            selfService: platform.tasks
              ? {
                  completed: platform.tasks.completed,
                  failed: platform.tasks.failed,
                  inFlight: platform.tasks.inFlight,
                }
              : null,
            platformScore: report.dimensions.platform.score,
          });
        }));

        // GET /api/engineering-intelligence/maturity
        router.get('/maturity', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          res.json({
            generatedAt: report.generatedAt,
            ...report.maturity,
          });
        }));

        // GET /api/engineering-intelligence/recommendations
        router.get('/recommendations', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          res.json({
            generatedAt: report.generatedAt,
            recommendations: report.recommendations,
          });
        }));

        // GET /api/engineering-intelligence/snapshots?limit=30
        router.get('/snapshots', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const requested = Number(req.query.limit ?? 30);
          const limit = Number.isFinite(requested)
            ? Math.min(Math.max(Math.trunc(requested), 1), MAX_SNAPSHOTS)
            : 30;
          const snapshots = await listSnapshots(db as any, limit);
          res.json({
            // Snapshots start accumulating from first install; there is no
            // history to back-fill, because no source retains one.
            snapshots: snapshots.map(s => ({
              capturedAt: s.capturedAt,
              overallScore: s.report.overallScore,
              status: s.report.status,
              // The maturity level is what leadership actually tracks over time.
              // Reports written before phase 2 have no maturity block, so this
              // stays optional rather than assuming every stored row has one.
              maturityLevel: s.report.maturity?.currentLevel ?? null,
              maturityConfirmed: s.report.maturity?.confirmed ?? null,
              dimensions: Object.fromEntries(
                Object.entries(s.report.dimensions).map(([k, v]) => [k, v.score]),
              ),
            })),
          });
        }));

        // POST /api/engineering-intelligence/refresh
        router.post('/refresh', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const outcome = await refresh();
          res.json({
            generatedAt: outcome.report.generatedAt,
            overallScore: outcome.report.overallScore,
            status: outcome.report.status,
            unavailable: outcome.unavailable,
          });
        }));

        // No addAuthPolicy override: the default httpRouter policy already
        // requires credentials, and every handler asserts a user principal.
        httpRouter.use(router);

        logger.info(
          `Engineering Intelligence plugin initialized (refresh every ${refreshMinutes}m)`,
        );
      },
    });
  },
});
