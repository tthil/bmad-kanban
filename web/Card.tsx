import { useEffect, useRef, useState } from 'preact/hooks';
import type { Epic, Story } from '../src/model.js';
import { copyText, epicColor } from './grouping.js';

export interface EpicInfo { epic: Epic; index: number }

export function EpicChip({ info }: { info: EpicInfo }) {
  const { epic, index } = info;
  const retro = epic.retrospective === 'done';
  return (
    <span class="chip" style={{ background: epicColor(index) }} title={`Epic ${epic.id}: ${epic.title}${retro ? ' (retrospective done)' : ''}`}>
      {epic.id}
      {retro && <span class="retro" aria-label="retrospective done">✓</span>}
    </span>
  );
}

function FileIcon() {
  return (
    <svg class="card-file" viewBox="0 0 16 16" width="13" height="13" role="img" aria-label="has story file">
      <title>Has a story file</title>
      <path d="M4 1.5h5L12.5 5v9.5h-8.5z M9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
    </svg>
  );
}

function CopyButton({ story }: { story: Story }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText(story));
      setState('copied');
    } catch {
      setState('failed');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };

  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy';
  return (
    <button
      type="button"
      class={`card-copy${state !== 'idle' ? ` ${state}` : ''}`}
      onClick={copy}
      aria-label="Copy title"
      title={`Copy "${copyText(story)}"`}
    >
      <span aria-live="polite">{label}</span>
    </button>
  );
}

export function Card(props: { story: Story; epic: EpicInfo | null; showEpic: boolean; onOpen: (s: Story) => void }) {
  const { story: s, epic } = props;
  const cls = `card${s.column === 'dropped' ? ' dropped' : ''}${s.noFile ? ' no-file' : ''}`;
  const body = (
    <>
      <span class="card-top">
        {props.showEpic && epic && <EpicChip info={epic} />}
        <span class="card-id">{s.id}</span>
        {!s.noFile && <FileIcon />}
        {s.blocked && <span class="badge blocked">blocked</span>}
        {(s.type === 'spike' || s.type === 'bug') && <span class={`badge type-${s.type}`}>{s.type}</span>}
      </span>
      <span class="card-title">{s.title}</span>
      {s.unknownStatus !== undefined && <span class="badge unknown">unknown status: {s.unknownStatus}</span>}
    </>
  );
  return (
    <div class="card-wrap">
      {s.noFile
        ? <div class={cls}>{body}</div>
        : <button type="button" class={cls} onClick={() => props.onOpen(s)}>{body}</button>}
      <CopyButton story={s} />
    </div>
  );
}
