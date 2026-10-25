// The DevEx survey is only trustworthy if nobody can read an individual answer
// back out of it. These run the real queries against an in-memory SQLite
// database (production is Postgres; the router only uses the query builder) and
// pin the three properties that make that true: one response per person per
// cycle, a team you actually belong to, and nothing served below the floor.
import knexFactory, { Knex } from 'knex';
import type { Request } from 'express';
import {
  DRIVERS,
  PERCEPTIONS,
  SurveyAnswers,
} from '@internal/engineering-intelligence-core';
import {
  createDevexSurveyRouter,
  respondentKey,
  teamName,
} from '../idpDevexSurvey';
import { PLATFORM_ADMIN_GROUP } from '../idpPermissionPolicy';
import { TEST_USER_HEADER, fakeHttpAuth, serve } from './routerHarness';

const GROUPS_HEADER = 'x-test-groups';
const MIN = 3;

let db: Knex;
let srv: { url: string; close: () => Promise<void> };

beforeEach(async () => {
  db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  // Mirrors the CREATE TABLEs in the plugin's init (Postgres-only DDL there).
  await db.schema.createTable('devex_survey_cycles', t => {
    t.increments('id');
    t.text('title').notNullable();
    t.text('opens_at').notNullable();
    t.text('closes_at').notNullable();
  });
  await db.schema.createTable('devex_survey_responses', t => {
    t.integer('cycle_id').notNullable();
    t.text('respondent').notNullable();
    t.text('team').notNullable();
    t.text('answers').notNullable();
    t.primary(['cycle_id', 'respondent']);
  });

  const httpAuth = fakeHttpAuth();
  srv = await serve(
    createDevexSurveyRouter({
      db: db as any,
      httpAuth,
      identify: async (req: Request) => {
        const creds: any = await httpAuth.credentials(req as any, { allow: ['user'] });
        const groups = (req.get(GROUPS_HEADER) ?? '').split(',').filter(Boolean);
        return { userRef: creds.principal.userEntityRef, groups };
      },
      salt: 'test-salt',
      minResponses: MIN,
      rateLimitPerMinute: 1000,
    }),
  );
});

afterEach(async () => {
  await srv.close();
  await db.destroy();
});

const as = (user: string, groups: string[] = ['group:default/payments']) => ({
  'content-type': 'application/json',
  [TEST_USER_HEADER]: user,
  [GROUPS_HEADER]: groups.join(','),
});
const admin = () => as('user:default/root', [PLATFORM_ADMIN_GROUP]);

function answers(score = 4): SurveyAnswers {
  return {
    drivers: Object.fromEntries(DRIVERS.map(d => [d.id, score])) as SurveyAnswers['drivers'],
    perceptions: Object.fromEntries(PERCEPTIONS.map(p => [p.id, score])) as SurveyAnswers['perceptions'],
    time: { newCapabilities: 50, maintenance: 25, toil: 15, other: 10 },
  };
}

async function openCycle() {
  const res = await fetch(`${srv.url}/cycles`, {
    method: 'POST',
    headers: admin(),
    body: JSON.stringify({ title: 'Q4 2026', days: 14 }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as number;
}

async function respond(user: string, cycleId: number, team = 'payments', body = answers(), groups?: string[]) {
  const res = await fetch(`${srv.url}/responses`, {
    method: 'POST',
    headers: as(user, groups),
    body: JSON.stringify({ cycleId, team, answers: body }),
  });
  return { status: res.status, body: await res.json() };
}

async function aggregate() {
  const res = await fetch(`${srv.url}/aggregate`, { headers: as('user:default/viewer') });
  return res.json();
}

describe('helpers', () => {
  it('shortens group refs to team names', () => {
    expect(teamName('group:default/payments')).toBe('payments');
  });

  it('keys respondents per cycle, so cycles cannot be joined person by person', () => {
    expect(respondentKey('s', 1, 'user:default/a')).not.toBe(respondentKey('s', 2, 'user:default/a'));
    expect(respondentKey('s', 1, 'user:default/a')).not.toContain('user:default/a');
  });
});

describe('cycles', () => {
  it('lets only the platform team open a cycle', async () => {
    const res = await fetch(`${srv.url}/cycles`, {
      method: 'POST',
      headers: as('user:default/alice'),
      body: JSON.stringify({ title: 'Q4', days: 14 }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a second open cycle', async () => {
    await openCycle();
    const res = await fetch(`${srv.url}/cycles`, {
      method: 'POST',
      headers: admin(),
      body: JSON.stringify({ title: 'again', days: 14 }),
    });
    expect(res.status).toBe(409);
  });

  it('reports the open cycle and whether the caller answered', async () => {
    const id = await openCycle();
    const before = await (await fetch(`${srv.url}/current`, { headers: as('user:default/alice') })).json();
    expect(before).toMatchObject({ cycle: { id, open: true }, answered: false, teams: ['payments'] });
    await respond('user:default/alice', id);
    const after = await (await fetch(`${srv.url}/current`, { headers: as('user:default/alice') })).json();
    expect(after.answered).toBe(true);
  });
});

describe('responses', () => {
  it('accepts one response per person per cycle', async () => {
    const id = await openCycle();
    expect((await respond('user:default/alice', id)).status).toBe(201);
    expect((await respond('user:default/alice', id)).status).toBe(409);
  });

  it('refuses a team the respondent is not in', async () => {
    const id = await openCycle();
    expect((await respond('user:default/alice', id, 'search')).status).toBe(400);
  });

  it('files group-less users under unassigned', async () => {
    const id = await openCycle();
    expect((await respond('user:default/guest', id, 'unassigned', answers(), [])).status).toBe(201);
  });

  it('refuses an incomplete answer set', async () => {
    const id = await openCycle();
    const partial = { ...answers(), drivers: {} };
    expect((await respond('user:default/alice', id, 'payments', partial as any)).status).toBe(400);
  });

  it('refuses answers to a closed cycle', async () => {
    const id = await openCycle();
    await fetch(`${srv.url}/cycles/${id}/close`, { method: 'POST', headers: admin() });
    expect((await respond('user:default/alice', id)).status).toBe(409);
  });

  it('stores no user ref', async () => {
    const id = await openCycle();
    await respond('user:default/alice', id);
    const rows = await db('devex_survey_responses').select();
    expect(JSON.stringify(rows)).not.toContain('alice');
  });
});

describe('aggregate', () => {
  const close = (id: number) => fetch(`${srv.url}/cycles/${id}/close`, { method: 'POST', headers: admin() });

  it('serves counts only while the cycle is open, so answers cannot be differenced out', async () => {
    const id = await openCycle();
    for (const u of ['a', 'b', 'c', 'd']) await respond(`user:default/${u}`, id, 'payments', answers(5));
    const before = await aggregate();
    await respond('user:default/e', id, 'payments', answers(1));
    const after = await aggregate();
    expect(before.org).toEqual({ responses: 4, withheld: true });
    expect(after.org).toEqual({ responses: 5, withheld: true });
    expect(after.teams).toEqual([{ team: 'payments', responses: 5, withheld: true }]);
  });

  it('withholds a team below the floor and serves it at the floor once closed', async () => {
    const id = await openCycle();
    await respond('user:default/a', id, 'payments', answers(5));
    await respond('user:default/b', id, 'payments', answers(5));
    await respond('user:default/x', id, 'search', answers(5), ['group:default/search']);
    await close(id);
    expect((await aggregate()).teams).toEqual([
      { team: 'payments', responses: 2, withheld: true },
      { team: 'search', responses: 1, withheld: true },
    ]);
  });

  it('serves means at the floor once closed', async () => {
    const id = await openCycle();
    for (const u of ['a', 'b', 'c']) await respond(`user:default/${u}`, id, 'payments', answers(5));
    await close(id);
    const result = await aggregate();
    expect(result.org).toMatchObject({ responses: 3, withheld: false, dxi: 100 });
    expect(result.teams[0]).toMatchObject({ team: 'payments', withheld: false, dxi: 100 });
  });

  it('serves no response rows or respondent keys', async () => {
    const id = await openCycle();
    for (const u of ['a', 'b', 'c']) await respond(`user:default/${u}`, id);
    const json = JSON.stringify(await aggregate());
    expect(json).not.toContain(respondentKey('test-salt', id, 'user:default/a'));
    expect(json).not.toContain('user:default/');
  });

  it('says there is no cycle rather than returning empty figures', async () => {
    expect(await aggregate()).toEqual({ cycle: null, minResponses: MIN });
  });
});
