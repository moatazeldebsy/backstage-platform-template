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
  baseUrl?: string;
  /** Base64(email:api_token), as already used for the /jira proxy's Basic auth header. */
  token?: string;
  fetchImpl?: typeof fetch;
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
  const summary = `${event.entityName} dropped out of compliance: ${event.failedChecks.join(', ')}`;
  const description =
    `Automated compliance watcher detected a regression on \`${event.entityRef}\`.\n\n` +
    `Checks no longer passing:\n${event.failedChecks.map(c => `- ${c}`).join('\n')}` +
    (event.owner ? `\n\nOwner: ${event.owner}` : '');

  try {
    const res = await fetchImpl(`${config.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${config.token}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: event.jiraProjectKey },
          issuetype: { name: 'Task' },
          summary,
          description: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: description }],
              },
            ],
          },
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { key?: string };
    return body.key ? { key: body.key } : null;
  } catch {
    return null;
  }
}
