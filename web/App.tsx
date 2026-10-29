import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Board, Epic, ProjectPrefs, ProjectSummary, SourceRef, Story } from '../src/model.js';
import { api, ApiError, eventsUrl } from './api.js';
import { EpicChip } from './Card.js';
import { CardDetail } from './CardDetail.js';
import { ColumnsView } from './ColumnsView.js';
import { Sidebar } from './Sidebar.js';
import { SwimlaneView } from './SwimlaneView.js';

type View = ProjectPrefs['view'];

const flatSources = (sources: SourceRef[]): SourceRef[] =>
  sources.flatMap((s) => [s, ...flatSources(s.children ?? [])]);

function pickSource(p: ProjectSummary, wanted: string | null | undefined): string | null {
  const ids = new Set(flatSources(p.sources).map((s) => s.id));
  for (const id of [wanted, p.prefs?.sourceId, p.defaultSourceId]) if (id && ids.has(id)) return id;
  return p.sources[0]?.id ?? null;
}

const boardsOf = (b: Board): Board[] => (b.children && b.children.length > 0 ? b.children : [b]);
const hasDropped = (b: Board): boolean => [b, ...(b.children ?? [])].some((x) => x.stories.some((s) => s.column === 'dropped'));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function BoardBody(props: {
  board: Board; view: View; showDropped: boolean; epicFilter: string | null; onOpen: (s: Story, sourceId: string) => void;
}) {
  const { board, view } = props;
  const one = (b: Board) => (
    <>
      {b.notices.map((n, i) => <div key={i} class={`notice ${n.level}`} role={n.level === 'error' ? 'alert' : undefined}>{n.text}</div>)}
      {b.stories.length === 0 ? (
        <p class="muted empty">No stories in this board yet.</p>
      ) : view === 'columns' ? (
        <ColumnsView board={b} showDropped={props.showDropped} epicFilter={props.epicFilter} onOpen={props.onOpen} />
      ) : (
        <SwimlaneView board={b} showDropped={props.showDropped} onOpen={props.onOpen} />
      )}
    </>
  );
  if (!board.children || board.children.length === 0) return one(board);
  return (
    <>
      {board.notices.map((n, i) => <div key={i} class={`notice ${n.level}`}>{n.text}</div>)}
      {board.children.map((c) => (
        <section class="child-board" key={c.sourceId} aria-label={c.label}>
          <h2 class="child-title">{c.label}</h2>
          {one(c)}
        </section>
      ))}
    </>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [view, setView] = useState<View>('columns');
  const [showDropped, setShowDropped] = useState(false);
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  // a loaded board (or error) is tagged with the selection it belongs to, so a stale one is never shown
  const [loaded, setLoaded] = useState<{ key: string; board: Board | null; error: string | null } | null>(null);
  const [boardTick, setBoardTick] = useState(0);
  const [detail, setDetail] = useState<{ story: Story; sourceId: string } | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const initialised = useRef(false);

  const project = projects?.find((p) => p.id === selectedId) ?? null;
  const closeDetail = useCallback(() => setDetail(null), []);

  const select = useCallback((p: ProjectSummary, wantedSource?: string | null) => {
    setSelectedId(p.id);
    setSourceId(pickSource(p, wantedSource));
    setView(p.prefs?.view ?? 'columns');
    setShowDropped(p.prefs?.showDropped ?? false);
    setEpicFilter(null);
    setDetail(null);
    const url = new URL(location.href);
    url.searchParams.set('project', p.id);
    history.replaceState(null, '', url);
    api.setLastViewed(p.id).catch(() => {});
  }, []);

  const savePrefs = useCallback((id: string, prefs: Partial<ProjectPrefs>) => {
    setProjects((ps) => ps && ps.map((p) => (p.id === id ? { ...p, prefs: { ...(p.prefs ?? { view: 'columns', showDropped: false, sourceId: null }), ...prefs } } : p)));
    api.setPrefs(id, prefs).catch(() => {});
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const ps = await api.projects();
      setProjects(ps);
      setLoadError(null);
      const cur = ps.find((p) => p.id === selectedRef.current);
      if (!initialised.current) {
        // the initial load picks the selection
      } else if (cur) {
        setSourceId((s) => pickSource(cur, s));
      } else if (ps.length > 0) {
        select(ps[0]!);
      } else {
        setSelectedId(null);
        setSourceId(null);
      }
    } catch (e) {
      setLoadError(message(e));
    }
  }, [select]);

  // initial load: ?project= wins, then lastViewed, then the first project
  useEffect(() => {
    (async () => {
      try {
        const [ps, st] = await Promise.all([api.projects(), api.state().catch(() => ({ lastViewed: null }))]);
        setProjects(ps);
        const wanted = [new URLSearchParams(location.search).get('project'), st.lastViewed];
        const p = wanted.map((id) => ps.find((x) => x.id === id)).find((x) => x !== undefined) ?? ps[0];
        initialised.current = true;
        if (p) select(p);
      } catch (e) {
        initialised.current = true;
        setLoadError(message(e));
      }
    })();
  }, [select]);

  // live refresh
  useEffect(() => {
    const es = new EventSource(eventsUrl);
    es.addEventListener('change', (ev) => {
      try {
        const { projectId } = JSON.parse((ev as MessageEvent<string>).data) as { projectId?: string };
        if (projectId !== selectedRef.current) return;
      } catch {
        return;
      }
      setBoardTick((t) => t + 1);
      void refreshProjects();
    });
    es.addEventListener('projects', () => void refreshProjects());
    // after a reconnect, events may have been missed: refetch everything shown
    let connected = false;
    es.addEventListener('open', () => {
      if (connected) {
        setBoardTick((t) => t + 1);
        void refreshProjects();
      }
      connected = true;
    });
    return () => es.close();
  }, [refreshProjects]);

  // board for the current selection; the old one stays on screen while the same board is refetched
  const missing = project?.missing ?? false;
  const boardKey = selectedId && sourceId ? `${selectedId}\u0000${sourceId}` : null;
  useEffect(() => {
    if (!selectedId || !sourceId || !boardKey || missing) return;
    let live = true;
    api.board(selectedId, sourceId).then(
      (b) => live && setLoaded({ key: boardKey, board: b, error: null }),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 410) void refreshProjects();
        setLoaded({ key: boardKey, board: null, error: message(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [selectedId, sourceId, boardKey, missing, boardTick, refreshProjects]);
  const current = loaded !== null && loaded.key === boardKey ? loaded : null;
  const board = current?.board ?? null;
  const boardError = current?.error ?? null;

  const onSelectProject = (id: string) => {
    const p = projects?.find((x) => x.id === id);
    if (p && id !== selectedId) select(p);
  };
  const onSelectSource = (projectId: string, sid: string) => {
    const p = projects?.find((x) => x.id === projectId);
    if (!p) return;
    if (projectId !== selectedId) select(p, sid);
    else {
      setSourceId(sid);
      setEpicFilter(null);
    }
    savePrefs(projectId, { sourceId: sid });
  };
  const onAdded = (p: ProjectSummary) => {
    setProjects((ps) => (ps ? [...ps.filter((x) => x.id !== p.id), p] : [p]));
    select(p);
  };
  const onRemove = async (p: ProjectSummary) => {
    if (!confirm(`Remove "${p.name}" from the list? The folder is not touched.`)) return;
    try {
      await api.removeProject(p.id);
    } catch {
      // refetch below shows the real state
    }
    await refreshProjects();
  };
  const changeView = (v: View) => {
    setView(v);
    if (selectedId) savePrefs(selectedId, { view: v });
  };
  const changeDropped = (on: boolean) => {
    setShowDropped(on);
    if (selectedId) savePrefs(selectedId, { showDropped: on });
  };

  const boards = board ? boardsOf(board) : [];
  const epics: { epic: Epic; index: number }[] = [];
  const seenEpics = new Set<string>();
  for (const b of boards) {
    b.epics.forEach((epic, index) => {
      if (!seenEpics.has(epic.id)) {
        seenEpics.add(epic.id);
        epics.push({ epic, index });
      }
    });
  }
  const activeFilter = epicFilter !== null && seenEpics.has(epicFilter) ? epicFilter : null;
  const dropped = board ? hasDropped(board) : false;
  const source = project ? flatSources(project.sources).find((s) => s.id === sourceId) : undefined;

  return (
    <div class="app">
      <Sidebar projects={projects ?? []} selectedId={selectedId} sourceId={sourceId}
        onSelectProject={onSelectProject} onSelectSource={onSelectSource} onAdded={onAdded} onRemove={onRemove} />
      <main class="main">
        {loadError !== null && <div class="notice error" role="alert">Could not reach the server: {loadError}</div>}
        {projects !== null && projects.length === 0 && (
          <div class="placeholder">
            <h1>No projects yet</h1>
            <p>Add a BMAD project folder with “+ Add project”, or run <code>npx bmad-kanban</code> inside one.</p>
          </div>
        )}
        {project && (
          <>
            <header class="board-head">
              <h1 class="board-title">
                {project.name}
                {(board?.label ?? source?.label) && <span class="board-source"> / {board?.label ?? source?.label}</span>}
              </h1>
              {!project.missing && board && (
                <div class="controls">
                  <div class="toggle" role="group" aria-label="Board view">
                    <button type="button" aria-pressed={view === 'columns'} class={view === 'columns' ? 'on' : ''}
                      onClick={() => changeView('columns')}>Columns</button>
                    <button type="button" aria-pressed={view === 'swimlanes'} class={view === 'swimlanes' ? 'on' : ''}
                      onClick={() => changeView('swimlanes')}>Swimlanes</button>
                  </div>
                  {dropped && (
                    <label class="switch">
                      <input type="checkbox" checked={showDropped} onChange={(e) => changeDropped((e.target as HTMLInputElement).checked)} />
                      <span>Show dropped</span>
                    </label>
                  )}
                </div>
              )}
            </header>
            {view === 'columns' && board && epics.length > 0 && (
              <div class="filters" role="group" aria-label="Filter by epic">
                <span class="filters-label">Epics:</span>
                <button type="button" class={`filter${activeFilter === null ? ' on' : ''}`} aria-pressed={activeFilter === null}
                  onClick={() => setEpicFilter(null)}>All</button>
                {epics.map((e) => (
                  <button type="button" key={e.epic.id} class={`filter${activeFilter === e.epic.id ? ' on' : ''}`}
                    aria-pressed={activeFilter === e.epic.id} onClick={() => setEpicFilter(e.epic.id)}>
                    <EpicChip info={e} /> {e.epic.title}
                  </button>
                ))}
              </div>
            )}
            <div class="board">
              {project.missing ? (
                <div class="placeholder"><h2>Folder not found</h2><p><code>{project.path}</code> no longer exists.</p></div>
              ) : project.error !== undefined && project.sources.length === 0 ? (
                <div class="notice error">Could not read this project's BMAD config: {project.error}</div>
              ) : sourceId === null ? (
                <p class="muted empty">No boards found in this project yet.</p>
              ) : boardError !== null ? (
                <div class="notice error" role="alert">{boardError}</div>
              ) : board === null ? (
                <p class="muted empty">Loading…</p>
              ) : (
                <BoardBody board={board} view={view} showDropped={showDropped && dropped} epicFilter={activeFilter}
                  onOpen={(story, sid) => setDetail({ story, sourceId: sid })} />
              )}
            </div>
          </>
        )}
      </main>
      {detail && project && (
        <CardDetail projectId={project.id} sourceId={detail.sourceId} story={detail.story} onClose={closeDetail} />
      )}
    </div>
  );
}

