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
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function createApprovalDecisionRouter(opts: ApprovalDecisionOptions): Router {
  const { httpAuth, logger, approvalServiceUrl } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const router = Router();
  router.use(express.json());

  // POST /api/idp-approvals/approvals/:id/decide { decision }
  router.post('/approvals/:id/decide', async (req, res, next) => {
    let userRef: string;
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      userRef = credentials.principal.userEntityRef;
    } catch (err) {
      next(err);
      return;
    }

    const { decision } = (req.body ?? {}) as { decision?: unknown };
    if (decision !== 'approved' && decision !== 'denied') {
      res.status(400).json({ error: 'decision must be "approved" or "denied"' });
      return;
    }

    const target = `${approvalServiceUrl}/approvals/${encodeURIComponent(req.params.id)}/decide`;
    let upstream: Response;
    try {
      upstream = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // decided_by comes from verified credentials only, never req.body.
        body: JSON.stringify({ decision, decided_by: userRef }),
      });
    } catch (err) {
      logger.warn(`idp-approvals: request to approval-service failed: ${err}`);
      res.status(502).json({ error: 'approval-service request failed' });
      return;
    }

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(await upstream.text());
  });

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
        httpRouter.use(createApprovalDecisionRouter({ httpAuth, logger, approvalServiceUrl }));
        // Every route requires a user via httpAuth.credentials(..., { allow: ['user'] }),
        // same as idpAiIdentityProxy.ts — no addAuthPolicy override needed.
        logger.info(`idp-approvals initialized (target: ${approvalServiceUrl})`);
      },
    });
  },
});
