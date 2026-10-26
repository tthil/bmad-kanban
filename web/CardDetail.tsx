import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Story, StoryDetail } from '../src/model.js';
import { api } from './api.js';

/** Split leading YAML frontmatter off so marked doesn't render it as a heading. */
function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  return m ? { frontmatter: m[1]!, body: md.slice(m[0].length) } : { frontmatter: null, body: md };
}

export function CardDetail(props: { projectId: string; sourceId: string; story: Story; onClose: () => void }) {
  const { projectId, sourceId, story, onClose } = props;
  const [detail, setDetail] = useState<StoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    api.story(projectId, sourceId, story.key).then(
      (d) => live && setDetail(d),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, sourceId, story.key]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (!dialog.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  const copy = async () => {
    if (!detail?.path) return;
    try {
      await navigator.clipboard.writeText(detail.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const parts = detail ? splitFrontmatter(detail.markdown) : null;
  const html = parts ? DOMPurify.sanitize(marked.parse(parts.body, { async: false })) : '';

  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="detail-title" ref={dialog}>
        <header class="modal-head">
          <h2 id="detail-title"><span class="card-id">{story.id}</span> {story.title}</h2>
          <button type="button" class="icon-btn" ref={closeBtn} onClick={onClose} aria-label="Close">×</button>
        </header>
        <div class="modal-path">
          {detail === null ? null : detail.path === null ? (
            <span class="muted">No file yet</span>
          ) : (
            <>
              <code title={detail.path}>{detail.path}</code>
              <button type="button" class="small-btn" onClick={copy}>{copied ? 'Copied' : 'Copy path'}</button>
            </>
          )}
        </div>
        <div class="modal-body">
          {error !== null && <p class="notice error">{error}</p>}
          {detail === null && error === null && <p class="muted">Loading…</p>}
          {parts?.frontmatter && <pre class="frontmatter">{parts.frontmatter}</pre>}
          {detail !== null && <div class="markdown" dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      </div>
    </div>
  );
}
