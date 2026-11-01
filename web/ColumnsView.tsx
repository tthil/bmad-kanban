import type { Board, Column, DoneSort, Story } from '../src/model.js';
import { Card, type EpicInfo } from './Card.js';
import { BOARD_COLUMNS, byColumn, COLUMN_LABELS, DONE_SORT_LABELS, isDoneSort } from './grouping.js';

export const epicIndex = (board: Board): Map<string, EpicInfo> =>
  new Map(board.epics.map((epic, index) => [epic.id, { epic, index }]));

export const visibleColumns = (showDropped: boolean): Column[] =>
  BOARD_COLUMNS.filter((c) => showDropped || c !== 'dropped');

/** The Done column's sort control. */
export function DoneSortSelect(props: { value: DoneSort; onChange: (v: DoneSort) => void }) {
  return (
    <select class="done-sort" aria-label="Sort done cards" value={props.value}
      onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (isDoneSort(v)) props.onChange(v); }}>
      {(Object.keys(DONE_SORT_LABELS) as DoneSort[]).map((k) => <option key={k} value={k}>{DONE_SORT_LABELS[k]}</option>)}
    </select>
  );
}

export function ColumnsView(props: {
  board: Board; showDropped: boolean; epicFilter: string | null; doneSort: DoneSort; onDoneSort: (v: DoneSort) => void;
  onOpen: (s: Story, sourceId: string) => void;
}) {
  const { board } = props;
  const cells = byColumn(board.stories, props.showDropped, props.epicFilter, props.doneSort);
  const epics = epicIndex(board);
  return (
    <div class="columns">
      {visibleColumns(props.showDropped).map((c) => (
        <section class={`column col-${c}`} key={c} aria-label={COLUMN_LABELS[c]}>
          <div class="col-top">
            <h3 class="col-head">{COLUMN_LABELS[c]} · {cells[c].length}</h3>
            {c === 'done' && <DoneSortSelect value={props.doneSort} onChange={props.onDoneSort} />}
          </div>
          {cells[c].map((s) => (
            <Card key={s.key} story={s} showEpic epic={s.epicId === null ? null : epics.get(s.epicId) ?? null}
              onOpen={(st) => props.onOpen(st, board.sourceId)} />
          ))}
        </section>
      ))}
    </div>
  );
}
