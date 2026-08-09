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
  'trivy-scanning',         // CI runs Trivy image scan (results surfaced in the Trivy entity tab)
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

// Returns true for entities that represent a mobile app (Android, iOS, Flutter, etc.)
function isMobileEntity(entity: { spec?: Record<string, unknown>; metadata: { tags?: string[] } }): boolean {
  return (
    entity.spec?.type === 'mobile' ||
    (entity.metadata.tags ?? []).includes('mobile')
  );
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
    'has-trivy-scanning': {
      type: 'boolean',
      description: 'Service image is scanned by Trivy (idp.io/quality-gates contains "trivy-scanning" OR github.com/project-slug annotation present)',
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
    // — Mobile platform maturity checks (new — tied to platform annotations) —
    'has-min-sdk-version': {
      type: 'boolean',
      description: 'Mobile app declares a minimum SDK/OS version via backstage.io/mobile-min-sdk annotation (Android >= 24 or iOS >= 16.0)',
    },
    'has-crashlytics-enabled': {
      type: 'boolean',
      description: 'Mobile app has crash reporting enabled — backstage.io/crashlytics-enabled annotation is "true"',
    },
    'has-accessibility-tests': {
      type: 'boolean',
      description: 'Mobile app has accessibility tests wired up — backstage.io/accessibility-tests annotation is "true"',
    },
    'has-app-size-budget': {
      type: 'boolean',
      description: 'Mobile app declares an app-size budget — backstage.io/app-size-budget-mb annotation is present',
    },
    'has-code-signing': {
      type: 'boolean',
      description: 'Mobile app has automated code signing configured — backstage.io/code-signing-setup annotation is "true"',
    },
  },
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
      const hasTrivyScanning =
        declaredGates.has('trivy-scanning') ||
        Boolean(annotations['github.com/project-slug']);

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

      // New mobile platform maturity checks — only meaningful for mobile entities.
      // Non-mobile entities always get false so the scorecard renders consistently.
      const isMobile = isMobileEntity(entity);

      // hasMinSdkVersion: annotation must exist and meet the platform floor.
      // iOS floor: "16.0" (numeric prefix comparison). Android floor: 24.
      const minSdkRaw = annotations['backstage.io/mobile-min-sdk'];
      let hasMinSdkVersion = false;
      if (isMobile && minSdkRaw) {
        const isIos = (entity.metadata.tags ?? []).includes('ios') ||
          (entity.metadata.tags ?? []).includes('swiftui') ||
          (entity.metadata.tags ?? []).includes('swift');
        if (isIos) {
          // iOS: compare major version number
          const major = parseFloat(minSdkRaw.split('.')[0]);
          hasMinSdkVersion = !isNaN(major) && major >= 16;
        } else {
          // Android / Flutter: integer API level
          const level = parseInt(minSdkRaw, 10);
          hasMinSdkVersion = !isNaN(level) && level >= 24;
        }
      }

      // hasCrashlyticsEnabled: annotation exactly "true"
      const hasCrashlyticsEnabled =
        isMobile && annotations['backstage.io/crashlytics-enabled'] === 'true';

      // hasAccessibilityTests: annotation exactly "true"
      const hasAccessibilityTests =
        isMobile && annotations['backstage.io/accessibility-tests'] === 'true';

      // hasAppSizeBudget: annotation present (any non-empty value)
      const hasAppSizeBudget =
        isMobile && Boolean(annotations['backstage.io/app-size-budget-mb']);

      // hasCodeSigning: annotation exactly "true"
      const hasCodeSigning =
        isMobile && annotations['backstage.io/code-signing-setup'] === 'true';

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
          'has-trivy-scanning':          hasTrivyScanning,
          'has-mobile-test-coverage':    hasMobileTestCoverage,
          'has-mobile-crash-reporting':  hasMobileCrashReporting,
          'has-mobile-ui-tests':         hasMobileUiTests,
          'has-mobile-fastlane':         hasMobileFastlane,
          // New mobile platform maturity facts
          'has-min-sdk-version':         hasMinSdkVersion,
          'has-crashlytics-enabled':     hasCrashlyticsEnabled,
          'has-accessibility-tests':     hasAccessibilityTests,
          'has-app-size-budget':         hasAppSizeBudget,
          'has-code-signing':            hasCodeSigning,
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
