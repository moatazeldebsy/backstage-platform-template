/**
 * Predicates that decide which entity tabs an entity actually gets.
 *
 * Every custom tab used to be registered with `filter: 'kind:component'`, so a
 * mobile SDK (`type: library`), a Terraform module (`type: infrastructure`), a
 * Playwright suite (`type: test-suite`) and an MLflow experiment all rendered the
 * same eleven tabs — Datadog, Trivy, On-Call, DORA, SLOs, Grafana, Jira and the
 * rest — almost all of them showing an empty state. The annotation checks existed,
 * but they lived *inside* each component and produced an empty panel rather than
 * hiding the tab.
 *
 * `EntityContentBlueprint`'s `filter` accepts a predicate, so the check belongs
 * here instead: a tab that has nothing to show should not be a tab.
 *
 * The rule of thumb when adding one: gate on the annotation the tab actually
 * reads. If the tab cannot render anything useful without annotation X, then X is
 * its filter. Gate on `spec.type` only when the tab is meaningful for a whole
 * class of entity regardless of annotations (see `isAnyType`).
 */
import type { Entity } from '@backstage/catalog-model';

/** Annotations consumed by the entity tabs, in one place so the tabs and the
 *  scaffolder skeletons that emit them can be cross-checked. */
export const ANNOTATION = {
  // Deployment / runtime
  KUBERNETES_ID: 'backstage.io/kubernetes-id',
  GITHUB_SLUG: 'github.com/project-slug',
  // Quality
  QUALITY_GATES: 'idp.io/quality-gates',
  SONAR_PROJECT: 'sonarcloud.io/project-key',
  SNYK_ORG: 'snyk.io/org-slug',
  // Operations
  PAGERDUTY_SERVICE: 'pagerduty.com/service-id',
  GRAFANA_SELECTOR: 'grafana/alert-label-selector',
  JIRA_PROJECT: 'jira/project-key',
  // SLOs
  SLOTH_SERVICE: 'idp.io/sloth-service',
  SLO_AVAILABILITY: 'idp.io/slo-availability-target',
  SLO_LATENCY: 'idp.io/slo-latency-target',
  // Datadog
  DD_DASHBOARD: 'datadoghq.com/dashboard-url',
  DD_MONITOR_TAG: 'datadoghq.com/monitor-tag',
  DD_SLO_ID: 'datadoghq.com/slo-id',
  // AI/ML
  LANGFUSE_SERVICE: 'langfuse.com/service-name',
  MODEL_NAME: 'idp.io/model-name',
  // Cost
  COST_BUDGET: 'idp.io/cost-budget-monthly-usd',
} as const;

/** spec.type values that represent an AI/ML workload. */
export const AI_TYPES = ['ai-agent', 'ml-experiment', 'mcp-server'] as const;

const annotations = (e: Entity): Record<string, string> =>
  e.metadata.annotations ?? {};

export const hasAnnotation = (e: Entity, key: string): boolean => {
  const v = annotations(e)[key];
  return typeof v === 'string' && v.trim() !== '';
};

export const hasAnyAnnotation = (e: Entity, ...keys: string[]): boolean =>
  keys.some(k => hasAnnotation(e, k));

/** `spec.type` is not part of the Entity type (it varies by kind), hence the cast. */
export const specType = (e: Entity): string | undefined => {
  const t = (e.spec as Record<string, unknown> | undefined)?.type;
  return typeof t === 'string' ? t : undefined;
};

export const isAnyType = (e: Entity, ...types: readonly string[]): boolean => {
  const t = specType(e);
  return t !== undefined && types.includes(t);
};

const isKind = (e: Entity, kind: string): boolean =>
  e.kind.toLowerCase() === kind.toLowerCase();

/**
 * Runs on something we deploy. This is the single best discriminator the catalog
 * has: 31 skeletons emit `backstage.io/kubernetes-id` and the ones that do not —
 * mobile-sdk, terraform-module, the mobile apps, the 18 QA suites — are exactly
 * the entities that should not show deployment, DORA or on-call tabs.
 */
export const isDeployed = (e: Entity): boolean =>
  isKind(e, 'component') && hasAnnotation(e, ANNOTATION.KUBERNETES_ID);

export const isComponent = (e: Entity): boolean => isKind(e, 'component');

// ── Per-tab predicates ────────────────────────────────────────────────────────
// Named after the tab so the registration site reads as a sentence.

export const showScorecard = (e: Entity): boolean =>
  isComponent(e) && hasAnnotation(e, ANNOTATION.QUALITY_GATES);

export const showSecurity = (e: Entity): boolean =>
  isComponent(e) &&
  hasAnyAnnotation(e, ANNOTATION.SONAR_PROJECT, ANNOTATION.SNYK_ORG);

/** Trivy scans container images, so it needs both a source repo and a deployment. */
export const showTrivy = (e: Entity): boolean =>
  isDeployed(e) && hasAnnotation(e, ANNOTATION.GITHUB_SLUG);

export const showOnCall = (e: Entity): boolean =>
  isComponent(e) && hasAnnotation(e, ANNOTATION.PAGERDUTY_SERVICE);

export const showGrafana = (e: Entity): boolean =>
  isComponent(e) && hasAnnotation(e, ANNOTATION.GRAFANA_SELECTOR);

export const showJira = (e: Entity): boolean =>
  isComponent(e) && hasAnnotation(e, ANNOTATION.JIRA_PROJECT);

/** DORA measures deployments, so an entity that is never deployed has no DORA. */
export const showDora = (e: Entity): boolean => isDeployed(e);

/**
 * Deployed services, plus anything explicitly annotated.
 *
 * Not annotation-only, because **no template emits these annotations**: the
 * `slo-definition` template opens its PR against the *platform* repo to add
 * `observability/slo/<service>-slos.yaml`, while a service's catalog-info.yaml
 * lives in the service's own repo — and a scaffolder skeleton cannot patch an
 * existing file. Gating on annotations alone would hide the tab from every
 * service forever.
 *
 * An SLO tab on a deployed service is a reasonable call to action even before an
 * SLO exists; the entities this is protecting (mobile SDKs, Terraform modules,
 * test suites) are already excluded by isDeployed.
 */
export const showSlo = (e: Entity): boolean =>
  isDeployed(e) ||
  (isComponent(e) &&
    hasAnyAnnotation(
      e,
      ANNOTATION.SLOTH_SERVICE,
      ANNOTATION.SLO_AVAILABILITY,
      ANNOTATION.SLO_LATENCY,
    ));

export const showBudget = (e: Entity): boolean => isKind(e, 'group');

/**
 * Anything that can have an incident: a deployed service, or something with an
 * on-call rotation. Records are matched by entity name against the marker the
 * router writes, so no per-service annotation is needed for the history — the
 * PagerDuty annotation only adds the on-call card.
 */
export const showIncidents = (e: Entity): boolean =>
  isDeployed(e) || (isComponent(e) && hasAnnotation(e, ANNOTATION.PAGERDUTY_SERVICE));

/**
 * These three are deliberately *not* config-aware. A blueprint `filter` is a pure
 * `(entity) => boolean` with no access to the config API, so "is the AI stack
 * enabled" and "is Datadog in demo mode" cannot be answered here.
 *
 * That split is fine, because the two questions belong at different layers:
 *   - which *entities* a tab applies to  → these predicates
 *   - whether the tab exists at all      → the `app.extensions` disable lists in
 *     app-config.local.yaml / app-config.aws.yaml
 *
 * Datadog gates on being deployed rather than on its annotations, because the tab
 * now falls back to demo data (DEMO_DATADOG_*) — showing it on a deployed service
 * with a "Demo data" chip is useful, whereas showing it on a Terraform module
 * never is.
 */
export const showDatadog = (e: Entity): boolean => isDeployed(e);

export const showLangfuse = (e: Entity): boolean =>
  isComponent(e) &&
  (hasAnnotation(e, ANNOTATION.LANGFUSE_SERVICE) || isAnyType(e, ...AI_TYPES));

export const showMlflow = (e: Entity): boolean =>
  isComponent(e) &&
  (isAnyType(e, 'ml-experiment') || hasAnnotation(e, ANNOTATION.MODEL_NAME));
