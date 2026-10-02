import {
  createBackendPlugin,
  coreServices,
  type DatabaseService,
  type HttpAuthService,
} from '@backstage/backend-plugin-api';
import express, { Router, type Request } from 'express';

type Db = Awaited<ReturnType<DatabaseService['getClient']>>;

/**
 * Progress routes on their own, so they can be tested against an in-memory
 * database without a backend (#321). The user a row belongs to always comes
 * from verified credentials, never from the request body.
 */
export function createLearningCenterRouter(opts: { db: Db; httpAuth: HttpAuthService }): Router {
  const { db, httpAuth } = opts;
  const router = Router();
  router.use(express.json());

  const userOf = async (req: Request) =>
    (await httpAuth.credentials(req, { allow: ['user'] })).principal.userEntityRef;
  const completedFor = async (userRef: string) =>
    (await db('learning_progress').where({ user_ref: userRef }).select('entity_ref')).map(
      (r: { entity_ref: string }) => r.entity_ref,
    );

  // Express 4 does not catch a rejected async handler, so each route passes
  // errors to next() — otherwise a refused credential left the request hanging.

  // GET /api/learning-center/progress -> { completed: string[] }
  router.get('/progress', async (req, res, next) => {
    try {
      res.json({ completed: await completedFor(await userOf(req)) });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/learning-center/progress { entityRef, completed } -> { completed: string[] }
  router.post('/progress', async (req, res, next) => {
    try {
      const userRef = await userOf(req);
      const { entityRef, completed } = req.body ?? {};
      if (typeof entityRef !== 'string' || !entityRef || typeof completed !== 'boolean') {
        res.status(400).json({ error: 'entityRef (string) and completed (boolean) are required' });
        return;
      }
      if (completed) {
        await db('learning_progress')
          .insert({ user_ref: userRef, entity_ref: entityRef })
          .onConflict(['user_ref', 'entity_ref'])
          .ignore();
      } else {
        await db('learning_progress').where({ user_ref: userRef, entity_ref: entityRef }).delete();
      }
      res.json({ completed: await completedFor(userRef) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Learning Center: tracks which catalog entities (templates) and curated
// docs a user has marked complete, so the /learning-center page can show a
// progress bar and tier badge. Backed by its own Postgres database
// (backstage_plugin_learning-center), auto-provisioned by Backstage's
// PluginDatabaseManager on first getClient() call — same pattern as
// rag-search (see idpRagSearch.ts), just without the vector-search parts.
export const learningCenterPlugin = createBackendPlugin({
  pluginId: 'learning-center',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({ httpRouter, database, httpAuth, logger }) {
        const db = await database.getClient();

        await db.raw(`
          CREATE TABLE IF NOT EXISTS learning_progress (
            user_ref     TEXT        NOT NULL,
            entity_ref   TEXT        NOT NULL,
            completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_ref, entity_ref)
          )
        `);

        const router = createLearningCenterRouter({ db, httpAuth });

        // No addAuthPolicy override needed: the default httpRouter policy already
        // requires credentials, and httpAuth.credentials(req, { allow: ['user'] })
        // above rejects anything but an authenticated user principal.
        httpRouter.use(router);

        logger.info('Learning Center plugin initialized');
      },
    });
  },
});
