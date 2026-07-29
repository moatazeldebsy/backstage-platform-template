import { checkPolicy } from '../policy.js';

describe('checkPolicy (default policy)', () => {
  it('requires approval for sync_app on any target', () => {
    const result = checkPolicy('sync_app', 'my-app');
    expect(result.requiresApproval).toBe(true);
  });

  it('requires approval for rollback_app', () => {
    const result = checkPolicy('rollback_app', 'my-app');
    expect(result.requiresApproval).toBe(true);
  });

  it('requires approval for approve_pr', () => {
    const result = checkPolicy('approve_pr', 'org/repo#42');
    expect(result.requiresApproval).toBe(true);
  });

  it('does not require approval for request_changes', () => {
    const result = checkPolicy('request_changes', 'org/repo#42');
    expect(result.requiresApproval).toBe(false);
  });

  it('fails safe (requires approval) for an unknown action', () => {
    const result = checkPolicy('delete_everything', 'prod');
    expect(result.requiresApproval).toBe(true);
    expect(result.matchedRule).toBe('default-fallback');
  });
});
