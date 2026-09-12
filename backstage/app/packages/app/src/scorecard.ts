import { Entity } from '@backstage/catalog-model';
import { computeFacts, isAiEntity as sharedIsAiEntity, isMobileEntity as sharedIsMobileEntity } from '@internal/scorecard-core';

// Pure scoring logic for the Tech Insights scorecard, extracted from
// extensions.tsx so it can be unit-tested without pulling in the whole
// Backstage frontend (importing extensions.tsx into a test loads every plugin
// and takes minutes).
//
// The check *predicates* (the 22 booleans below) come from
// @internal/scorecard-core, shared with the backend's Tech Insights fact
// retriever (packages/backend/src/modules/idpTechInsights.ts) — the two used
// to independently recompute the same checks and had drifted on three of
// them. What stays local to this file, deliberately: tier *thresholds*
// (TIER_THRESHOLDS/AI_TIER_THRESHOLDS/MOBILE_TIER_REQUIREMENTS below) — see
// the comment on TIER_THRESHOLDS for why those remain a frontend-only
// concern, not something the shared module also owns.

export type CheckKey =
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
  | 'has-min-sdk-version'
  | 'has-crashlytics-enabled'
  | 'has-accessibility-tests'
  | 'has-app-size-budget'
  | 'has-code-signing';

export interface CheckDef {
  id: CheckKey;
  label: string;
  group: 'Hygiene' | 'Shift-Left CI' | 'Test Coverage' | 'AI Governance' | 'Security' | 'Mobile';
  remediation: string;
}

export const CHECKS: CheckDef[] = [
  { id: 'has-owner',             group: 'Hygiene',       label: 'Has owner',                 remediation: 'Set spec.owner in catalog-info.yaml.' },
  { id: 'has-techdocs',          group: 'Hygiene',       label: 'Has TechDocs',              remediation: 'Add annotation backstage.io/techdocs-ref: dir:.' },
  { id: 'has-health-probes',     group: 'Hygiene',       label: 'Has Kubernetes probes',     remediation: 'Add annotation backstage.io/kubernetes-id (the Helm chart wires the probes).' },
  { id: 'has-runbook-url',       group: 'Hygiene',       label: 'Has runbook URL',           remediation: 'Add annotation backstage.io/runbook-url linking to your service runbook.' },
  { id: 'has-api-definition',    group: 'Hygiene',       label: 'Has API definition',        remediation: 'Declare providesApis in catalog-info.yaml or expose /openapi.json.' },
  { id: 'uses-pinned-image-tag', group: 'Hygiene',       label: 'Pinned image tag (no :latest)', remediation: 'Set annotation backstage.io/image-tag to a SHA or version; avoid latest.' },
  { id: 'has-coverage-gate',     group: 'Shift-Left CI', label: 'Coverage gate in CI',       remediation: 'Add "coverage" to idp.io/quality-gates annotation (skeleton CI already enforces 70%).' },
  { id: 'has-static-analysis',   group: 'Shift-Left CI', label: 'Static analysis in CI',     remediation: 'Add "static-analysis" to idp.io/quality-gates annotation.' },
  { id: 'has-vuln-scan',         group: 'Shift-Left CI', label: 'Vuln scan in CI',           remediation: 'Add "vuln-scan" to idp.io/quality-gates annotation.' },
  { id: 'has-contract-tests',    group: 'Test Coverage', label: 'Contract tests',            remediation: 'Run the enable-contract-testing scaffolder template, or add "contract" to idp.io/quality-gates.' },
  { id: 'has-e2e-tests',         group: 'Test Coverage', label: 'End-to-end tests',          remediation: 'Run the playwright-e2e-suite scaffolder, or tag the entity with e2e/playwright.' },
  { id: 'has-model-card',        group: 'AI Governance', label: 'Has model card',            remediation: 'Add annotation backstage.io/model-card-url documenting the model, its training data, and performance.' },
  { id: 'has-eval-suite',        group: 'AI Governance', label: 'LLM eval suite in CI',      remediation: 'Add "llm-eval" to idp.io/quality-gates and run the deepeval-llm-eval-suite scaffolder.' },
  { id: 'has-ai-observability',  group: 'AI Governance', label: 'AI observability wired',    remediation: 'Add annotation backstage.io/kubernetes-id to enable Grafana dashboards (applies to entities tagged "ai" or with an AI spec.type).' },
  { id: 'has-sonar-scanning',    group: 'Security',      label: 'SonarCloud quality gate',   remediation: 'Run the enable-security-scanning scaffolder, or add a sonarcloud.io/project-key annotation.' },
  { id: 'has-snyk-scanning',     group: 'Security',      label: 'Snyk SCA scan',             remediation: 'Run the enable-security-scanning scaffolder, or add a snyk.io/org-slug annotation.' },
  { id: 'has-trivy-scanning',    group: 'Security',      label: 'Trivy image scan',          remediation: 'See the Trivy tab — requires a github.com/project-slug annotation and CI to have run at least once.' },
  // Mobile maturity checks. Rendered only for mobile entities, and unlike every
  // other group these gate the tier individually rather than by count — see
  // MOBILE_TIER_REQUIREMENTS. The predicate logic itself comes from
  // @internal/scorecard-core, shared with the backend.
  { id: 'has-code-signing',        group: 'Mobile', label: 'Automated code signing',  remediation: 'Run the mobile-code-signing scaffolder, then set annotation backstage.io/code-signing-setup: "true".' },
  { id: 'has-min-sdk-version',     group: 'Mobile', label: 'Minimum SDK version',     remediation: 'Set annotation backstage.io/mobile-min-sdk — Android API ≥24, or iOS ≥16.0.' },
  { id: 'has-accessibility-tests', group: 'Mobile', label: 'Accessibility tests',     remediation: 'Run the accessibility-suite scaffolder, then set annotation backstage.io/accessibility-tests: "true".' },
  { id: 'has-crashlytics-enabled', group: 'Mobile', label: 'Crash reporting enabled', remediation: 'Wire up Firebase Crashlytics or Sentry, then set annotation backstage.io/crashlytics-enabled: "true".' },
  { id: 'has-app-size-budget',     group: 'Mobile', label: 'App size budget',         remediation: 'Set annotation backstage.io/app-size-budget-mb to your agreed binary size ceiling.' },
];

export type TierName = 'none' | 'bronze' | 'silver' | 'gold';

// CHECKS above now holds 22 entries and none are marked aiOnly, so both threshold
// sets below are applied against the same 22 checks. The comment here previously
// described 17 checks with 3 AI-only and did the percentage arithmetic on 14;
// that array no longer exists.
//
// The absolute cutoffs have never moved while the array grew from 11 to 22, so
// the effective bar has fallen a long way: gold was ~82% of 11 checks and is now
// ~41% of 22.
//
// This also disagrees with the other implementation. observability/tech-insights-
// exporter/exporter.py scores a strict 11-check subset of these ids and puts gold
// at >= 10 of them — ~91%. The same service can therefore be gold on its entity
// page and bronze on the Grafana dashboard. scorecard.test.ts pins both numbers so
// neither side can drift further without a failing test.
//
// Raising these is a policy change: it demotes services overnight, so it needs the
// scorecard owners rather than a quiet edit here.
export const TIER_THRESHOLDS: Record<Exclude<TierName, 'none'>, number> = {
  bronze: 4,   // ~29% of 14 checks
  silver: 7,   // ~50% of 14 checks
  gold:   9,   // ~64% of 14 checks
};
export const AI_TIER_THRESHOLDS: Record<Exclude<TierName, 'none'>, number> = {
  bronze: 5,   // ~29% of 17 checks
  silver: 9,   // ~53% of 17 checks
  gold:   12,  // ~71% of 17 checks
};

// Mobile scores differently from everything else. The other groups use count
// thresholds — pass any N of them and you reach a tier. That model is wrong for
// mobile, where specific things are non-negotiable: an app you cannot sign is
// not a Bronze app no matter how many other boxes it ticks. So mobile tiers name
// the checks each tier requires, per docs/mobile-platform.md.
//
// These are *additional* gates, not a replacement: a mobile entity's tier is the
// lower of its count-based tier and its mobile tier, so it must clear both the
// platform-wide bar and the mobile-specific one.
export const MOBILE_TIER_REQUIREMENTS: Record<Exclude<TierName, 'none'>, CheckKey[]> = {
  bronze: ['has-code-signing'],
  silver: ['has-code-signing', 'has-min-sdk-version', 'has-accessibility-tests'],
  gold:   [
    'has-code-signing',
    'has-min-sdk-version',
    'has-accessibility-tests',
    'has-crashlytics-enabled',
    'has-app-size-budget',
  ],
};

export const TIER_ORDER: TierName[] = ['none', 'bronze', 'silver', 'gold'];

export function lowerTier(a: TierName, b: TierName): TierName {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;
}

// Highest mobile tier whose required checks all pass.
export function mobileTier(results: Record<CheckKey, boolean>): TierName {
  let tier: TierName = 'none';
  for (const candidate of ['bronze', 'silver', 'gold'] as const) {
    if (MOBILE_TIER_REQUIREMENTS[candidate].every(id => results[id])) tier = candidate;
  }
  return tier;
}

// The mobile requirement blocking the next tier up, for the hint line.
export function missingMobileRequirement(
  tier: TierName,
  results: Record<CheckKey, boolean>,
): CheckKey | null {
  const next = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1] as Exclude<TierName, 'none'> | undefined;
  if (!next) return null;
  return MOBILE_TIER_REQUIREMENTS[next].find(id => !results[id]) ?? null;
}

// Which checks apply to an entity. AI and Mobile groups are conditional; every
// other group always applies. Single definition so the score, the hint and the
// rendered tables cannot disagree about what is being counted.
export function visibleChecks(opts: { isAiEntity: boolean; isMobile: boolean }): CheckDef[] {
  return CHECKS.filter(c => {
    if (c.group === 'AI Governance') return opts.isAiEntity;
    if (c.group === 'Mobile')        return opts.isMobile;
    return true;
  });
}

// Deliberately case-sensitive — see @internal/scorecard-core's isMobileEntity
// doc comment. Re-exported here (rather than re-implemented) so existing
// imports of `isMobileEntity` from './scorecard' keep working unchanged.
export function isMobileEntity(entity: Entity): boolean {
  return sharedIsMobileEntity(entity as any);
}

export interface ScorecardResult {
  results: Record<CheckKey, boolean>;
  passed: number;
  total: number;
  tier: TierName;
}

export function computeScorecard(entity: Entity): ScorecardResult {
  const isMobile = isMobileEntity(entity);
  const isAiEntityValue = sharedIsAiEntity(entity as any);

  // computeFacts returns all @internal/scorecard-core ScorecardFactKey
  // entries (26, including the backend-only legacy mobile-* checks this
  // page never renders); Record<CheckKey, boolean> (22 keys) is a subset,
  // which TypeScript accepts structurally without a cast.
  const results: Record<CheckKey, boolean> = computeFacts(entity as any);

  const thresholds = isAiEntityValue ? AI_TIER_THRESHOLDS : TIER_THRESHOLDS;
  const activeChecks = visibleChecks({ isAiEntity: isAiEntityValue, isMobile });
  const passed = activeChecks.filter(c => results[c.id]).length;

  // Count-based tier over everything that applies, mobile checks included: they
  // still count towards the general score, they just also gate it below.
  let tier: TierName = 'none';
  if (passed >= thresholds.gold)        tier = 'gold';
  else if (passed >= thresholds.silver) tier = 'silver';
  else if (passed >= thresholds.bronze) tier = 'bronze';

  // A mobile app cannot outrank what its mobile requirements allow.
  if (isMobile) tier = lowerTier(tier, mobileTier(results));

  return { results, passed, total: activeChecks.length, tier };
}

