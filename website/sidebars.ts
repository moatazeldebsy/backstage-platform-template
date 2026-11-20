import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// Mirrors the `nav` in ../mkdocs.yml (the Backstage TechDocs nav): same
// sections, order and labels. Change both together.
const doc = (id: string, label: string) => ({type: 'doc' as const, id, label});

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Get Started',
      collapsed: false,
      items: [
        doc('index', 'Overview'),
        doc('getting-started', 'Quickstart'),
        doc('local-setup', 'Local Setup'),
        doc('screenshots', 'Screenshots'),
      ],
    },
    {
      type: 'category',
      label: 'Deploy on AWS',
      items: [
        doc('PRE_DEPLOYMENT_CHECKLIST', 'Pre-Deployment Checklist'),
        doc('DEPLOYMENT_GUIDE', 'Deployment Guide'),
        doc('aws-install-failure-modes', 'Known Failure Modes'),
        doc('readiness-checklist', 'Readiness Checklist'),
        doc('github-app-setup', 'GitHub App Setup'),
      ],
    },
    {
      type: 'category',
      label: 'Platform',
      items: [
        doc('golden-path', 'Golden Path'),
        doc('mobile-platform', 'Mobile Platform'),
        doc('preview-environments', 'PR Preview Environments'),
        doc('contract-testing', 'Contract Testing'),
        doc('crossplane', 'Crossplane'),
        doc('crossplane-vs-terraform', 'Crossplane vs Terraform'),
        doc('team-management', 'Team Management'),
        doc('dora-finops', 'DORA & FinOps'),
      ],
    },
    {
      type: 'category',
      label: 'AI & Agents',
      items: [
        doc('ai-assistant', 'AI Assistant'),
        doc('agentic-platform', 'Agentic Development Platform'),
        doc('agent-approvals', 'Agent Approvals'),
      ],
    },
    {
      type: 'category',
      label: 'Engineering Intelligence',
      items: [
        doc('engineering-intelligence/product-vision', 'Product Vision'),
        doc('engineering-intelligence/architecture', 'Architecture'),
        doc('engineering-intelligence/maturity-model', 'Maturity Model'),
        doc('engineering-intelligence/scoring', 'Scoring'),
        doc('engineering-intelligence/integrations', 'Integrations'),
        doc('engineering-intelligence/ai-advisor', 'AI Advisor'),
        doc('engineering-intelligence/core4', 'DX Core 4'),
        doc('engineering-intelligence/roadmap', 'Roadmap'),
      ],
    },
    {
      type: 'category',
      label: 'Quality & Security',
      items: [
        doc('shift-left', 'Shift-Left Quality'),
        doc('flaky-test-quarantine', 'Flaky-Test Quarantine'),
        doc('test-impact-analysis', 'Test-Impact Analysis'),
        doc('security', 'Security'),
        doc('security-scanning', 'Security Scanning (SonarCloud + Snyk)'),
      ],
    },
    {
      type: 'category',
      label: 'Operate',
      items: [
        doc('sre-reliability', 'SRE & Reliability'),
        doc('scaling-runbook', 'Scaling Runbook'),
        doc('TROUBLESHOOTING', 'Troubleshooting'),
        {
          type: 'category',
          label: 'Runbooks',
          // runbooks/index.md is the section's own page, as in MkDocs.
          link: {type: 'doc', id: 'runbooks/index'},
          items: [
            doc('runbooks/incident-severity', 'Incident Severity'),
            doc('runbooks/deployment-rollback', 'Deployment Rollback'),
            doc('runbooks/pod-crash-loop', 'Pod Crash Loop'),
            doc('runbooks/high-memory', 'High Memory'),
            doc('runbooks/high-cpu', 'High CPU'),
            doc('runbooks/db-recovery', 'Database Recovery'),
            doc('runbooks/image-pull-backoff', 'ImagePullBackOff'),
            doc('runbooks/kind-node-ip-mismatch', 'Kind Node IP Mismatch / Docker Restart'),
            doc('runbooks/cost-budget-exceeded', 'Cost Budget Exceeded'),
            doc('runbooks/kagent-guardrails', 'KAgent Guardrails'),
            doc('runbooks/regional-rebuild', 'Regional Rebuild'),
          ],
        },
        doc('postmortem-template', 'Post-Mortem Template'),
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        doc('architecture', 'Architecture'),
        doc('cli-reference', 'CLI Reference'),
        doc('scripts-reference', 'Scripts Reference'),
        {
          type: 'category',
          label: 'Design Decisions',
          items: [
            doc('design/adr-0001-batch-orchestration', 'ADR-0001: Batch orchestration'),
            doc('design/adr-0002-delivery-model', 'ADR-0002: Delivery model'),
            doc('design/adr-0003-incident-management', 'ADR-0003: Incident management'),
            doc('design/adr-0004-identity-and-access', 'ADR-0004: Identity and access'),
            doc('design/adr-0005-llm-serving-and-agent-frameworks', 'ADR-0005: LLM serving and agent frameworks'),
            doc('design/adr-0006-engineering-intelligence', 'ADR-0006: Engineering Intelligence'),
            doc('design/adr-0007-ai-gateway', 'ADR-0007: AI Gateway'),
            doc('design/adr-0008-litellm-multiprovider-gateway', 'ADR-0008: LiteLLM multi-provider gateway'),
            doc('design/adr-0009-single-region-multi-az', 'ADR-0009: Single-region, multi-AZ'),
          ],
        },
      ],
    },
  ],
};

export default sidebars;
