const mockGetEntities = jest.fn();
jest.mock('@backstage/catalog-client', () => ({
  CatalogClient: jest.fn().mockImplementation(() => ({
    getEntities: (...args: any[]) => mockGetEntities(...args),
  })),
}));

// @backstage/catalog-model exports RELATION_OWNED_BY as a plain string
// constant, so importing the real module is safe and keeps the retriever's
// relation-type comparisons meaningful.
import { RELATION_OWNED_BY } from '@backstage/catalog-model';
import { entityFactRetriever } from '../idpTechInsights';

function getFactRetriever() {
  return entityFactRetriever;
}

function makeEntity(overrides: {
  name?: string;
  namespace?: string;
  kind?: string;
  owner?: string;
  ownedByRelation?: boolean;
  annotations?: Record<string, string>;
  tags?: string[];
  relations?: Array<{ type: string }>;
  specType?: string;
}) {
  const relations = overrides.relations ?? [];
  if (overrides.ownedByRelation) relations.push({ type: RELATION_OWNED_BY });
  return {
    kind: overrides.kind ?? 'Component',
    metadata: {
      name: overrides.name ?? 'hello-service',
      namespace: overrides.namespace,
      annotations: overrides.annotations ?? {},
      tags: overrides.tags ?? [],
    },
    spec: { owner: overrides.owner, type: overrides.specType },
    relations,
  };
}

async function runRetriever(entities: any[]) {
  const retriever = getFactRetriever();
  mockGetEntities.mockResolvedValue({ items: entities });
  const auth = {
    getOwnServiceCredentials: jest.fn().mockResolvedValue({}),
    getPluginRequestToken: jest.fn().mockResolvedValue({ token: 'tok' }),
  };
  const facts = await retriever.handler({ discovery: {}, auth, entityFilter: [{ kind: 'Component' }] } as any);
  return facts[0]?.facts as Record<string, boolean>;
}

describe('idp-entity-facts retriever', () => {
  beforeEach(() => {
    mockGetEntities.mockReset();
  });

  it('reports the fact envelope shape (namespace defaults to "default")', async () => {
    const retriever = getFactRetriever();
    mockGetEntities.mockResolvedValue({ items: [makeEntity({ name: 'hello-service' })] });
    const auth = {
      getOwnServiceCredentials: jest.fn().mockResolvedValue({}),
      getPluginRequestToken: jest.fn().mockResolvedValue({ token: 'tok' }),
    };
    const facts = await retriever.handler({ discovery: {}, auth, entityFilter: [{ kind: 'Component' }] } as any);
    expect(facts[0].entity).toEqual({ namespace: 'default', kind: 'Component', name: 'hello-service' });
  });

  it('has-owner requires both spec.owner and an ownedBy relation', async () => {
    const withBoth = await runRetriever([makeEntity({ owner: 'team-a', ownedByRelation: true })]);
    expect(withBoth['has-owner']).toBe(true);

    const ownerOnly = await runRetriever([makeEntity({ owner: 'team-a' })]);
    expect(ownerOnly['has-owner']).toBe(false);

    const relationOnly = await runRetriever([makeEntity({ ownedByRelation: true })]);
    expect(relationOnly['has-owner']).toBe(false);
  });

  it('reads has-techdocs, has-health-probes, and has-runbook-url from their annotations', async () => {
    const facts = await runRetriever([makeEntity({
      annotations: {
        'backstage.io/techdocs-ref': 'dir:.',
        'backstage.io/kubernetes-id': 'hello-service',
        'backstage.io/runbook-url': 'https://runbooks/hello',
      },
    })]);
    expect(facts['has-techdocs']).toBe(true);
    expect(facts['has-health-probes']).toBe(true);
    expect(facts['has-runbook-url']).toBe(true);
  });

  it('uses-pinned-image-tag is false for an unset or "latest" tag, true otherwise', async () => {
    expect((await runRetriever([makeEntity({})]))['uses-pinned-image-tag']).toBe(false);
    expect((await runRetriever([makeEntity({ annotations: { 'backstage.io/image-tag': 'latest' } })]))['uses-pinned-image-tag']).toBe(false);
    expect((await runRetriever([makeEntity({ annotations: { 'backstage.io/image-tag': 'a3f1b2c' } })]))['uses-pinned-image-tag']).toBe(true);
  });

  it('has-contract-tests is true via the quality-gates annotation OR a providesApi relation', async () => {
    const viaGate = await runRetriever([makeEntity({ annotations: { 'idp.io/quality-gates': 'contract' } })]);
    expect(viaGate['has-contract-tests']).toBe(true);

    const viaRelation = await runRetriever([makeEntity({ relations: [{ type: 'providesApi' }] })]);
    expect(viaRelation['has-contract-tests']).toBe(true);
    expect(viaRelation['has-api-definition']).toBe(true);

    const neither = await runRetriever([makeEntity({})]);
    expect(neither['has-contract-tests']).toBe(false);
  });

  it('has-e2e-tests is true via the quality-gates annotation, an e2e-ish tag, or a consumesApi relation', async () => {
    expect((await runRetriever([makeEntity({ annotations: { 'idp.io/quality-gates': 'e2e' } })]))['has-e2e-tests']).toBe(true);
    expect((await runRetriever([makeEntity({ tags: ['playwright'] })]))['has-e2e-tests']).toBe(true);
    expect((await runRetriever([makeEntity({ relations: [{ type: 'consumesApi' }] })]))['has-e2e-tests']).toBe(true);
    expect((await runRetriever([makeEntity({})]))['has-e2e-tests']).toBe(false);
  });

  it('has-ai-observability requires both health probes AND the "ai" tag', async () => {
    const both = await runRetriever([makeEntity({
      annotations: { 'backstage.io/kubernetes-id': 'x' },
      tags: ['ai'],
    })]);
    expect(both['has-ai-observability']).toBe(true);

    const probesOnly = await runRetriever([makeEntity({ annotations: { 'backstage.io/kubernetes-id': 'x' } })]);
    expect(probesOnly['has-ai-observability']).toBe(false);

    const tagOnly = await runRetriever([makeEntity({ tags: ['ai'] })]);
    expect(tagOnly['has-ai-observability']).toBe(false);
  });

  it('has-sonar-scanning/has-snyk-scanning/has-trivy-scanning fall back to their tool-specific annotations', async () => {
    const facts = await runRetriever([makeEntity({
      annotations: {
        'sonarcloud.io/project-key': 'org_repo',
        'snyk.io/org-slug': 'acme',
        'github.com/project-slug': 'acme/hello-service',
      },
    })]);
    expect(facts['has-sonar-scanning']).toBe(true);
    expect(facts['has-snyk-scanning']).toBe(true);
    expect(facts['has-trivy-scanning']).toBe(true);
  });

  it('mobile scorecard facts (test coverage, crash reporting, UI tests, fastlane) are false for a non-mobile entity even with matching gates', async () => {
    const facts = await runRetriever([makeEntity({
      annotations: { 'idp.io/quality-gates': 'mobile-test-coverage,mobile-fastlane' },
      tags: ['appium'],
    })]);
    expect(facts['has-mobile-test-coverage']).toBe(false);
    expect(facts['has-mobile-ui-tests']).toBe(false);
    expect(facts['has-mobile-fastlane']).toBe(false);
  });

  it('mobile scorecard facts activate for spec.type === "mobile"', async () => {
    const facts = await runRetriever([makeEntity({
      specType: 'mobile',
      annotations: { 'idp.io/quality-gates': 'mobile-test-coverage,mobile-fastlane' },
      tags: ['appium'],
    })]);
    expect(facts['has-mobile-test-coverage']).toBe(true);
    expect(facts['has-mobile-ui-tests']).toBe(true);
    expect(facts['has-mobile-fastlane']).toBe(true);
  });

  it('has-min-sdk-version applies the Android floor (>=24) for non-iOS tags', async () => {
    const below = await runRetriever([makeEntity({ specType: 'mobile', annotations: { 'backstage.io/mobile-min-sdk': '21' } })]);
    expect(below['has-min-sdk-version']).toBe(false);

    const atFloor = await runRetriever([makeEntity({ specType: 'mobile', annotations: { 'backstage.io/mobile-min-sdk': '24' } })]);
    expect(atFloor['has-min-sdk-version']).toBe(true);
  });

  it('has-min-sdk-version applies the iOS floor (>=16.0) when tagged ios/swift/swiftui', async () => {
    const below = await runRetriever([makeEntity({
      specType: 'mobile', tags: ['ios'], annotations: { 'backstage.io/mobile-min-sdk': '15.0' },
    })]);
    expect(below['has-min-sdk-version']).toBe(false);

    const atFloor = await runRetriever([makeEntity({
      specType: 'mobile', tags: ['ios'], annotations: { 'backstage.io/mobile-min-sdk': '16.0' },
    })]);
    expect(atFloor['has-min-sdk-version']).toBe(true);
  });

  it('the mobile platform maturity facts require the annotation value to be exactly "true"', async () => {
    const notQuiteTrue = await runRetriever([makeEntity({
      specType: 'mobile',
      annotations: {
        'backstage.io/crashlytics-enabled': 'yes',
        'backstage.io/accessibility-tests': 'True',
        'backstage.io/code-signing-setup': '1',
      },
    })]);
    expect(notQuiteTrue['has-crashlytics-enabled']).toBe(false);
    expect(notQuiteTrue['has-accessibility-tests']).toBe(false);
    expect(notQuiteTrue['has-code-signing']).toBe(false);

    const exact = await runRetriever([makeEntity({
      specType: 'mobile',
      annotations: {
        'backstage.io/crashlytics-enabled': 'true',
        'backstage.io/accessibility-tests': 'true',
        'backstage.io/code-signing-setup': 'true',
      },
    })]);
    expect(exact['has-crashlytics-enabled']).toBe(true);
    expect(exact['has-accessibility-tests']).toBe(true);
    expect(exact['has-code-signing']).toBe(true);
  });

  it('has-app-size-budget is true for any non-empty annotation value', async () => {
    const facts = await runRetriever([makeEntity({
      specType: 'mobile',
      annotations: { 'backstage.io/app-size-budget-mb': '150' },
    })]);
    expect(facts['has-app-size-budget']).toBe(true);
  });

  it('the mobile platform maturity facts also activate for an entity tagged "mobile" even without spec.type', async () => {
    const facts = await runRetriever([makeEntity({
      tags: ['mobile'],
      annotations: { 'backstage.io/crashlytics-enabled': 'true' },
    })]);
    expect(facts['has-crashlytics-enabled']).toBe(true);
  });

  it('produces one fact record per entity', async () => {
    const retriever = getFactRetriever();
    mockGetEntities.mockResolvedValue({
      items: [makeEntity({ name: 'a' }), makeEntity({ name: 'b' })],
    });
    const auth = {
      getOwnServiceCredentials: jest.fn().mockResolvedValue({}),
      getPluginRequestToken: jest.fn().mockResolvedValue({ token: 'tok' }),
    };
    const facts = await retriever.handler({ discovery: {}, auth, entityFilter: [{ kind: 'Component' }] } as any);
    expect(facts).toHaveLength(2);
    expect(facts.map((f: any) => f.entity.name)).toEqual(['a', 'b']);
  });
});
