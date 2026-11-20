/* Demo data for the static platform demo. Everything here is fictional but
 * shaped after the real repo: service names come from services/, templates
 * from backstage/catalog/templates/, agents from kubernetes/kagent/, budgets
 * from kubernetes/finops/team-budgets-configmap.yaml, scorecard checks from
 * backstage/app/packages/app/src/scorecard.ts. No network calls; plain global. */
window.DEMO = (function () {
  'use strict';

  var user = { name: 'Alex Rivera', handle: 'arivera', team: 'platform-team', role: 'Platform engineer' };

  // Team budgets mirror kubernetes/finops/team-budgets-configmap.yaml.
  var teams = [
    { name: 'platform-team', display: 'Platform Team', budget: 2000, spend: 1712, lead: 'Alex Rivera', members: 9, namespace: 'platform', slack: '#team-platform', mission: 'Builds and runs the Internal Developer Platform: golden paths, GitOps, the portal, and the AI gateway.' },
    { name: 'ml-team', display: 'ML Team', budget: 1500, spend: 1394, lead: 'Priya Nair', members: 6, namespace: 'ml-platform', slack: '#team-ml', mission: 'Owns model training, serving, and the recommendation and fraud models.' },
    { name: 'backend-team', display: 'Backend Team', budget: 600, spend: 642, lead: 'Marcus Chen', members: 11, namespace: 'commerce', slack: '#team-backend', mission: 'Payments, orders, inventory and notifications for the commerce system.' },
    { name: 'data-team', display: 'Data Team', budget: 800, spend: 517, lead: 'Sofia Alvarez', members: 5, namespace: 'data', slack: '#team-data', mission: 'Search, analytics pipelines and the event warehouse.' },
    { name: 'frontend-team', display: 'Frontend Team', budget: 400, spend: 288, lead: 'Jordan Blake', members: 7, namespace: 'web', slack: '#team-frontend', mission: 'Customer-facing web storefront and design system.' },
    { name: 'android-team', display: 'Android Team', budget: 300, spend: 214, lead: 'Lena Fischer', members: 4, namespace: 'mobile', slack: '#team-android', mission: 'The Android shopping app and shared Kotlin SDK.' },
    { name: 'ios-team', display: 'iOS Team', budget: 300, spend: 251, lead: 'Kenji Watanabe', members: 4, namespace: 'mobile', slack: '#team-ios', mission: 'The iOS shopping app built with SwiftUI.' },
    { name: 'qa-team', display: 'QA Platform Team', budget: 200, spend: 173, lead: 'Amara Okafor', members: 5, namespace: 'qa', slack: '#team-qa', mission: 'Test-suite golden paths, contract testing and the quality scorecard.' }
  ];

  var people = ['Alex Rivera', 'Priya Nair', 'Marcus Chen', 'Sofia Alvarez', 'Jordan Blake', 'Lena Fischer', 'Kenji Watanabe', 'Amara Okafor', 'Diego Santos', 'Hannah Kim', 'Omar Haddad', 'Chloe Martin'];

  // score = number of scorecard checks the entity passes (see CHECKS in app.js)
  // dora: df = deploys/day, lt = lead time (hours), cfr = change failure %, mttr = minutes
  var components = [
    { name: 'hello-service', type: 'service', owner: 'platform-team', system: 'internal-developer-platform', lifecycle: 'production', lang: 'Go', desc: 'Reference Go service used by every golden path walkthrough.', tags: ['go', 'golden-path', 'reference'], score: 12, slo: { avail: 99.5, latency: 99.0 }, dora: { df: 4.2, lt: 3.1, cfr: 4.0, mttr: 22 }, replicas: 3, version: '1.14.2', apis: ['hello-service-api'] },
    { name: 'idp-mcp-server', type: 'service', owner: 'platform-team', system: 'internal-developer-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'MCP server exposing IDP capabilities (catalog, scaffolding, metrics) as AI tools.', tags: ['mcp', 'ai', 'typescript'], score: 14, ai: true, slo: { avail: 99.9, latency: 99.0 }, dora: { df: 3.1, lt: 4.5, cfr: 6.2, mttr: 31 }, replicas: 2, version: '0.9.0', apis: ['idp-mcp-api'] },
    { name: 'qa-mcp-server', type: 'service', owner: 'qa-team', system: 'internal-developer-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'MCP server exposing QA and testing capabilities as AI tools for KAgent.', tags: ['mcp', 'qa', 'testing'], score: 11, ai: true, slo: { avail: 99.5, latency: 98.5 }, dora: { df: 1.6, lt: 7.8, cfr: 8.1, mttr: 44 }, replicas: 2, version: '0.6.3' },
    { name: 'contract-mcp-server', type: 'service', owner: 'qa-team', system: 'internal-developer-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'Self-describing, self-testing API contract registry.', tags: ['mcp', 'contract-testing', 'pact'], score: 13, ai: true, slo: { avail: 99.5, latency: 99.0 }, dora: { df: 1.2, lt: 9.4, cfr: 5.0, mttr: 38 }, replicas: 1, version: '0.4.1' },
    { name: 'github-mcp-server', type: 'service', owner: 'platform-team', system: 'ai-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'MCP server exposing GitHub API operations as AI tools.', tags: ['mcp', 'github'], score: 9, ai: true, slo: { avail: 99.5, latency: 98.0 }, dora: { df: 0.9, lt: 11.2, cfr: 7.5, mttr: 52 }, replicas: 1, version: '0.3.4' },
    { name: 'argocd-mcp-server', type: 'service', owner: 'platform-team', system: 'ai-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'MCP server exposing ArgoCD application management as AI tools.', tags: ['mcp', 'argocd', 'gitops'], score: 10, ai: true, slo: { avail: 99.5, latency: 98.0 }, dora: { df: 0.8, lt: 12.6, cfr: 4.8, mttr: 35 }, replicas: 1, version: '0.3.0' },
    { name: 'cost-mcp-server', type: 'service', owner: 'platform-team', system: 'ai-platform', lifecycle: 'experimental', lang: 'TypeScript', desc: 'MCP server exposing OpenCost spend and budget data as AI tools.', tags: ['mcp', 'finops', 'opencost'], score: 7, ai: true, slo: { avail: 99.0, latency: 97.5 }, dora: { df: 0.5, lt: 18.0, cfr: 9.0, mttr: 70 }, replicas: 1, version: '0.2.0' },
    { name: 'incident-mcp-server', type: 'service', owner: 'platform-team', system: 'ai-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'MCP server exposing incident tracking, alert history, runbooks and notifications as AI tools.', tags: ['mcp', 'sre', 'incidents'], score: 9, ai: true, slo: { avail: 99.9, latency: 99.0 }, dora: { df: 0.7, lt: 14.1, cfr: 3.5, mttr: 28 }, replicas: 2, version: '0.2.6' },
    { name: 'security-mcp-server', type: 'service', owner: 'platform-team', system: 'ai-platform', lifecycle: 'experimental', lang: 'TypeScript', desc: 'MCP server exposing Dependabot alerts, secret-rotation status and Kyverno policy violations as AI tools.', tags: ['mcp', 'security', 'kyverno'], score: 8, ai: true, slo: { avail: 99.0, latency: 97.5 }, dora: { df: 0.6, lt: 16.3, cfr: 6.0, mttr: 48 }, replicas: 1, version: '0.1.9' },
    { name: 'agent-event-router', type: 'service', owner: 'ml-team', system: 'ai-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'Webhook receiver that routes platform events to KAgent agents via A2A.', tags: ['kagent', 'a2a', 'webhooks'], score: 10, ai: true, slo: { avail: 99.5, latency: 99.0 }, dora: { df: 1.1, lt: 8.9, cfr: 5.5, mttr: 40 }, replicas: 2, version: '0.5.2' },
    { name: 'approval-service', type: 'service', owner: 'platform-team', system: 'ai-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'Human-in-the-loop approval gate for agent-initiated mutating actions, with Policy-as-Prompt evaluation.', tags: ['hitl', 'governance', 'ai'], score: 12, ai: true, slo: { avail: 99.9, latency: 99.5 }, dora: { df: 1.4, lt: 6.2, cfr: 2.9, mttr: 19 }, replicas: 2, version: '1.2.0' },
    { name: 'mcp-common', type: 'library', owner: 'platform-team', system: 'ai-platform', lifecycle: 'production', lang: 'TypeScript', desc: 'Shared MCP server plumbing: metrics, audit logging, auth.', tags: ['library', 'mcp'], score: 6, slo: null, dora: { df: 0.4, lt: 20.0, cfr: 2.0, mttr: 15 }, replicas: 0, version: '0.8.0' },
    { name: 'payments-api', type: 'service', owner: 'backend-team', system: 'commerce', lifecycle: 'production', lang: 'Go', desc: 'Card and wallet payment authorisation, capture and refunds.', tags: ['go', 'payments', 'pci'], score: 13, slo: { avail: 99.95, latency: 99.0 }, dora: { df: 6.8, lt: 2.2, cfr: 3.1, mttr: 18 }, replicas: 6, version: '3.22.0', apis: ['payments-api-v2'] },
    { name: 'checkout-web', type: 'website', owner: 'frontend-team', system: 'commerce', lifecycle: 'production', lang: 'React', desc: 'Customer checkout flow: cart, address, payment and confirmation.', tags: ['react', 'vite', 'frontend'], score: 10, slo: { avail: 99.9, latency: 98.0 }, dora: { df: 9.5, lt: 1.4, cfr: 6.5, mttr: 25 }, replicas: 4, version: '2026.11.19' },
    { name: 'orders-service', type: 'service', owner: 'backend-team', system: 'commerce', lifecycle: 'production', lang: 'Java', desc: 'Order lifecycle: placement, fulfilment state machine and cancellations.', tags: ['java', 'spring-boot', 'kafka'], score: 8, slo: { avail: 99.9, latency: 99.0 }, dora: { df: 2.3, lt: 26.0, cfr: 11.4, mttr: 96 }, replicas: 4, version: '5.8.1', apis: ['orders-api', 'order-events'] },
    { name: 'inventory-service', type: 'service', owner: 'backend-team', system: 'commerce', lifecycle: 'production', lang: 'Node.js', desc: 'Stock levels and reservations across warehouses.', tags: ['nodejs', 'express'], score: 6, slo: { avail: 99.5, latency: 98.5 }, dora: { df: 1.0, lt: 30.5, cfr: 14.2, mttr: 130 }, replicas: 3, version: '1.9.4' },
    { name: 'notifications-service', type: 'service', owner: 'backend-team', system: 'commerce', lifecycle: 'production', lang: 'Node.js', desc: 'Email, SMS and push notifications with per-user preferences.', tags: ['nodejs', 'sqs'], score: 5, slo: { avail: 99.5, latency: 97.0 }, dora: { df: 0.6, lt: 48.0, cfr: 9.8, mttr: 75 }, replicas: 2, version: '0.14.0' },
    { name: 'search-api', type: 'service', owner: 'data-team', system: 'data-platform', lifecycle: 'production', lang: 'Python', desc: 'Product search with typo tolerance and facet filters.', tags: ['python', 'fastapi', 'search'], score: 11, slo: { avail: 99.9, latency: 99.0 }, dora: { df: 3.4, lt: 5.1, cfr: 4.4, mttr: 27 }, replicas: 4, version: '2.3.0', apis: ['search-api-graphql'] },
    { name: 'analytics-pipeline', type: 'service', owner: 'data-team', system: 'data-platform', lifecycle: 'production', lang: 'Python', desc: 'Streaming clickstream ingestion into the event warehouse.', tags: ['python', 'kafka', 'streaming'], score: 7, slo: { avail: 99.0, latency: 95.0 }, dora: { df: 0.9, lt: 20.4, cfr: 7.0, mttr: 62 }, replicas: 3, version: '1.4.7' },
    { name: 'recommendations-ml', type: 'service', owner: 'ml-team', system: 'ai-platform', lifecycle: 'production', lang: 'Python', desc: 'Personalised product recommendations served from an MLflow-registered model.', tags: ['ml', 'mlflow', 'ai', 'python'], score: 12, ai: true, slo: { avail: 99.5, latency: 98.0 }, dora: { df: 1.8, lt: 9.0, cfr: 5.6, mttr: 33 }, replicas: 3, version: '4.0.0' },
    { name: 'fraud-scoring', type: 'service', owner: 'ml-team', system: 'commerce', lifecycle: 'experimental', lang: 'Python', desc: 'Real-time fraud risk score for payment authorisations.', tags: ['ml', 'ai', 'payments'], score: 8, ai: true, slo: { avail: 99.9, latency: 99.5 }, dora: { df: 0.7, lt: 15.5, cfr: 8.3, mttr: 41 }, replicas: 2, version: '0.7.0' },
    { name: 'android-shop-app', type: 'mobile', owner: 'android-team', system: 'commerce', lifecycle: 'production', lang: 'Kotlin', desc: 'Android shopping app.', tags: ['android', 'kotlin', 'mobile'], score: 9, slo: null, dora: { df: 0.3, lt: 72.0, cfr: 5.0, mttr: 240 }, replicas: 0, version: '7.12.0' },
    { name: 'ios-shop-app', type: 'mobile', owner: 'ios-team', system: 'commerce', lifecycle: 'production', lang: 'Swift', desc: 'iOS shopping app built with SwiftUI.', tags: ['ios', 'swiftui', 'mobile'], score: 10, slo: null, dora: { df: 0.3, lt: 68.0, cfr: 4.0, mttr: 210 }, replicas: 0, version: '7.12.1' }
  ];

  var apis = [
    { name: 'hello-service-api', type: 'openapi', owner: 'platform-team', system: 'internal-developer-platform', provider: 'hello-service', version: 'v1', desc: 'Greeting endpoints for the reference service.',
      endpoints: [['GET', '/healthz', 'Liveness probe'], ['GET', '/readyz', 'Readiness probe'], ['GET', '/hello', 'Return a greeting'], ['GET', '/hello/{name}', 'Greet by name'], ['GET', '/metrics', 'Prometheus metrics']] },
    { name: 'idp-mcp-api', type: 'openapi', owner: 'platform-team', system: 'internal-developer-platform', provider: 'idp-mcp-server', version: 'v1', desc: 'HTTP surface of the IDP MCP server (MCP over streamable HTTP plus health).',
      endpoints: [['POST', '/mcp', 'MCP JSON-RPC endpoint (tools/list, tools/call)'], ['GET', '/health', 'Health check'], ['GET', '/metrics', 'mcp_tool_calls_total and friends']] },
    { name: 'payments-api-v2', type: 'openapi', owner: 'backend-team', system: 'commerce', provider: 'payments-api', version: 'v2', desc: 'Authorise, capture and refund payments.',
      endpoints: [['POST', '/v2/payments', 'Authorise a payment'], ['POST', '/v2/payments/{id}/capture', 'Capture an authorised payment'], ['POST', '/v2/payments/{id}/refunds', 'Refund a captured payment'], ['GET', '/v2/payments/{id}', 'Get payment status']] },
    { name: 'orders-api', type: 'openapi', owner: 'backend-team', system: 'commerce', provider: 'orders-service', version: 'v1', desc: 'Place and track orders.',
      endpoints: [['POST', '/v1/orders', 'Place an order'], ['GET', '/v1/orders/{id}', 'Get an order'], ['POST', '/v1/orders/{id}/cancel', 'Cancel an order'], ['GET', '/v1/orders?customer={id}', 'List orders for a customer']] },
    { name: 'order-events', type: 'asyncapi', owner: 'backend-team', system: 'commerce', provider: 'orders-service', version: '1.2.0', desc: 'Order lifecycle events on Kafka topic orders.v1.',
      endpoints: [['PUB', 'orders.v1 / OrderPlaced', 'Emitted when an order is accepted'], ['PUB', 'orders.v1 / OrderShipped', 'Emitted when fulfilment ships'], ['PUB', 'orders.v1 / OrderCancelled', 'Emitted on cancellation']] },
    { name: 'search-api-graphql', type: 'graphql', owner: 'data-team', system: 'data-platform', provider: 'search-api', version: '2', desc: 'Product search GraphQL schema.',
      endpoints: [['QUERY', 'search(query, filters, page)', 'Full-text product search'], ['QUERY', 'suggest(prefix)', 'Autocomplete'], ['QUERY', 'facets(query)', 'Facet counts']] }
  ];

  var systems = [
    { name: 'internal-developer-platform', owner: 'platform-team', desc: 'The IDP itself: portal, golden paths, GitOps and the reference service.' },
    { name: 'ai-platform', owner: 'ml-team', desc: 'KAgent agents, the AI gateway, LiteLLM, MCP servers and model serving.' },
    { name: 'commerce', owner: 'backend-team', desc: 'Storefront, checkout, payments, orders and mobile apps.' },
    { name: 'data-platform', owner: 'data-team', desc: 'Search, analytics and the event warehouse.' }
  ];

  // Crossplane claims double as catalog Resources.
  var resources = [
    { name: 'payments-db', kind: 'PostgreSQLInstance', provider: 'rds-database-crossplane', owner: 'backend-team', system: 'commerce', ns: 'commerce', synced: true, ready: true, age: '84d', secret: 'payments-db-conn', desc: 'RDS PostgreSQL 16, db.t4g.medium, Multi-AZ.' },
    { name: 'orders-queue', kind: 'Queue', provider: 'sqs-queue-crossplane', owner: 'backend-team', system: 'commerce', ns: 'commerce', synced: true, ready: true, age: '61d', secret: 'orders-queue-conn', desc: 'SQS standard queue with DLQ (maxReceiveCount 5).' },
    { name: 'search-snapshots', kind: 'Bucket', provider: 's3-bucket-crossplane', owner: 'data-team', system: 'data-platform', ns: 'data', synced: true, ready: true, age: '40d', secret: 'search-snapshots-conn', desc: 'S3 bucket, versioned, SSE-KMS, 30-day lifecycle.' },
    { name: 'clickstream-events', kind: 'Topic', provider: 'kafka-topic-crossplane', owner: 'data-team', system: 'data-platform', ns: 'data', synced: true, ready: false, age: '3h', secret: 'clickstream-events-conn', desc: 'MSK topic, 12 partitions, 7-day retention.', reason: 'Waiting for MSK cluster to report topic ACLs' },
    { name: 'sessions-table', kind: 'Table', provider: 'dynamodb-table-crossplane', owner: 'frontend-team', system: 'commerce', ns: 'web', synced: true, ready: true, age: '22d', secret: 'sessions-table-conn', desc: 'DynamoDB on-demand, TTL on expiresAt.' },
    { name: 'ml-artifacts', kind: 'Bucket', provider: 's3-bucket-crossplane', owner: 'ml-team', system: 'ai-platform', ns: 'ml-platform', synced: true, ready: true, age: '118d', secret: 'ml-artifacts-conn', desc: 'MLflow artifact store.' },
    { name: 'fraud-features', kind: 'Table', provider: 'dynamodb-table-crossplane', owner: 'ml-team', system: 'commerce', ns: 'ml-platform', synced: false, ready: false, age: '12m', secret: 'fraud-features-conn', desc: 'Online feature store for fraud-scoring.', reason: 'ReconcileError: AccessDenied on dynamodb:TagResource (IRSA policy missing tag permission)' }
  ];

  // Real scorecard checks (scorecard.ts CHECKS[]).
  var checks = [
    ['has-owner', 'Hygiene', 'Has owner'], ['has-techdocs', 'Hygiene', 'Has TechDocs'], ['has-health-probes', 'Hygiene', 'Has Kubernetes probes'],
    ['has-runbook-url', 'Hygiene', 'Has runbook URL'], ['has-api-definition', 'Hygiene', 'Has API definition'], ['uses-pinned-image-tag', 'Hygiene', 'Pinned image tag (no :latest)'],
    ['has-coverage-gate', 'Shift-Left CI', 'Coverage gate in CI'], ['has-static-analysis', 'Shift-Left CI', 'Static analysis in CI'], ['has-vuln-scan', 'Shift-Left CI', 'Vuln scan in CI'],
    ['has-contract-tests', 'Test Coverage', 'Contract tests'], ['has-e2e-tests', 'Test Coverage', 'End-to-end tests'],
    ['has-sonar-scanning', 'Security', 'SonarCloud quality gate'], ['has-snyk-scanning', 'Security', 'Snyk SCA scan'], ['has-trivy-scanning', 'Security', 'Trivy image scan'],
    ['has-model-card', 'AI Governance', 'Has model card', 'ai'], ['has-eval-suite', 'AI Governance', 'LLM eval suite in CI', 'ai'], ['has-ai-observability', 'AI Governance', 'AI observability wired', 'ai'],
    ['has-litellm-virtual-key', 'AI Governance', 'Has LiteLLM virtual key', 'ai'], ['has-budget-configured', 'AI Governance', 'Has spend budget configured', 'ai'],
    ['has-code-signing', 'Mobile', 'Automated code signing', 'mobile'], ['has-min-sdk-version', 'Mobile', 'Minimum SDK version', 'mobile'], ['has-accessibility-tests', 'Mobile', 'Accessibility tests', 'mobile'],
    ['has-crashlytics-enabled', 'Mobile', 'Crash reporting enabled', 'mobile'], ['has-app-size-budget', 'Mobile', 'App size budget', 'mobile']
  ];
  var tierThresholds = { std: { bronze: 4, silver: 7, gold: 9 }, ai: { bronze: 5, silver: 9, gold: 12 } };

  var activity = [
    { t: '6 min ago', who: 'Priya Nair', what: 'promoted', target: 'recommendations-ml', detail: 'canary to 100% (v4.0.0)', kind: 'deploy' },
    { t: '14 min ago', who: 'idp-assistant', what: 'scaffolded', target: 'inventory-sync', detail: 'from go-service template (approved by Marcus Chen)', kind: 'ai' },
    { t: '32 min ago', who: 'ArgoCD', what: 'synced', target: 'payments-api-local', detail: 'revision 8c1f2ab → Healthy', kind: 'gitops' },
    { t: '1 h ago', who: 'Amara Okafor', what: 'ran template', target: 'k6-performance-suite', detail: 'for checkout-web, PR #412 opened', kind: 'scaffold' },
    { t: '2 h ago', who: 'Alertmanager', what: 'resolved', target: 'HighErrorRate', detail: 'orders-service error rate back under 1%', kind: 'alert' },
    { t: '3 h ago', who: 'security-agent', what: 'flagged', target: 'inventory-service', detail: '2 high CVEs in express 4.19 (Snyk)', kind: 'security' },
    { t: '5 h ago', who: 'Sofia Alvarez', what: 'reached Gold', target: 'search-api', detail: 'contract tests added (11 checks passing)', kind: 'scorecard' },
    { t: 'Yesterday', who: 'Kenji Watanabe', what: 'released', target: 'ios-shop-app', detail: '7.12.1 to App Store (phased 10%)', kind: 'deploy' },
    { t: 'Yesterday', who: 'cost-agent', what: 'warned', target: 'backend-team', detail: 'budget at 107% of $600 for November', kind: 'cost' }
  ];

  var incidents = [
    { id: 'INC-2041', title: 'Checkout payment failures for wallet payments', sev: 'SEV2', status: 'resolved', service: 'payments-api', started: 'Nov 18, 14:02', duration: '47 min', commander: 'Marcus Chen', pm: true,
      summary: 'A wallet provider rotated their TLS intermediate certificate. payments-api pinned the old chain, so 31% of wallet authorisations failed until the pin was removed.',
      timeline: [['14:02', 'HighErrorRate fires for payments-api (5xx 6.1%)'], ['14:05', 'incident-agent opens INC-2041 and pages backend on-call'], ['14:11', 'Errors isolated to wallet provider calls'], ['14:26', 'Root cause: certificate pin mismatch'], ['14:38', 'Hotfix 3.21.4 rolled out via canary (10% → 100%)'], ['14:49', 'Error rate back under 0.2%; resolved']],
      actions: [['Replace certificate pinning with CA bundle validation', 'backend-team', 'done'], ['Add synthetic check for wallet authorisation', 'qa-team', 'in progress'], ['Alert on provider TLS expiry 30 days ahead', 'platform-team', 'open']] },
    { id: 'INC-2040', title: 'Search latency above SLO during reindex', sev: 'SEV3', status: 'resolved', service: 'search-api', started: 'Nov 15, 09:40', duration: '2 h 05 min', commander: 'Sofia Alvarez', pm: true,
      summary: 'A full reindex ran during peak traffic and saturated the search cluster; p95 latency reached 1.8 s.',
      timeline: [['09:40', 'SLO burn-rate alert (fast burn) for search-api latency'], ['09:52', 'Reindex job identified as cause'], ['10:15', 'Reindex paused; latency recovers partially'], ['11:45', 'Reindex rescheduled to 02:00 UTC; resolved']],
      actions: [['Run reindex as Argo Workflow in the off-peak window', 'data-team', 'done'], ['Add reindex guard to the runbook', 'data-team', 'done']] },
    { id: 'INC-2042', title: 'inventory-service pods in CrashLoopBackOff', sev: 'SEV3', status: 'investigating', service: 'inventory-service', started: 'Today, 10:12', duration: 'ongoing', commander: 'Diego Santos', pm: false,
      summary: 'New release fails readiness: missing REDIS_URL after a secret rename.',
      timeline: [['10:12', 'KubePodCrashLooping fires (3 pods)'], ['10:15', 'Runbook pod-crash-loop linked by incident-agent'], ['10:21', 'Rollback proposed by release-agent, awaiting approval']], actions: [] },
    { id: 'INC-2038', title: 'ArgoCD sync stuck on cert-manager CRDs', sev: 'SEV4', status: 'resolved', service: 'platform', started: 'Nov 9, 16:30', duration: '25 min', commander: 'Alex Rivera', pm: true,
      summary: 'A cert-manager chart bump changed CRDs; ArgoCD needed ServerSideApply to sync them.',
      timeline: [['16:30', 'cert-manager app OutOfSync, sync failing'], ['16:44', 'Enabled ServerSideApply=true sync option'], ['16:55', 'Synced and Healthy; resolved']],
      actions: [['Default ServerSideApply for CRD-heavy charts', 'platform-team', 'done']] }
  ];

  var runbooks = [
    ['pod-crash-loop', 'Pod crash loop'], ['high-cpu', 'High CPU'], ['high-memory', 'High memory'], ['image-pull-backoff', 'ImagePullBackOff'],
    ['deployment-rollback', 'Deployment rollback'], ['db-recovery', 'Database recovery'], ['cost-budget-exceeded', 'Cost budget exceeded'],
    ['incident-severity', 'Incident severity levels'], ['kagent-guardrails', 'KAgent guardrails'], ['kind-node-ip-mismatch', 'Kind node IP mismatch'], ['regional-rebuild', 'Regional rebuild']
  ];

  var docs = [
    { id: 'getting-started', title: 'Getting started', section: 'Platform', body: [
      ['p', 'This platform gives every team a paved road from idea to production: pick a golden-path template, get a repo with CI, a Helm release and dashboards, and ship through GitOps.'],
      ['h2', 'Three ways in'], ['ul', ['The portal: catalog, templates, scorecards and dashboards.', 'The idp CLI: idp scaffold, idp doctor, idp context inject.', 'The AI Assistant: ask in plain English; mutating actions wait for your approval.']],
      ['h2', 'Your first service'], ['code', 'idp scaffold service --name my-svc --type go\n# or use Create → Go Service in the portal'],
      ['p', 'ArgoCD picks the new service up from services/<name>/ through the idp-services ApplicationSet. No raw Kubernetes YAML: every service uses the one shared Helm chart.']] },
    { id: 'golden-paths', title: 'Golden paths', section: 'Platform', body: [
      ['p', '60 software templates cover services, test suites, cloud resources, AI agents and mobile apps. Each produces the same shape: source, Dockerfile, helm-values-local.yaml, helm-values-aws.yaml and a catalog-info.yaml.'],
      ['h2', 'Terraform or Crossplane?'], ['p', 'Resource templates come in pairs. s3-bucket opens a Terraform PR that a platform engineer applies; s3-bucket-crossplane writes a Claim that ArgoCD syncs. Choose by lifecycle: long-lived shared infra goes to Terraform, per-service resources to Crossplane.'],
      ['h2', 'Scorecard tiers'], ['p', 'Bronze, Silver and Gold are count thresholds over the Tech Insights checks: 4 / 7 / 9 of 14 for standard services, 5 / 9 / 12 of 19 for AI services.']] },
    { id: 'ai-gateway', title: 'AI gateway and agents', section: 'AI & Agents', body: [
      ['p', 'One agentgateway instance fronts all 8 MCP servers and all model traffic. Model calls go on to LiteLLM, which holds the provider keys, virtual keys and spend tracking.'],
      ['h2', 'Approvals'], ['p', 'Mutating tools such as scaffold_service, sync_app and rollback_app call request_approval first. A human approves or rejects in Agent Approvals; the agent polls get_approval_status.'],
      ['code', 'kubectl get agents -n kagent\nkubectl logs -n ml-platform deploy/ai-gateway']] },
    { id: 'hello-service', title: 'hello-service', section: 'Services', body: [
      ['p', 'Reference Go service. Every golden-path walkthrough starts here.'],
      ['h2', 'Run locally'], ['code', 'cd services/hello-service\ngo test ./... -coverprofile=coverage.out\ngo run ./src'],
      ['h2', 'SLOs'], ['p', 'Availability 99.5%, latency 99.0% of requests under 300 ms, both over 30 days. Sloth generates the recording and burn-rate rules.']] },
    { id: 'runbooks', title: 'Runbooks', section: 'Operate', body: [
      ['p', 'Every Prometheus alert links to one of these runbooks. The incident-agent fetches them with get_runbook.'], ['runbooks']] }
  ];

  var radar = [
    ['Go', 'Languages & Frameworks', 'Adopt'], ['TypeScript', 'Languages & Frameworks', 'Adopt'], ['FastAPI', 'Languages & Frameworks', 'Adopt'], ['Spring Boot 3', 'Languages & Frameworks', 'Trial'], ['LangGraph', 'Languages & Frameworks', 'Trial'], ['Ruby / Sinatra', 'Languages & Frameworks', 'Hold'], ['Flutter', 'Languages & Frameworks', 'Assess'],
    ['ArgoCD', 'Platforms', 'Adopt'], ['Kubernetes (EKS)', 'Platforms', 'Adopt'], ['Crossplane', 'Platforms', 'Trial'], ['KAgent', 'Platforms', 'Trial'], ['agentgateway', 'Platforms', 'Assess'], ['Self-managed Kafka', 'Platforms', 'Hold'],
    ['Playwright', 'Tools', 'Adopt'], ['k6', 'Tools', 'Adopt'], ['Trivy', 'Tools', 'Adopt'], ['LiteLLM', 'Tools', 'Trial'], ['Langfuse', 'Tools', 'Trial'], ['DeepEval', 'Tools', 'Assess'], ['Jenkins', 'Tools', 'Hold'],
    ['GitOps', 'Techniques', 'Adopt'], ['Contract testing', 'Techniques', 'Adopt'], ['SLOs with burn-rate alerts', 'Techniques', 'Adopt'], ['Canary releases', 'Techniques', 'Trial'], ['Policy-as-Prompt', 'Techniques', 'Assess'], ['Manual prod changes', 'Techniques', 'Hold']
  ];

  var learning = [
    { title: 'Scaffold your first Go service', topic: 'Services', level: 'Beginner', type: 'Tutorial', mins: 15, template: 'go-service' },
    { title: 'Deploy to Kind from the portal', topic: 'Services', level: 'Beginner', type: 'Tutorial', mins: 10, template: 'deploy-to-kind' },
    { title: 'Add a Playwright E2E suite', topic: 'Testing', level: 'Beginner', type: 'Tutorial', mins: 20, template: 'playwright-e2e-suite' },
    { title: 'Contract testing with the MCP registry', topic: 'Testing', level: 'Intermediate', type: 'How-to', mins: 25, template: 'enable-contract-testing' },
    { title: 'Load testing with k6', topic: 'Testing', level: 'Intermediate', type: 'How-to', mins: 20, template: 'k6-performance-suite' },
    { title: 'Mutation testing explained', topic: 'Testing', level: 'Advanced', type: 'Concept', mins: 12 },
    { title: 'Terraform or Crossplane?', topic: 'Infrastructure', level: 'Intermediate', type: 'Concept', mins: 8 },
    { title: 'Request an S3 bucket with Crossplane', topic: 'Infrastructure', level: 'Beginner', type: 'How-to', mins: 10, template: 's3-bucket-crossplane' },
    { title: 'Write a reusable Terraform module', topic: 'Infrastructure', level: 'Advanced', type: 'Tutorial', mins: 40, template: 'terraform-module' },
    { title: 'Define SLOs for your service', topic: 'Observability', level: 'Intermediate', type: 'How-to', mins: 15, template: 'slo-definition' },
    { title: 'Reading the DORA dashboard', topic: 'Observability', level: 'Beginner', type: 'Concept', mins: 6 },
    { title: 'Ship a canary with Argo Rollouts', topic: 'Observability', level: 'Advanced', type: 'Tutorial', mins: 30, template: 'canary-deployment' },
    { title: 'Build a KAgent agent', topic: 'AI', level: 'Intermediate', type: 'Tutorial', mins: 30, template: 'ai-agent-kagent' },
    { title: 'Build an MCP server', topic: 'AI', level: 'Advanced', type: 'Tutorial', mins: 45, template: 'mcp-server' },
    { title: 'Trace an LLM app with Langfuse', topic: 'AI', level: 'Intermediate', type: 'How-to', mins: 15, template: 'enable-langfuse-tracing' },
    { title: 'How agent approvals work', topic: 'AI', level: 'Beginner', type: 'Concept', mins: 7 },
    { title: 'Enable SonarCloud and Snyk', topic: 'Security', level: 'Beginner', type: 'How-to', mins: 10, template: 'enable-security-scanning' },
    { title: 'Rotate secrets automatically', topic: 'Security', level: 'Advanced', type: 'How-to', mins: 20, template: 'secret-rotation' }
  ];
  var learningDone = ['Scaffold your first Go service', 'Deploy to Kind from the portal', 'Reading the DORA dashboard', 'How agent approvals work', 'Add a Playwright E2E suite'];

  // Engineering Intelligence: dimensions and level floors from docs/engineering-intelligence/maturity-model.md
  var maturityLevels = [
    { level: 1, name: 'Ad Hoc', desc: 'Inconsistent practices; no shared tooling.' },
    { level: 2, name: 'Standardised', desc: 'Quality ≥ 50, Platform ≥ 40, Reliability ≥ 40.' },
    { level: 3, name: 'Platform Enabled', desc: 'Platform ≥ 70, Quality ≥ 65, Reliability ≥ 65.' },
    { level: 4, name: 'AI Enabled', desc: 'AI Engineering ≥ 65, Security ≥ 60, Developer Experience ≥ 60.' },
    { level: 5, name: 'Autonomous', desc: 'AI Engineering ≥ 80, Reliability ≥ 80, plus approval-gated and auto-remediation evidence (not yet measurable).' }
  ];
  var dimensions = ['Quality', 'Platform', 'Reliability', 'Security', 'Developer Experience', 'AI Engineering'];
  var teamScores = {
    'platform-team': [78, 88, 81, 72, 74, 70], 'ml-team': [69, 74, 70, 63, 66, 82], 'backend-team': [62, 71, 58, 66, 59, 41],
    'data-team': [71, 76, 72, 61, 68, 48], 'frontend-team': [66, 72, 67, 55, 71, 39], 'android-team': [57, 52, 61, 58, 63, 22],
    'ios-team': [59, 55, 64, 60, 65, 25], 'qa-team': [84, 79, 70, 64, 72, 58]
  };
  var core4 = [
    { area: 'Speed', metric: 'Merged PRs / engineer / week', value: '3.8', prev: '3.4', good: true, secondary: 'Lead time 6.2 h · deploys 41/day' },
    { area: 'Effectiveness', metric: 'Developer Experience Index', value: '71', prev: '67', good: true, secondary: 'Ease of delivery 3.9 / 5' },
    { area: 'Quality', metric: 'Change failure rate', value: '6.4%', prev: '7.9%', good: true, secondary: 'MTTR 38 min' },
    { area: 'Impact', metric: '% time on new capabilities', value: '54%', prev: '56%', good: false, secondary: 'Self-reported in survey' }
  ];

  var survey = [
    { q: 'I can get a change into production without waiting on another team.', score: 3.9, prev: 3.6 },
    { q: 'Our CI pipeline gives me useful feedback in under 10 minutes.', score: 3.4, prev: 3.3 },
    { q: 'I can find the documentation I need when I need it.', score: 3.7, prev: 3.2 },
    { q: 'Local development environments are easy to set up.', score: 3.1, prev: 2.8 },
    { q: 'I trust our tests to catch regressions before release.', score: 3.5, prev: 3.5 },
    { q: 'I have enough focus time to do deep work.', score: 2.9, prev: 3.0 },
    { q: 'AI tools save me meaningful time each week.', score: 3.8, prev: 3.4 }
  ];

  var copilot = { seats: 64, active: 52, acceptance: 31.4, suggestions: 48210, accepted: 15138, linesAccepted: 41820, chatTurns: 9312,
    languages: [['TypeScript', 38.1], ['Go', 33.4], ['Python', 31.0], ['Java', 27.6], ['Kotlin', 25.2], ['Swift', 22.9], ['YAML', 18.7]],
    teams: [['platform-team', 9, 34.2], ['backend-team', 11, 29.8], ['ml-team', 6, 33.0], ['data-team', 5, 30.1], ['frontend-team', 7, 35.6], ['qa-team', 5, 28.4], ['android-team', 4, 24.9], ['ios-team', 4, 23.7]] };

  // KAgent agents and their models (kubernetes/kagent/*-agent.yaml).
  var agents = [
    { name: 'idp-assistant', model: 'claude-anthropic', ready: true, team: 'platform-team', desc: 'Searches the catalog, checks metrics, scaffolds services and test suites, manages contracts and ArgoCD releases, with persistent user memory.', tools: ['catalog_search', 'catalog_semantic_search', 'get_service_metrics', 'get_template_params', 'scaffold_service', 'list_deployments', 'list_templates', 'get_user_memory', 'set_user_memory', 'list_test_suites', 'scaffold_test_suite', 'register_contract', 'list_apps', 'sync_app', 'rollback_app'] },
    { name: 'platform-assistant', model: 'claude-sonnet', ready: true, team: 'platform-team', desc: 'Unified entry point across IDP, QA, contract, release and cost capabilities with persistent user memory.', tools: ['catalog_search', 'catalog_semantic_search', 'get_service_metrics', 'scaffold_service', 'list_test_suites', 'can_i_deploy', 'list_apps', 'get_team_spend'] },
    { name: 'qa-assistant', model: 'claude-sonnet', ready: true, team: 'qa-team', desc: 'Discovers and scaffolds test suites, searches the testing catalog and queries test metrics.', tools: ['list_test_suites', 'scaffold_test_suite', 'search_test_catalog', 'get_test_metrics', 'get_pr_diff', 'add_pr_comment', 'get_ci_status', 'request_approval', 'get_approval_status'] },
    { name: 'contract-assistant', model: 'claude-sonnet', ready: true, team: 'qa-team', desc: 'Registers API specs, detects breaking changes, generates Pact consumer tests and validates compatibility.', tools: ['fetch_service_contract', 'auto_discover_contracts', 'register_contract', 'get_contract', 'list_contracts', 'generate_contract_tests', 'validate_compatibility', 'detect_breaking_changes', 'get_compatibility_report', 'can_i_deploy', 'catalog_search', 'list_deployments'] },
    { name: 'release-agent', model: 'claude-sonnet', ready: true, team: 'platform-team', desc: 'Manages ArgoCD application syncs, rollbacks and health checks across environments.', tools: ['list_apps', 'get_app_health', 'get_app_diff', 'sync_app', 'rollback_app', 'catalog_search', 'list_deployments', 'request_approval', 'get_approval_status'] },
    { name: 'incident-agent', model: 'claude-sonnet', ready: true, team: 'platform-team', desc: 'Triages firing alerts, tracks open incidents, surfaces runbooks and posts status updates.', tools: ['get_open_incidents', 'get_alert_history', 'get_runbook', 'post_incident_update', 'send_notification', 'get_incident_timeline', 'link_pagerduty_incident', 'get_service_metrics', 'list_deployments'] },
    { name: 'cost-agent', model: 'claude-sonnet', ready: true, team: 'platform-team', desc: 'Analyses team spend, forecasts overruns, lists budget breaches and recommends rightsizing.', tools: ['get_team_spend', 'forecast_budget', 'list_budget_overruns', 'get_namespace_cost', 'get_rightsizing_recommendations', 'catalog_search'] },
    { name: 'security-agent', model: 'claude-sonnet', ready: false, team: 'platform-team', desc: 'Surfaces vulnerable dependencies, overdue secret rotations and cluster policy violations.', tools: ['list_vulnerable_deps', 'get_secret_rotation_status', 'list_policy_violations', 'catalog_search'], note: 'security target degraded at the gateway; 3 of 4 tools resolved' },
    { name: 'onboarding-agent', model: 'claude-haiku', ready: true, team: 'platform-team', desc: 'Helps new engineers find the right template, docs and team ownership.', tools: ['list_templates', 'get_template_params', 'catalog_search', 'catalog_semantic_search'] }
  ];
  var modelConfigs = [
    { name: 'claude-anthropic', provider: 'Anthropic', model: 'claude-haiku-4-5-20251001', via: 'ai-gateway → LiteLLM' },
    { name: 'claude-haiku', provider: 'Anthropic', model: 'claude-haiku-4-5-20251001', via: 'ai-gateway → LiteLLM' },
    { name: 'claude-sonnet', provider: 'Anthropic', model: 'claude-sonnet-4-6', via: 'ai-gateway → LiteLLM' },
    { name: 'claude-opus', provider: 'Anthropic', model: 'claude-opus-4-8', via: 'ai-gateway → LiteLLM' },
    { name: 'claude-sonnet-bedrock', provider: 'Anthropic (Bedrock)', model: 'claude-sonnet-bedrock', via: 'ai-gateway → LiteLLM → Bedrock (IRSA)' },
    { name: 'openai-prod', provider: 'OpenAI', model: 'gpt-4o', via: 'ai-gateway → LiteLLM' },
    { name: 'ollama-local', provider: 'Ollama', model: 'qwen2.5:1.5b', via: 'in-cluster Ollama' }
  ];

  // The 8 MCP targets behind the AI gateway (kubernetes/ml-platform/ai-gateway.yaml).
  var mcpServers = [
    { name: 'idp-mcp-server', target: 'idp', health: 'healthy', p95: 182, calls: 18420, tools: ['catalog_search', 'catalog_semantic_search', 'get_service_metrics', 'get_template_params', 'scaffold_service', 'list_deployments', 'list_templates', 'get_user_memory', 'set_user_memory', 'request_approval', 'get_approval_status', 'check_policy'] },
    { name: 'qa-mcp-server', target: 'qa', health: 'healthy', p95: 140, calls: 6210, tools: ['list_test_suites', 'scaffold_test_suite', 'search_test_catalog', 'get_test_metrics'] },
    { name: 'contract-mcp-server', target: 'contract', health: 'healthy', p95: 236, calls: 4870, tools: ['fetch_service_contract', 'auto_discover_contracts', 'register_contract', 'get_contract', 'list_contracts', 'generate_contract_tests', 'validate_compatibility', 'detect_breaking_changes', 'get_compatibility_report', 'can_i_deploy', 'get_stale_contracts', 'get_audit_log', 'generate_migration_guide'] },
    { name: 'github-mcp-server', target: 'github', health: 'healthy', p95: 412, calls: 3990, tools: ['get_pr_diff', 'add_pr_comment', 'get_ci_status', 'approve_pr', 'request_changes'] },
    { name: 'argocd-mcp-server', target: 'argocd', health: 'healthy', p95: 298, calls: 5120, tools: ['list_apps', 'get_app_health', 'get_app_diff', 'sync_app', 'rollback_app'] },
    { name: 'cost-mcp-server', target: 'cost', health: 'healthy', p95: 355, calls: 1840, tools: ['get_team_spend', 'forecast_budget', 'list_budget_overruns', 'get_namespace_cost', 'get_rightsizing_recommendations'] },
    { name: 'incident-mcp-server', target: 'incident', health: 'healthy', p95: 201, calls: 2630, tools: ['get_open_incidents', 'get_alert_history', 'get_runbook', 'post_incident_update', 'send_notification', 'get_incident_timeline', 'link_pagerduty_incident'] },
    { name: 'security-mcp-server', target: 'security', health: 'degraded', p95: 1840, calls: 910, tools: ['list_vulnerable_deps', 'get_secret_rotation_status', 'list_policy_violations'] }
  ];
  var gatewayModels = [
    { name: 'claude-haiku-4-5-20251001', provider: 'anthropic', backend: 'LiteLLM', rpm: 42 },
    { name: 'claude-sonnet-4-6', provider: 'anthropic', backend: 'LiteLLM', rpm: 118 },
    { name: 'claude-opus-4-8', provider: 'anthropic', backend: 'LiteLLM', rpm: 6 },
    { name: 'claude-sonnet-bedrock', provider: 'anthropic', backend: 'LiteLLM → Bedrock', rpm: 21 },
    { name: '*', provider: 'anthropic', backend: 'LiteLLM (catch-all)', rpm: 3 }
  ];

  var litellmKeys = [
    { key: 'sk-…a91f', alias: 'idp-assistant', team: 'platform-team', budget: 150, spend: 96.40, model: 'claude-haiku-4-5' },
    { key: 'sk-…3c02', alias: 'platform-assistant', team: 'platform-team', budget: 300, spend: 241.75, model: 'claude-sonnet-4-6' },
    { key: 'sk-…77d4', alias: 'qa-assistant', team: 'qa-team', budget: 80, spend: 52.10, model: 'claude-sonnet-4-6' },
    { key: 'sk-…b510', alias: 'contract-assistant', team: 'qa-team', budget: 60, spend: 33.85, model: 'claude-sonnet-4-6' },
    { key: 'sk-…e2a8', alias: 'release-agent', team: 'platform-team', budget: 60, spend: 41.20, model: 'claude-sonnet-4-6' },
    { key: 'sk-…0f6c', alias: 'recommendations-llm', team: 'ml-team', budget: 400, spend: 388.90, model: 'claude-sonnet-bedrock' },
    { key: 'sk-…5d1e', alias: 'incident-agent', team: 'platform-team', budget: 60, spend: 18.30, model: 'claude-sonnet-4-6' },
    { key: 'sk-…c4b9', alias: 'onboarding-agent', team: 'platform-team', budget: 20, spend: 4.95, model: 'claude-haiku-4-5' }
  ];

  var mlflow = [
    { name: 'recommendations-ranker', owner: 'ml-team', runs: [
      { id: 'a3f9c1', name: 'lightgbm-lr0.05', status: 'FINISHED', started: 'Nov 19, 22:10', dur: '18m', params: { model: 'lightgbm', lr: 0.05, depth: 8 }, metrics: { ndcg10: 0.412, map: 0.338, loss: 0.291 }, registered: 'v14 · Production' },
      { id: '7b22e0', name: 'lightgbm-lr0.1', status: 'FINISHED', started: 'Nov 19, 21:40', dur: '14m', params: { model: 'lightgbm', lr: 0.1, depth: 8 }, metrics: { ndcg10: 0.398, map: 0.327, loss: 0.305 } },
      { id: 'c81d44', name: 'two-tower-v3', status: 'FINISHED', started: 'Nov 18, 10:05', dur: '1h 52m', params: { model: 'two-tower', lr: 0.001, depth: 3 }, metrics: { ndcg10: 0.405, map: 0.331, loss: 0.288 }, registered: 'v13 · Staging' },
      { id: 'e09a71', name: 'two-tower-v4', status: 'RUNNING', started: 'Today, 09:30', dur: '41m', params: { model: 'two-tower', lr: 0.0005, depth: 4 }, metrics: { ndcg10: 0.379, map: 0.302, loss: 0.322 } }] },
    { name: 'fraud-scoring', owner: 'ml-team', runs: [
      { id: 'f4410b', name: 'xgb-balanced', status: 'FINISHED', started: 'Nov 17, 15:22', dur: '9m', params: { model: 'xgboost', lr: 0.08, depth: 6 }, metrics: { auc: 0.962, precision: 0.871, recall: 0.794 }, registered: 'v6 · Production' },
      { id: '19c3aa', name: 'xgb-smote', status: 'FINISHED', started: 'Nov 16, 11:04', dur: '12m', params: { model: 'xgboost', lr: 0.08, depth: 7 }, metrics: { auc: 0.958, precision: 0.842, recall: 0.823 } },
      { id: '6d70fe', name: 'mlp-baseline', status: 'FAILED', started: 'Nov 16, 09:40', dur: '3m', params: { model: 'mlp', lr: 0.01, depth: 2 }, metrics: { auc: 0, precision: 0, recall: 0 } }] },
    { name: 'search-query-intent', owner: 'data-team', runs: [
      { id: '2be8d3', name: 'distilbert-ft', status: 'FINISHED', started: 'Nov 12, 13:00', dur: '46m', params: { model: 'distilbert', lr: 0.00003, depth: 6 }, metrics: { accuracy: 0.914, f1: 0.902, loss: 0.241 }, registered: 'v3 · Production' }] }
  ];

  var traces = [
    { id: 'tr-8f21', name: 'idp-assistant · chat', user: 'arivera', latency: 4.2, tokens: 3810, cost: 0.0061, status: 'ok', t: '2 min ago',
      spans: [['agent.turn', 4200, 0], ['llm.claude-haiku-4-5 (plan)', 1150, 1], ['tool.catalog_search', 182, 1], ['tool.get_service_metrics', 344, 1], ['llm.claude-haiku-4-5 (answer)', 2310, 1]] },
    { id: 'tr-8f1c', name: 'release-agent · rollback', user: 'dsantos', latency: 9.8, tokens: 6120, cost: 0.0284, status: 'ok', t: '9 min ago',
      spans: [['agent.turn', 9800, 0], ['llm.claude-sonnet-4-6 (plan)', 2400, 1], ['tool.get_app_health', 290, 1], ['tool.request_approval', 120, 1], ['wait.approval', 5100, 1], ['llm.claude-sonnet-4-6 (answer)', 1700, 1]] },
    { id: 'tr-8eff', name: 'recommendations-llm · explain', user: 'svc', latency: 1.3, tokens: 920, cost: 0.0032, status: 'ok', t: '12 min ago',
      spans: [['request', 1300, 0], ['llm.claude-sonnet-bedrock', 1210, 1]] },
    { id: 'tr-8ef0', name: 'security-agent · triage', user: 'hkim', latency: 31.0, tokens: 2210, cost: 0.0105, status: 'error', t: '20 min ago',
      spans: [['agent.turn', 31000, 0], ['llm.claude-sonnet-4-6 (plan)', 1800, 1], ['tool.list_vulnerable_deps', 30000, 1]], error: 'MCP target security timed out after 30 s' },
    { id: 'tr-8ed7', name: 'qa-assistant · scaffold suite', user: 'aokafor', latency: 6.7, tokens: 5030, cost: 0.0212, status: 'ok', t: '41 min ago',
      spans: [['agent.turn', 6700, 0], ['llm.claude-sonnet-4-6 (plan)', 2100, 1], ['tool.search_test_catalog', 160, 1], ['tool.scaffold_test_suite', 2900, 1], ['llm.claude-sonnet-4-6 (answer)', 1400, 1]] }
  ];

  var approvals = [
    { id: 'APR-318', agent: 'release-agent', tool: 'rollback_app', target: 'inventory-service-local', risk: 'medium', by: 'Diego Santos', t: '4 min ago', reason: 'Roll back to revision 41 (1.9.3) while INC-2042 is investigated.', policy: 'Allowed with approval: rollback in services namespace' },
    { id: 'APR-317', agent: 'idp-assistant', tool: 'scaffold_service', target: 'loyalty-points (python-service)', risk: 'low', by: 'Hannah Kim', t: '11 min ago', reason: 'New service for the loyalty programme; owner backend-team.', policy: 'Allowed with approval: creates a repo and a PR' },
    { id: 'APR-316', agent: 'qa-assistant', tool: 'approve_pr', target: 'checkout-web#418', risk: 'high', by: 'Jordan Blake', t: '26 min ago', reason: 'Auto-approve dependency bump after green CI.', policy: 'Flagged: agents approving PRs bypasses two-person review' },
    { id: 'APR-315', agent: 'cost-agent', tool: 'set_replicas', target: 'analytics-pipeline (3 → 2)', risk: 'medium', by: 'Sofia Alvarez', t: '1 h ago', reason: 'Rightsizing: CPU p95 at 18% for 14 days.', policy: 'Allowed with approval: scale-down in non-prod hours only' }
  ];

  var argoApps = [
    { name: 'idp-root', parent: null, project: 'platform', sync: 'Synced', health: 'Healthy', rev: 'main@501762b', ns: 'argocd' },
    { name: 'platform-infra', parent: 'idp-root', project: 'platform', sync: 'Synced', health: 'Healthy', rev: 'main@501762b', ns: 'argocd' },
    { name: 'ingress-nginx', parent: 'platform-infra', project: 'platform', sync: 'Synced', health: 'Healthy', rev: '4.11.3', ns: 'ingress-nginx' },
    { name: 'cert-manager', parent: 'platform-infra', project: 'platform', sync: 'Synced', health: 'Healthy', rev: 'v1.16.2', ns: 'cert-manager' },
    { name: 'kube-prometheus-stack', parent: 'platform-infra', project: 'platform', sync: 'Synced', health: 'Healthy', rev: '66.3.1', ns: 'monitoring' },
    { name: 'loki', parent: 'platform-infra', project: 'platform', sync: 'Synced', health: 'Healthy', rev: '6.21.0', ns: 'monitoring' },
    { name: 'tempo', parent: 'platform-infra', project: 'platform', sync: 'OutOfSync', health: 'Healthy', rev: '1.14.0', ns: 'monitoring' },
    { name: 'kyverno', parent: 'platform-infra', project: 'platform', sync: 'Synced', health: 'Healthy', rev: '3.3.4', ns: 'kyverno' },
    { name: 'gatekeeper', parent: 'platform-infra', project: 'platform', sync: 'Synced', health: 'Healthy', rev: '3.18.0', ns: 'gatekeeper-system' },
    { name: 'idp-services', parent: 'idp-root', project: 'services', sync: 'Synced', health: 'Degraded', rev: 'ApplicationSet', ns: 'argocd' }
  ];

  var alerts = [
    { name: 'KubePodCrashLooping', state: 'firing', sev: 'warning', since: '38m', labels: 'namespace=services-dev pod=inventory-service-7c9f', runbook: 'pod-crash-loop', expr: 'max_over_time(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}[5m]) >= 1' },
    { name: 'TeamBudgetExceeded', state: 'firing', sev: 'warning', since: '1d', labels: 'team=backend-team', runbook: 'cost-budget-exceeded', expr: 'idp_team_budget_utilization_ratio > 1' },
    { name: 'TeamBudgetWarning', state: 'firing', sev: 'info', since: '3d', labels: 'team=ml-team', runbook: 'cost-budget-exceeded', expr: 'idp_team_budget_utilization_ratio > 0.8' },
    { name: 'MCPTargetUnhealthy', state: 'firing', sev: 'warning', since: '22m', labels: 'target=security', runbook: 'kagent-guardrails', expr: 'agentgateway_mcp_target_up == 0' },
    { name: 'SLOErrorBudgetBurn', state: 'pending', sev: 'critical', since: '4m', labels: 'sloth_service=orders-service slo=availability', runbook: 'incident-severity', expr: 'slo:sli_error:ratio_rate5m > (14.4 * 0.001)' },
    { name: 'HighMemory', state: 'inactive', sev: 'warning', since: '-', labels: 'namespace=ml-platform', runbook: 'high-memory', expr: 'container_memory_working_set_bytes / limits > 0.9' },
    { name: 'HighCPU', state: 'inactive', sev: 'warning', since: '-', labels: 'namespace=services-dev', runbook: 'high-cpu', expr: 'rate(container_cpu_usage_seconds_total[5m]) / limits > 0.9' }
  ];

  var violations = [
    { engine: 'Kyverno', policy: 'require-requests-limits', resource: 'Deployment/fraud-scoring', ns: 'ml-platform', action: 'Audit', sev: 'medium', msg: 'CPU and memory limits are required for container "scorer".' },
    { engine: 'Kyverno', policy: 'disallow-latest-tag', resource: 'Deployment/notifications-service', ns: 'commerce', action: 'Enforce', sev: 'high', msg: 'Image tag ":latest" is not allowed; pin a version or SHA.' },
    { engine: 'Kyverno', policy: 'require-pod-probes', resource: 'Deployment/analytics-pipeline', ns: 'data', action: 'Audit', sev: 'low', msg: 'Readiness probe missing on container "consumer".' },
    { engine: 'Gatekeeper', policy: 'K8sRequiredLabels (team-label)', resource: 'Namespace/scratch-jb', ns: '-', action: 'Deny', sev: 'medium', msg: 'Missing required label "team".' },
    { engine: 'Gatekeeper', policy: 'K8sPSPPrivilegedContainer', resource: 'Pod/debug-shell', ns: 'services-dev', action: 'Deny', sev: 'critical', msg: 'Privileged containers are not allowed.' },
    { engine: 'Kyverno', policy: 'restrict-image-registries', resource: 'Deployment/inventory-service', ns: 'commerce', action: 'Audit', sev: 'medium', msg: 'Image docker.io/library/redis:7 is outside allowed registries (ghcr.io, ECR).' }
  ];

  var previews = [
    { pr: 418, service: 'checkout-web', branch: 'feat/apple-pay-button', author: 'Jordan Blake', status: 'ready', url: 'pr-418.checkout-web.preview.idp.local', ttl: '2d 4h', cost: 1.84, age: '6h' },
    { pr: 233, service: 'payments-api', branch: 'fix/wallet-cert-chain', author: 'Marcus Chen', status: 'ready', url: 'pr-233.payments-api.preview.idp.local', ttl: '1d 2h', cost: 3.10, age: '1d' },
    { pr: 97, service: 'search-api', branch: 'feat/synonyms', author: 'Sofia Alvarez', status: 'deploying', url: 'pr-97.search-api.preview.idp.local', ttl: '3d', cost: 0.12, age: '4m' },
    { pr: 61, service: 'idp-mcp-server', branch: 'feat/get-core4-report', author: 'Alex Rivera', status: 'ready', url: 'pr-61.idp-mcp-server.preview.idp.local', ttl: '5h', cost: 0.96, age: '2d' },
    { pr: 405, service: 'checkout-web', branch: 'chore/bump-vite', author: 'dependabot', status: 'failed', url: '-', ttl: '-', cost: 0.02, age: '3h', reason: 'ImagePullBackOff: tag not yet pushed' }
  ];

  var aiSearchCorpus = [
    { title: 'Runbook: Pod crash loop', kind: 'TechDocs', href: '#/techdocs/runbooks', text: 'crashloop crash restart pod failing readiness rollback logs' },
    { title: 'Runbook: Deployment rollback', kind: 'TechDocs', href: '#/techdocs/runbooks', text: 'rollback revert release argocd previous revision' },
    { title: 'Golden paths: Terraform or Crossplane?', kind: 'TechDocs', href: '#/techdocs/golden-paths', text: 'terraform crossplane s3 bucket rds database claim infrastructure' },
    { title: 'AI gateway and agents', kind: 'TechDocs', href: '#/techdocs/ai-gateway', text: 'agent mcp gateway litellm approval model tools kagent' },
    { title: 'Getting started', kind: 'TechDocs', href: '#/techdocs/getting-started', text: 'start first service scaffold cli portal onboarding new engineer' },
    { title: 'hello-service SLOs', kind: 'TechDocs', href: '#/techdocs/hello-service', text: 'slo availability latency error budget sloth' },
    { title: 'payments-api', kind: 'Component', href: '#/entity/payments-api', text: 'payments card wallet refund capture pci go' },
    { title: 'search-api', kind: 'Component', href: '#/entity/search-api', text: 'search product query facets python' },
    { title: 'recommendations-ml', kind: 'Component', href: '#/entity/recommendations-ml', text: 'ml model recommendations mlflow ranking' },
    { title: 'Template: k6 Performance Suite', kind: 'Template', href: '#/create/k6-performance-suite', text: 'load performance test k6 latency throughput' },
    { title: 'Template: Enable Contract Testing', kind: 'Template', href: '#/create/enable-contract-testing', text: 'contract pact breaking change api compatibility' },
    { title: 'Template: Define SLOs', kind: 'Template', href: '#/create/slo-definition', text: 'slo error budget burn rate alert reliability' }
  ];

  // Template metadata extracted once from backstage/catalog/templates/*/template.yaml
  var templates = [
    {"n":"accessibility-suite","t":"Accessibility (a11y) Test Suite","d":"Scaffold an axe-core + Playwright accessibility test suite enforcing WCAG compliance on every PR","tags":["accessibility","a11y","axe-core","playwright","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"add-secret","t":"Add Secret to a Service","d":"Provision a secret in AWS Secrets Manager and wire it into your service via External Secrets Operator","tags":["secrets","aws","security","golden-path","local","v1","blessed"],"type":"service"},
    {"n":"ai-agent-kagent","t":"AI Agent (KAgent)","d":"Scaffold a Kubernetes-native AI agent using KAgent — powered by Anthropic Claude API. Defines an Agent CRD with MCP tool access to the Backstage catalog, Prometheus, and scaffolder.","tags":["ai","agent","kagent","mcp","anthropic","local","v1","advanced"],"type":"template"},
    {"n":"android-app","t":"Android App (Kotlin)","d":"Scaffold a production-ready Android app with Kotlin, Jetpack Compose, Gradle, Fastlane CI/CD, and optional Firebase integration","tags":["android","kotlin","mobile","golden-path","local","aws","v1","advanced"],"type":"mobile"},
    {"n":"appium-mobile-suite","t":"Appium Mobile Test Suite","d":"Scaffold an Appium + WebdriverIO mobile test suite for iOS and Android","tags":["appium","mobile","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"bdd-cucumber-suite","t":"BDD Cucumber Test Suite","d":"Scaffold a Cucumber.js BDD test suite with Gherkin feature files and TypeScript step definitions","tags":["bdd","cucumber","gherkin","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"canary-deployment","t":"Enable Progressive Delivery","d":"Opts an existing service into Argo Rollouts — canary or blue-green. Configures the traffic steps, auto-rollback thresholds and analysis, then opens a PR adding a helm-values-rollout-<env>.yaml overlay","tags":["sre","progressive-delivery","canary","argo-rollouts","v1","advanced"],"type":"service"},
    {"n":"chaos-mesh-suite","t":"Chaos Engineering Suite (Chaos Mesh)","d":"Scaffold Chaos Mesh experiment definitions for resilience testing — pod failure, network latency, and stress scenarios","tags":["chaos","chaos-mesh","resilience","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"component-test-suite","t":"Component Test Suite (mocked deps)","d":"Test a single service end-to-end with its external HTTP dependencies stubbed by WireMock. Faster than Testcontainers, more realistic than unit tests.","tags":["component-testing","wiremock","qa","shift-left","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"contract-testing-suite","t":"Contract Testing Suite (MCP-Powered)","d":"Scaffold a self-describing, self-testing API contract suite. Generates an OpenAPI consumer contract, Pact consumer tests, and a CI workflow that auto-registers the spec with the IDP contract registry ","tags":["contract-testing","pact","mcp","self-describing","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"create-namespace","t":"Create Namespace (self-service, instant)","d":"Instantly create a Kubernetes namespace with Pod Security Standards, a tiered ResourceQuota, and a default-deny NetworkPolicy — applied directly to the cluster, no PR/GitOps round-trip. For full team ","tags":["platform","kubernetes","self-service","local","v1","blessed"],"type":"infrastructure"},
    {"n":"datadog-synthetic-suite","t":"Datadog Synthetic Test Suite","d":"Scaffold Datadog synthetic monitoring tests (API and browser) with CI-triggered execution","tags":["datadog","synthetic","monitoring","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"decommission-service","t":"Decommission Service","d":"Remove a service from the IDP. This template allows GitHub organization admins to: - Archive a service repo on GitHub (freezes it as read-only, reversible) - Permanently delete a service repo on GitHu","tags":["admin","decommission","dangerous","v1","blessed"],"type":"service"},
    {"n":"deepeval-llm-eval-suite","t":"DeepEval LLM Eval Suite","d":"Scaffold a DeepEval evaluation suite for an AI agent — covers answer relevancy, faithfulness, and tool correctness","tags":["deepeval","llm","eval","ai","testing","qa","v1","advanced"],"type":"test-suite"},
    {"n":"deploy-to-kind","t":"Deploy Service to local Kind cluster","d":"[Local only] Build and deploy an existing service to the local Kind cluster via Helm. Run this anytime after scaffolding. Not available on AWS.","tags":["local-only","deploy","local","kind","golden-path","v1","advanced"],"type":"service"},
    {"n":"dynamodb-table-crossplane","t":"DynamoDB Table (Crossplane)","d":"Provision a DynamoDB table via a Crossplane Claim. On-demand billing and point-in-time recovery are on by default.","tags":["dynamodb","aws","crossplane","v1","advanced"],"type":"resource"},
    {"n":"eks-cluster","t":"Kubernetes Cluster (EKS)","d":"Provision an EKS cluster with autoscaling node groups and platform addons (ingress-nginx, cert-manager, ArgoCD, Prometheus).","tags":["eks","kubernetes","aws","golden-path","v1","advanced"],"type":"resource"},
    {"n":"enable-contract-testing","t":"Enable Contract Testing (MCP-Powered)","d":"One-click setup for self-describing, self-testing APIs on the IDP. Deploys the contract-mcp-server, registers the contract-assistant KAgent agent, auto-discovers your service's OpenAPI contract, and s","tags":["contract-testing","mcp","self-describing","kagent","platform","local","v1","advanced"],"type":"platform-capability"},
    {"n":"enable-datadog-apm","t":"Enable Datadog APM & Monitoring","d":"Opens a PR against an existing service repository with instructions and env-var wiring for Datadog APM (dd-trace) instrumentation, unified service tagging, and the Backstage catalog annotations needed","tags":["datadog","apm","observability","monitoring","platform","local","aws","v1","advanced"],"type":"platform-capability"},
    {"n":"enable-langfuse-tracing","t":"Enable Langfuse LLM Tracing","d":"Opens a PR against an existing service repository that wires it into the platform's Langfuse instance: a drop-in OpenTelemetry module (runnable for Node.js and Python, instructions for the other runti","tags":["langfuse","llm","ai","observability","tracing","platform","local","aws","v1","advanced"],"type":"platform-capability"},
    {"n":"enable-security-scanning","t":"Enable Security Scanning (SonarCloud + Snyk)","d":"Opens a PR against an existing service repository adding SonarCloud (code quality + quality gate) and Snyk (SCA / dependency vulnerabilities) scanning to CI. Workflow is gated on SONAR_TOKEN / SNYK_TO","tags":["security","sonarcloud","snyk","sca","static-analysis","platform","local","aws","v1","advanced"],"type":"platform-capability"},
    {"n":"flutter-app","t":"Flutter App (Dart)","d":"Scaffold a production-ready Flutter app with Dart, multi-platform support (Android/iOS/Web), GitHub Actions CI/CD, Fastlane, and optional Firebase integration","tags":["flutter","dart","mobile","golden-path","local","aws","v1","advanced"],"type":"mobile"},
    {"n":"flutter-integration-test-suite","t":"Flutter Integration Test Suite","d":"Add Flutter integration tests to an existing Flutter app. Tests run on Firebase Test Lab via GitHub Actions.","tags":["flutter","mobile","testing","integration","qa","v1","advanced"],"type":"test-suite"},
    {"n":"go-service","t":"Go Service","d":"Scaffold a Go HTTP service with CI/CD and Helm deployment","tags":["go","golang","golden-path","local","aws","v1","blessed"],"type":"service"},
    {"n":"iac-test-suite","t":"IaC Test Suite (Terraform)","d":"Add tflint + Checkov (policy/security) + Terratest (real-apply) to an existing Terraform repo. Catches misconfigs before they ship.","tags":["terraform","iac","checkov","terratest","tflint","security","shift-left","aws","v1","advanced"],"type":"test-suite"},
    {"n":"ios-app","t":"iOS App (Swift/SwiftUI)","d":"Scaffold a production-ready iOS app with Swift, SwiftUI, Swift Package Manager, Fastlane CI/CD, SonarCloud, and Snyk integration","tags":["ios","swift","swiftui","mobile","golden-path","local","aws","v1","advanced"],"type":"mobile"},
    {"n":"jvm-service","t":"JVM (Java/Spring Boot) Service","d":"Scaffold a Java Spring Boot service with Gradle, CI/CD, and Helm deployment — the golden path for JVM microservices owned by autonomous teams","tags":["java","jvm","spring-boot","gradle","golden-path","local","aws","v1","blessed"],"type":"service"},
    {"n":"k6-performance-suite","t":"k6 Performance Test Suite","d":"Scaffold a k6 JavaScript performance test suite with smoke, load, and stress scenarios","tags":["k6","performance","load-testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"kafka-topic-crossplane","t":"Kafka Topic (Crossplane)","d":"Create a Kafka topic on the existing MSK cluster via a Crossplane Claim. The cluster itself is Terraform-managed; topic lifecycle (partitions, retention, cleanup policy) lives in Git per topic.","tags":["kafka","msk","streaming","aws","crossplane","v1","advanced"],"type":"resource"},
    {"n":"kafka-topic","t":"Kafka Topic","d":"Create a Kafka topic on the shared MSK cluster with partitions, retention, ACLs for the owning service, and an optional schema registry subject.","tags":["kafka","messaging","aws","msk","golden-path","v1","advanced"],"type":"resource"},
    {"n":"langgraph-agent","t":"LangGraph Agent (Python)","d":"Scaffold a Python agent built on a LangGraph StateGraph — plan, select tools, act, reflect — that loads its tools from the platform's MCP servers rather than reimplementing them, and traces every node","tags":["llm","ai","agent","langgraph","mcp","langfuse","python","fastapi","golden-path","local","aws","v1","blessed"],"type":"ai-agent"},
    {"n":"llm-app-langfuse","t":"LLM App (Python + Langfuse)","d":"Scaffold a Python FastAPI service that calls Claude and reports every model call to the platform's Langfuse instance — prompt, completion, token counts, cost and latency. Ships with the telemetry modu","tags":["llm","ai","langfuse","python","fastapi","golden-path","local","aws","v1","blessed"],"type":"service"},
    {"n":"mcp-server","t":"MCP Server (kmcp)","d":"Scaffold a Model Context Protocol server managed by the kmcp Kubernetes controller. Defines an MCPServer CRD — the controller auto-deploys it as a pod in the kagent namespace.","tags":["mcp","ai","kagent","kmcp","typescript","local","aws","v1","advanced"],"type":"template"},
    {"n":"mlflow-experiment","t":"ML Experiment (MLflow)","d":"Run a Python ML training job with MLflow tracking. Scaffolds the experiment locally and submits a Kubernetes Job to the ml-platform namespace. Results appear in the MLflow UI.","tags":["ml","mlflow","python","training","local","aws","v1","advanced"],"type":"template"},
    {"n":"mobile-app-store-deploy","t":"Mobile App Store Deployment","d":"Add automated Google Play or App Store deployment via Fastlane to an existing mobile app repository","tags":["deployment","appstore","googleplay","fastlane","mobile","release","v1","advanced"],"type":"service"},
    {"n":"mobile-code-signing","t":"Mobile Code Signing Setup","d":"Add automated code signing for iOS (Fastlane Match via S3) or Android (keystore via AWS Secrets Manager) to an existing mobile app repository","tags":["codesigning","ios","android","mobile","security","v1","advanced"],"type":"service"},
    {"n":"mobile-device-farm","t":"Mobile Device Farm","d":"Add cloud device-farm testing to an existing mobile app — runs Espresso, XCUITest, or Flutter integration tests across a configurable real-device matrix on Firebase Test Lab or LambdaTest","tags":["testing","devicefarm","firebase","lambdatest","mobile","e2e","v1","advanced"],"type":"service"},
    {"n":"mobile-sdk","t":"Shared Mobile SDK Library","d":"Scaffold a shared mobile SDK library for Android (Kotlin), iOS (Swift Package), Flutter, or Kotlin Multiplatform — with GitHub Packages publishing built in","tags":["sdk","library","mobile","kotlin","swift","flutter","v1","advanced"],"type":"library"},
    {"n":"model-serving-api","t":"Model Serving API","d":"Deploy an ML model as a REST API — a lightweight mock, real Ollama for CPU inference, or vLLM on a GPU node. Auto-scaling and health probes included.","tags":["ai","ml","serving","inference","llm","ollama","vllm","v1","advanced"],"type":"service"},
    {"n":"mutation-testing-suite","t":"Mutation Testing Suite (Stryker)","d":"Scaffold a Stryker mutation testing configuration to measure test suite quality beyond code coverage","tags":["stryker","mutation-testing","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"newman-api-suite","t":"Newman API Test Suite","d":"Scaffold a Postman/Newman API test suite with CI and environment management","tags":["newman","postman","api-testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"nodejs-service","t":"Node.js Service","d":"Scaffold a Node.js/Express service with CI/CD and Helm deployment","tags":["nodejs","express","golden-path","local","aws","v1","blessed"],"type":"service"},
    {"n":"pact-contract-suite","t":"Pact Contract Test Suite","d":"Scaffold a Pact consumer-driven contract test suite with PactFlow broker publishing","tags":["pact","contract-testing","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"playwright-e2e-suite","t":"Playwright E2E Test Suite","d":"Scaffold a Playwright TypeScript E2E test suite targeting an existing service","tags":["playwright","e2e","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"python-service","t":"Python FastAPI Service","d":"Scaffold a Python FastAPI service with CI/CD and Helm deployment","tags":["python","fastapi","golden-path","local","aws","v1","blessed"],"type":"service"},
    {"n":"rds-database-crossplane","t":"RDS Postgres (Crossplane)","d":"Provision a Postgres RDS instance via a Crossplane Claim. ArgoCD syncs the Claim on merge; Crossplane creates the instance and writes connection details (host, port, username, password) to a K8s Secre","tags":["rds","postgres","database","aws","crossplane","golden-path","v1","advanced"],"type":"resource"},
    {"n":"rds-database","t":"Managed Postgres (RDS)","d":"Spin up an Amazon RDS Postgres instance with multi-AZ failover, automated backups, and IAM auth. Credentials are written to the requesting service namespace as a secret.","tags":["database","aws","rds","postgresql","golden-path","v1","advanced"],"type":"resource"},
    {"n":"react-frontend","t":"React Frontend","d":"Scaffold a React + Vite + TypeScript frontend with CI/CD and Helm deployment","tags":["react","vite","typescript","frontend","golden-path","local","aws","v1","blessed"],"type":"website"},
    {"n":"ruby-service","t":"Ruby Sinatra Service","d":"Scaffold a Ruby Sinatra service with CI/CD and Helm deployment — the golden path for services extracted from the Ruby monolith","tags":["ruby","sinatra","golden-path","local","aws","v1","blessed"],"type":"service"},
    {"n":"s3-bucket-crossplane","t":"S3 Object Bucket (Crossplane)","d":"Request an S3 bucket via a Crossplane Claim. ArgoCD picks the Claim up on merge; Crossplane reconciles it into a real bucket within a few minutes. No `terraform apply` step.","tags":["s3","storage","aws","crossplane","golden-path","v1","advanced"],"type":"resource"},
    {"n":"s3-bucket","t":"S3 Object Bucket","d":"Create an S3 bucket with versioning, lifecycle rules, KMS encryption, and a least-privilege IAM policy attached to the requesting service.","tags":["s3","storage","aws","golden-path","v1","advanced"],"type":"resource"},
    {"n":"secret-rotation","t":"Secret with Rotation Reminder","d":"Provision a secret in AWS Secrets Manager and schedule a recurring GitHub issue reminder to rotate it","tags":["secrets","aws","security","advanced","v1"],"type":"service"},
    {"n":"slo-definition","t":"Define Service SLOs","d":"Generate Sloth-format SLO definitions (availability + latency) for any service, wire multi-window burn-rate alerts to AlertManager, and open a PR to observability/slo/ in this platform repo.","tags":["sre","slo","observability","reliability","v1","advanced"],"type":"service"},
    {"n":"sqs-queue-crossplane","t":"SQS Queue (Crossplane)","d":"Provision an SQS queue via a Crossplane Claim. Server-side encryption is on by default; FIFO is opt-in.","tags":["sqs","messaging","aws","crossplane","v1","advanced"],"type":"resource"},
    {"n":"team-namespace","t":"Provision Team Namespace","d":"Self-service team onboarding — creates a GitHub Org Team, a Kubernetes namespace, RBAC bindings, ArgoCD project, and resource quotas in one step. The Backstage Group entity follows automatically from ","tags":["platform","kubernetes","onboarding","self-service","local","aws","v1","blessed"],"type":"infrastructure"},
    {"n":"terraform-module","t":"Terraform Module","d":"Scaffold a reusable Terraform module with tests, examples, and CI pipeline","tags":["terraform","infrastructure","iac","golden-path","aws","v1","advanced"],"type":"infrastructure"},
    {"n":"testcontainers-suite","t":"Testcontainers Integration Test Suite","d":"Scaffold a Testcontainers integration test suite that spins up real dependencies (DB, cache, queues) in CI","tags":["testcontainers","integration-testing","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"unit-test-suite","t":"Unit Test Suite (brownfield)","d":"Add a unit-test workflow + coverage gate (70%) + JUnit output to an existing service repo, using the runner it already has. Language-aware (Go, Node — Jest or Vitest, Python).","tags":["unit-testing","coverage","qa","shift-left","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"visual-regression-suite","t":"Visual Regression Test Suite","d":"Scaffold a Playwright visual regression suite with pixel-diff screenshot comparison on every PR","tags":["playwright","visual-regression","testing","qa","local","aws","v1","advanced"],"type":"test-suite"},
    {"n":"zap-dast-suite","t":"OWASP ZAP DAST Security Scan","d":"Scaffold an OWASP ZAP dynamic application security test suite with baseline and full-scan modes","tags":["zap","dast","security","owasp","qa","local","aws","v1","advanced"],"type":"test-suite"}
  ];

  return {
    user: user, teams: teams, people: people, components: components, apis: apis, systems: systems, resources: resources,
    checks: checks, tierThresholds: tierThresholds, activity: activity, incidents: incidents, runbooks: runbooks, docs: docs,
    radar: radar, learning: learning, learningDone: learningDone, maturityLevels: maturityLevels, dimensions: dimensions,
    teamScores: teamScores, core4: core4, survey: survey, copilot: copilot, agents: agents, modelConfigs: modelConfigs,
    mcpServers: mcpServers, gatewayModels: gatewayModels, litellmKeys: litellmKeys, mlflow: mlflow, traces: traces,
    approvals: approvals, argoApps: argoApps, alerts: alerts, violations: violations, previews: previews,
    aiSearchCorpus: aiSearchCorpus, templates: templates
  };
})();
