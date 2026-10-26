# BMAD Kanban — Design

Date: 2026-10-26
Status: draft for approval

## Intent

A read-only Kanban board for any project that uses the BMAD Method. You run one command, and a local web app shows every epic and story across your BMAD projects and where each one stands. It never changes project files: BMAD (and its agents) stay the only writers, and the board follows what they write.

It has to work for both BMAD v6 projects and the upcoming v7, and keep working as v7 evolves. It is published openly so any BMAD user can run it with `npx bmad-kanban`.

Prior art: [vscode-bmad-kanban](https://github.com/RianKhanafi/vscode-bmad-kanban). We take its useful ideas (status-to-column mapping, epic grouping from `sprint-status.yaml`, swimlanes) but not its VS Code dependency or its editing features, and it only understands v6 sprint mode.

## Goals

- See at a glance where every story stands, in any BMAD project, with zero setup in that project.
- Several projects in one app, switchable from a sidebar.
- Support all three BMAD story layouts (below), detected automatically.
- Survive BMAD v7 changes by reading v7 through BMAD's own script rather than re-implementing its format.
- Installable and runnable by anyone: `npx bmad-kanban`, public npm package, public GitHub repo (`tthil/bmad-kanban`).

## Non-goals

- Changing anything: no drag-and-drop, no status edits, no writes to any project file.
- Syncing with trackers (Jira, GitHub Issues, Linear, …). v7 has its own tracker integration.
- Hosting or multi-user access. It runs on `localhost` for one person.
- Being a VS Code (or any editor) extension.
- Stats, burndown, due dates, effort bars and the other extras in the reference project. Not now.

## Anti-goals (would make it a failure even if it works)

- It writes to, reformats, or "fixes" any file in a BMAD project.
- It silently picks one layout when a project contains two (e.g. half-migrated v6→v7) and hides the other's stories.
- It breaks every time BMAD v7 changes a file format, because it parsed v7 files itself.
- It needs per-project configuration before it shows anything.

## Constraints

- Runtime: Node.js (BMAD's installer already requires it). Target the current Node LTS.
- v7 projects need `uv` on the PATH, because v7's `tickets.py` runs through `uv`. BMAD v7 already requires `uv`, so this adds nothing for v7 users.
- Local only: bind to `127.0.0.1`.
- Read-only access to project folders.

## The three BMAD layouts

The app must detect and read each one. A project can contain more than one; show all, labelled by source.

All paths come from the project's merged BMAD config. Merge, in order: `_bmad/config.toml`, `_bmad/config.user.toml`, `_bmad/custom/config.toml`, `_bmad/custom/config.user.toml`. Substitute `{project-root}` with the folder containing `_bmad/`. Fallback when a v6 install only has YAML: `_bmad/bmm/config.yaml` and `_bmad/core/config.yaml`. The installed version is in `_bmad/_config/manifest.yaml` (`installation.version`). Use it as a label, not to choose readers: detect by what's on disk.

### 1. v6 sprint mode

- Status file: `{implementation_artifacts}/sprint-status.yaml`, key `development_status`, an ordered map.
  - `epic-N` keys are epic markers. Their value is the epic status: `backlog | in-progress | done`.
  - `N-M[a-z]?-slug` keys are stories: `backlog | ready-for-dev | in-progress | review | done`. Legacy values: `drafted` → `ready-for-dev`, `contexted` → `in-progress`.
  - `epic-N-retrospective` keys are retrospectives: `optional | done`. Show these on the epic, not as cards.
  - Ignore `action_items` and unknown keys.
- Epic titles come from epic files in `{planning_artifacts}` (`epics.md`, `epic-*.md`, or a sharded `epics/` folder): headings `## Epic N: Title` and `### Story N.M: Title`. If no epic file is found, use `Epic N`.
- Detection and story list (Claude's call): the project counts as v6 sprint mode when either `sprint-status.yaml` or an epic file exists. The story list is the union of both. A story only in the epic file (e.g. planning done, sprint planning not run yet) is Backlog. A story only in `sprint-status.yaml` uses its key as title. Order follows `sprint-status.yaml` when present, else the epic file.
- Story content: `{implementation_artifacts}/<story-key>.md` when the file exists. If it doesn't, the card has no detail view, only its title from the epic file.
- Reference implementation of this format: BMAD 6.12's `bmad-sprint-planning/scripts/sprint_plan.py` (its regexes are the ground truth for headings and keys).

### 2. v6 spec mode

- Spec folders: `{output_folder}/specs/spec-*/`, also checked under `{planning_artifacts}` and `{implementation_artifacts}` (same search the 6.12 retrospective skill uses).
- `stories.yaml` in a spec folder: an ordered list of `{id, title, description, …}`. It carries no status.
- Status: frontmatter `status` of `stories/<id>-*.md` in that spec folder. A story with no file is Backlog.
- One spec folder = one epic on the board. Its title comes from `SPEC.md`'s first heading, falling back to the folder name.

### 3. v7 ticket tree

- Store: `{output_folder}`. Initiatives are its child folders that contain `tickets/tickets.toml`, plus the special `backlog/` folder.
- Data source: run `uv run --no-project {project-root}/_bmad/method/scripts/tickets.py status <initiative-folder>` with the project root as the working directory, and parse its JSON. `--no-project` stops `uv` creating a `.venv` or `uv.lock` in projects that have a `pyproject.toml` (read-only rule). Each ticket row has `ref`, `id`, `title`, `type` (story | spike | bug), its epic, `status`, `tracker_status`, `state` (backlog | in-progress | review | done | dropped), and the file/plan paths. The initiative view adds an `epics` array in build order.
- Layout on disk (current v7): `<initiative>/tickets/tickets.toml` lists epics in build order (`[[epic]]` tables with `slug`). Each epic is a folder `<initiative>/tickets/<epic-slug>/` with its own `tickets/tickets.toml` (`[[entry]]` tables, in build order), and its plans and leaf files sit in that inner `tickets/` folder. An initiative with no epics has `[[entry]]` tables directly in `<initiative>/tickets/tickets.toml`, with plans beside it.
- Fallback when `tickets.py` is missing, `uv` is missing, or the call exits non-zero for any reason other than the older-layout refusal: read the `tickets.toml` files and frontmatter directly, following the layout above. A story's status is the `status` in `<type>-<slug>-plan.md` in its folder, else `status` in the leaf file `<type>-<slug>.md`, else none (Backlog). The board shows a visible "reduced fidelity" notice when the fallback is in use.
- Pre-release layout (Claude's call): `tickets.py` refuses trees from earlier v7 previews (`tickets.toml` and epic folders directly in the initiative folder, no `tickets/` folder) with an error naming `bmad migrate`. The board does not read those trees. It shows the initiative with a "uses a pre-release v7 layout — run `bmad migrate method`" message instead of cards. Those previews were never released, so this affects only early testers.
- Tracker stores (Claude's call): when a v7 project publishes tickets to a tracker, a ticket can carry `tracker_status` (the tracker's column, mirrored into the leaf file). When `tracker_status` is present, the board follows `state` from `tickets.py` (which already prefers the tracker), because that is the column the team sees. Otherwise it maps from the raw `status` per the table below.
- A parent initiative (its `tickets.toml` has `[[initiative]]` tables) is shown as a group of its child initiatives.
- Source documents for v7: BMAD main branch `tools/ticket-tree-rules.md`, `docs/plan/set-up-the-ticket-tree.md`, `skills/bmad-agent-po/assets/tickets-template.toml`, `skills/bmad-agent-po/scripts/tickets.py`.

## The app

### Starting and adding projects

- `npx bmad-kanban` (or the installed `bmad-kanban` command) run inside a BMAD project:
  - If the app isn't running, it starts the server, adds this project to the list, and opens the browser on it.
  - If it is already running, it adds this project to the running app and opens the browser on it. It does not start a second server.
- `bmad-kanban` run outside any BMAD project starts or opens the app on the last-viewed project.
- "+ Add project" in the sidebar takes a folder path. The folder must contain `_bmad/` (or a parent of it must).
- Projects can be removed from the list (this removes them from the app, never touches the folder).
- The project list and per-project UI preferences persist on the user's machine in a per-user config location, not in the projects.
- A project whose folder is gone stays in the list, greyed out, with a "folder not found" note.

### Layout

- **Sidebar:** projects, each with a v6/v7 tag. Under a project, one entry per board source, each with a story count:
  - each v7 initiative (a parent initiative is a group with its child initiatives under it; selecting the parent shows its children's boards stacked),
  - `Backlog` for v7's `backlog/` folder, when it has tickets (shown as one epic-less group),
  - `v6 sprint` and each v6 spec folder, when present.
  A v6-only project with a single source shows no sub-entries.
- **Selecting a project** opens its default source: the v7 `active_initiative` from merged config, else the first source in the list. Other sources are one click away and their counts are always visible, so nothing is hidden (Claude's recommendation).
- **Board:** for the selected source, with a toggle between two views. The choice is remembered per project.
  - **Status columns:** one column per status, each card with a coloured epic chip, and an epic filter in the header.
  - **Swimlanes:** one row per epic, in epic order, with a done/total progress bar. Columns are the statuses.
- **Card:** story id (e.g. `2.3`), title, epic chip. v7 `blocked` shows a red marker. v7 type spike or bug shows a small type tag.
- **Card detail:** clicking a card opens the story's markdown, rendered read-only, plus its absolute file path with a copy button. For v7, show the plan file if it exists, else the leaf file, else the entry's description and verify line from `tickets.toml`.
- **Live refresh:** when files under the project's BMAD folders change, the open board updates within ~2 seconds without a page reload.

### Columns and status mapping

| Column | v6 sprint | v6 spec (frontmatter) | v7 `status` |
|---|---|---|---|
| Backlog | `backlog`, no status | none, `draft`, `backlog` | none, `draft` |
| Ready | `ready-for-dev` (+ legacy `drafted`) | `ready-for-dev` | `ready-for-dev` |
| In progress | `in-progress` (+ legacy `contexted`) | `in-progress` | `in-progress`, `blocked` (red marker) |
| Review | `review` | `review`, `in-review` | `in-review`, `built` |
| Done | `done` | `done` | `done` |
| (hidden) | — | — | `dropped`, behind a "show dropped" switch |

Note: v7's own `state` folds `draft` and `ready-for-dev` into one `backlog` state. We map from the raw `status` instead, so Ready stays a separate column. Any unknown status value goes to Backlog with an "unknown status: X" badge, never dropped.

### Mixed layouts

If a project has more than one layout on disk (typically mid-migration), every source appears as its own sidebar entry with its story count, and the project shows both v6 and v7 tags. Nothing is merged or deduplicated across sources.

## Distribution

- npm package `bmad-kanban` (name is free as of 2026-10-26), `bin: bmad-kanban`.
- Public GitHub repo `tthil/bmad-kanban`, MIT license (builder's call; see below).
- No BMad Builder module now. v7 changes how modules and skills install (`npx skills add`, `bmod.toml`), so a Builder 2.2.2 module would likely need rework. Later, once v7's format is stable, a thin BMAD skill can just run `npx bmad-kanban`.

## Testing

- Fixture projects for each layout: v6 sprint, v6 spec, v7 initiative (with and without epics), v7 parent initiative, a mixed v6+v7 project, a broken or missing file.
- Reader tests run against those fixtures. The v7 reader is tested both through a real `tickets.py` (vendored copy pinned in the fixtures, run if `uv` is available) and through the fallback path.
- Read-only guarantee: a test that snapshots every fixture before and after a full run and asserts nothing changed.

## Decided by the user

- Read-only; no editing.
- v6 and v7 both supported.
- Local web app, not a VS Code extension.
- Several projects in one app, sidebar switcher (option A).
- Board has both status-column and swimlane views, with a toggle.
- Public open-source package anyone can use.

## Calls made by Claude (review these)

- Node.js runtime; `uv` needed only for v7.
- Reading v7 through `tickets.py status`, with a file-reading fallback.
- Column set Backlog / Ready / In progress / Review / Done, and the mapping above.
- Running the command inside a project adds it and opens the app; a single shared server.
- Missing project folders stay greyed out; dropped v7 stories hidden behind a switch; retrospectives shown on the epic.
- MIT license; npm name `bmad-kanban`.
- Selecting a project opens its active initiative; every other source (initiatives, v7 backlog, v6 sources) is its own sidebar entry with a count. The user asked for this recommendation; it's not yet confirmed.
- v6 sprint detection triggers on either `sprint-status.yaml` or an epic file; the story list is the union of both.
- v7 pre-release tree layouts get a "run `bmad migrate method`" message, not a board.
- v7 tracker stores: follow `tickets.py`'s `state` when `tracker_status` is present.
- `uv run --no-project` so the board never creates files in a project.
- No BMad Builder module for now.

## Left to the builder

- Frontend and backend frameworks, bundling, port choice and how the CLI finds a running instance.
- Where the per-user config lives (follow platform conventions).
- File-watching mechanism and debounce.
- Visual design, colours for epic chips, empty states.
- Markdown rendering library.
