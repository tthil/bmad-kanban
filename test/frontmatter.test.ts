import { describe, expect, it } from 'vitest';
import { FrontmatterError, readFrontmatter } from '../src/bmad/frontmatter.js';

describe('readFrontmatter', () => {
  it('parses frontmatter and body', () => {
    expect(readFrontmatter('---\nstatus: done\n---\n# T')).toEqual({ data: { status: 'done' }, body: '# T' });
  });
  it('handles CRLF', () => {
    expect(readFrontmatter('---\r\nstatus: done\r\n---\r\n# T')).toEqual({ data: { status: 'done' }, body: '# T' });
  });
  it('returns text untouched without frontmatter', () => {
    expect(readFrontmatter('# T')).toEqual({ data: {}, body: '# T' });
  });
  it('throws FrontmatterError on invalid YAML', () => {
    expect(() => readFrontmatter('---\na: [\n---\nx')).toThrow(FrontmatterError);
  });
  it('throws when frontmatter is not a mapping', () => {
    expect(() => readFrontmatter('---\n- a\n---\nx')).toThrow(FrontmatterError);
  });
});
