import { parse } from 'yaml';

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function readFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = FM.exec(text);
  if (!m) return { data: {}, body: text };
  let parsed: unknown;
  try {
    // a repeated key (e.g. a status line left behind by an edit) keeps its last value
    parsed = parse(m[1], { uniqueKeys: false });
  } catch (e) {
    throw new FrontmatterError(`Invalid YAML frontmatter: ${(e as Error).message}`);
  }
  if (parsed == null) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterError('Frontmatter must be a YAML mapping');
  }
  return { data: parsed as Record<string, unknown>, body: text.slice(m[0].length) };
}
