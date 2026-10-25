import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import {
  DIMENSIONS,
  DimensionId,
  AiCostReport,
  EvaluationReport,
  MetricSample,
  WeightOverrides,
  AdvisorQuestion,
  Core4Report,
  Core4TeamInput,
  HealthReport,
  answer as answerQuestion,
  core4Changes,
  scoreCore4,
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
import { collectLitellmSpend } from './engineeringIntelligence/litellmSpend';
import { collectLangfuse } from './engineeringIntelligence/langfuse';
import { collectOpenCost } from './engineeringIntelligence/opencost';
import { collectPrometheus } from './engineeringIntelligence/prometheus';
import { collectTechInsights } from './engineeringIntelligence/techInsights';
import { collectThroughput } from './engineeringIntelligence/throughput';
import {
  SurveyAggregateResponse,
  collectSurvey,
  teamInputs,
} from './engineeringIntelligence/devexSurvey';
import { getJson } from './engineeringIntelligence/source';
import {
  ensureSchema,
  latestSnapshot,
  listSnapshots,
  saveSnapshot,
  snapshotsSince,
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

/**
 * Whether this process's in-memory views (platform facts, samples, evaluation,
 * cost) need a collection before they are served.
 *
 * The scheduled refresh is a *global* task: with more than one Backstage
 * replica, only the one holding the scheduler lock runs it. Every other replica
 * used to collect once on its first request and then serve that result forever,
 * so behind a load balancer the same page alternated between current and
 * frozen data. Treating views as stale after 1.5× the refresh interval leaves
 * the lock holder untouched (its task keeps them younger than that) and bounds
 * how old any other replica's views can get. The extra half-interval keeps an
 * on-demand collection from racing a scheduled one that is merely running late.
 */
export function viewsAreStale(
  lastCollectedAt: number | undefined,
  now: number,
  refreshMinutes: number,
): boolean {
  if (lastCollectedAt === undefined) return true;
  return now - lastCollectedAt > refreshMinutes * 60_000 * 1.5;
}
const MAX_SNAPSHOTS = 200;

/** How far back the Core 4 comparison reaches — a quarter. */
const CORE4_BASELINE_DAYS = 90;
/** The youngest snapshot a Core 4 movement may be measured against. */
const CORE4_MIN_BASELINE_DAYS = 7;

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
        // has no breakdown until the next collection, so the view endpoints
        // collect on demand. `lastCollectedAt` (see viewsAreStale) bounds that
        // to once per interval — rather than on every request when the catalog
        // source is switched off — and keeps replicas that do not hold the
        // scheduler lock from serving their first collection forever.
        let platform: { facts?: PlatformFacts; tasks?: TaskOutcome } = {};
        let lastCollectedAt: number | undefined;
        let inflightViewRefresh: Promise<unknown> | undefined;

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

        // Team-level Core 4 inputs from the most recent collection. Set by the
        // throughput and survey collectors, read once both have finished, so
        // the Core 4 report is attached to the same snapshot as the scores.
        let lastThroughputTeams: Core4TeamInput[] = [];
        let lastSurvey: SurveyAggregateResponse | undefined;

        /**
         * `persist: false` is for on-demand view refreshes: the snapshot table
         * is the trend history, written once per interval by the scheduled
         * task, and extra rows from other replicas would show up as
         * near-duplicate points in "what moved".
         */
        async function refresh(
          { persist = true }: { persist?: boolean } = {},
        ): Promise<CollectionOutcome> {
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
            // Parallel to the langfuse ai-cost collector above — a distinct,
            // never-merged signal (ai.litellmSpendUsd vs. ai.costAttributedRatio).
            // See litellmSpend.ts's header comment for why. No `lastX` state is
            // held here because nothing else in this module reads it back —
            // unlike lastCost, this collector's output is samples only.
            enabled('litellm') ? () => collectLitellmSpend(ctx) : undefined,
            // DX Core 4 inputs. Both collectors hold their team rows rather than
            // emitting team-labelled samples: the scoring engine takes one
            // sample per metric, so a per-team sample would be read as the
            // organisation's figure.
            enabled('devexSurvey')
              ? async () => {
                  const result = await collectSurvey({
                    baseUrl: () => discovery.getBaseUrl('devex-survey'),
                    token: () => serviceToken('devex-survey'),
                  });
                  lastSurvey = result.survey;
                  return result;
                }
              : undefined,
            enabled('throughput')
              ? async () => {
                  const result = await collectThroughput(ctx, {
                    baseUrl: () => discovery.getBaseUrl('catalog'),
                    token: () => serviceToken('catalog'),
                  });
                  lastThroughputTeams = result.teams ?? [];
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
          outcome.report.core4 = scoreCore4(outcome.samples, {
            generatedAt: outcome.report.generatedAt,
            teams: teamInputs(lastThroughputTeams, lastSurvey),
          });
          lastSamples = outcome.samples;
          lastCollectedAt = Date.now();
          if (persist) await saveSnapshot(db as any, outcome.report);

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

        /**
         * The Core 4 view: the current report's, the quarter-ago baseline's
         * movement against it, and which survey cycle it reflects.
         */
        async function core4View(report: HealthReport) {
          let core4: Core4Report | undefined = report.core4;
          if (!core4) {
            // A snapshot written before Core 4 existed. Score the in-memory
            // samples instead of returning nothing until the next collection.
            await ensureFreshViews();
            core4 = scoreCore4(lastSamples, {
              generatedAt: report.generatedAt,
              teams: teamInputs(lastThroughputTeams, lastSurvey),
            });
          }
          const since = new Date(
            Date.parse(report.generatedAt) - CORE4_BASELINE_DAYS * 86_400_000,
          ).toISOString();
          // At least a week old: against a snapshot from half an hour ago every
          // delta is noise, and a page showing "+0.3" invites a reading of it.
          const latestBaseline = Date.parse(report.generatedAt) - CORE4_MIN_BASELINE_DAYS * 86_400_000;
          const baseline = (await snapshotsSince(db as any, since, 50)).find(
            s => s.report.core4 && Date.parse(s.capturedAt) <= latestBaseline,
          );
          return {
            ...core4,
            // Null until there is an earlier Core 4 snapshot to compare with —
            // the same no-back-fill rule the executive report follows.
            change: baseline
              ? {
                  since: baseline.capturedAt,
                  sinceDays: Math.round(
                    (Date.parse(report.generatedAt) - Date.parse(baseline.capturedAt)) / 86_400_000,
                  ),
                  areas: core4Changes(core4, baseline.report.core4!),
                }
              : null,
            survey: lastSurvey?.cycle
              ? { cycle: lastSurvey.cycle, responses: lastSurvey.org?.responses ?? 0, minResponses: lastSurvey.minResponses }
              : null,
          };
        }

        /** Collect for the in-memory views if they are stale; concurrent callers share one collection. */
        async function ensureFreshViews(): Promise<void> {
          if (!viewsAreStale(lastCollectedAt, Date.now(), refreshMinutes)) return;
          inflightViewRefresh ??= refresh({ persist: false }).finally(() => {
            inflightViewRefresh = undefined;
          });
          await inflightViewRefresh;
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
            core4: await core4View(report).then(
              v => ({
                areas: Object.values(v.areas).map(a => ({
                  area: a.dimension,
                  label: a.label,
                  score: a.score,
                  status: a.status,
                  keyLabel: a.keyLabel,
                  key: a.key?.value ?? null,
                })),
                change: v.change,
                guardrail: v.guardrail,
              }),
              () => null,
            ),
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
          await ensureFreshViews();
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
          await ensureFreshViews();
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

        // GET /api/engineering-intelligence/core4
        //
        // DX Core 4 for leadership. Readable by backend callers as well as
        // users, so the AI Assistant's idp-mcp-server can answer "how did
        // Effectiveness move this quarter" from the same numbers the page shows.
        router.get('/core4', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user', 'service'] });
          res.json(await core4View(await currentReport()));
        }));

        // GET /api/engineering-intelligence/ai-readiness
        router.get('/ai-readiness', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          await ensureFreshViews();
          res.json(scoreAiReadiness(lastSamples, report.generatedAt));
        }));

        // GET /api/engineering-intelligence/platform
        router.get('/platform', route(async (req, res) => {
          await httpAuth.credentials(req, { allow: ['user'] });
          const report = await currentReport();
          await ensureFreshViews();
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
