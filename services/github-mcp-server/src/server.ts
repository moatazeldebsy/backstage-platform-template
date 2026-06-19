import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { RequestInit } from 'node-fetch';
import { Counter, Histogram } from 'prom-client';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const GITHUB_API = process.env.GITHUB_API ?? 'https://api.github.com';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '8000', 10);
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

  return server;
}
