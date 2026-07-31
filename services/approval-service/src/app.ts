import express, { Express } from 'express';
import { register } from 'prom-client';
import { checkPolicy } from './policy.js';
import { createApproval, getApproval, listApprovals, decideApproval, initSchema } from './store.js';

function auditLog(event: Record<string, unknown>): void {
  console.log('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), server: 'approval-service', ...event }));
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '0.1.0' }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  // POST /policy/check { action, target } -> whether this action requires human approval
  app.post('/policy/check', (req, res) => {
    const { action, target } = req.body as { action?: string; target?: string };
    if (!action || !target) {
      res.status(400).json({ error: 'action and target are required' });
      return;
    }
    const result = checkPolicy(action, target);
    res.json({ action, target, requires_approval: result.requiresApproval, reason: result.reason, matched_rule: result.matchedRule });
  });

  // POST /approvals { action, agent, target, context } -> create a pending approval
  // (or, if policy says this action/target doesn't require approval, auto-approve it)
  app.post('/approvals', async (req, res) => {
    const { action, agent, target, context } = req.body as { action?: string; agent?: string; target?: string; context?: Record<string, unknown> };
    if (!action || !agent || !target) {
      res.status(400).json({ error: 'action, agent, and target are required' });
      return;
    }
    const policy = checkPolicy(action, target);
    const approval = await createApproval(action, agent, target, context ?? {});
    auditLog({ event: 'approval_requested', approval_id: approval.id, action, agent, target, requires_approval: policy.requiresApproval });

    if (!policy.requiresApproval) {
      const autoApproved = await decideApproval(approval.id, 'approved', 'policy:auto-approve');
      auditLog({ event: 'approval_auto_approved', approval_id: approval.id, reason: policy.reason });
      res.status(201).json(autoApproved);
      return;
    }
    res.status(201).json(approval);
  });

  // GET /approvals?status=pending -> list approvals (for the Backstage approval UI)
  app.get('/approvals', async (req, res) => {
    const status = req.query.status as string | undefined;
    const approvals = await listApprovals(status);
    res.json({ total: approvals.length, approvals });
  });

  // GET /approvals/:id -> a single approval's current status
  app.get('/approvals/:id', async (req, res) => {
    const approval = await getApproval(req.params.id);
    if (!approval) {
      res.status(404).json({ error: 'approval not found' });
      return;
    }
    res.json(approval);
  });

  // POST /approvals/:id/decide { decision: "approved"|"denied", decided_by } -> human decision
  app.post('/approvals/:id/decide', async (req, res) => {
    const { decision, decided_by } = req.body as { decision?: string; decided_by?: string };
    if (decision !== 'approved' && decision !== 'denied') {
      res.status(400).json({ error: 'decision must be "approved" or "denied"' });
      return;
    }
    if (!decided_by) {
      res.status(400).json({ error: 'decided_by is required' });
      return;
    }
    const updated = await decideApproval(req.params.id, decision, decided_by);
    if (!updated) {
      res.status(409).json({ error: 'approval not found, or already decided' });
      return;
    }
    auditLog({ event: 'approval_decided', approval_id: updated.id, decision, decided_by });
    res.json(updated);
  });

  return app;
}

export async function bootstrap(): Promise<Express> {
  await initSchema();
  return createApp();
}
