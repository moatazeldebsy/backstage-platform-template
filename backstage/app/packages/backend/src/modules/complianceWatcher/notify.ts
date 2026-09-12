// Slack + Jira notification for a detected scorecard-check regression.
//
// Slack reuses the SLACK_WEBHOOK_URL already wired for KAgent's
// send_notification tool (docs/ai-assistant.md, local/.env.example) — one
// webhook, no new Slack app. Jira reuses the JIRA_URL/JIRA_TOKEN already
// configured for the read-only Jira proxy (app-config.local.yaml /
// app-config.aws.yaml `/jira` endpoint, local/backstage/.env.example) and
// the `jira/project-key` annotation the Jira entity tab already reads
// (extensions.tsx) — this is the first *write* against that config, not a
// new integration.

export interface RegressionEvent {
  entityRef: string;
  entityName: string;
  owner?: string;
  failedChecks: string[];
  jiraProjectKey?: string;
}

export interface SlackConfig {
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Best-effort — a Slack outage must not stop the watcher from continuing. */
export async function postSlackRegression(
  event: RegressionEvent,
  config: SlackConfig,
): Promise<boolean> {
  if (!config.webhookUrl) return false;
  const fetchImpl = config.fetchImpl ?? fetch;
  const ownerLine = event.owner ? ` (owner: \`${event.owner}\`)` : '';
  const text =
    `:warning: *${event.entityName}*${ownerLine} dropped out of compliance.\n` +
    event.failedChecks.map(c => `• \`${c}\` is no longer passing`).join('\n');
  try {
    const res = await fetchImpl(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface JiraConfig {
  /** Site base URL, e.g. https://your-site.atlassian.net */
  baseUrl?: string;
  /**
   * Either Base64(email:api_token) for a classic (unscoped) API token, used
   * as-is with Basic auth against the site directly, OR the raw token for a
   * scoped/organization-service-account token, which Jira Cloud only accepts
   * as a Bearer token against the api.atlassian.com/ex/jira/<cloudId>
   * gateway — not against the site URL. There is no reliable way to tell
   * which kind a given string is, so createJiraIssue tries the gateway/Bearer
   * path first (the form Atlassian now steers new tokens toward) and falls
   * back to classic Basic-against-the-site on failure.
   */
  token?: string;
  fetchImpl?: typeof fetch;
}

function buildIssuePayload(event: RegressionEvent) {
  const summary = `${event.entityName} dropped out of compliance: ${event.failedChecks.join(', ')}`;
  const description =
    `Automated compliance watcher detected a regression on \`${event.entityRef}\`.\n\n` +
    `Checks no longer passing:\n${event.failedChecks.map(c => `- ${c}`).join('\n')}` +
    (event.owner ? `\n\nOwner: ${event.owner}` : '');
  return {
    fields: {
      project: { key: event.jiraProjectKey },
      issuetype: { name: 'Task' },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
      },
    },
  };
}

async function postIssue(
  url: string,
  authHeader: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<{ key: string } | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { key?: string };
    return body.key ? { key: body.key } : null;
  } catch {
    return null;
  }
}

/** Unauthenticated — resolves the Atlassian cloud ID for a site's Jira REST gateway. */
async function resolveCloudId(baseUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${baseUrl}/_edge/tenant_info`);
    if (!res.ok) return null;
    const body = (await res.json()) as { cloudId?: string };
    return body.cloudId ?? null;
  } catch {
    return null;
  }
}

/**
 * Files a Jira issue for the regression via `POST /rest/api/3/issue`.
 * Requires `jiraProjectKey` (the entity's `jira/project-key` annotation) —
 * without a project to file into there is nothing to do, so this is a
 * no-op rather than a guess.
 */
export async function createJiraIssue(
  event: RegressionEvent,
  config: JiraConfig,
): Promise<{ key: string } | null> {
  if (!config.baseUrl || !config.token || !event.jiraProjectKey) return null;
  const fetchImpl = config.fetchImpl ?? fetch;
  const payload = buildIssuePayload(event);

  const cloudId = await resolveCloudId(config.baseUrl, fetchImpl);
  if (cloudId) {
    const viaGateway = await postIssue(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`,
      `Bearer ${config.token}`,
      payload,
      fetchImpl,
    );
    if (viaGateway) return viaGateway;
  }

  return postIssue(`${config.baseUrl}/rest/api/3/issue`, `Basic ${config.token}`, payload, fetchImpl);
}
