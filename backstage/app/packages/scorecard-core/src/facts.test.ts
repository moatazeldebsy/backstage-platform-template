import { computeFacts, isAiEntity, isMobileEntity, FactsEntityLike } from './facts';

function entity(overrides: Partial<FactsEntityLike> = {}): FactsEntityLike {
  return {
    metadata: { annotations: {}, tags: [] },
    relations: [],
    ...overrides,
  };
}

describe('isMobileEntity', () => {
  it('matches on spec.type', () => {
    expect(isMobileEntity(entity({ spec: { type: 'mobile' } }))).toBe(true);
  });
  it('matches on the mobile tag', () => {
    expect(isMobileEntity(entity({ metadata: { tags: ['mobile'] } }))).toBe(true);
  });
  it('is case-sensitive', () => {
    expect(isMobileEntity(entity({ metadata: { tags: ['Mobile'] } }))).toBe(false);
    expect(isMobileEntity(entity({ spec: { type: 'Mobile' } }))).toBe(false);
  });
});

describe('isAiEntity', () => {
  it('matches on the "ai" tag', () => {
    expect(isAiEntity(entity({ metadata: { tags: ['ai'] } }))).toBe(true);
  });
  it('matches on spec.type in the AI-workload set', () => {
    for (const type of ['ai-agent', 'model-serving', 'llm', 'ml-model']) {
      expect(isAiEntity(entity({ spec: { type } }))).toBe(true);
    }
  });
  it('is false for an unrelated spec.type with no ai tag', () => {
    expect(isAiEntity(entity({ spec: { type: 'service' } }))).toBe(false);
  });
});

describe('computeFacts', () => {
  it('has-owner requires both spec.owner and an ownedBy relation', () => {
    expect(computeFacts(entity({ spec: { owner: 'team-a' }, relations: [{ type: 'ownedBy' }] }))['has-owner']).toBe(true);
    expect(computeFacts(entity({ spec: { owner: 'team-a' } }))['has-owner']).toBe(false);
    expect(computeFacts(entity({ relations: [{ type: 'ownedBy' }] }))['has-owner']).toBe(false);
  });

  it('uses-pinned-image-tag is false for unset or "latest", true otherwise', () => {
    expect(computeFacts(entity())['uses-pinned-image-tag']).toBe(false);
    expect(computeFacts(entity({ metadata: { annotations: { 'backstage.io/image-tag': 'latest' } } }))['uses-pinned-image-tag']).toBe(false);
    expect(computeFacts(entity({ metadata: { annotations: { 'backstage.io/image-tag': 'a3f1b2c' } } }))['uses-pinned-image-tag']).toBe(true);
  });

  it('has-contract-tests is true via the quality-gates annotation OR a providesApi relation', () => {
    expect(computeFacts(entity({ metadata: { annotations: { 'idp.io/quality-gates': 'contract' } } }))['has-contract-tests']).toBe(true);
    expect(computeFacts(entity({ relations: [{ type: 'providesApi' }] }))['has-contract-tests']).toBe(true);
    expect(computeFacts(entity())['has-contract-tests']).toBe(false);
  });

  it('has-e2e-tests is true via the quality-gates annotation, an e2e-ish tag, or a consumesApi relation', () => {
    expect(computeFacts(entity({ metadata: { annotations: { 'idp.io/quality-gates': 'e2e' } } }))['has-e2e-tests']).toBe(true);
    expect(computeFacts(entity({ metadata: { tags: ['playwright'] } }))['has-e2e-tests']).toBe(true);
    expect(computeFacts(entity({ relations: [{ type: 'consumesApi' }] }))['has-e2e-tests']).toBe(true);
    expect(computeFacts(entity())['has-e2e-tests']).toBe(false);
  });

  describe('AI governance checks are gated on isAiEntity (unified, broad definition)', () => {
    it('has-model-card requires an AI entity, not just the annotation', () => {
      const withAnnotationOnly = entity({ metadata: { annotations: { 'backstage.io/model-card-url': 'https://x' } } });
      expect(computeFacts(withAnnotationOnly)['has-model-card']).toBe(false);

      const aiWithAnnotation = entity({
        spec: { type: 'ai-agent' },
        metadata: { annotations: { 'backstage.io/model-card-url': 'https://x' } },
      });
      expect(computeFacts(aiWithAnnotation)['has-model-card']).toBe(true);
    });

    it('has-eval-suite requires an AI entity, not just the quality gate', () => {
      const withGateOnly = entity({ metadata: { annotations: { 'idp.io/quality-gates': 'llm-eval' } } });
      expect(computeFacts(withGateOnly)['has-eval-suite']).toBe(false);

      const aiWithGate = entity({ metadata: { tags: ['ai'], annotations: { 'idp.io/quality-gates': 'llm-eval' } } });
      expect(computeFacts(aiWithGate)['has-eval-suite']).toBe(true);
    });

    it('has-ai-observability activates for spec.type-only AI entities too (broadened from tag-only)', () => {
      const specTypeOnly = entity({
        spec: { type: 'model-serving' },
        metadata: { annotations: { 'backstage.io/kubernetes-id': 'x' } },
      });
      expect(computeFacts(specTypeOnly)['has-ai-observability']).toBe(true);

      const probesOnly = entity({ metadata: { annotations: { 'backstage.io/kubernetes-id': 'x' } } });
      expect(computeFacts(probesOnly)['has-ai-observability']).toBe(false);

      const tagOnlyNoProbes = entity({ metadata: { tags: ['ai'] } });
      expect(computeFacts(tagOnlyNoProbes)['has-ai-observability']).toBe(false);
    });
  });

  it('has-sonar/snyk/trivy-scanning fall back to their tool-specific annotations', () => {
    const facts = computeFacts(entity({
      metadata: {
        annotations: {
          'sonarcloud.io/project-key': 'org_repo',
          'snyk.io/org-slug': 'acme',
          'github.com/project-slug': 'acme/hello-service',
        },
      },
    }));
    expect(facts['has-sonar-scanning']).toBe(true);
    expect(facts['has-snyk-scanning']).toBe(true);
    expect(facts['has-trivy-scanning']).toBe(true);
  });

  it('legacy mobile checks (has-mobile-*) gate on spec.type === "mobile" specifically, not the mobile tag', () => {
    const taggedOnly = entity({
      metadata: { tags: ['mobile', 'appium'], annotations: { 'idp.io/quality-gates': 'mobile-test-coverage,mobile-fastlane' } },
    });
    expect(computeFacts(taggedOnly)['has-mobile-test-coverage']).toBe(false);
    expect(computeFacts(taggedOnly)['has-mobile-ui-tests']).toBe(false);
    expect(computeFacts(taggedOnly)['has-mobile-fastlane']).toBe(false);

    const specTypeMobile = entity({
      spec: { type: 'mobile' },
      metadata: { tags: ['appium'], annotations: { 'idp.io/quality-gates': 'mobile-test-coverage,mobile-fastlane' } },
    });
    expect(computeFacts(specTypeMobile)['has-mobile-test-coverage']).toBe(true);
    expect(computeFacts(specTypeMobile)['has-mobile-ui-tests']).toBe(true);
    expect(computeFacts(specTypeMobile)['has-mobile-fastlane']).toBe(true);
  });

  it('has-min-sdk-version applies the Android floor (>=24) for non-iOS tags', () => {
    const below = entity({ spec: { type: 'mobile' }, metadata: { annotations: { 'backstage.io/mobile-min-sdk': '21' } } });
    expect(computeFacts(below)['has-min-sdk-version']).toBe(false);
    const atFloor = entity({ spec: { type: 'mobile' }, metadata: { annotations: { 'backstage.io/mobile-min-sdk': '24' } } });
    expect(computeFacts(atFloor)['has-min-sdk-version']).toBe(true);
  });

  it('has-min-sdk-version applies the iOS floor (>=16.0) when tagged ios/swift/swiftui', () => {
    const below = entity({ spec: { type: 'mobile' }, metadata: { tags: ['ios'], annotations: { 'backstage.io/mobile-min-sdk': '15.0' } } });
    expect(computeFacts(below)['has-min-sdk-version']).toBe(false);
    const atFloor = entity({ spec: { type: 'mobile' }, metadata: { tags: ['ios'], annotations: { 'backstage.io/mobile-min-sdk': '16.0' } } });
    expect(computeFacts(atFloor)['has-min-sdk-version']).toBe(true);
  });

  it('mobile platform-maturity checks require the annotation value to be exactly "true"', () => {
    const notQuiteTrue = entity({
      spec: { type: 'mobile' },
      metadata: {
        annotations: {
          'backstage.io/crashlytics-enabled': 'yes',
          'backstage.io/accessibility-tests': 'True',
          'backstage.io/code-signing-setup': '1',
        },
      },
    });
    const notQuite = computeFacts(notQuiteTrue);
    expect(notQuite['has-crashlytics-enabled']).toBe(false);
    expect(notQuite['has-accessibility-tests']).toBe(false);
    expect(notQuite['has-code-signing']).toBe(false);

    const exact = entity({
      spec: { type: 'mobile' },
      metadata: {
        annotations: {
          'backstage.io/crashlytics-enabled': 'true',
          'backstage.io/accessibility-tests': 'true',
          'backstage.io/code-signing-setup': 'true',
        },
      },
    });
    const exactFacts = computeFacts(exact);
    expect(exactFacts['has-crashlytics-enabled']).toBe(true);
    expect(exactFacts['has-accessibility-tests']).toBe(true);
    expect(exactFacts['has-code-signing']).toBe(true);
  });

  it('has-app-size-budget is true for any non-empty annotation value', () => {
    const facts = computeFacts(entity({ spec: { type: 'mobile' }, metadata: { annotations: { 'backstage.io/app-size-budget-mb': '150' } } }));
    expect(facts['has-app-size-budget']).toBe(true);
  });

  it('mobile platform-maturity checks also activate for an entity tagged "mobile" even without spec.type', () => {
    const facts = computeFacts(entity({ metadata: { tags: ['mobile'], annotations: { 'backstage.io/crashlytics-enabled': 'true' } } }));
    expect(facts['has-crashlytics-enabled']).toBe(true);
  });
});
