import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  techInsightsFactRetrieversExtensionPoint,
  type TechInsightFact,
  type FactRetriever,
} from '@backstage/plugin-tech-insights-node';
import { CatalogClient } from '@backstage/catalog-client';
import { computeFacts, ScorecardFactKey } from '@internal/scorecard-core';

// Quality gates a service can declare via the `idp.io/quality-gates` annotation
// (comma-separated). The hardened language skeleton CI declares the first three;
// `contract` and `e2e` are added by the contract-testing and playwright-e2e-suite
// scaffolders when run in "add to existing" mode.
const QUALITY_GATES = [
  'coverage',               // CI enforces a coverage threshold
  'static-analysis',        // CI runs lint/type-check (golangci-lint, ruff+mypy, tsc, prettier)
  'vuln-scan',              // CI runs dependency + secret scan (govulncheck / npm audit / pip-audit + Trivy fs)
  'contract',               // service has a registered OpenAPI/Pact contract
  'e2e',                    // service has an associated end-to-end test suite
  'llm-eval',               // AI service has LLM evaluation suite (deepeval or equivalent)
  'bias-check',             // AI model has bias/fairness evaluation
  'rag-eval',               // RAG system has retrieval quality evaluation
  'sonar-scanning',         // CI runs SonarCloud quality gate
  'snyk-scanning',          // CI runs Snyk SCA scan
  'trivy-scanning',         // CI runs Trivy image scan (results surfaced in the Trivy entity tab)
  // Mobile-specific quality gates
  'mobile-test-coverage',   // Mobile app has unit/widget test coverage gate in CI
  'mobile-crash-reporting', // Mobile app has crash reporting (Firebase Crashlytics / Sentry)
  'mobile-ui-tests',        // Mobile app has Appium/Espresso/XCTest UI tests
  'mobile-fastlane',        // Mobile app uses Fastlane for release automation
] as const;

// Every entry here is a boolean fact with only its description varying, so
// the literal `{ type: 'boolean', description: ... }` shape used to repeat
// 28 times in the schema below — SonarCloud's duplication detector flagged
// that repetition against itself. Generating the schema from this table
// keeps the same keys, order, and shape without the repeated structure.
//
// The check *logic* itself lives in @internal/scorecard-core, shared with
// packages/app/src/scorecard.ts — this table only carries the id ->
// human-readable description mapping the Tech Insights schema needs.
const FACT_DESCRIPTIONS: Array<[ScorecardFactKey, string]> = [
  // — Service hygiene (Bronze tier) —
  ['has-owner', 'Entity has an owner defined in spec.owner'],
  ['has-techdocs', 'Entity has a backstage.io/techdocs-ref annotation'],
  ['has-health-probes', 'Entity has backstage.io/kubernetes-id annotation (implies probes via Helm chart)'],
  ['has-runbook-url', 'Entity has a backstage.io/runbook-url annotation'],
  ['has-api-definition', 'Entity has at least one providesApis relation'],
  ['uses-pinned-image-tag', 'Entity image tag annotation is not "latest"'],
  // — Shift-left quality gates (Silver / Gold tiers) —
  ['has-coverage-gate', 'CI enforces a code coverage threshold (idp.io/quality-gates contains "coverage")'],
  ['has-static-analysis', 'CI runs lint + type-check (idp.io/quality-gates contains "static-analysis")'],
  ['has-vuln-scan', 'CI runs dependency + secret scan (idp.io/quality-gates contains "vuln-scan")'],
  ['has-contract-tests', 'Service has a registered consumer-driven contract (annotation OR providesApi relation)'],
  ['has-e2e-tests', 'Service has an end-to-end test suite registered in the catalog (annotation OR consumesApi from a test-suite component)'],
  // — AI/ML service governance (Gold tier) —
  ['has-model-card', 'AI entity has a backstage.io/model-card-url annotation documenting the model'],
  ['has-eval-suite', 'AI entity has LLM evaluation suite in CI (idp.io/quality-gates contains "llm-eval")'],
  ['has-ai-observability', 'AI entity has observability configured (backstage.io/kubernetes-id annotation)'],
  ['has-sonar-scanning', 'Service is wired up to SonarCloud (idp.io/quality-gates contains "sonar-scanning" OR sonarcloud.io/project-key annotation present)'],
  ['has-snyk-scanning', 'Service is wired up to Snyk (idp.io/quality-gates contains "snyk-scanning" OR snyk.io/org-slug annotation present)'],
  ['has-trivy-scanning', 'Service image is scanned by Trivy (idp.io/quality-gates contains "trivy-scanning" OR github.com/project-slug annotation present)'],
  // — Mobile app scorecard (Bronze/Silver/Gold for spec.type === "mobile") —
  ['has-mobile-test-coverage', 'Mobile app CI enforces a test coverage threshold (idp.io/quality-gates contains "mobile-test-coverage")'],
  ['has-mobile-crash-reporting', 'Mobile app has crash reporting configured — Firebase Crashlytics or Sentry (annotation or quality gate)'],
  ['has-mobile-ui-tests', 'Mobile app has Appium/Espresso/Flutter integration tests registered in the catalog'],
  ['has-mobile-fastlane', 'Mobile app uses Fastlane for release automation (idp.io/quality-gates contains "mobile-fastlane")'],
  // — Mobile platform maturity checks (new — tied to platform annotations) —
  ['has-min-sdk-version', 'Mobile app declares a minimum SDK/OS version via backstage.io/mobile-min-sdk annotation (Android >= 24 or iOS >= 16.0)'],
  ['has-crashlytics-enabled', 'Mobile app has crash reporting enabled — backstage.io/crashlytics-enabled annotation is "true"'],
  ['has-accessibility-tests', 'Mobile app has accessibility tests wired up — backstage.io/accessibility-tests annotation is "true"'],
  ['has-app-size-budget', 'Mobile app declares an app-size budget — backstage.io/app-size-budget-mb annotation is present'],
  ['has-code-signing', 'Mobile app has automated code signing configured — backstage.io/code-signing-setup annotation is "true"'],
];

const entityFactRetriever: FactRetriever = {
  id: 'idp-entity-facts',
  version: '0.4.0',
  title: 'IDP Entity Facts',
  description:
    'Collects Bronze/Silver/Gold scorecard facts — service hygiene plus shift-left quality gates',
  entityFilter: [{ kind: 'Component' }],
  schema: Object.fromEntries(
    FACT_DESCRIPTIONS.map(([key, description]) => [key, { type: 'boolean' as const, description }]),
  ),
  // FactRetrieverContext does not supply `entities` — the retriever fetches
  // them itself, which is what the token and catalog client below were always
  // for. This used to destructure `entities` off the context, so at runtime it
  // was undefined and the `for…of` threw immediately: every fact in this
  // retriever silently produced nothing, and the scorecard stayed empty.
  // entityFilter is the same filter declared on the retriever above.
  handler: async ({ discovery, auth, entityFilter }) => {
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const catalogClient = new CatalogClient({ discoveryApi: discovery });
    const { items: entities } = await catalogClient.getEntities(
      { filter: entityFilter },
      { token },
    );

    const facts: TechInsightFact[] = entities.map(entity => ({
      entity: {
        namespace: entity.metadata.namespace ?? 'default',
        kind: entity.kind,
        name: entity.metadata.name,
      },
      facts: computeFacts(entity),
    }));

    return facts;
  },
};

export const idpTechInsightsModule = createBackendModule({
  pluginId: 'tech-insights',
  moduleId: 'idp-entity-facts',
  register(env) {
    env.registerInit({
      deps: {
        factRetrievers: techInsightsFactRetrieversExtensionPoint,
      },
      async init({ factRetrievers }) {
        factRetrievers.addFactRetrievers({
          [entityFactRetriever.id]: entityFactRetriever,
        });
      },
    });
  },
});

// Exported for unit tests / docs generation.
export { QUALITY_GATES, entityFactRetriever };
