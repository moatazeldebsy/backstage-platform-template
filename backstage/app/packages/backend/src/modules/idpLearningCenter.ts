import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import express, { Router } from 'express';

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

        const router = Router();
        router.use(express.json());

        // GET /api/learning-center/progress -> { completed: string[] }
        router.get('/progress', async (req, res) => {
          const credentials = await httpAuth.credentials(req, { allow: ['user'] });
          const userRef = credentials.principal.userEntityRef;
          const rows = await db('learning_progress').where({ user_ref: userRef }).select('entity_ref');
          res.json({ completed: rows.map(r => r.entity_ref) });
        });

        // POST /api/learning-center/progress { entityRef, completed } -> { completed: string[] }
        router.post('/progress', async (req, res) => {
          const credentials = await httpAuth.credentials(req, { allow: ['user'] });
          const userRef = credentials.principal.userEntityRef;
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
          const rows = await db('learning_progress').where({ user_ref: userRef }).select('entity_ref');
          res.json({ completed: rows.map(r => r.entity_ref) });
        });

        // No addAuthPolicy override needed: the default httpRouter policy already
        // requires credentials, and httpAuth.credentials(req, { allow: ['user'] })
        // above rejects anything but an authenticated user principal.
        httpRouter.use(router);

        logger.info('Learning Center plugin initialized');
      },
    });
  },
});
