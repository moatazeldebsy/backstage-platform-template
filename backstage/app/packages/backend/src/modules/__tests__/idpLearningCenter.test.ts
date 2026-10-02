// Learning Center progress is per user, and the user comes from verified
// credentials (CLAUDE.md: the browser calls this plugin directly, so a
// client-supplied identity would be forgeable). These run the real queries
// against an in-memory SQLite database; production uses Postgres, but the
// router only uses the query builder, which knex translates for both.
import knexFactory, { Knex } from 'knex';
import { createLearningCenterRouter } from '../idpLearningCenter';
import { TEST_USER_HEADER, fakeHttpAuth, serve } from './routerHarness';

let db: Knex;
let srv: { url: string; close: () => Promise<void> };

beforeEach(async () => {
  db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  // Mirrors the CREATE TABLE in the plugin's init (Postgres-only DDL there).
  await db.schema.createTable('learning_progress', t => {
    t.text('user_ref').notNullable();
    t.text('entity_ref').notNullable();
    t.timestamp('completed_at').defaultTo(db.fn.now());
    t.primary(['user_ref', 'entity_ref']);
  });
  srv = await serve(createLearningCenterRouter({ db: db as any, httpAuth: fakeHttpAuth() }));
});

afterEach(async () => {
  await srv.close();
  await db.destroy();
});

const as = (user?: string) => ({
  'content-type': 'application/json',
  ...(user ? { [TEST_USER_HEADER]: user } : {}),
});

async function mark(user: string, entityRef: string, completed: boolean) {
  const res = await fetch(`${srv.url}/progress`, {
    method: 'POST',
    headers: as(user),
    body: JSON.stringify({ entityRef, completed }),
  });
  return { status: res.status, body: await res.json() };
}

describe('createLearningCenterRouter', () => {
  it('records and returns completion for the signed-in user', async () => {
    expect((await mark('user:default/alice', 'template:default/go-service', true)).body).toEqual({
      completed: ['template:default/go-service'],
    });
    const res = await fetch(`${srv.url}/progress`, { headers: as('user:default/alice') });
    expect(await res.json()).toEqual({ completed: ['template:default/go-service'] });
  });

  it("keeps each user's progress separate", async () => {
    await mark('user:default/alice', 'template:default/go-service', true);
    await mark('user:default/bob', 'doc:platform/slo-guide', true);

    const alice = await (await fetch(`${srv.url}/progress`, { headers: as('user:default/alice') })).json();
    const bob = await (await fetch(`${srv.url}/progress`, { headers: as('user:default/bob') })).json();
    expect(alice.completed).toEqual(['template:default/go-service']);
    expect(bob.completed).toEqual(['doc:platform/slo-guide']);
  });

  it('is idempotent when marking the same item twice, and un-marks it', async () => {
    await mark('user:default/alice', 'template:default/go-service', true);
    expect((await mark('user:default/alice', 'template:default/go-service', true)).body.completed).toHaveLength(1);
    expect((await mark('user:default/alice', 'template:default/go-service', false)).body).toEqual({ completed: [] });
  });

  it('rejects a malformed body with 400', async () => {
    for (const body of [{}, { entityRef: '', completed: true }, { entityRef: 'x', completed: 'yes' }]) {
      const res = await fetch(`${srv.url}/progress`, {
        method: 'POST',
        headers: as('user:default/alice'),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses unauthenticated requests instead of hanging', async () => {
    expect((await fetch(`${srv.url}/progress`, { headers: as() })).status).toBe(401);
    const post = await fetch(`${srv.url}/progress`, {
      method: 'POST',
      headers: as(),
      body: JSON.stringify({ entityRef: 'x', completed: true }),
    });
    expect(post.status).toBe(401);
    expect(await db('learning_progress').count({ n: '*' })).toEqual([{ n: 0 }]);
  });
});
