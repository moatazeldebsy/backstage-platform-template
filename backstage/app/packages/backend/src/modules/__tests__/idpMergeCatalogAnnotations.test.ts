import { mergeAnnotations } from '../idpMergeCatalogAnnotations';

const WITH_ANNOTATIONS = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payments-api
  description: Handles payments
  annotations:
    github.com/project-slug: acme/payments-api
    # a comment the owner wrote
    backstage.io/techdocs-ref: dir:.
  tags:
    - go
spec:
  type: service
`;

describe('mergeAnnotations', () => {
  it('inserts missing annotations at the existing indent', () => {
    const { content, added, skipped } = mergeAnnotations(WITH_ANNOTATIONS, {
      'datadoghq.com/monitor-tag': 'service:payments-api',
      'datadoghq.com/site': 'app.datadoghq.eu',
    });
    expect(added).toEqual(['datadoghq.com/monitor-tag', 'datadoghq.com/site']);
    expect(skipped).toEqual([]);
    expect(content).toContain('    datadoghq.com/monitor-tag: "service:payments-api"');
    expect(content).toContain('    datadoghq.com/site: "app.datadoghq.eu"');
  });

  it('never overwrites an annotation the owner already set', () => {
    const { content, added, skipped } = mergeAnnotations(WITH_ANNOTATIONS, {
      'github.com/project-slug': 'someone-else/wrong',
      'datadoghq.com/site': 'app.datadoghq.eu',
    });
    expect(skipped).toContain('github.com/project-slug');
    expect(added).toEqual(['datadoghq.com/site']);
    expect(content).toContain('github.com/project-slug: acme/payments-api');
    expect(content).not.toContain('someone-else/wrong');
  });

  it('leaves every other byte alone, including comments and ordering', () => {
    const { content } = mergeAnnotations(WITH_ANNOTATIONS, {
      'langfuse.com/service-name': 'payments-api',
    });
    expect(content).toContain('# a comment the owner wrote');
    expect(content).toContain('  tags:\n    - go');
    expect(content).toContain('spec:\n  type: service');
    // Only one line longer than the original.
    expect(content.split('\n').length).toBe(WITH_ANNOTATIONS.split('\n').length + 1);
  });

  it('creates the annotations block when the file has none', () => {
    const noAnn = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: bare
spec:
  type: service
`;
    const { content, added } = mergeAnnotations(noAnn, { 'langfuse.com/service-name': 'bare' });
    expect(added).toEqual(['langfuse.com/service-name']);
    expect(content).toContain('  annotations:\n    langfuse.com/service-name: "bare"');
    expect(content).toContain('spec:\n  type: service');
  });

  it('refuses to guess when there is no metadata block', () => {
    expect(() => mergeAnnotations('kind: Component\n', { a: 'b' })).toThrow(/no `metadata:` block/);
  });

  it('is a no-op when every annotation is already present', () => {
    const { content, added, skipped } = mergeAnnotations(WITH_ANNOTATIONS, {
      'backstage.io/techdocs-ref': 'dir:.',
    });
    expect(added).toEqual([]);
    expect(skipped).toEqual(['backstage.io/techdocs-ref']);
    expect(content).toBe(WITH_ANNOTATIONS);
  });

  it('quotes values so a colon or URL cannot break the YAML', () => {
    const { content } = mergeAnnotations(WITH_ANNOTATIONS, {
      'datadoghq.com/dashboard-url': 'https://app.datadoghq.eu/dashboard/abc-123',
    });
    expect(content).toContain(
      '    datadoghq.com/dashboard-url: "https://app.datadoghq.eu/dashboard/abc-123"',
    );
  });
});
