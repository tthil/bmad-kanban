import type { Board, Column, Story } from '../src/model.js';
import { Card, type EpicInfo } from './Card.js';
import { BOARD_COLUMNS, byColumn, COLUMN_LABELS } from './grouping.js';

export const epicIndex = (board: Board): Map<string, EpicInfo> =>
  new Map(board.epics.map((epic, index) => [epic.id, { epic, index }]));

export const visibleColumns = (showDropped: boolean): Column[] =>
  BOARD_COLUMNS.filter((c) => showDropped || c !== 'dropped');

export function ColumnsView(props: {
  board: Board; showDropped: boolean; epicFilter: string | null; onOpen: (s: Story, sourceId: string) => void;
}) {
  const { board } = props;
  const cells = byColumn(board.stories, props.showDropped, props.epicFilter);
  const epics = epicIndex(board);
  return (
    <div class="columns">
      {visibleColumns(props.showDropped).map((c) => (
        <section class={`column col-${c}`} key={c} aria-label={COLUMN_LABELS[c]}>
          <h3 class="col-head">{COLUMN_LABELS[c]} · {cells[c].length}</h3>
          {cells[c].map((s) => (
            <Card key={s.key} story={s} showEpic epic={s.epicId === null ? null : epics.get(s.epicId) ?? null}
              onOpen={(st) => props.onOpen(st, board.sourceId)} />
          ))}
        </section>
      ))}
    </div>
  );
}
