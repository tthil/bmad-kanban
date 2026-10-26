import { useState } from 'preact/hooks';
import type { ProjectSummary, SourceRef } from '../src/model.js';
import { api } from './api.js';

interface Props {
  projects: ProjectSummary[];
  selectedId: string | null;
  sourceId: string | null;
  onSelectProject: (id: string) => void;
  onSelectSource: (projectId: string, sourceId: string) => void;
  onAdded: (p: ProjectSummary) => void;
  onRemove: (p: ProjectSummary) => void;
}

const showSources = (p: ProjectSummary): boolean =>
  p.sources.length > 1 || p.sources.some((s) => (s.children?.length ?? 0) > 0);

function AddProject({ onAdded }: { onAdded: (p: ProjectSummary) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setPath('');
    setError(null);
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (path.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.addProject(path.trim());
      close();
      onAdded(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button type="button" class="add-btn" onClick={() => setOpen(true)}>+ Add project</button>;
  }
  return (
    <form class="add-form" onSubmit={submit}>
      <label for="add-path" class="sr-only">Project folder path</label>
      <input id="add-path" type="text" placeholder="/path/to/project" value={path} autoFocus
        onInput={(e) => setPath((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => e.key === 'Escape' && close()} />
      <div class="add-actions">
        <button type="submit" class="small-btn primary" disabled={busy}>Add</button>
        <button type="button" class="small-btn" onClick={close}>Cancel</button>
      </div>
      {error !== null && <p class="add-error" role="alert">{error}</p>}
    </form>
  );
}

function SourceItem(props: { project: ProjectSummary; source: SourceRef; selected: string | null; onSelect: Props['onSelectSource'] }) {
  const { project, source, selected } = props;
  return (
    <li>
      <button type="button" class={`source${selected === source.id ? ' on' : ''}`}
        aria-current={selected === source.id ? 'true' : undefined}
        onClick={() => props.onSelect(project.id, source.id)}>
        <span class="source-label">{source.label}</span>
        <span class="count">{source.count}</span>
      </button>
      {source.children && source.children.length > 0 && (
        <ul class="sources nested">
          {source.children.map((c) => (
            <SourceItem key={c.id} project={project} source={c} selected={selected} onSelect={props.onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar(props: Props) {
  return (
    <nav class="sidebar" aria-label="Projects">
      <div class="sidebar-head">
        <span class="brand">BMAD Kanban</span>
      </div>
      <AddProject onAdded={props.onAdded} />
      <ul class="projects">
        {props.projects.map((p) => {
          const on = p.id === props.selectedId;
          return (
            <li key={p.id} class={`project${on ? ' on' : ''}${p.missing ? ' missing' : ''}`}>
              <div class="project-row">
                <button type="button" class="project-btn" aria-current={on ? 'true' : undefined}
                  title={p.path} onClick={() => props.onSelectProject(p.id)}>
                  <span class="project-name">{p.name}</span>
                  {p.tags.map((t) => <span class="tag" key={t}>{t}</span>)}
                </button>
                <button type="button" class="icon-btn remove" aria-label={`Remove ${p.name} from the list`}
                  title="Remove from list" onClick={() => props.onRemove(p)}>×</button>
              </div>
              {p.missing && <div class="project-note">folder not found</div>}
              {p.error !== undefined && <div class="project-note error" title={p.error}>config error: {p.error}</div>}
              {!p.missing && showSources(p) && (
                <ul class="sources">
                  {p.sources.map((s) => (
                    <SourceItem key={s.id} project={p} source={s} selected={on ? props.sourceId : null}
                      onSelect={props.onSelectSource} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {props.projects.length === 0 && <p class="muted empty">No projects yet.</p>}
    </nav>
  );
}
