import { auditLog, getAuditLog } from '../audit.js';

describe('auditLog / getAuditLog', () => {
  it('records an event retrievable by getAuditLog', () => {
    auditLog({ action: 'register_contract', agent: 'test-agent', service: 'svc-x' });
    const events = getAuditLog({ service: 'svc-x' });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].action).toBe('register_contract');
    expect(events[0].service).toBe('svc-x');
    expect(events[0].ts).toBeTruthy();
  });

  it('filters by action', () => {
    auditLog({ action: 'list_contracts', agent: 'agent-a', service: undefined });
    auditLog({ action: 'get_contract', agent: 'agent-a', service: 'svc-y' });
    const events = getAuditLog({ action: 'get_contract' });
    expect(events.every(e => e.action === 'get_contract')).toBe(true);
  });

  it('filters by agent', () => {
    auditLog({ action: 'can_i_deploy', agent: 'agent-unique-1', service: 'svc-z' });
    const events = getAuditLog({ agent: 'agent-unique-1' });
    expect(events.length).toBe(1);
    expect(events[0].agent).toBe('agent-unique-1');
  });

  it('returns most-recent-first order', () => {
    auditLog({ action: 'order-test', agent: 'order-agent', service: 'order-svc', seq: 1 });
    auditLog({ action: 'order-test', agent: 'order-agent', service: 'order-svc', seq: 2 });
    const events = getAuditLog({ agent: 'order-agent' });
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(1);
  });

  it('respects the limit option', () => {
    for (let i = 0; i < 5; i++) {
      auditLog({ action: 'limit-test', agent: 'limit-agent', seq: i });
    }
    const events = getAuditLog({ agent: 'limit-agent', limit: 2 });
    expect(events.length).toBe(2);
  });

  it('caps the buffer at AUDIT_LOG_CAPACITY entries', () => {
    for (let i = 0; i < 600; i++) {
      auditLog({ action: 'capacity-test', agent: 'capacity-agent', seq: i });
    }
    const events = getAuditLog({ agent: 'capacity-agent', limit: 1000 });
    expect(events.length).toBeLessThanOrEqual(500);
  });
});
