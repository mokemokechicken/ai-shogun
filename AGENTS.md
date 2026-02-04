# Repository Guidelines

## Project Structure & Module Organization
- `bin/` holds the CLI entry point (`bin/ai-shogun.js`).
- `server/` is the Node/Express backend in TypeScript. Source lives in `server/src`, tests in `server/tests`, and build output in `server/dist`.
- `web/` is the React + Vite frontend. Source lives in `web/src`, build output in `web/dist`.
- `shared/` contains shared TypeScript utilities/types used by both server and web (`shared/src`, built to `shared/dist`).
- `config/` contains the example configuration file (`config/shogun.config.example.json`).
- `docs/` and `test-results/` are documentation and generated test output respectively. Runtime workspaces are created under `.shogun/` via `SHOGUN_ROOT`.

## Build, Test, and Development Commands
- `npm run bootstrap`: install dependencies for root, `shared`, `server`, and `web`.
- `npm run dev`: start the server in watch mode using `tsx`.
- `npm run dev:web`: start the Vite dev server for the web UI.
- `npm run dev:all`: run server and web dev servers together.
- `npm run build`: build `shared`, `server`, and `web` packages.
- `npm run lint`: run ESLint across all packages.
- `npm run test`: run all package tests (only `server` has real tests today).
- `make package`: produce `ai-shogun-<version>.tgz` in the repo root.

## Coding Style & Naming Conventions
- TypeScript is ESM (`"type": "module"`). Keep new code in `src/` and avoid editing `dist/`.
- ESLint is the canonical style gate; run `npm run lint` before submitting changes.
- Type-only imports are required by linting (`@typescript-eslint/consistent-type-imports`).
- Prefix intentionally unused parameters with `_` to satisfy `no-unused-vars`.
- Test files follow `*.test.ts` (see `server/tests/`).

## Testing Guidelines
- Server tests use Vitest. Run them with `npm --prefix server run test`.
- `shared` and `web` currently have placeholder test scripts. If you add tests, update their `package.json` scripts to keep `npm run test` meaningful.

## Commit & Pull Request Guidelines
- Commit messages are short and descriptive; the history includes both Japanese summaries and Conventional Commits style (`feat:`, `fix:`). Pick a clear, consistent style for your series.
- PRs should include: a concise summary, the tests/commands you ran, linked issues (if any), and screenshots or short clips for UI changes.

## Configuration & Environment
- Default ports: server `4090`, web `4091`.
- Environment variables: `SHOGUN_ROOT`, `SHOGUN_PORT`, `SHOGUN_WEB_PORT`, and optional `VITE_API_URL` for the web proxy target.
