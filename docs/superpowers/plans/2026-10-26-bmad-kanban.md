# BMAD Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, local web Kanban board (`npx bmad-kanban`) that shows epics and stories from any number of BMAD v6 and v7 projects.

**Architecture:** A Node/TypeScript backend with one reader per BMAD layout (v6 sprint, v6 spec, v7 ticket tree via BMAD's `tickets.py` with a file fallback). The readers all produce one `Board` model. A small `node:http` server exposes the boards as JSON plus a Server-Sent-Events stream driven by a file watcher. A Preact single-page app renders the sidebar, the two board views and the card detail. A CLI starts or reuses a single per-user server instance.

**Tech Stack:** Node ≥ 22, TypeScript, `vitest`, `yaml`, `smol-toml`, `chokidar` v4, `env-paths`, `open`; frontend Preact + Vite, `marked` + `dompurify`; Playwright for one end-to-end smoke test.

**Spec:** `docs/superpowers/specs/2026-10-26-bmad-kanban-design.md`

## Global Constraints

- Never write, create, rename or delete anything inside a registered project folder. The only writable location is the per-user config dir (`env-paths('bmad-kanban').config`).
- v7 script call is exactly: `uv run --no-project <projectRoot>/_bmad/method/scripts/tickets.py status <initiativeAbsPath>`, cwd = projectRoot, 10 s timeout.
- Server binds `127.0.0.1` only. Reject any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard). Mutating endpoints require `Content-Type: application/json`.
- Clients never send file paths for reading. Story detail is looked up by `storyKey` through the reader, and the resolved path must sit inside the project root.
- Columns, in order: `backlog`, `ready`, `in-progress`, `review`, `done`; `dropped` is hidden unless "show dropped" is on.
- Unknown status → column `backlog` with `unknownStatus` set; never dropped.
- Board refreshes within ~2 s of a file change (watch debounce 300 ms).
- Package name `bmad-kanban`, bin `bmad-kanban`, license MIT, `engines.node >=22`.

## Review Focus

- A malformed `sprint-status.yaml` / `tickets.toml` / frontmatter in one source → that source shows an error notice; other sources and projects still load (tests in Tasks 3, 4, 5, 7).
- `uv` absent, `tickets.py` absent, or the script exits non-zero/time-outs → fallback reader with the "reduced fidelity" notice; exit with the pre-release refusal → the migrate message (Task 6).
- A registered project folder deleted or moved while the app runs → it greys out, with no crash and no 500 errors on its board endpoint (Tasks 8, 9).
- A second `bmad-kanban` started while one runs, or a stale lock file left by a crashed server → it reuses the live one, or replaces the stale one (Task 10).
- Story files edited in bursts (an agent rewriting many files) → one refresh per burst, and the board never shows a half-parsed state (Task 9).

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, vitest.config.ts, LICENSE, README.md
src/
  model.ts                 Board/Story/Epic/SourceRef/ProjectSummary types
  status.ts                raw status → Column mapping per layout
  bmad/config.ts           merged BMAD config for a project root
  bmad/frontmatter.ts      split + parse YAML frontmatter from markdown
  readers/v6Sprint.ts      v6 sprint mode
  readers/v6Spec.ts        v6 spec folders
  readers/v7Tree.ts        v7 file reader (fallback) + layout helpers
  readers/v7Script.ts      v7 via tickets.py, falls back to v7Tree
  readers/detect.ts        listSources / readBoard / getStoryDetail dispatch
  registry.ts              persisted project list + per-project prefs
  server/app.ts            HTTP routes + SSE
  server/watch.ts          chokidar watcher per project → change events
  instance.ts              lock file, find/start running server
  cli.ts                   bin entry
web/
  index.html, main.tsx, api.ts, App.tsx, Sidebar.tsx,
  ColumnsView.tsx, SwimlaneView.tsx, Card.tsx, CardDetail.tsx,
  grouping.ts (pure), styles.css
test/
  fixtures/<name>/...      one fake BMAD project per case (Task 2 onward)
  *.test.ts                unit tests per src module
  e2e/smoke.spec.ts        Playwright
.github/workflows/ci.yml
```

## Shared types (`src/model.ts`, Task 1)

```ts
export type Column = 'backlog' | 'ready' | 'in-progress' | 'review' | 'done' | 'dropped';
export type SourceKind = 'v6-sprint' | 'v6-spec' | 'v7-initiative' | 'v7-parent' | 'v7-backlog';

export interface Epic { id: string; title: string; status?: string; retrospective?: 'optional' | 'done' }
export interface Story {
  key: string;            // unique within the board; used for detail lookup
  id: string;             // display id, e.g. "2.3"
  title: string;
  epicId: string | null;
  column: Column;
  rawStatus: string | null;
  unknownStatus?: string;
  blocked?: boolean;
  type?: 'story' | 'spike' | 'bug';
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
export interface ProjectSummary {
  id: string; name: string; path: string; missing: boolean;
  tags: ('v6' | 'v7')[]; version: string | null;
  sources: SourceRef[]; defaultSourceId: string | null;
}
```

---

### Task 1: Scaffold, shared types, status mapping

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE` (MIT, "tthil"), `src/model.ts` (exactly as above), `src/status.ts`
- Test: `test/status.test.ts`

**Interfaces:**
- Produces: `mapStatus(layout: 'v6-sprint' | 'v6-spec' | 'v7', raw: string | null | undefined): { column: Column; blocked?: boolean; unknownStatus?: string }`
- Produces: `mapV7State(state: string): Column` (`backlog|in-progress|review|done|dropped` → same-named column)
- Produces: `COLUMNS: Column[]` = `['backlog','ready','in-progress','review','done']`

- [ ] **Step 1: Scaffold.** `package.json` with `"type": "module"`, `bin: {"bmad-kanban": "dist/cli.js"}`, `engines.node ">=22"`, `files: ["dist"]`, scripts `build` (`tsc -p . && vite build`), `test` (`vitest run`), `test:e2e` (`playwright test`). TS `strict`, `module`/`moduleResolution` `NodeNext`, outDir `dist`, rootDir `src`.

- [ ] **Step 2: Write the failing test** `test/status.test.ts`, table-driven:

```ts
const cases: [Layout, string | null, Column, object?][] = [
  ['v6-sprint', 'backlog', 'backlog'], ['v6-sprint', null, 'backlog'],
  ['v6-sprint', 'ready-for-dev', 'ready'], ['v6-sprint', 'drafted', 'ready'],
  ['v6-sprint', 'in-progress', 'in-progress'], ['v6-sprint', 'contexted', 'in-progress'],
  ['v6-sprint', 'review', 'review'], ['v6-sprint', 'done', 'done'],
  ['v6-spec', 'draft', 'backlog'], ['v6-spec', 'in-review', 'review'], ['v6-spec', 'ready-for-dev', 'ready'],
  ['v7', '', 'backlog'], ['v7', 'draft', 'backlog'], ['v7', 'ready-for-dev', 'ready'],
  ['v7', 'blocked', 'in-progress', { blocked: true }], ['v7', 'built', 'review'],
  ['v7', 'in-review', 'review'], ['v7', 'dropped', 'dropped'], ['v7', 'done', 'done'],
  ['v6-sprint', 'wibble', 'backlog', { unknownStatus: 'wibble' }],
];
test.each(cases)('%s %s → %s', (layout, raw, column, extra = {}) =>
  expect(mapStatus(layout, raw)).toEqual({ column, ...extra }));
test('v7 state', () => expect(mapV7State('review')).toBe('review'));
```

Also map `in progress`/`IN-PROGRESS` the same as `in-progress` (trim + lowercase + spaces → dashes before lookup).

- [ ] **Step 3: Run** `npx vitest run test/status.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement** `src/status.ts` as lookup tables per layout, from the spec's mapping table.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat: scaffold package, shared model and status mapping`.

---

### Task 2: BMAD config loader + frontmatter helper

**Files:**
- Create: `src/bmad/config.ts`, `src/bmad/frontmatter.ts`
- Create fixtures: `test/fixtures/v6-sprint/_bmad/{config.toml,_config/manifest.yaml}`, `test/fixtures/v6-yaml/_bmad/{bmm/config.yaml,core/config.yaml}`, `test/fixtures/v7/_bmad/{config.toml,custom/config.toml,custom/config.user.toml}`
- Test: `test/config.test.ts`, `test/frontmatter.test.ts`

**Interfaces:**
- Produces: `findProjectRoot(start: string): string | null` (nearest ancestor-or-self containing `_bmad/`)
- Produces: `loadBmadConfig(root: string): BmadConfig` where
  `interface BmadConfig { root: string; outputFolder: string; planningArtifacts: string; implementationArtifacts: string; activeInitiative: string | null; version: string | null }`. All paths are absolute.
- Produces: `readFrontmatter(text: string): { data: Record<string, unknown>; body: string }` (no frontmatter → `{data:{}, body:text}`; invalid YAML → throws `FrontmatterError`)

- [ ] **Step 1: Fixtures.**
  - `v6-sprint/_bmad/config.toml`: `[core] output_folder = "{project-root}/_bmad-output"`, `[modules.bmm] planning_artifacts = "{project-root}/_bmad-output/planning-artifacts"`, `implementation_artifacts = "{project-root}/_bmad-output/implementation-artifacts"`. `manifest.yaml`: `installation: { version: 6.12.4 }`.
  - `v6-yaml`: only YAML files with `output_folder: "{project-root}/out"` and `implementation_artifacts: "{project-root}/out/impl"`.
  - `v7/_bmad/config.toml`: `[core] output_folder = "{project-root}/_bmad-output"`. `custom/config.toml` overrides it to `"{project-root}/store"`. `custom/config.user.toml`: `[core] active_initiative = "initiative-checkout"`.
- [ ] **Step 2: Failing tests.**
  - `v6-sprint`: `outputFolder` = `<root>/_bmad-output`, `implementationArtifacts` = `<root>/_bmad-output/implementation-artifacts`, `version` = `'6.12.4'`, `activeInitiative` null.
  - `v6-yaml`: `implementationArtifacts` = `<root>/out/impl`, and `planningArtifacts` defaults to `<outputFolder>/planning-artifacts`.
  - `v7`: `outputFolder` = `<root>/store` (custom wins), `activeInitiative` = `'initiative-checkout'`.
  - `findProjectRoot('<fixture>/_bmad-output/x')` returns the fixture root.
  - frontmatter: `'---\nstatus: done\n---\n# T'` → `{data:{status:'done'}, body:'# T'}`; no frontmatter; invalid YAML throws.
- [ ] **Step 3: Run** `npx vitest run test/config.test.ts test/frontmatter.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Merge order: `_bmad/config.toml` → `_bmad/config.user.toml` → `_bmad/custom/config.toml` → `_bmad/custom/config.user.toml` (deep merge of tables; missing files skipped). If no TOML exists, read `_bmad/core/config.yaml` then `_bmad/bmm/config.yaml`. Keys: `core.output_folder`, `core.active_initiative`, `modules.bmm.planning_artifacts`, `modules.bmm.implementation_artifacts` (YAML: top-level keys of the same names). Defaults: output `<root>/_bmad-output`, planning `<output>/planning-artifacts`, impl `<output>/implementation-artifacts`. Replace `{project-root}` with root, then `path.resolve`.
- [ ] **Step 5: Run** again. Expected: PASS.
- [ ] **Step 6: Commit** `feat: load merged BMAD config and frontmatter`.

---

### Task 3: v6 sprint reader

**Files:**
- Create: `src/readers/v6Sprint.ts`
- Fixtures: `test/fixtures/v6-sprint/_bmad-output/planning-artifacts/epics.md`, `.../implementation-artifacts/{sprint-status.yaml,1-1-user-login.md}`; `test/fixtures/v6-planning-only/` (config + `epics.md`, no status file); `test/fixtures/v6-broken/` (status file `development_status: [unclosed`)
- Test: `test/v6Sprint.test.ts`

**Interfaces:**
- Consumes: `BmadConfig`, `mapStatus`
- Produces: `detectV6Sprint(cfg: BmadConfig): boolean` (true if `sprint-status.yaml` or an epic file exists)
- Produces: `readV6Sprint(cfg: BmadConfig, sourceId: string): Board` (kind `v6-sprint`, label `v6 sprint`)
- Produces: `v6SprintDetailPath(cfg: BmadConfig, storyKey: string): string | null`

- [ ] **Step 1: Fixtures.** `epics.md`:
  ```
  ## Epic 1: Accounts
  ### Story 1.1: User login
  ### Story 1.2: Password reset
  ## Epic 2: Plants
  ### Story 2.1: Plant data model
  ```
  `sprint-status.yaml` `development_status`: `epic-1: in-progress`, `1-1-user-login: done`, `1-2-password-reset: contexted`, `epic-1-retrospective: optional`, `epic-2: backlog`, `2-1-plant-data-model: ready-for-dev`, `2-9-orphan-story: review`. Add `action_items: [...]`, which must be ignored.
- [ ] **Step 2: Failing tests.**
  - `epics` = `[{id:'1',title:'Accounts',status:'in-progress',retrospective:'optional'},{id:'2',title:'Plants',status:'backlog'}]`.
  - Story `1-1-user-login`: `id '1.1'`, title `'User login'`, column `done`. `1-2-password-reset` → `in-progress`. `2-9-orphan-story` → title `'2-9-orphan-story'`, epicId `'2'`, column `review`. Order follows the status file.
  - No story with a key containing `retrospective` or `epic-`.
  - `v6-planning-only`: `detectV6Sprint` true; 3 stories, all `backlog`, in epic-file order.
  - `v6-broken`: `readV6Sprint` returns stories from `epics.md` and one `error` notice whose text contains `sprint-status.yaml`. It does not throw.
  - `v6SprintDetailPath(cfg,'1-1-user-login')` ends with `1-1-user-login.md`; for `1-2-password-reset` it returns null.
  - Sharded epics: a fixture `epics/epic-1.md` + `epics/epic-2.md` parses the same as `epics.md`.
- [ ] **Step 3: Run** `npx vitest run test/v6Sprint.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Epic files in `planningArtifacts`: `epics.md`, `epic-*.md`, `epics/*.md` (sorted). Heading regexes copied from BMAD 6.12 `sprint_plan.py`: epic `^#{1,3}\s*Epic\s+(\d+)\s*:?\s*(.*?)\s*#*\s*$` (i), story `^#{2,4}\s*Story\s+(\d+)\.(\d+)([a-z]?)\s*:?\s*(.*?)\s*#*\s*$` (i). Skip fenced code blocks. Story key = `${e}-${s}${suffix}-${kebab(title)}`. Status keys: `^epic-(\d+)$`, `^epic-(\d+)-retrospective$`, `^(\d+)-(\d+)([a-z]?)-.+`. Parse YAML with `yaml` (map order preserved). Union: status-file order first, then epic-file stories missing from it.
- [ ] **Step 5: Run** again. Expected: PASS.
- [ ] **Step 6: Commit** `feat: read v6 sprint-mode boards`.

---

### Task 4: v6 spec reader

**Files:**
- Create: `src/readers/v6Spec.ts`
- Fixtures: `test/fixtures/v6-spec/` (config + `_bmad-output/specs/spec-checkout/{SPEC.md,stories.yaml,stories/1-add-to-cart.md,stories/2-apply-discount.md}`, + `_bmad-output/specs/spec-broken/stories.yaml` containing `- id: [`)
- Test: `test/v6Spec.test.ts`

**Interfaces:**
- Produces: `findSpecFolders(cfg: BmadConfig): string[]`, absolute paths to `spec-*` folders that contain `stories.yaml`, found under `outputFolder/specs`, `planningArtifacts`, `implementationArtifacts`; de-duplicated and sorted
- Produces: `readV6Spec(folder: string, sourceId: string): Board` (kind `v6-spec`, label = SPEC.md first `# ` heading or folder name; a single epic with id = folder name)
- Produces: `v6SpecDetailPath(folder: string, storyKey: string): string | null`

- [ ] **Step 1: Fixtures.** `SPEC.md` starts `# Checkout`. `stories.yaml` has ids `"1"`, `"2"`, `"3"`. `1-add-to-cart.md` frontmatter `status: in-progress`; `2-apply-discount.md` `status: done`; no file for 3.
- [ ] **Step 2: Failing tests.** Label `Checkout`. Stories in list order: `1` → `in-progress`, `2` → `done`, `3` → `backlog`. `story.key` = id. The detail path for `1` ends with `stories/1-add-to-cart.md`. `spec-broken` → board with zero stories and one `error` notice; it does not throw. A story file named `10-x.md` must not match id `1` (match `^<id>-`, and the prefix-free rule guarantees uniqueness).
- [ ] **Step 3: Run** `npx vitest run test/v6Spec.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: read v6 spec-folder boards`.

---

### Task 5: v7 file reader (fallback) and layout helpers

**Files:**
- Create: `src/readers/v7Tree.ts`
- Fixtures under `test/fixtures/v7/store/` (output folder from Task 2):
  - `initiative-checkout/initiative-checkout.md`; `tickets/tickets.toml` with `[[epic]]` id 1 slug `epic-pricing-rules` title "Pricing rules", id 2 slug `epic-cart-rules` title "Cart rules" (no folder yet)
  - `initiative-checkout/tickets/epic-pricing-rules/epic-pricing-rules.md`; `tickets/tickets.toml` with entries `1` "Pricing function" (story), `2` "Tax rules" (story), `3` "Spike: rounding" (spike), `4` "Old idea" (story); `story-pricing-function-plan.md` (`ticket: 1`, `status: built`); `story-tax-rules.md` (leaf, `id: 2`) + `story-tax-rules-plan.md` (`ticket: 2`, `status: blocked`); `story-old-idea-plan.md` (`ticket: 4`, `status: dropped`)
  - `initiative-flat/initiative-flat.md`; `tickets/tickets.toml` with entries `1` "Only story", and `story-only-story-plan.md` `status: in-progress`
  - `backlog/bug-checkout-total.md` (frontmatter `type: bug`, `title: "Checkout total ignores codes"`, `status: ready-for-dev`)
  - `initiative-old/initiative-old.md` + `initiative-old/tickets.toml` (pre-release layout: no `tickets/` folder)
  - `initiative-parent/tickets/tickets.toml` with `[[initiative]]` ids 1 → slug `initiative-checkout`, 2 → slug `initiative-flat`
- Test: `test/v7Tree.test.ts`

**Interfaces:**
- Produces: `type V7FolderKind = 'initiative' | 'parent' | 'backlog' | 'pre-release'`
- Produces: `listV7Folders(cfg: BmadConfig): { path: string; name: string; kind: V7FolderKind }[]`: children of `outputFolder` that have `tickets/tickets.toml` (kind `parent` when it holds `[[initiative]]` tables), `backlog/` with ≥1 `.md`, or that have a `tickets.toml` directly (kind `pre-release`). Sorted by name, backlog last.
- Produces: `readV7Tree(folder: string, kind: V7FolderKind, sourceId: string): Board`
- Produces: `findV7Plan(ticketsDir: string, id: string): string | null` (scans `*-plan.md` for frontmatter `ticket` equal to id, compared as strings)
- Produces: `v7DetailPath(folder: string, storyKey: string): string | null` (plan → leaf file → null)
- Produces: `v7EntryText(folder: string, storyKey: string): string | null` (`description` + `Verify: <verify>` from the entry, used when no file exists)
- Story keys: `<epicSlug or initiative folder name>/<id>`; display id `<epicId>.<id>` (`<id>` when there are no epics).

- [ ] **Step 1: Fixtures** as listed above.
- [ ] **Step 2: Failing tests** for `readV7Tree(initiative-checkout)`:
  - epics `[{id:'1',title:'Pricing rules'},{id:'2',title:'Cart rules'}]`.
  - `1.1` column `review` (built). `1.2` column `in-progress` with `blocked: true`. `1.3` type `spike`, column `backlog`. `1.4` column `dropped`.
  - Leaf frontmatter `status` is used only when no plan exists: fixture `story-legacy.md` with `id: 5`, `status: done`, no plan → `done`.
  - `initiative-flat`: no epics, story `1` (`epicId` null) column `in-progress`.
  - `backlog`: one story, type `bug`, title "Checkout total ignores codes", column `ready`.
  - `pre-release`: zero stories, notice `{level:'warn', text: contains 'bmad migrate method'}`.
  - `parent`: `children` has two boards with labels `initiative-checkout`, `initiative-flat`.
  - Every board read by this module has notice `{level:'info', text: contains 'reduced fidelity'}`, except backlog and pre-release.
  - Malformed `tickets.toml` → `error` notice; no throw.
  - `v7DetailPath(checkout,'epic-pricing-rules/2')` ends with `story-tax-rules-plan.md`; for `epic-pricing-rules/3` it returns null; `v7EntryText` for `/3` contains the entry's description.
- [ ] **Step 3: Run** `npx vitest run test/v7Tree.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Parse TOML with `smol-toml`. Epic order from the initiative's `[[epic]]` tables, then any `tickets/epic-*` folder not listed (sorted). An epic without a folder shows with no stories. Leaf files join to entries by frontmatter `id`.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: read v7 ticket trees from files`.

---

### Task 6: v7 reader via `tickets.py`

**Files:**
- Create: `src/readers/v7Script.ts`
- Fixture: copy BMAD main's `skills/bmad-agent-po/scripts/tickets.py` to `test/fixtures/v7/_bmad/method/scripts/tickets.py`, with a header comment giving the source commit SHA.
- Test: `test/v7Script.test.ts`

**Interfaces:**
- Consumes: `readV7Tree`, `mapStatus`, `mapV7State`, `BmadConfig`
- Produces: `readV7(cfg: BmadConfig, folder: string, kind: V7FolderKind, sourceId: string, run?: RunScript): Promise<Board>`
- Produces: `type RunScript = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>` (default uses `child_process.execFile`)

- [ ] **Step 1: Failing tests** (the injected `run` fake drives them):
  - The fake returns code 0 and JSON `{tickets:[{epic:'epic-pricing-rules',id:1,type:'story',title:'Pricing function',status:'built',tracker_status:'',state:'review'}, {…id:2,status:'ready-for-dev',tracker_status:'',state:'backlog'}, {…id:3,status:'',tracker_status:'In Progress',state:'in-progress'}], epics:[{slug:'epic-pricing-rules',id:1}]}` → columns `review`, `ready` (raw status wins), `in-progress` (tracker_status present → state). No "reduced fidelity" notice. Epic titles come from `tickets.toml`.
  - The fake asserts it was called with `('uv', ['run','--no-project', <root>/_bmad/method/scripts/tickets.py,'status', folder], root, 10000)`.
  - Code 1 with stderr containing `bmad migrate` → pre-release migrate notice, zero stories.
  - Code 2, a non-JSON stdout, the `ENOENT` error from `uv`, or a missing `tickets.py` file (checked before calling) → result equals `readV7Tree(...)` (has the reduced-fidelity notice).
  - Kind `backlog`: the folder argument is still passed. Backlog rows have no entry id, so their story key is `backlog/<file stem>`, matching Task 5.
  - Integration test (`test.skipIf(!hasUv)`): real `uv` against the fixture `initiative-checkout` gives the same columns as Task 5's expectations for `1.1`, `1.2` and `1.4`.
- [ ] **Step 2: Run** `npx vitest run test/v7Script.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** For a `parent` folder, read `initiatives` from the JSON and build `children` by calling `readV7` on each child folder that exists. Map a row: `column = row.tracker_status ? mapV7State(row.state) : mapStatus('v7', row.status).column`. `blocked` when `status==='blocked'` or `blocked_at` is set.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: read v7 boards through tickets.py with file fallback`.

---

### Task 7: Source detection, dispatch, story detail

**Files:**
- Create: `src/readers/detect.ts`
- Fixture: `test/fixtures/mixed/` (v6 sprint files + a v7 `store/initiative-a/…` under one config whose output folder holds both)
- Test: `test/detect.test.ts`

**Interfaces:**
- Consumes: all readers, `loadBmadConfig`
- Produces: `listSources(root: string): Promise<{ sources: SourceRef[]; defaultSourceId: string | null; tags: ('v6'|'v7')[]; version: string | null }>`
- Produces: `readBoard(root: string, sourceId: string): Promise<Board>` (throws `UnknownSourceError`)
- Produces: `getStoryDetail(root: string, sourceId: string, storyKey: string): Promise<StoryDetail>`
- Source ids: `v6-sprint`, `v6-spec:<folder name>`, `v7:<folder name>`, `v7-backlog`. A parent's children are `v7:<child>`.

- [ ] **Step 1: Failing tests.**
  - `v6-sprint` fixture → one source `v6-sprint` with `count` 4, tags `['v6']`, default `v6-sprint`.
  - `v7` fixture → sources in order `v7:initiative-checkout`, `v7:initiative-flat`, `v7:initiative-old`, `v7:initiative-parent` (with children), `v7-backlog`; default `v7:initiative-checkout` (active initiative); tags `['v7']`. A child initiative appears only under its parent, never also at top level. In this fixture the parent's children are `initiative-checkout` and `initiative-flat`, so the top-level list is really `v7:initiative-old`, `v7:initiative-parent` (children `v7:initiative-checkout`, `v7:initiative-flat`), `v7-backlog`. Assert that exact shape. `defaultSourceId` can name a child.
  - `mixed` → tags `['v6','v7']`; both kinds present; default is the v7 active initiative if set, else the first source.
  - `count` excludes dropped stories.
  - `getStoryDetail(v6-sprint, '1-1-user-login')` → `{path:<abs>, markdown: file text}`; for a v7 entry without a file → `{path:null, markdown: v7EntryText}`; a key that resolves outside the root → throws.
  - A reader throwing unexpectedly → `readBoard` returns a board with an `error` notice (never rejects for reader faults).
- [ ] **Step 2: Run** `npx vitest run test/detect.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: detect board sources and resolve story details`.

---

### Task 8: Project registry and preferences

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Produces: `class Registry { constructor(file: string); list(): RegisteredProject[]; add(path: string): RegisteredProject; remove(id: string): void; get(id: string): RegisteredProject | undefined; setPref(id: string, pref: Partial<ProjectPrefs>): void; lastViewed: string | null; setLastViewed(id: string): void }`
- `interface RegisteredProject { id: string; path: string; name: string; prefs: ProjectPrefs }`, `interface ProjectPrefs { view: 'columns' | 'swimlanes'; showDropped: boolean; sourceId: string | null }`
- `id` = first 12 hex chars of sha1(absolute root path). `name` = basename of root.
- Produces: `configDir(): string`: `process.env.BMAD_KANBAN_CONFIG_DIR`, else `envPaths('bmad-kanban',{suffix:''}).config`. Task 10's lock file and the e2e test use it too.
- Default file: `path.join(configDir(), 'projects.json')`.

- [ ] **Step 1: Failing tests** (temp dir file):
  - `add(<fixture>/sub/dir)` stores the project root (via `findProjectRoot`), not the subfolder. Adding twice gives one entry.
  - `add('/tmp/no-bmad')` throws `NotABmadProjectError`.
  - Prefs default `{view:'columns', showDropped:false, sourceId:null}` and persist across a new `Registry(file)`.
  - A corrupt JSON file → empty list, and the corrupt file is renamed to `projects.json.bak`.
  - Writes are atomic (write temp + rename).
- [ ] **Step 2: Run** `npx vitest run test/registry.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: persist project list and per-project prefs`.

---

### Task 9: HTTP server, SSE, file watching

**Files:**
- Create: `src/server/app.ts`, `src/server/watch.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `Registry`, `listSources`, `readBoard`, `getStoryDetail`
- Produces: `startServer(opts: { registry: Registry; port: number; webRoot: string }): Promise<{ port: number; close(): Promise<void> }>` (if `port` is taken, try the next 10)
- Produces: `watchProject(root: string, cfg: BmadConfig, onChange: () => void): () => void` (watches `outputFolder`, `planningArtifacts`, `implementationArtifacts`, `_bmad/custom`; ignores `.git`, `node_modules`; 300 ms debounce; `awaitWriteFinish` on)
- Routes (JSON):
  - `GET /api/projects` → `ProjectSummary[]` (with `missing: true` and `sources: []` when the folder is gone)
  - `POST /api/projects` `{path}` → `201 ProjectSummary`; `400 {error}` when not a BMAD project
  - `DELETE /api/projects/:id` → `204`
  - `PUT /api/projects/:id/prefs` `Partial<ProjectPrefs>` → `204`
  - `GET /api/projects/:id/boards/:sourceId` → `Board` (`404` unknown project/source; a missing folder → `410`)
  - `GET /api/projects/:id/boards/:sourceId/stories/:storyKey` → `StoryDetail` (keys URL-encoded)
  - `GET /api/state` → `{ lastViewed: string | null }`; `PUT /api/state` `{lastViewed}` → `204`
  - `GET /api/events` → SSE; sends `event: change\ndata: {"projectId":"…"}` on watched changes, plus `event: projects` when the list changes
  - everything else → static files from `webRoot`, falling back to `index.html`

- [ ] **Step 1: Failing tests** (real server on port 0, temp registry):
  - Adding the `v6-sprint` fixture, then GET board `v6-sprint` → 4 stories.
  - A request with `Host: evil.com` → `403`. A POST without a JSON content type → `415`.
  - Removing the fixture folder (use a temp copy) → GET projects shows `missing: true`; GET board → `410`.
  - SSE: open `/api/events`, write to the temp copy's `sprint-status.yaml` twice within 100 ms → exactly one `change` event within 2 s.
  - Story key `..%2F..%2Fetc%2Fpasswd` → `404`, never file contents.
  - Snapshot test: hash every file in the fixture copy before and after the whole suite; they must be identical (read-only guarantee).
- [ ] **Step 2: Run** `npx vitest run test/server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Watchers start lazily when a project is first requested, and stop when it is removed or its folder disappears.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: serve boards over HTTP with live change events`.

---

### Task 10: Single instance + CLI

**Files:**
- Create: `src/instance.ts`, `src/cli.ts`
- Test: `test/instance.test.ts`

**Interfaces:**
- Consumes: `startServer`, `Registry`, `findProjectRoot`
- Produces: `readLock(file: string): { port: number; pid: number } | null`; `findRunning(file: string): Promise<number | null>` (lock exists, pid alive, and `GET /api/state` on that port answers → port; otherwise delete the stale lock and return null)
- Lock file: `<config dir>/server.json`, written after the server listens and removed on SIGINT/SIGTERM/exit.
- CLI behaviour (`bmad-kanban [path] [--port N] [--no-open]`, default port 4310):
  1. `root = findProjectRoot(path ?? cwd)`.
  2. `port = await findRunning()`. If none, start the server in this process (it stays in the foreground and logs its URL).
  3. If there's a root: `POST /api/projects {path: root}` (to self or the running instance), then open `http://127.0.0.1:<port>/?project=<id>`. If not, open `http://127.0.0.1:<port>/`.
  4. When reusing an instance, print `Opened <name> in the running board at <url>` and exit 0.
  - `--help` and `--version`.

- [ ] **Step 1: Failing tests.** A stale lock (dead pid) → `findRunning` returns null and deletes the file. A live server → returns its port. A lock pointing at a port where nothing answers → null.
- [ ] **Step 2: Run** `npx vitest run test/instance.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `open` for the browser. Add the `#!/usr/bin/env node` shebang.
- [ ] **Step 4: Run.** Expected: PASS. Manual check: `npm run build && node dist/cli.js test/fixtures/v6-sprint --no-open` prints a URL, and a second run in another shell prints "Opened … in the running board" and exits.
- [ ] **Step 5: Commit** `feat: CLI with single shared server instance`.

---

### Task 11: Web app

**Files:**
- Create: `vite.config.ts` (root `web/`, outDir `dist/web`, dev proxy `/api` → 4310), `web/index.html` (`<title>BMAD Kanban</title>`), `web/main.tsx`, `web/api.ts`, `web/App.tsx`, `web/Sidebar.tsx`, `web/ColumnsView.tsx`, `web/SwimlaneView.tsx`, `web/Card.tsx`, `web/CardDetail.tsx`, `web/grouping.ts`, `web/styles.css`
- Test: `test/grouping.test.ts`

**Interfaces:**
- Consumes: the HTTP API from Task 9, types from `src/model.ts` (import type only)
- Produces (pure, in `web/grouping.ts`):
  - `byColumn(stories: Story[], showDropped: boolean, epicFilter: string | null): Record<Column, Story[]>`
  - `swimlanes(board: Board, showDropped: boolean): { epic: Epic | null; done: number; total: number; cells: Record<Column, Story[]> }[]` (epic order; stories with no epic go in a final `null` lane, shown only if non-empty; `total` excludes dropped)
  - `epicColor(index: number): string` (fixed 8-colour palette)

- [ ] **Step 1: Failing tests** for `grouping.ts`: dropped stories excluded unless `showDropped`; the epic filter keeps only matching stories; swimlane `done/total` for the v6-sprint fixture board is `1/2` for epic 1; a story with an unknown `epicId` lands in the `null` lane.
- [ ] **Step 2: Run** `npx vitest run test/grouping.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `grouping.ts`**, then run. Expected: PASS.
- [ ] **Step 4: Build the UI** to match the approved mockups (`.superpowers/brainstorm/*/content/multi-project.html` option A, `board-layout.html`):
  - **Sidebar:** projects with v6/v7 tags. Source entries (with counts) under a project when it has more than one source; parent initiatives group their children. "+ Add project" asks for a path via a small inline input, then POSTs it and shows the API's error text on 400. Each project has a remove action. Missing projects are greyed out with "folder not found".
  - **Header:** project/source name, a Columns|Swimlanes toggle, a "show dropped" switch (only when the board has dropped stories), and epic filter chips (columns view).
  - **Card:** display id, title, epic chip (colour by epic index), a red "blocked" marker, a spike/bug tag, and an "unknown status: X" badge.
  - **Retrospective:** a small marker on the epic chip or lane header when `retrospective === 'done'`.
  - **Notices:** a banner above the board for each board notice.
  - **CardDetail:** a modal that renders `marked` → `DOMPurify.sanitize`, shows the path with a copy button ("No file yet" when the path is null), and closes on Esc.
  - **State:** from `?project=` on load, else `lastViewed`. Selection changes `PUT /api/state` and the prefs (view, showDropped, sourceId). An SSE `change` for the shown project refetches the board; `projects` refetches the sidebar.
  - **Theme:** light and dark via `prefers-color-scheme`.
- [ ] **Step 5: Verify manually.** Run `npm run build && node dist/cli.js test/fixtures/v7`, then check: sidebar groups, toggle, card detail, and that editing a plan's `status` in a temp copy moves the card within 2 s.
- [ ] **Step 6: Commit** `feat: web board with sidebar, columns and swimlanes`.

---

### Task 12: End-to-end smoke, packaging, CI, README

**Files:**
- Create: `playwright.config.ts`, `test/e2e/smoke.spec.ts`, `.github/workflows/ci.yml`, `README.md`
- Modify: `package.json` (`prepublishOnly: npm run build && npm test`)

- [ ] **Step 1: Write the e2e test.** Start `dist/cli.js` with `BMAD_KANBAN_CONFIG_DIR` set to a temp dir and `--no-open` against a temp copy of `test/fixtures/mixed`. Then assert:
  - the sidebar shows both v6 and v7 tags
  - clicking `v6 sprint` shows the "User login" card in Done
  - toggling Swimlanes shows an "Accounts" lane
  - clicking a card opens a detail modal containing its markdown heading
  - editing the copy's `sprint-status.yaml` (`1-2-password-reset: done`) moves that card to Done within 3 s
- [ ] **Step 2: Run** `npm run build && npx playwright test`. Expected: PASS.
- [ ] **Step 3: CI.** GitHub Actions on push and PR: matrix of `ubuntu-latest` and `macos-latest` × Node `22` and `24`. Set up `uv` (`astral-sh/setup-uv`), then `npm ci`, `npm run build`, `npm test`, `npx playwright install --with-deps chromium`, `npm run test:e2e`.
- [ ] **Step 4: README.** What it is, `npx bmad-kanban`, the supported layouts (v6 sprint, v6 spec, v7), the `uv` requirement for full v7 fidelity, a read-only statement, the column mapping table (from the spec), and how to remove projects. Credit vscode-bmad-kanban as inspiration.
- [ ] **Step 5: Packaging check.** `npm pack --dry-run` lists only `dist/**`, `README.md`, `LICENSE` and `package.json`, and contains `dist/web/index.html`.
- [ ] **Step 6: Commit** `chore: e2e smoke test, CI and README`.

Publishing to npm (`npm publish`) is not part of this plan. It needs the user's npm account and explicit go-ahead.
