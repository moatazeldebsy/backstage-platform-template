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
  /**
   * URL of an agent's own A2A endpoint, with `{agent}` standing for the agent
   * name, e.g. http://{agent}.kagent.svc.cluster.local:8080. The KAgent
   * controller's A2A proxy at `kagentUrl` drops custom headers, so identity
   * only reaches the MCP servers when the agent pod is called directly.
   * Unset → controller only.
   */
  agentUrlTemplate?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

// Connection errors that mean the request was never sent to an agent.
const NOT_DELIVERED = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/**
 * The proxy route on its own, so it can be tested without a backend (#321).
 * The property that matters: the X-Backstage-User header KAgent receives comes
 * from the caller's verified credentials and nothing the client sent.
 */
export function createIdentityProxyRouter(opts: IdentityProxyOptions): Router {
  const { httpAuth, logger, kagentUrl, agentUrlTemplate } = opts;
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

    const agent = encodeURIComponent(req.params.agent);
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Set from verified credentials, never from req.get('x-backstage-user').
        'X-Backstage-User': userRef,
        // The agent forwards both to its MCP tool calls (allowedHeaders on the
        // Agent's mcpServer tool), where they become the approval's requester
        // and agent.
        'X-Agent-ID': req.params.agent.slice(0, 64),
      },
      body: JSON.stringify(req.body),
    };

    let upstream: Response | undefined;
    if (agentUrlTemplate) {
      const direct = agentUrlTemplate.split('{agent}').join(agent);
      try {
        const directRes = await fetchImpl(direct, init);
        // 404: the local ingress has no route for this agent (only the
        // built-in agents get one). Anything else is the agent's own answer.
        if (directRes.status !== 404) upstream = directRes;
      } catch (err) {
        // Fall back only when the request never reached an agent. A failure
        // after it was delivered (reset mid-turn) must not re-run the turn
        // through the controller: the agent may already have scaffolded.
        if (!NOT_DELIVERED.has((err as { cause?: { code?: string } }).cause?.code ?? '')) {
          logger.warn(`idp-ai-identity: request to agent ${req.params.agent} failed: ${err}`);
          res.status(502).json({ error: 'KAgent request failed' });
          return;
        }
      }
      if (!upstream) {
        logger.warn(
          `idp-ai-identity: agent ${req.params.agent} not reachable at ${direct}; ` +
            'falling back to the KAgent controller, which drops X-Backstage-User',
        );
      }
    }

    if (!upstream) {
      try {
        upstream = await fetchImpl(`${kagentUrl}/a2a/kagent/${agent}`, init);
      } catch (err) {
        logger.warn(`idp-ai-identity: request to KAgent failed: ${err}`);
        res.status(502).json({ error: 'KAgent request failed' });
        return;
      }
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
        const agentUrlTemplate = process.env.KAGENT_AGENT_URL;

        httpRouter.use(createIdentityProxyRouter({ httpAuth, logger, kagentUrl, agentUrlTemplate }));
        // Every route here already requires an authenticated user via
        // httpAuth.credentials(..., { allow: ['user'] }) — no separate
        // addAuthPolicy override needed, same reasoning as idpLearningCenter.ts.

        logger.info(
          `idp-ai-identity proxy initialized (agents: ${agentUrlTemplate ?? 'none'}, controller: ${kagentUrl})`,
        );
      },
    });
  },
});
