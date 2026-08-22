import { Entity } from '@backstage/catalog-model';
import { showLambdaTest, ANNOTATION } from './entityFilters';

const entity = (over: Partial<Entity['metadata']> & { type?: string }): Entity => {
  const { type, ...metadata } = over;
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'demo', ...metadata },
    spec: type ? { type } : {},
  } as Entity;
};

describe('showLambdaTest', () => {
  it('shows on an entity carrying the project annotation', () => {
    expect(
      showLambdaTest(entity({ annotations: { [ANNOTATION.LAMBDATEST_PROJECT]: 'checkout' } })),
    ).toBe(true);
  });

  it('shows on mobile and test-suite entities without any annotation', () => {
    expect(showLambdaTest(entity({ type: 'mobile' }))).toBe(true);
    expect(showLambdaTest(entity({ type: 'test-suite' }))).toBe(true);
  });

  it('shows on entities tagged for mobile or e2e work', () => {
    for (const tag of ['mobile', 'e2e', 'appium', 'playwright', 'devicefarm']) {
      expect(showLambdaTest(entity({ tags: [tag] }))).toBe(true);
    }
  });

  it('matches tags case-insensitively', () => {
    expect(showLambdaTest(entity({ tags: ['Playwright'] }))).toBe(true);
  });

  // Kinds other than Component reach the tag branch trivially — the mobile Domain,
  // the android-team Group and the scaffolder Templates are all tagged "mobile".
  it('hides on non-Component kinds even when they match on tags or type', () => {
    for (const kind of ['Domain', 'Group', 'System', 'Template', 'Resource']) {
      const e = { ...entity({ tags: ['mobile'], type: 'mobile' }), kind } as Entity;
      expect(showLambdaTest(e)).toBe(false);
    }
  });

  // The whole point of the predicate: a Terraform module or a plain backend
  // service must not grow a device-farm tab it can never populate.
  it('hides on unrelated entities', () => {
    expect(showLambdaTest(entity({ type: 'service' }))).toBe(false);
    expect(showLambdaTest(entity({ type: 'infrastructure', tags: ['terraform'] }))).toBe(false);
    expect(showLambdaTest(entity({}))).toBe(false);
  });
});
