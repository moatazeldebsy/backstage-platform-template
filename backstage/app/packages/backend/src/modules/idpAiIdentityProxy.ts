import {
  createBackendPlugin,
  coreServices,
  type HttpAuthService,
  type LoggerService,
} from '@backstage/backend-plugin-api';
import express, { Router } from 'express';
import { Readable } from 'stream';

// AI Assistant identity proxy (ADP Phase 4b — docs/agent-approvals.md).
//
// The AI Assistant chat page used to POST straight to the generic passthrough
// proxy (`/api/proxy/kagent/a2a/kagent/<agent>`) with an `X-Backstage-User`
// header the BROWSER set from its own copy of the signed-in identity. The
// generic proxy plugin forwards headers verbatim, so any caller with a valid
// Backstage session could put a *different* user's ref in that header and
// have it trusted downstream — the same header idp-mcp-server binds user
// memory to (see services/idp-mcp-server/src/index.ts) and that
// request_approval now stamps onto agent_approvals.requested_by_user.
//
// This route re-does that hop server-side: resolve the caller's identity from
// their signed Backstage credentials (the same `httpAuth.credentials(req, {
// allow: ['user'] })` pattern idpLearningCenter.ts already uses correctly),
// ignore whatever the client sent, and set X-Backstage-User ourselves before
// forwarding to KAgent. A forged header in the incoming request simply never
// reaches KAgent.
export interface IdentityProxyOptions {
  httpAuth: HttpAuthService;
  logger: LoggerService;
  /** KAgent base URL, e.g. http://kagent.idp.local */
  kagentUrl: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The proxy route on its own, so it can be tested without a backend (#321).
 * The property that matters: the X-Backstage-User header KAgent receives comes
 * from the caller's verified credentials and nothing the client sent.
 */
export function createIdentityProxyRouter(opts: IdentityProxyOptions): Router {
  const { httpAuth, logger, kagentUrl } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const router = Router();
  router.use(express.json());

  // POST /api/idp-ai-identity/a2a/kagent/:agent — same JSON-RPC body shape
  // the frontend already sends, just re-signed with a verified identity.
  router.post('/a2a/kagent/:agent', async (req, res, next) => {
    // Express 4 does not catch a rejected async handler: a throw here (e.g. a
    // service token, which credentials({ allow: ['user'] }) refuses) used to
    // leave the request hanging. next(err) lets Backstage's error middleware
    // answer it with the right 401/403.
    let userRef: string;
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      userRef = credentials.principal.userEntityRef;
    } catch (err) {
      next(err);
      return;
    }

    const target = `${kagentUrl}/a2a/kagent/${encodeURIComponent(req.params.agent)}`;
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The only identity header that matters — set from verified
          // credentials, never from req.get('x-backstage-user').
          'X-Backstage-User': userRef,
        },
        body: JSON.stringify(req.body),
      });
    } catch (err) {
      logger.warn(`idp-ai-identity: request to KAgent failed: ${err}`);
      res.status(502).json({ error: 'KAgent request failed' });
      return;
    }

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);

    if (!upstream.body) {
      res.end();
      return;
    }
    // a2a normally streams text/event-stream for the agent turn; pipe it
    // through rather than buffering, same as the frontend's own handling
    // of the streamed response today.
    Readable.fromWeb(upstream.body as unknown as import('stream/web').ReadableStream).pipe(res);
  });

  return router;
}

export const idpAiIdentityProxyPlugin = createBackendPlugin({
  pluginId: 'idp-ai-identity',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
      },
      async init({ httpRouter, httpAuth, logger }) {
        // Same env var / default idpDeployAgent.ts and idpSetupContractTesting.ts
        // already use to reach KAgent from the backend.
        const kagentUrl = process.env.KAGENT_EXTERNAL_URL ?? 'http://kagent.idp.local';

        httpRouter.use(createIdentityProxyRouter({ httpAuth, logger, kagentUrl }));
        // Every route here already requires an authenticated user via
        // httpAuth.credentials(..., { allow: ['user'] }) — no separate
        // addAuthPolicy override needed, same reasoning as idpLearningCenter.ts.

        logger.info(`idp-ai-identity proxy initialized (target: ${kagentUrl})`);
      },
    });
  },
});
