import type { Epic, Story } from '../src/model.js';
import { epicColor } from './grouping.js';

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

export function Card(props: { story: Story; epic: EpicInfo | null; showEpic: boolean; onOpen: (s: Story) => void }) {
  const { story: s, epic } = props;
  return (
    <button type="button" class={`card${s.column === 'dropped' ? ' dropped' : ''}`} onClick={() => props.onOpen(s)}>
      <span class="card-top">
        {props.showEpic && epic && <EpicChip info={epic} />}
        <span class="card-id">{s.id}</span>
        {s.blocked && <span class="badge blocked">blocked</span>}
        {(s.type === 'spike' || s.type === 'bug') && <span class={`badge type-${s.type}`}>{s.type}</span>}
      </span>
      <span class="card-title">{s.title}</span>
      {s.unknownStatus !== undefined && <span class="badge unknown">unknown status: {s.unknownStatus}</span>}
    </button>
  );
}
