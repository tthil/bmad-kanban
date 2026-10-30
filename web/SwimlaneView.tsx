import type { Board, Story } from '../src/model.js';
import { Card } from './Card.js';
import { epicIndex, visibleColumns } from './ColumnsView.js';
import { COLUMN_LABELS, epicColor, swimlanes } from './grouping.js';

export function SwimlaneView(props: { board: Board; showDropped: boolean; onOpen: (s: Story, sourceId: string) => void }) {
  const { board } = props;
  const cols = visibleColumns(props.showDropped);
  const lanes = swimlanes(board, props.showDropped);
  const epics = epicIndex(board);
  return (
    <div class="lanes" style={{ gridTemplateColumns: `minmax(140px, 180px) repeat(${cols.length}, minmax(140px, 1fr))` }}>
      <div class="lane-corner" />
      {cols.map((c) => <h3 class="col-head" key={c}>{COLUMN_LABELS[c]}</h3>)}
      {lanes.map((lane) => {
        const info = lane.epic ? epics.get(lane.epic.id) : undefined;
        const pct = lane.total === 0 ? 0 : Math.round((lane.done / lane.total) * 100);
        return [
          <div class={`lane-head${lane.epic?.quick ? ' quick' : ''}`} key={`h-${lane.epic?.id ?? '-'}`}
            style={{ borderLeftColor: lane.epic?.quick ? 'var(--quick)' : info ? epicColor(info.index) : 'var(--muted)' }}>
            <div class="lane-title">
              {lane.epic?.quick ? lane.epic.title : lane.epic ? <>{lane.epic.id} {lane.epic.title}</> : 'No epic'}
            </div>
            <div class="lane-meta">
              {lane.epic?.quick && <span>outside the sprint</span>}
              {lane.epic?.status && <span>{lane.epic.status}</span>}
              {lane.epic?.retrospective === 'done' && <span class="retro-tag">✓ retro</span>}
              <span>{lane.done}/{lane.total} done</span>
            </div>
            <div class="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
              aria-label={`${lane.done} of ${lane.total} done`}>
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>,
          ...cols.map((c) => (
            <div class="cell" key={`${lane.epic?.id ?? '-'}-${c}`}>
              {lane.cells[c].map((s) => (
                <Card key={s.key} story={s} showEpic={false} epic={info ?? null}
                  onOpen={(st) => props.onOpen(st, board.sourceId)} />
              ))}
            </div>
          )),
        ];
      })}
    </div>
  );
}
