// Single source of truth for every Bronze/Silver/Gold scorecard *check*
// (the boolean predicates), shared between the Tech Insights fact retriever
// (packages/backend/src/modules/idpTechInsights.ts) and the entity-page
// scorecard tab (packages/app/src/scorecard.ts). Those two used to
// independently recompute the same checks and had drifted on three of them
// (has-model-card, has-eval-suite, has-ai-observability — see isAiEntity
// below). This module ends that: change a check's meaning once, here.
//
// What this module deliberately does NOT own: tier *thresholds* (Bronze/
// Silver/Gold cutoffs). packages/app/src/scorecard.ts's TIER_THRESHOLDS
// comment explains why the frontend's cutoffs and
// observability/tech-insights-exporter/exporter.py's cutoffs are pinned to
// different, intentionally-divergent values — reconciling those is a policy
// decision for the scorecard owners, not a refactor.

export type ScorecardFactKey =
  | 'has-owner'
  | 'has-techdocs'
  | 'has-health-probes'
  | 'has-runbook-url'
  | 'has-api-definition'
  | 'uses-pinned-image-tag'
  | 'has-coverage-gate'
  | 'has-static-analysis'
  | 'has-vuln-scan'
  | 'has-contract-tests'
  | 'has-e2e-tests'
  | 'has-model-card'
  | 'has-eval-suite'
  | 'has-ai-observability'
  | 'has-sonar-scanning'
  | 'has-snyk-scanning'
  | 'has-trivy-scanning'
  // Legacy mobile checks — computed by the backend retriever only; the
  // frontend scorecard tab has never rendered these (see the five
  // platform-maturity mobile checks below for what it does render).
  | 'has-mobile-test-coverage'
  | 'has-mobile-crash-reporting'
  | 'has-mobile-ui-tests'
  | 'has-mobile-fastlane'
  // Mobile platform-maturity checks (rendered by both).
  | 'has-min-sdk-version'
  | 'has-crashlytics-enabled'
  | 'has-accessibility-tests'
  | 'has-app-size-budget'
  | 'has-code-signing';

export interface FactsEntityLike {
  spec?: { owner?: unknown; type?: string };
  metadata: {
    annotations?: Record<string, string>;
    tags?: string[];
  };
  relations?: Array<{ type: string }>;
}

function parseGates(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * True for entities tagged "mobile" or with spec.type === "mobile".
 * Deliberately case-sensitive: a looser match would put the frontend and
 * backend out of step, since only this exact definition is shared between
 * them — an entity tagged "Mobile" would show mobile checks on its entity
 * page while the backend recorded every mobile fact as false.
 */
export function isMobileEntity(entity: FactsEntityLike): boolean {
  return (
    entity.spec?.type === 'mobile' ||
    (entity.metadata.tags ?? []).includes('mobile')
  );
}

/**
 * True for an entity tagged "ai" or with spec.type in the AI-workload set.
 * Broader than a tag-only check on purpose: a service declared
 * spec.type: ai-agent/model-serving/llm/ml-model is an AI service even if
 * nobody remembers to also tag it "ai". This is the definition
 * packages/app/src/scorecard.ts always used; idpTechInsights.ts previously
 * used a narrower tag-only check for has-ai-observability and no gate at
 * all for has-model-card/has-eval-suite — unified here to the broad
 * definition, gating all three (see computeFacts below).
 */
export function isAiEntity(entity: FactsEntityLike): boolean {
  const tags = entity.metadata.tags ?? [];
  return (
    tags.some(t => t.toLowerCase() === 'ai') ||
    ['ai-agent', 'model-serving', 'llm', 'ml-model'].includes(
      (entity.spec?.type ?? '').toLowerCase(),
    )
  );
}

export function computeFacts(entity: FactsEntityLike): Record<ScorecardFactKey, boolean> {
  const annotations = entity.metadata.annotations ?? {};
  const relations = entity.relations ?? [];
  const tags = entity.metadata.tags ?? [];
  const gates = parseGates(annotations['idp.io/quality-gates']);

  const hasOwner = Boolean(entity.spec?.owner && relations.some(r => r.type === 'ownedBy'));
  const hasApiDefinition = relations.some(r => r.type === 'providesApi');
  const imageTag = annotations['backstage.io/image-tag'] ?? '';
  const hasE2eTagged = tags.some(t =>
    ['e2e', 'playwright', 'cypress', 'appium'].includes(t.toLowerCase()),
  );
  const hasKubernetesId = Boolean(annotations['backstage.io/kubernetes-id']);
  const isAi = isAiEntity(entity);

  // Legacy mobile checks (has-mobile-*) gate on spec.type === 'mobile'
  // specifically, matching idpTechInsights.ts's original isMobileApp — a
  // narrower check than isMobileEntity's tag-or-type. Preserved exactly;
  // not in scope to also broaden these to tag-matching.
  const isMobileSpecType = entity.spec?.type === 'mobile';

  // Mobile platform-maturity checks use the broader isMobileEntity.
  const isMobile = isMobileEntity(entity);
  const minSdkRaw = annotations['backstage.io/mobile-min-sdk'];
  let meetsMinSdk = false;
  if (isMobile && minSdkRaw) {
    const isIos = ['ios', 'swiftui', 'swift'].some(t => tags.includes(t));
    if (isIos) {
      const major = parseFloat(minSdkRaw.split('.')[0]);
      meetsMinSdk = !isNaN(major) && major >= 16;
    } else {
      const level = parseInt(minSdkRaw, 10);
      meetsMinSdk = !isNaN(level) && level >= 24;
    }
  }

  return {
    'has-owner': hasOwner,
    'has-techdocs': Boolean(annotations['backstage.io/techdocs-ref']),
    'has-health-probes': hasKubernetesId,
    'has-runbook-url': Boolean(annotations['backstage.io/runbook-url']),
    'has-api-definition': hasApiDefinition,
    'uses-pinned-image-tag': imageTag !== '' && imageTag !== 'latest',
    'has-coverage-gate': gates.has('coverage'),
    'has-static-analysis': gates.has('static-analysis'),
    'has-vuln-scan': gates.has('vuln-scan'),
    'has-contract-tests': gates.has('contract') || hasApiDefinition,
    'has-e2e-tests': gates.has('e2e') || hasE2eTagged || relations.some(r => r.type === 'consumesApi'),
    'has-model-card': isAi && Boolean(annotations['backstage.io/model-card-url']),
    'has-eval-suite': isAi && gates.has('llm-eval'),
    'has-ai-observability': isAi && hasKubernetesId,
    'has-sonar-scanning': gates.has('sonar-scanning') || Boolean(annotations['sonarcloud.io/project-key']),
    'has-snyk-scanning': gates.has('snyk-scanning') || Boolean(annotations['snyk.io/org-slug']),
    'has-trivy-scanning': gates.has('trivy-scanning') || Boolean(annotations['github.com/project-slug']),
    'has-mobile-test-coverage': isMobileSpecType && gates.has('mobile-test-coverage'),
    'has-mobile-crash-reporting':
      isMobileSpecType &&
      (gates.has('mobile-crash-reporting') || Boolean(annotations['mobile.io/crash-reporting'])),
    'has-mobile-ui-tests':
      isMobileSpecType &&
      (gates.has('mobile-ui-tests') ||
        tags.some(t => ['appium', 'espresso', 'xctest', 'flutter-integration'].includes(t.toLowerCase()))),
    'has-mobile-fastlane': isMobileSpecType && gates.has('mobile-fastlane'),
    'has-min-sdk-version': isMobile && meetsMinSdk,
    'has-crashlytics-enabled': isMobile && annotations['backstage.io/crashlytics-enabled'] === 'true',
    'has-accessibility-tests': isMobile && annotations['backstage.io/accessibility-tests'] === 'true',
    'has-app-size-budget': isMobile && Boolean(annotations['backstage.io/app-size-budget-mb']),
    'has-code-signing': isMobile && annotations['backstage.io/code-signing-setup'] === 'true',
  };
}
