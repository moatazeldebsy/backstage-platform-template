import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentConsent } from './extensions';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const agentsBody = { data: [{ agent: { metadata: { name: 'provisioning-agent' } } }] };

describe('AgentConsent', () => {
  it('lists active grants only and revokes through the idp-approvals route', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url.endsWith('/api/proxy/kagent/api/agents')) return json(agentsBody);
      if (url.endsWith('/consent/revoke')) return json({ ok: true });
      return json({
        grants: [
          { id: '1', agent: 'provisioning-agent', scope: 'scaffold_service', granted_at: 'x', expires_at: null, revoked_at: null },
          { id: '2', agent: 'idp-assistant', scope: 'sync_app', granted_at: 'x', expires_at: null, revoked_at: '2026-01-01T00:00:00Z' },
          { id: '3', agent: 'idp-assistant', scope: 'rollback_app', granted_at: 'x', expires_at: '2000-01-01T00:00:00Z', revoked_at: null },
        ],
      });
    });
    render(<AgentConsent fetchApi={{ fetch: fetchMock as any }} base="http://be" />);

    expect(await screen.findByText('scaffold_service', { selector: 'code' })).toBeInTheDocument();
    expect(screen.queryByText('sync_app', { selector: 'code' })).not.toBeInTheDocument();
    expect(screen.queryByText('rollback_app', { selector: 'code' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('http://be/api/idp-approvals/consent/revoke', expect.objectContaining({ method: 'POST' })),
    );
    const call = fetchMock.mock.calls.find(c => c[0].endsWith('/consent/revoke')) as unknown as [string, RequestInit];
    // No user_ref: the backend takes the user from the session.
    expect(JSON.parse(call[1].body as string)).toEqual({ agent: 'provisioning-agent', scope: 'scaffold_service' });
  });

  it('grants the selected agent and action', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url.endsWith('/api/proxy/kagent/api/agents')) return json(agentsBody);
      if (url.endsWith('/consent/grant')) return json({ ok: true });
      return json({ grants: [] });
    });
    render(<AgentConsent fetchApi={{ fetch: fetchMock as any }} base="http://be" />);

    expect(await screen.findByText(/haven.t allowed any agent/)).toBeInTheDocument();
    const allow = screen.getByRole('button', { name: 'Allow' });
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('http://be/api/idp-approvals/consent/grant', expect.objectContaining({ method: 'POST' })),
    );
    const call = fetchMock.mock.calls.find(c => c[0].endsWith('/consent/grant')) as unknown as [string, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({ agent: 'provisioning-agent', scope: 'scaffold_service' });
  });

  it('shows the error approval-service returns', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url.endsWith('/api/proxy/kagent/api/agents')) return json(agentsBody);
      if (url.endsWith('/consent/grant')) return json({ error: 'approval-service refused' }, 503);
      return json({ grants: [] });
    });
    render(<AgentConsent fetchApi={{ fetch: fetchMock as any }} base="http://be" />);
    const allow = await screen.findByRole('button', { name: 'Allow' });
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    expect(await screen.findByText('approval-service refused')).toBeInTheDocument();
  });
});
