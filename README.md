# bmad-kanban

A read-only Kanban board for [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) projects. It runs locally, reads your project's BMAD files, and shows stories as cards in Backlog, Ready, In progress, Review and Done columns, with optional epic swimlanes. It updates live when files change.

It never writes to your project. Remove a project from the sidebar and only the board's own list changes; your folder is not touched.

## Usage

Run it inside a BMAD project:

```sh
npx bmad-kanban
```

Or point it at a folder:

```sh
npx bmad-kanban ~/code/my-project
```

Options (`bmad-kanban --help`):

- `--port N`: port to listen on (default 4310)
- `--no-open`: do not open a browser
- `[path]`: project folder (default: current directory)

If a board is already running on that port, the new project is added to it instead of starting a second server.

Requirements: Node 22 or newer. `uv` is needed for full BMAD v7 fidelity (the board calls v7's own scripts through it). Without `uv` the board falls back to reading the files directly and shows a "reduced fidelity" notice.

The project list is stored in a per-user config directory. Set `BMAD_KANBAN_CONFIG_DIR` to use a different one. Use the × next to a project in the sidebar to remove it from the list.

## Supported layouts

- **v6 sprint**: `sprint-status.yaml` plus story files in the implementation artifacts folder.
- **v6 spec**: story files with a `status` in their frontmatter.
- **v7**: initiatives and tickets (`tickets.toml` and story plan files).

A project can have more than one layout (typically mid-migration). Each source gets its own sidebar entry and nothing is merged across them.

## Columns

| Column | v6 sprint | v6 spec (frontmatter) | v7 `status` |
|---|---|---|---|
| Backlog | `backlog`, no status | none, `draft`, `backlog` | none, `draft` |
| Ready | `ready-for-dev` (+ legacy `drafted`) | `ready-for-dev` | `ready-for-dev` |
| In progress | `in-progress` (+ legacy `contexted`) | `in-progress` | `in-progress`, `blocked` (red marker) |
| Review | `review` | `review`, `in-review` | `in-review`, `built` |
| Done | `done` | `done` | `done` |
| (hidden) | none | none | `dropped`, behind a "show dropped" switch |

An unknown status goes to Backlog with an "unknown status: X" badge.

## Development

```sh
npm install
npm test          # unit tests (vitest)
npm run typecheck
npm run build     # dist/cli.js and dist/web
npm run test:e2e  # Playwright smoke test; run the build first
```

## Acknowledgements

Inspired by [vscode-bmad-kanban](https://github.com/RianKhanafi/vscode-bmad-kanban) by RianKhanafi.

## License

MIT
