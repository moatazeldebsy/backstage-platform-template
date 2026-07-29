import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import { Counter, Histogram } from 'prom-client';

// approve_pr / request_changes default to dry_run: true — there is no HiTL
// approval gate wired up yet (see docs/agentic-platform.md Phase 4). Once that
// gate lands, agents can be trusted to flip dry_run off; until then these tools
// only preview what they would do.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_API = process.env.GITHUB_API ?? 'https://api.github.com';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '8000', 10);
// Set once the ADP Phase 4 approval-service is deployed (see docs/agentic-platform.md).
// Unset by default so this gate is opt-in.
const APPROVAL_SERVICE_URL = process.env.APPROVAL_SERVICE_URL ?? '';
export const SERVER_NAME = 'github-mcp-server';

export const toolCalls = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool calls',
  labelNames: ['server', 'tool', 'outcome'],
});
export const toolDuration = new Histogram({
  name: 'mcp_tool_duration_seconds',
  help: 'MCP tool call duration',
  labelNames: ['server', 'tool'],
});

export function auditLog(event: Record<string, unknown>): void {
  console.log('[AUDIT] ' + JSON.stringify({ ts: new Date().toISOString(), server: SERVER_NAME, ...event }));
}

// Enforces the ADP Phase 4 HiTL gate at the tool-server layer for approve_pr —
// no-op when APPROVAL_SERVICE_URL isn't configured (Phase 4 not deployed).
async function requireApproval(action: string, target: string, approvalId?: string): Promise<void> {
  if (!APPROVAL_SERVICE_URL) return;
  if (!approvalId) {
    throw new Error(`Approval required for ${action} on "${target}". Call request_approval first (idp-mcp-server), then retry with approval_id.`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${APPROVAL_SERVICE_URL}/approvals/${encodeURIComponent(approvalId)}`, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Could not verify approval ${approvalId}: HTTP ${res.status}`);
  const approval = await res.json() as { status: string; action: string; target: string };
  if (approval.action !== action || approval.target !== target) {
    throw new Error(`Approval ${approvalId} was requested for a different action/target — refusing to reuse it.`);
  }
  if (approval.status !== 'approved') {
    throw new Error(`Approval ${approvalId} is not approved (status: ${approval.status}). Wait for a human to decide it, or call get_approval_status.`);
  }
}

export async function ghFetch(path: string, init: RequestInit = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> ?? {}),
      },
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export function createServer(agentId: string = 'unknown') {
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });

  server.tool(
    'get_pr_diff',
    'Get the list of changed files and a summary for a GitHub pull request',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
      pr_number: z.number().int().describe('Pull request number'),
    },
    async ({ repo, pr_number }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_pr_diff' });
      let outcome = 'success';
      try {
        const res = await ghFetch(`/repos/${repo}/pulls/${pr_number}/files`);
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const files = await res.json() as Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
        const summary = files.map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ repo, pr_number, changed_files: summary, total: files.length }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_pr_diff', outcome });
      }
    },
  );

  server.tool(
    'add_pr_comment',
    'Post a comment on a GitHub pull request (used by QA agent to report missing test coverage)',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
      pr_number: z.number().int().describe('Pull request number'),
      body: z.string().describe('Markdown comment body'),
    },
    async ({ repo, pr_number, body }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'add_pr_comment' });
      let outcome = 'success';
      try {
        const res = await ghFetch(`/repos/${repo}/issues/${pr_number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        });
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const comment = await res.json() as { id: number; html_url: string };
        auditLog({ action: 'pr_comment_posted', agent: agentId, repo, pr_number, comment_id: comment.id });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ comment_id: comment.id, url: comment.html_url }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'add_pr_comment', outcome });
      }
    },
  );

  server.tool(
    'get_ci_status',
    'Get the CI check-run results for the latest commit on a pull request',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
      pr_number: z.number().int().describe('Pull request number'),
    },
    async ({ repo, pr_number }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'get_ci_status' });
      let outcome = 'success';
      try {
        const prRes = await ghFetch(`/repos/${repo}/pulls/${pr_number}`);
        if (!prRes.ok) throw new Error(`GitHub API error ${prRes.status}: ${await prRes.text()}`);
        const pr = await prRes.json() as { head: { sha: string } };
        const sha = pr.head.sha;

        const checksRes = await ghFetch(`/repos/${repo}/commits/${sha}/check-runs`);
        if (!checksRes.ok) throw new Error(`GitHub API error ${checksRes.status}: ${await checksRes.text()}`);
        const checks = await checksRes.json() as { check_runs: Array<{ name: string; status: string; conclusion: string | null }> };

        const summary = checks.check_runs.map(c => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
        }));

        const allPassed = summary.every(c => c.conclusion === 'success');
        const failed = summary.filter(c => c.conclusion === 'failure');

        return { content: [{ type: 'text' as const, text: JSON.stringify({ sha, all_passed: allPassed, failed_checks: failed, checks: summary }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'get_ci_status', outcome });
      }
    },
  );

  server.tool(
    'approve_pr',
    'Approve a GitHub pull request review. Defaults to dry_run: true (no HiTL approval gate exists yet — see docs/agentic-platform.md Phase 4); pass dry_run: false only when the user has explicitly confirmed the approval.',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
      pr_number: z.number().int().describe('Pull request number'),
      body: z.string().optional().describe('Optional markdown review summary'),
      dry_run: z.boolean().optional().describe('If true (default), preview only — no review is posted'),
      approval_id: z.string().optional().describe('Required for a real (non-dry-run) approval once the HiTL approval gate is deployed — obtain via request_approval'),
    },
    async ({ repo, pr_number, body, dry_run = true, approval_id }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'approve_pr' });
      let outcome = 'success';
      auditLog({ action: 'approve_pr_requested', agent: agentId, repo, pr_number, dry_run, approval_id });
      try {
        if (dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ dry_run: true, repo, pr_number, event: 'APPROVE', message: 'Dry run — no review posted. Pass dry_run: false to proceed.' }),
            }],
          };
        }
        await requireApproval('approve_pr', `${repo}#${pr_number}`, approval_id);
        const res = await ghFetch(`/repos/${repo}/pulls/${pr_number}/reviews`, {
          method: 'POST',
          body: JSON.stringify({ event: 'APPROVE', body: body ?? '' }),
        });
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const review = await res.json() as { id: number; html_url: string };
        auditLog({ action: 'pr_approved', agent: agentId, repo, pr_number, review_id: review.id });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ review_id: review.id, url: review.html_url }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'approve_pr', outcome });
      }
    },
  );

  server.tool(
    'request_changes',
    'Request changes on a GitHub pull request review. Defaults to dry_run: true (no HiTL approval gate exists yet — see docs/agentic-platform.md Phase 4); pass dry_run: false only when the user has explicitly confirmed.',
    {
      repo: z.string().describe('Full repo name e.g. org/my-service'),
      pr_number: z.number().int().describe('Pull request number'),
      body: z.string().describe('Markdown explanation of what must change — required by GitHub for REQUEST_CHANGES reviews'),
      dry_run: z.boolean().optional().describe('If true (default), preview only — no review is posted'),
    },
    async ({ repo, pr_number, body, dry_run = true }) => {
      const end = toolDuration.startTimer({ server: SERVER_NAME, tool: 'request_changes' });
      let outcome = 'success';
      auditLog({ action: 'request_changes_requested', agent: agentId, repo, pr_number, dry_run });
      try {
        if (dry_run) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ dry_run: true, repo, pr_number, event: 'REQUEST_CHANGES', body, message: 'Dry run — no review posted. Pass dry_run: false to proceed.' }),
            }],
          };
        }
        const res = await ghFetch(`/repos/${repo}/pulls/${pr_number}/reviews`, {
          method: 'POST',
          body: JSON.stringify({ event: 'REQUEST_CHANGES', body }),
        });
        if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
        const review = await res.json() as { id: number; html_url: string };
        auditLog({ action: 'pr_changes_requested', agent: agentId, repo, pr_number, review_id: review.id });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ review_id: review.id, url: review.html_url }) }] };
      } catch (err) {
        outcome = 'error';
        throw err;
      } finally {
        end();
        toolCalls.inc({ server: SERVER_NAME, tool: 'request_changes', outcome });
      }
    },
  );

  return server;
}
