# Repository Guidelines

## Project Structure & Module Organization

This is an npm workspace for a local-first multi-asset ledger. Shared TypeScript packages live in `packages/`: `core` contains platform-agnostic models and calculations, `db` contains SQLite schema/repository/sync logic, and `logger` contains structured logging. Applications live in `apps/`: `web` is the React + Vite UI, `sync-server` relays encrypted commits and attachments, and `desktop` is the Tauri shell. Tests are colocated in each workspace under `test/*.test.ts`. Documentation belongs in `docs/`; startup helpers are in `scripts/`. Treat `dist/`, `target/`, and `node_modules/` as generated output.

## Build, Test, and Development Commands

- `npm install`: install all workspace dependencies.
- `npm run dev`: start the web app through `@zichan/web`.
- `npm start` / `npm stop`: use the Windows dev start/cleanup scripts.
- `npm test`: run Vitest across all workspaces with tests.
- `npm run typecheck`: run `tsc --noEmit` across workspaces.
- `npm run build`: build shared packages (`logger`, `core`, `db`).
- `npm run dev -w @zichan/desktop`: run the Tauri desktop shell.
- `npm start -w @zichan/sync-server`: build and start the sync server.

## Coding Style & Naming Conventions

Use TypeScript ESM and follow the strict settings in `tsconfig.base.json`. Keep source modules small and domain-focused, with camelCase functions and variables, PascalCase types/components, and lowercase file names that match the feature (`conversion.ts`, `sync.test.ts`). Use two-space indentation, single quotes, and semicolons to match existing code. Ledger math must use `decimal.js` helpers from `@zichan/core`; do not use JavaScript floats for money or asset quantities.

## Testing Guidelines

Vitest is the test framework. Add tests in the affected workspace's `test/` directory using `*.test.ts`, with `describe` blocks named for the behavior under test. For shared ledger behavior, prefer deterministic examples and exact string assertions after rounding. Run `npm test` before broad changes; run targeted workspace tests such as `npm test -w @zichan/core` during iteration.

## Commit & Pull Request Guidelines

Git history is not available in this checkout, so use concise imperative commit subjects with an optional scope, for example `core: fix FIFO lot matching`. Keep commits focused and include tests or docs with behavior changes. Pull requests should describe the user-facing change, list validation commands run, link related issues or docs, and include screenshots for visible UI changes.

## Security & Configuration Tips

Do not commit `.env`, `.env.local`, database snapshots, or private ledger exports. The sync server stores encrypted protocol-v2 commits only; keep plaintext ledger data in local development storage.
