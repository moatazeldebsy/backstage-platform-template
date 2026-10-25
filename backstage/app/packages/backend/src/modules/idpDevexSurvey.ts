import {
  createBackendPlugin,
  coreServices,
  type DatabaseService,
  type HttpAuthService,
} from '@backstage/backend-plugin-api';
import {
  MIN_RESPONSES,
  SurveyAnswers,
  aggregateSurvey,
  validateAnswers,
} from '@internal/engineering-intelligence-core';
import { createHmac, randomBytes } from 'crypto';
import express, { Router, type Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { PLATFORM_ADMIN_GROUP } from './idpPermissionPolicy';

type Db = Awaited<ReturnType<DatabaseService['getClient']>>;

/** Who is asking, resolved server-side from verified credentials. */
export interface Respondent {
  userRef: string;
  /** Group entity refs the user belongs to, e.g. `group:default/payments`. */
  groups: string[];
}

/** Team label used when the respondent belongs to no catalog Group. */
export const UNASSIGNED_TEAM = 'unassigned';

const MAX_CYCLE_DAYS = 60;
const DEFAULT_CYCLE_DAYS = 14;

/** `group:default/payments` → `payments`, matching the owner names EI already uses. */
export function teamName(groupRef: string): string {
  return groupRef.includes('/') ? groupRef.split('/').pop()! : groupRef;
}

/**
 * The respondent key stored with an answer.
 *
 * Keyed per cycle, so one quarter's answers cannot be joined to the next
 * person-by-person, and salted with a per-install secret, so the hash of a known
 * user ref cannot be recomputed from outside. It exists for one purpose: refusing
 * a second response from the same person in the same cycle.
 */
export function respondentKey(salt: string, cycleId: number, userRef: string): string {
  return createHmac('sha256', salt).update(`${cycleId}:${userRef}`).digest('hex');
}

interface CycleRow {
  id: number;
  title: string;
  opens_at: string | Date;
  closes_at: string | Date;
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function cycleView(row: CycleRow, now: Date) {
  const closesAt = iso(row.closes_at);
  return {
    id: row.id,
    title: row.title,
    opensAt: iso(row.opens_at),
    closesAt,
    open: new Date(closesAt) > now,
  };
}

function parseAnswers(raw: unknown): SurveyAnswers {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as SurveyAnswers;
}

/**
 * Survey routes on their own, so they can be tested against an in-memory
 * database without a backend — the same split idpLearningCenter.ts uses.
 *
 * What is served is aggregates only. No route returns a response row, a
 * respondent key, or a team's figures below the floor.
 */
export function createDevexSurveyRouter(opts: {
  db: Db;
  httpAuth: HttpAuthService;
  /** Resolves the signed-in user and their groups; rejects non-user callers. */
  identify: (req: Request) => Promise<Respondent>;
  salt: string;
  minResponses?: number;
  now?: () => Date;
  rateLimitPerMinute?: number;
}): Router {
  const { db, httpAuth, identify, salt } = opts;
  const minResponses = opts.minResponses ?? MIN_RESPONSES;
  const now = opts.now ?? (() => new Date());
  const router = Router();

  // Keyed on the bearer token rather than the IP, for the reason given in
  // idpLearningCenter.ts: many users share an address behind the ingress.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: opts.rateLimitPerMinute ?? 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: req => req.headers.authorization ?? ipKeyGenerator(req.ip ?? ''),
    }),
  );
  router.use(express.json());

  const openCycle = async (): Promise<CycleRow | undefined> =>
    db('devex_survey_cycles')
      .where('opens_at', '<=', now().toISOString())
      .andWhere('closes_at', '>', now().toISOString())
      .orderBy('opens_at', 'desc')
      .first();

  const teamsOf = (r: Respondent) => {
    const teams = r.groups.filter(g => g.startsWith('group:')).map(teamName);
    return teams.length > 0 ? teams : [UNASSIGNED_TEAM];
  };

  // Express 4 does not catch a rejected async handler, so each route passes
  // errors to next() — otherwise a refused credential leaves the request hanging.

  // GET /current -> { cycle | null, answered, teams }
  router.get('/current', async (req, res, next) => {
    try {
      const respondent = await identify(req);
      const cycle = await openCycle();
      const answered = cycle
        ? !!(await db('devex_survey_responses')
            .where({ cycle_id: cycle.id, respondent: respondentKey(salt, cycle.id, respondent.userRef) })
            .first())
        : false;
      res.json({
        cycle: cycle ? cycleView(cycle, now()) : null,
        answered,
        teams: teamsOf(respondent),
        isAdmin: respondent.groups.includes(PLATFORM_ADMIN_GROUP),
        minResponses,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /responses { cycleId, team, answers }
  router.post('/responses', async (req, res, next) => {
    try {
      const respondent = await identify(req);
      const { cycleId, team, answers } = req.body ?? {};
      const cycle = await openCycle();
      if (!cycle || cycle.id !== cycleId) {
        res.status(409).json({ error: 'That survey cycle is not open.' });
        return;
      }
      // The team must be one the user actually belongs to. A free-text team
      // would let anyone push a small team's aggregate over the floor, or skew
      // a team they are not on.
      if (typeof team !== 'string' || !teamsOf(respondent).includes(team)) {
        res.status(400).json({ error: 'team must be one of your catalog groups' });
        return;
      }
      const validated = validateAnswers(answers);
      if ('error' in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }
      const inserted = await db('devex_survey_responses')
        .insert({
          cycle_id: cycle.id,
          respondent: respondentKey(salt, cycle.id, respondent.userRef),
          team,
          answers: JSON.stringify(validated.answers),
        })
        .onConflict(['cycle_id', 'respondent'])
        .ignore()
        .returning('cycle_id');
      if (inserted.length === 0) {
        res.status(409).json({ error: 'You have already answered this cycle.' });
        return;
      }
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /cycles { title, days } — platform team only
  router.post('/cycles', async (req, res, next) => {
    try {
      const respondent = await identify(req);
      if (!respondent.groups.includes(PLATFORM_ADMIN_GROUP)) {
        res.status(403).json({ error: `Only ${PLATFORM_ADMIN_GROUP} can open a survey cycle.` });
        return;
      }
      if (await openCycle()) {
        res.status(409).json({ error: 'A cycle is already open.' });
        return;
      }
      const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 120) : '';
      const days = Number(req.body?.days ?? DEFAULT_CYCLE_DAYS);
      if (!title || !Number.isInteger(days) || days < 1 || days > MAX_CYCLE_DAYS) {
        res.status(400).json({ error: `title (string) and days (1–${MAX_CYCLE_DAYS}) are required` });
        return;
      }
      const opensAt = now();
      const closesAt = new Date(opensAt.getTime() + days * 86_400_000);
      const [row] = await db('devex_survey_cycles')
        .insert({ title, opens_at: opensAt.toISOString(), closes_at: closesAt.toISOString() })
        .returning(['id', 'title', 'opens_at', 'closes_at']);
      res.status(201).json(cycleView(row, now()));
    } catch (err) {
      next(err);
    }
  });

  // POST /cycles/:id/close — platform team only
  router.post('/cycles/:id/close', async (req, res, next) => {
    try {
      const respondent = await identify(req);
      if (!respondent.groups.includes(PLATFORM_ADMIN_GROUP)) {
        res.status(403).json({ error: `Only ${PLATFORM_ADMIN_GROUP} can close a survey cycle.` });
        return;
      }
      const updated = await db('devex_survey_cycles')
        .where({ id: Number(req.params.id) })
        .andWhere('closes_at', '>', now().toISOString())
        .update({ closes_at: now().toISOString() });
      res.status(updated ? 200 : 404).json({ ok: !!updated });
    } catch (err) {
      next(err);
    }
  });

  // GET /aggregate -> the most recent cycle that has opened, org-wide and per team
  //
  // Readable by any signed-in user and by other backend plugins (Engineering
  // Intelligence collects from it). Everything below the floor is withheld, and
  // everything is withheld while the cycle is still open.
  router.get('/aggregate', async (req, res, next) => {
    try {
      await httpAuth.credentials(req, { allow: ['user', 'service'] });
      const cycle: CycleRow | undefined = await db('devex_survey_cycles')
        .where('opens_at', '<=', now().toISOString())
        .orderBy('opens_at', 'desc')
        .first();
      if (!cycle) {
        res.json({ cycle: null, minResponses });
        return;
      }
      const rows: { team: string; answers: unknown }[] = await db('devex_survey_responses')
        .where({ cycle_id: cycle.id })
        .select('team', 'answers');
      const view = cycleView(cycle, now());
      // While a cycle is open, counts only. A live mean moves with every
      // submission, so reading it just before and just after a colleague
      // answers recovers their answers exactly — the floor protects a static
      // group, not a growing one. Means are served once the set is final.
      const floor = view.open ? Infinity : minResponses;
      const byTeam = new Map<string, SurveyAnswers[]>();
      for (const row of rows) {
        const list = byTeam.get(row.team) ?? [];
        list.push(parseAnswers(row.answers));
        byTeam.set(row.team, list);
      }
      res.json({
        cycle: view,
        minResponses,
        org: aggregateSurvey(rows.map(r => parseAnswers(r.answers)), floor),
        teams: [...byTeam.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([team, answers]) => ({ team, ...aggregateSurvey(answers, floor) })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// DevEx survey: the self-reported half of DX Core 4 (see
// docs/engineering-intelligence/core4.md). Backed by its own Postgres database
// (backstage_plugin_devex-survey), the same pattern as learning-center.
export const devexSurveyPlugin = createBackendPlugin({
  pluginId: 'devex-survey',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        logger: coreServices.logger,
      },
      async init({ httpRouter, database, httpAuth, userInfo, logger }) {
        const db = await database.getClient();

        await db.raw(`
          CREATE TABLE IF NOT EXISTS devex_survey_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);
        await db.raw(`
          CREATE TABLE IF NOT EXISTS devex_survey_cycles (
            id        SERIAL      PRIMARY KEY,
            title     TEXT        NOT NULL,
            opens_at  TIMESTAMPTZ NOT NULL,
            closes_at TIMESTAMPTZ NOT NULL
          )
        `);
        await db.raw(`
          CREATE TABLE IF NOT EXISTS devex_survey_responses (
            cycle_id     INTEGER     NOT NULL REFERENCES devex_survey_cycles(id),
            respondent   TEXT        NOT NULL,
            team         TEXT        NOT NULL,
            answers      JSONB       NOT NULL,
            submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (cycle_id, respondent)
          )
        `);

        // Generated once per install and kept in the plugin's own database, so
        // respondent keys stay stable across restarts and replicas without a
        // secret to configure.
        await db('devex_survey_meta')
          .insert({ key: 'salt', value: randomBytes(32).toString('hex') })
          .onConflict('key')
          .ignore();
        const { value: salt } = await db('devex_survey_meta').where({ key: 'salt' }).first();

        const identify = async (req: Request): Promise<Respondent> => {
          const credentials = await httpAuth.credentials(req, { allow: ['user'] });
          const info = await userInfo.getUserInfo(credentials);
          return {
            userRef: credentials.principal.userEntityRef,
            groups: info.ownershipEntityRefs.filter(r => r.startsWith('group:')),
          };
        };

        httpRouter.use(createDevexSurveyRouter({ db, httpAuth, identify, salt }));
        logger.info('DevEx survey plugin initialized');
      },
    });
  },
});
