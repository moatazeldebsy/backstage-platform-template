import { describeAgentFailure, findFailedTurn } from './aiAgentErrors';

// Verbatim from a real failed platform-assistant task (2026-09-26).
const ANTHROPIC_NO_CREDIT =
  'anthropic API error: POST "http://ai-gateway.ml-platform.svc.cluster.local:3000/v1/messages": ' +
  '400 Bad Request {"type":"error","error":{"type":"invalid_request_error","message":"{\\"error\\":' +
  '{\\"message\\":\\"litellm.BadRequestError: AnthropicException - {\\\\\\"type\\\\\\":\\\\\\"error\\\\\\",' +
  '\\\\\\"error\\\\\\":{\\\\\\"message\\\\\\":\\\\\\"Your credit balance is too low to access the Anthropic API. ' +
  'Please go to Plans & Billing to upgrade or purchase credits.\\\\\\"}}"}}"}}';

const sentAt = Date.parse('2026-09-26T19:37:27.000Z');
const task = (state: string, timestamp: string, text?: string) => ({
  status: { state, timestamp, message: text ? { parts: [{ kind: 'text', text }] } : undefined },
});

describe('findFailedTurn', () => {
  it('returns the error of a task that failed during this turn', () => {
    expect(findFailedTurn([task('failed', '2026-09-26T19:37:29.310Z', 'boom')], sentAt)).toBe('boom');
  });

  it('ignores a failure from an earlier turn in the same session', () => {
    // Sessions are reused across turns; yesterday's failure must not end today's turn.
    expect(findFailedTurn([task('failed', '2026-09-25T10:00:00Z', 'old')], sentAt)).toBeNull();
  });

  it('tolerates a few seconds of clock skew between browser and cluster', () => {
    expect(findFailedTurn([task('failed', '2026-09-26T19:37:24.000Z', 'skewed')], sentAt)).toBe('skewed');
  });

  it('ignores tasks that are still running or completed', () => {
    const tasks = [task('working', '2026-09-26T19:37:29Z'), task('completed', '2026-09-26T19:37:30Z')];
    expect(findFailedTurn(tasks, sentAt)).toBeNull();
  });

  it('treats rejected and canceled as terminal, with a fallback message when there is no text', () => {
    expect(findFailedTurn([task('rejected', '2026-09-26T19:37:29Z')], sentAt)).toBe(
      'The agent\'s task ended as "rejected".',
    );
    expect(findFailedTurn([task('canceled', '2026-09-26T19:37:29Z', 'stopped')], sentAt)).toBe('stopped');
  });

  it('handles missing or malformed fields without throwing', () => {
    expect(findFailedTurn([{}, { status: {} }, task('failed', 'not-a-date', 'x')], sentAt)).toBeNull();
  });
});

describe('describeAgentFailure', () => {
  it('explains an exhausted Anthropic balance and says who has to act', () => {
    const msg = describeAgentFailure(ANTHROPIC_NO_CREDIT);
    expect(msg).toMatch(/out of credits/);
    expect(msg).toMatch(/Plans & Billing/);
    expect(msg).toMatch(/Provider said:/);
  });

  it('recognises an OpenAI quota error', () => {
    expect(describeAgentFailure('Error code: 429 - insufficient_quota: You exceeded your current quota')).toMatch(
      /run out of quota/,
    );
  });

  it('recognises a rejected API key', () => {
    expect(describeAgentFailure('401 {"type":"authentication_error","message":"invalid x-api-key"}')).toMatch(
      /rejected the platform's API key/,
    );
  });

  it('recognises rate limiting and overload', () => {
    expect(describeAgentFailure('429 rate_limit_error')).toMatch(/rate-limiting/);
    expect(describeAgentFailure('529 overloaded_error')).toMatch(/overloaded/);
  });

  it('falls back to the raw detail, shortened', () => {
    const msg = describeAgentFailure(`something odd ${'x'.repeat(1000)}`);
    expect(msg).toMatch(/^The agent failed before it could answer/);
    expect(msg.length).toBeLessThan(400);
  });
});
