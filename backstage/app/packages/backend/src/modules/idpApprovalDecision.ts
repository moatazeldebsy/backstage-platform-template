import {
  createBackendPlugin,
  coreServices,
  type HttpAuthService,
  type LoggerService,
} from '@backstage/backend-plugin-api';
import express, { Router } from 'express';

// Approval decisions with a verified decider (ADP Phase 4 — docs/agent-approvals.md).
//
// The Approvals page used to POST { decision, decided_by } straight through the
// generic /api/proxy/approval-service passthrough, with decided_by taken from the
// browser's own copy of the profile. Any signed-in user could therefore record a
// decision under any name — including approving the rollback_app / approve_pr
// their own agent had just requested. Same class of bug idpAiIdentityProxy.ts
// fixed for X-Backstage-User, fixed the same way: resolve the caller from their
// signed credentials and set decided_by server-side, ignoring the body's value.
// approval-service then refuses a decision whose decided_by equals the
// approval's requested_by_user (no self-approval).
export interface ApprovalDecisionOptions {
  httpAuth: HttpAuthService;
  logger: LoggerService;
  /** approval-service base URL, e.g. http://approval-service.services-dev.svc.cluster.local:3009 */
  approvalServiceUrl: string;
  /** Bearer token approval-service requires on /decide (APPROVAL_SERVICE_DECIDER_TOKEN). */
  deciderToken?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

// The tools the MCP servers check consent for (scope = tool name):
// idp-mcp-server scaffold_service, argocd-mcp-server sync_app/rollback_app,
// github-mcp-server approve_pr.
export const CONSENT_SCOPES = ['scaffold_service', 'sync_app', 'rollback_app', 'approve_pr'] as const;
const AGENT_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function createApprovalDecisionRouter(opts: ApprovalDecisionOptions): Router {
  const { httpAuth, logger, approvalServiceUrl, deciderToken } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const router = Router();
  router.use(express.json());

  const forward = async (res: express.Response, path: string, init?: RequestInit) => {
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${approvalServiceUrl}${path}`, init);
    } catch (err) {
      logger.warn(`idp-approvals: request to approval-service failed: ${err}`);
      res.status(502).json({ error: 'approval-service request failed' });
      return;
    }
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(await upstream.text());
  };

  const caller = async (req: express.Request, next: express.NextFunction) => {
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      return credentials.principal.userEntityRef;
    } catch (err) {
      next(err);
      return undefined;
    }
  };

  const deciderHeaders = {
    'Content-Type': 'application/json',
    ...(deciderToken ? { Authorization: `Bearer ${deciderToken}` } : {}),
  };

  // POST /api/idp-approvals/approvals/:id/decide { decision }
  router.post('/approvals/:id/decide', async (req, res, next) => {
    const userRef = await caller(req, next);
    if (!userRef) return;

    const { decision } = (req.body ?? {}) as { decision?: unknown };
    if (decision !== 'approved' && decision !== 'denied') {
      res.status(400).json({ error: 'decision must be "approved" or "denied"' });
      return;
    }

    await forward(res, `/approvals/${encodeURIComponent(req.params.id)}/decide`, {
      method: 'POST',
      headers: deciderHeaders,
      // decided_by comes from verified credentials only, never req.body.
      body: JSON.stringify({ decision, decided_by: userRef }),
    });
  });

  // Self-service consent (docs/agent-approvals.md#consent-grants). The user is
  // always the signed-in caller, so nobody can grant or revoke for someone else.

  // GET /api/idp-approvals/consent -> the caller's own grants
  router.get('/consent', async (req, res, next) => {
    const userRef = await caller(req, next);
    if (!userRef) return;
    await forward(res, `/consent?${new URLSearchParams({ user_ref: userRef })}`);
  });

  // POST /api/idp-approvals/consent/grant|revoke { agent, scope }
  for (const op of ['grant', 'revoke'] as const) {
    router.post(`/consent/${op}`, async (req, res, next) => {
      const userRef = await caller(req, next);
      if (!userRef) return;
      const { agent, scope } = (req.body ?? {}) as { agent?: unknown; scope?: unknown };
      if (typeof agent !== 'string' || !AGENT_NAME.test(agent)) {
        res.status(400).json({ error: 'agent must be a Kubernetes resource name' });
        return;
      }
      if (typeof scope !== 'string' || !(CONSENT_SCOPES as readonly string[]).includes(scope)) {
        res.status(400).json({ error: `scope must be one of ${CONSENT_SCOPES.join(', ')}` });
        return;
      }
      await forward(res, `/consent/${op}`, {
        method: 'POST',
        headers: deciderHeaders,
        // user_ref comes from verified credentials only, never req.body.
        body: JSON.stringify({ user_ref: userRef, agent, scope }),
      });
    });
  }

  return router;
}

/**
 * The approval-service URL: same target the /approval-service proxy endpoint
 * uses (app-config.local.yaml / app-config.aws.yaml), so there is one place to
 * configure it. APPROVAL_SERVICE_URL overrides.
 */
export function resolveApprovalServiceUrl(endpoints: unknown): string | undefined {
  if (process.env.APPROVAL_SERVICE_URL) return process.env.APPROVAL_SERVICE_URL;
  const entry = (endpoints as Record<string, unknown> | undefined)?.['/approval-service'];
  if (typeof entry === 'string') return entry;
  if (entry && typeof (entry as { target?: unknown }).target === 'string') {
    return (entry as { target: string }).target;
  }
  return undefined;
}

export const idpApprovalDecisionPlugin = createBackendPlugin({
  pluginId: 'idp-approvals',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
      },
      async init({ httpRouter, httpAuth, logger, config }) {
        const approvalServiceUrl = resolveApprovalServiceUrl(config.getOptional('proxy.endpoints'));
        if (!approvalServiceUrl) {
          logger.info('idp-approvals: no /approval-service proxy endpoint configured — route disabled');
          return;
        }
        // Written by bootstrap-ai.sh --adp (local/backstage/.env locally, the
        // backstage-approval-service Secret on AWS). Without it approval-service
        // refuses every decision, so say so at startup rather than on first click.
        const deciderToken = process.env.APPROVAL_SERVICE_DECIDER_TOKEN;
        if (!deciderToken) {
          logger.warn('idp-approvals: APPROVAL_SERVICE_DECIDER_TOKEN is not set — approval-service will refuse approve/deny');
        }
        httpRouter.use(createApprovalDecisionRouter({ httpAuth, logger, approvalServiceUrl, deciderToken }));
        // Every route requires a user via httpAuth.credentials(..., { allow: ['user'] }),
        // same as idpAiIdentityProxy.ts — no addAuthPolicy override needed.
        logger.info(`idp-approvals initialized (target: ${approvalServiceUrl})`);
      },
    });
  },
});
