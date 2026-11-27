import { render, screen } from '@testing-library/react';
import { ApprovalContext } from './extensions';

describe('ApprovalContext', () => {
  it('renders a scaffold approval as summary, reason, cost and values', () => {
    render(
      <ApprovalContext
        context={{
          summary: 'provisioning-agent wants to run template s3-bucket-crossplane for "orders-bucket"',
          reason: 'orders-service needs invoice storage',
          estimated_monthly_usd: '15',
          values: { name: 'orders-bucket', versioning: true },
          values_sha256: 'abc',
        }}
      />,
    );
    expect(screen.getByText(/wants to run template s3-bucket-crossplane/)).toBeInTheDocument();
    expect(screen.getByText('Reason: orders-service needs invoice storage')).toBeInTheDocument();
    expect(screen.getByText('Estimated cost: $15/month at template defaults')).toBeInTheDocument();
    expect(screen.getByText(/name: orders-bucket/)).toHaveTextContent('versioning: true');
    expect(screen.queryByText(/values_sha256/)).not.toBeInTheDocument();
  });

  it('shows non-numeric estimates as they are', () => {
    render(<ApprovalContext context={{ summary: 's', estimated_monthly_usd: 'usage-based' }} />);
    expect(screen.getByText('Estimated cost: usage-based')).toBeInTheDocument();
  });

  it('falls back to raw JSON for approvals without a summary', () => {
    render(<ApprovalContext context={{ why: 'hotfix' }} />);
    expect(screen.getByText('{"why":"hotfix"}')).toBeInTheDocument();
  });

  it('renders nothing for an empty context', () => {
    const { container } = render(<ApprovalContext context={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
