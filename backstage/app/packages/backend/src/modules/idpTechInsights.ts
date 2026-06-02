import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  techInsightsFactRetrieversExtensionPoint,
  type TechInsightFact,
  type FactRetriever,
} from '@backstage/plugin-tech-insights-node';
import { CatalogClient } from '@backstage/catalog-client';
import { RELATION_OWNED_BY } from '@backstage/catalog-model';

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
  // Mobile-specific quality gates
  'mobile-test-coverage',   // Mobile app has unit/widget test coverage gate in CI
  'mobile-crash-reporting', // Mobile app has crash reporting (Firebase Crashlytics / Sentry)
  'mobile-ui-tests',        // Mobile app has Appium/Espresso/XCTest UI tests
  'mobile-fastlane',        // Mobile app uses Fastlane for release automation
] as const;

function parseGates(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

const entityFactRetriever: FactRetriever = {
  id: 'idp-entity-facts',
  version: '0.3.0',
  title: 'IDP Entity Facts',
  description:
    'Collects Bronze/Silver/Gold scorecard facts — service hygiene plus shift-left quality gates',
  entityFilter: [{ kind: 'Component' }],
  schema: {
    // — Service hygiene (Bronze tier) —
    'has-owner': {
      type: 'boolean',
      description: 'Entity has an owner defined in spec.owner',
    },
    'has-techdocs': {
      type: 'boolean',
      description: 'Entity has a backstage.io/techdocs-ref annotation',
    },
    'has-health-probes': {
      type: 'boolean',
      description: 'Entity has backstage.io/kubernetes-id annotation (implies probes via Helm chart)',
    },
    'has-runbook-url': {
      type: 'boolean',
      description: 'Entity has a backstage.io/runbook-url annotation',
    },
    'has-api-definition': {
      type: 'boolean',
      description: 'Entity has at least one providesApis relation',
    },
    'uses-pinned-image-tag': {
      type: 'boolean',
      description: 'Entity image tag annotation is not "latest"',
    },
    // — Shift-left quality gates (Silver / Gold tiers) —
    'has-coverage-gate': {
      type: 'boolean',
      description: 'CI enforces a code coverage threshold (idp.io/quality-gates contains "coverage")',
    },
    'has-static-analysis': {
      type: 'boolean',
      description: 'CI runs lint + type-check (idp.io/quality-gates contains "static-analysis")',
    },
    'has-vuln-scan': {
      type: 'boolean',
      description: 'CI runs dependency + secret scan (idp.io/quality-gates contains "vuln-scan")',
    },
    'has-contract-tests': {
      type: 'boolean',
      description: 'Service has a registered consumer-driven contract (annotation OR providesApi relation)',
    },
    'has-e2e-tests': {
      type: 'boolean',
      description: 'Service has an end-to-end test suite registered in the catalog (annotation OR consumesApi from a test-suite component)',
    },
    // — AI/ML service governance (Gold tier) —
    'has-model-card': {
      type: 'boolean',
      description: 'AI service has a backstage.io/model-card-url annotation documenting the model',
    },
    'has-eval-suite': {
      type: 'boolean',
      description: 'AI agent or model has LLM evaluation suite in CI (idp.io/quality-gates contains "llm-eval")',
    },
    'has-ai-observability': {
      type: 'boolean',
      description: 'AI service has observability configured (backstage.io/kubernetes-id annotation AND "ai" tag present)',
    },
    'has-sonar-scanning': {
      type: 'boolean',
      description: 'Service is wired up to SonarCloud (idp.io/quality-gates contains "sonar-scanning" OR sonarcloud.io/project-key annotation present)',
    },
    'has-snyk-scanning': {
      type: 'boolean',
      description: 'Service is wired up to Snyk (idp.io/quality-gates contains "snyk-scanning" OR snyk.io/org-slug annotation present)',
    },
    // — Mobile app scorecard (Bronze/Silver/Gold for spec.type === "mobile") —
    'has-mobile-test-coverage': {
      type: 'boolean',
      description: 'Mobile app CI enforces a test coverage threshold (idp.io/quality-gates contains "mobile-test-coverage")',
    },
    'has-mobile-crash-reporting': {
      type: 'boolean',
      description: 'Mobile app has crash reporting configured — Firebase Crashlytics or Sentry (annotation or quality gate)',
    },
    'has-mobile-ui-tests': {
      type: 'boolean',
      description: 'Mobile app has Appium/Espresso/Flutter integration tests registered in the catalog',
    },
    'has-mobile-fastlane': {
      type: 'boolean',
      description: 'Mobile app uses Fastlane for release automation (idp.io/quality-gates contains "mobile-fastlane")',
    },
  },
  handler: async ({ entities, discovery, auth }) => {
    const { token } = await auth.getPluginRequestToken({
      onBehalfOf: await auth.getOwnServiceCredentials(),
      targetPluginId: 'catalog',
    });
    const catalogClient = new CatalogClient({ discoveryApi: discovery });

    const facts: TechInsightFact[] = [];

    for (const entity of entities) {
      const annotations = entity.metadata.annotations ?? {};
      const relations   = entity.relations ?? [];
      const tags        = entity.metadata.tags ?? [];

      // Hygiene facts
      const hasOwner = Boolean(
        entity.spec?.owner &&
        relations.some(r => r.type === RELATION_OWNED_BY),
      );
      const hasTechDocs      = Boolean(annotations['backstage.io/techdocs-ref']);
      const hasHealthProbes  = Boolean(annotations['backstage.io/kubernetes-id']);
      const hasRunbookUrl    = Boolean(annotations['backstage.io/runbook-url']);
      const hasApiDefinition = relations.some(r => r.type === 'providesApi');
      const imageTag         = annotations['backstage.io/image-tag'] ?? '';
      const usesPinnedTag    = imageTag !== '' && imageTag !== 'latest';

      // Quality-gate facts
      const declaredGates = parseGates(annotations['idp.io/quality-gates']);
      const hasCoverageGate   = declaredGates.has('coverage');
      const hasStaticAnalysis = declaredGates.has('static-analysis');
      const hasVulnScan       = declaredGates.has('vuln-scan');

      // Contract tests: explicit annotation OR catalog relation to an API entity.
      // Services scaffolded through enable-contract-testing get the annotation;
      // services registered manually still credit if they expose an API.
      const hasContractTests = declaredGates.has('contract') || hasApiDefinition;

      // E2E tests: explicit annotation OR a Backstage tag of "e2e"/"playwright"
      // OR an inbound consumesApi relation from a test-suite component.
      // Suite scaffolders add the annotation; legacy services can opt in via tags.
      const hasE2eTagged = tags.some(t =>
        ['e2e', 'playwright', 'cypress', 'appium'].includes(t.toLowerCase()),
      );
      const hasE2eRelation = relations.some(r => r.type === 'consumesApi');
      const hasE2eTests =
        declaredGates.has('e2e') || hasE2eTagged || hasE2eRelation;

      // AI/ML service governance facts
      const hasModelCard = Boolean(annotations['backstage.io/model-card-url']);
      const hasEvalSuite = declaredGates.has('llm-eval');
      const isAiService = tags.some(t => t.toLowerCase() === 'ai');
      const hasAiObservability = hasHealthProbes && isAiService;

      // Sonar/Snyk: opt in via quality-gates list OR via tool-specific annotation.
      const hasSonarScanning =
        declaredGates.has('sonar-scanning') ||
        Boolean(annotations['sonarcloud.io/project-key']);
      const hasSnykScanning =
        declaredGates.has('snyk-scanning') ||
        Boolean(annotations['snyk.io/org-slug']);

      // Mobile scorecard facts (only meaningful for spec.type === 'mobile', but
      // computed for all Components so the scorecard UI can render consistently)
      const isMobileApp = entity.spec?.type === 'mobile';
      const hasMobileTestCoverage = isMobileApp && declaredGates.has('mobile-test-coverage');
      // Crash reporting: explicit gate OR Firebase/Sentry annotation
      const hasMobileCrashReporting =
        isMobileApp &&
        (declaredGates.has('mobile-crash-reporting') ||
          Boolean(annotations['mobile.io/crash-reporting']));
      // UI tests: gate OR tags like "appium", "espresso", "xctest", "flutter-integration"
      const hasMobileUiTests =
        isMobileApp &&
        (declaredGates.has('mobile-ui-tests') ||
          tags.some(t =>
            ['appium', 'espresso', 'xctest', 'flutter-integration'].includes(t.toLowerCase()),
          ));
      const hasMobileFastlane = isMobileApp && declaredGates.has('mobile-fastlane');

      facts.push({
        entity: {
          namespace: entity.metadata.namespace ?? 'default',
          kind:      entity.kind,
          name:      entity.metadata.name,
        },
        facts: {
          'has-owner':             hasOwner,
          'has-techdocs':          hasTechDocs,
          'has-health-probes':     hasHealthProbes,
          'has-runbook-url':       hasRunbookUrl,
          'has-api-definition':    hasApiDefinition,
          'uses-pinned-image-tag': usesPinnedTag,
          'has-coverage-gate':     hasCoverageGate,
          'has-static-analysis':   hasStaticAnalysis,
          'has-vuln-scan':         hasVulnScan,
          'has-contract-tests':    hasContractTests,
          'has-e2e-tests':         hasE2eTests,
          'has-model-card':        hasModelCard,
          'has-eval-suite':        hasEvalSuite,
          'has-ai-observability':  hasAiObservability,
          'has-sonar-scanning':          hasSonarScanning,
          'has-snyk-scanning':           hasSnykScanning,
          'has-mobile-test-coverage':    hasMobileTestCoverage,
          'has-mobile-crash-reporting':  hasMobileCrashReporting,
          'has-mobile-ui-tests':         hasMobileUiTests,
          'has-mobile-fastlane':         hasMobileFastlane,
        },
      });
    }

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
export { QUALITY_GATES };
