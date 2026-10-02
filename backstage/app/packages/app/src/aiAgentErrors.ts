/**
 * Detecting and explaining a failed KAgent turn.
 *
 * When the model call behind an agent fails — Anthropic out of credits, a
 * revoked API key, a rate limit — KAgent marks the A2A *task* for that turn as
 * `failed` with the provider's error text, but writes no agent event to the
 * session. The AI Assistant page only read session events, so it showed
 * "Agent is thinking…" for the full 5-minute deadline and then a generic
 * "Agent did not respond in time", while the real reason sat in
 * /api/sessions/<id>/tasks the whole time. Observed 2026-09-26 with an
 * exhausted Anthropic balance: the task failed ~2s in, the page gave up at 5m.
 */

/** A2A task states that end a turn without an answer. */
const TERMINAL_FAILURE_STATES = new Set(['failed', 'rejected', 'canceled']);

export interface A2ATask {
  status?: {
    state?: string;
    timestamp?: string;
    message?: { parts?: Array<{ text?: string; kind?: string }> };
  };
}

/**
 * The failure message of the turn sent at `sentAt`, or null if that turn has
 * not failed. Tasks from earlier turns in the same session are ignored — a
 * conversation reuses its session, so an old failure must not end a new turn.
 * `skewMs` absorbs clock differences between the browser and the cluster.
 */
export function findFailedTurn(
  tasks: A2ATask[],
  sentAt: number,
  skewMs = 5000,
): string | null {
  for (const task of tasks) {
    const state = task.status?.state;
    if (!state || !TERMINAL_FAILURE_STATES.has(state)) continue;
    const ts = Date.parse(task.status?.timestamp ?? '');
    if (Number.isNaN(ts) || ts < sentAt - skewMs) continue;
    const text = (task.status?.message?.parts ?? [])
      .map(p => p.text ?? '')
      .join(' ')
      .trim();
    return text || `The agent's task ended as "${state}".`;
  }
  return null;
}

/**
 * Turn a raw provider/agent error into something a user can act on. The raw
 * text is kept (shortened) after the explanation so an admin can still see
 * exactly what the provider said.
 */
export function describeAgentFailure(raw: string): string {
  // Rendered as Markdown by the chat: the raw text is escaped JSON full of
  // backslashes, underscores and asterisks, so show it as inline code (with
  // any backticks removed so they cannot close it early).
  const detail = `\`${raw.replace(/\s+/g, ' ').replace(/`/g, "'").trim().slice(0, 300)}\``;
  const has = (re: RegExp) => re.test(raw);

  if (has(/credit balance is too low/i)) {
    return (
      'The AI provider (Anthropic) is out of credits, so the agent cannot answer. ' +
      'A platform admin needs to top up at console.anthropic.com → Plans & Billing. ' +
      `Nothing else on the platform is affected.\n\nProvider said: ${detail}`
    );
  }
  if (has(/insufficient_quota|exceeded your current quota|billing/i)) {
    return (
      'The AI provider account has run out of quota or has a billing problem, so the ' +
      'agent cannot answer. A platform admin needs to check the provider billing page.' +
      `\n\nProvider said: ${detail}`
    );
  }
  if (has(/invalid x-api-key|authentication_error|invalid api key|incorrect api key|\b401\b/i)) {
    return (
      'The AI provider rejected the platform\'s API key (missing, revoked or wrong). ' +
      'A platform admin needs to update it in local/.env (or the secret on AWS) and ' +
      `re-run bootstrap-ai.sh.\n\nProvider said: ${detail}`
    );
  }
  if (has(/rate_limit|rate limit|too many requests|\b429\b/i)) {
    return `The AI provider is rate-limiting requests right now. Try again in a minute.\n\nProvider said: ${detail}`;
  }
  if (has(/overloaded|\b529\b|\b503\b/i)) {
    return `The AI provider is temporarily overloaded. Try again shortly.\n\nProvider said: ${detail}`;
  }
  return `The agent failed before it could answer.\n\nDetails: ${detail}`;
}

/**
 * Tools that pause a KAgent turn until a human answers through KAgent's own
 * UI. The AI Assistant page has no way to answer them, so a turn that calls
 * one never finishes: the page used to poll for the full 5 minutes and report
 * "Agent did not respond in time", and because the session is reused, every
 * later message in that conversation hung the same way (#516). The agents'
 * system prompts forbid calling these (#520), but that relies on the model
 * obeying, so the page also stops as soon as it sees one.
 */
const HUMAN_INPUT_TOOLS = new Set(['ask_user', 'adk_request_confirmation']);

export interface AgentFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}

export function isHumanInputCall(call: AgentFunctionCall | undefined): boolean {
  return !!call?.name && HUMAN_INPUT_TOOLS.has(call.name);
}

/** Pull whatever question text the call carries, in whichever shape it uses. */
function extractQuestions(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const asText = (v: unknown): string | null => {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['question', 'text', 'prompt', 'message']) {
        if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
      }
    }
    return null;
  };
  if (Array.isArray(args.questions)) {
    return args.questions.map(asText).filter((q): q is string => !!q);
  }
  const single = asText(args);
  return single ? [single] : [];
}

/**
 * The chat message shown instead of waiting forever: what the agent wanted to
 * ask (so the user can answer in their next message), and that the
 * conversation has been restarted.
 */
export function describeHumanInputRequest(call: AgentFunctionCall): string {
  const questions = extractQuestions(call.args);
  const asked = questions.length
    ? `\n\nIt wanted to ask:\n${questions.map(q => `- ${q}`).join('\n')}`
    : '';
  return (
    `The agent paused to ask a question through \`${call.name}\`, which this chat cannot answer.` +
    `${asked}\n\nThe conversation has been restarted so it does not stay stuck. ` +
    'Send your request again with those details included.'
  );
}
