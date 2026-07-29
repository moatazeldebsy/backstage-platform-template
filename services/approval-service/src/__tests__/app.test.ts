import request from 'supertest';

jest.mock('../store.js', () => ({
  createApproval: jest.fn(),
  getApproval: jest.fn(),
  listApprovals: jest.fn(),
  decideApproval: jest.fn(),
  initSchema: jest.fn(),
}));

import { createApp } from '../app.js';
import { createApproval, getApproval, listApprovals, decideApproval } from '../store.js';

const mockCreateApproval = createApproval as jest.Mock;
const mockGetApproval = getApproval as jest.Mock;
const mockListApprovals = listApprovals as jest.Mock;
const mockDecideApproval = decideApproval as jest.Mock;

beforeEach(() => jest.resetAllMocks());

describe('POST /policy/check', () => {
  it('returns requires_approval for a mutating action', async () => {
    const app = createApp();
    const res = await request(app).post('/policy/check').send({ action: 'sync_app', target: 'my-app' });
    expect(res.status).toBe(200);
    expect(res.body.requires_approval).toBe(true);
  });

  it('400s when action or target is missing', async () => {
    const app = createApp();
    const res = await request(app).post('/policy/check').send({ action: 'sync_app' });
    expect(res.status).toBe(400);
  });
});

describe('POST /approvals', () => {
  it('creates a pending approval when policy requires one', async () => {
    mockCreateApproval.mockResolvedValueOnce({ id: 'abc-123', action: 'sync_app', agent: 'release-agent', target: 'my-app', context: {}, status: 'pending', requested_at: 'now', decided_at: null, decided_by: null });
    const app = createApp();
    const res = await request(app).post('/approvals').send({ action: 'sync_app', agent: 'release-agent', target: 'my-app' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(mockDecideApproval).not.toHaveBeenCalled();
  });

  it('auto-approves when policy does not require approval', async () => {
    mockCreateApproval.mockResolvedValueOnce({ id: 'def-456', action: 'request_changes', agent: 'qa-assistant', target: 'org/repo#42', context: {}, status: 'pending', requested_at: 'now', decided_at: null, decided_by: null });
    mockDecideApproval.mockResolvedValueOnce({ id: 'def-456', action: 'request_changes', agent: 'qa-assistant', target: 'org/repo#42', context: {}, status: 'approved', requested_at: 'now', decided_at: 'now', decided_by: 'policy:auto-approve' });
    const app = createApp();
    const res = await request(app).post('/approvals').send({ action: 'request_changes', agent: 'qa-assistant', target: 'org/repo#42' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
    expect(res.body.decided_by).toBe('policy:auto-approve');
  });

  it('400s when required fields are missing', async () => {
    const app = createApp();
    const res = await request(app).post('/approvals').send({ action: 'sync_app' });
    expect(res.status).toBe(400);
  });
});

describe('GET /approvals/:id', () => {
  it('returns the approval when found', async () => {
    mockGetApproval.mockResolvedValueOnce({ id: 'abc-123', status: 'pending' });
    const app = createApp();
    const res = await request(app).get('/approvals/abc-123');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  it('404s when not found', async () => {
    mockGetApproval.mockResolvedValueOnce(null);
    const app = createApp();
    const res = await request(app).get('/approvals/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('GET /approvals', () => {
  it('lists approvals, optionally filtered by status', async () => {
    mockListApprovals.mockResolvedValueOnce([{ id: '1', status: 'pending' }]);
    const app = createApp();
    const res = await request(app).get('/approvals?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(mockListApprovals).toHaveBeenCalledWith('pending');
  });
});

describe('POST /approvals/:id/decide', () => {
  it('approves a pending approval', async () => {
    mockDecideApproval.mockResolvedValueOnce({ id: 'abc-123', status: 'approved', decided_by: 'jane' });
    const app = createApp();
    const res = await request(app).post('/approvals/abc-123/decide').send({ decision: 'approved', decided_by: 'jane' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  it('409s when the approval was already decided or does not exist', async () => {
    mockDecideApproval.mockResolvedValueOnce(null);
    const app = createApp();
    const res = await request(app).post('/approvals/abc-123/decide').send({ decision: 'denied', decided_by: 'jane' });
    expect(res.status).toBe(409);
  });

  it('400s on an invalid decision value', async () => {
    const app = createApp();
    const res = await request(app).post('/approvals/abc-123/decide').send({ decision: 'maybe', decided_by: 'jane' });
    expect(res.status).toBe(400);
  });

  it('400s when decided_by is missing', async () => {
    const app = createApp();
    const res = await request(app).post('/approvals/abc-123/decide').send({ decision: 'approved' });
    expect(res.status).toBe(400);
  });
});
