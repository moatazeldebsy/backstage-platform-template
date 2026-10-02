// The text helpers decide what gets embedded: stripHtml turns rendered TechDocs
// pages into the plain text sent to Voyage AI, truncate bounds each request,
// and vectorLiteral is the only thing standing between a float array and the
// `?::vector` cast in the pgvector query.
import { stripHtml, truncate, vectorLiteral } from '../idpRagSearch';

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<h1>Title</h1>\n\n  <p>Some <b>bold</b>\ttext</p>')).toBe('Title Some bold text');
  });

  it('keeps text between tags and drops attributes with them', () => {
    expect(stripHtml('<a href="https://x.invalid?a=1&b=2">link</a> after')).toBe('link after');
  });

  it('handles an unterminated tag by dropping the rest rather than leaking markup', () => {
    expect(stripHtml('visible <script src="x"')).toBe('visible');
  });

  it('stays linear on a large page (manual scan, not a super-linear regex)', () => {
    const page = `<div>${'x'.repeat(200_000)}${'<'.repeat(50_000)}</div>`;
    const start = Date.now();
    stripHtml(page);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('returns an empty string for markup-only input', () => {
    expect(stripHtml('<br/><hr>')).toBe('');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });

  it('cuts long text to the limit (2000 by default)', () => {
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('x'.repeat(2500))).toHaveLength(2000);
  });
});

describe('vectorLiteral', () => {
  it('formats an embedding as a pgvector literal', () => {
    expect(vectorLiteral([0.1, -2, 3.5e-7])).toBe('[0.1,-2,3.5e-7]');
  });

  it('formats an empty vector', () => {
    expect(vectorLiteral([])).toBe('[]');
  });
});
