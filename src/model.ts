export type Column = 'backlog' | 'ready' | 'in-progress' | 'review' | 'done' | 'dropped';
export type SourceKind = 'v6-sprint' | 'v6-spec' | 'v7-initiative' | 'v7-parent' | 'v7-backlog';

export interface Epic {
  id: string; title: string; status?: string; retrospective?: 'optional' | 'done';
  quick?: true;           // the v6 lane holding quick-flow specs
}
export interface Story {
  key: string;            // unique within the board; used for detail lookup
  id: string;             // display id, e.g. "2.3"
  title: string;
  epicId: string | null;
  column: Column;
  rawStatus: string | null;
  unknownStatus?: string;
  blocked?: boolean;
  type?: string;          // v7: story, spike or bug; quick specs: their frontmatter type (feature, bug, ...)
  noFile?: true;          // nothing to open: no story/plan file (or v7 description) yet
  quick?: true;           // a v6 quick-flow spec (spec-*.md), not part of the sprint
}
export interface Notice { level: 'info' | 'warn' | 'error'; text: string }
export interface Board {
  sourceId: string; kind: SourceKind; label: string;
  epics: Epic[];          // in build/epic order
  stories: Story[];       // in build order
  notices: Notice[];
  children?: Board[];     // v7-parent only
}
export interface SourceRef {
  id: string; kind: SourceKind; label: string; path: string; // path = absolute folder/file the reader uses
  count: number; children?: SourceRef[];
}
export interface StoryDetail { path: string | null; markdown: string }
export interface ProjectPrefs {
  view: 'columns' | 'swimlanes';
  showDropped: boolean;
  sourceId: string | null;
}
export interface ProjectSummary {
  id: string; name: string; path: string; missing: boolean;
  tags: ('v6' | 'v7')[]; version: string | null;
  sources: SourceRef[]; defaultSourceId: string | null;
  error?: string;
  prefs?: ProjectPrefs;
  /** false: added from a browser, so the project's own scripts never run */
  trusted?: boolean;
}
