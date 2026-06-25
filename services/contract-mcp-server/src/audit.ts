const SERVER_NAME = 'contract-mcp-server';
const CAPACITY = parseInt(process.env.AUDIT_LOG_CAPACITY ?? '500', 10);

export interface AuditEvent {
  ts: string;
  server: string;
  action?: string;
  agent?: string;
  service?: string;
  [key: string]: unknown;
}

export interface AuditLogFilter {
  service?: string;
  action?: string;
  agent?: string;
  limit?: number;
}

const buffer: AuditEvent[] = [];

export function auditLog(event: Record<string, unknown>): void {
  const entry: AuditEvent = { ts: new Date().toISOString(), server: SERVER_NAME, ...event };
  console.log('[AUDIT] ' + JSON.stringify(entry));
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
}

export function getAuditLog(filter: AuditLogFilter = {}): AuditEvent[] {
  const { service, action, agent, limit = 100 } = filter;
  const matches = buffer
    .filter(e => !service || e.service === service)
    .filter(e => !action || e.action === action)
    .filter(e => !agent || e.agent === agent);
  return matches.slice(-limit).reverse();
}
