# Repository Guidelines

## Project Structure & Module Organization
MindOS is a Bun + TypeScript monorepo managed with Turbo. Services live in `apps/` (e.g., `apps/mind-service/`, `apps/toolmesh/`), each with a `src/` entrypoint. Shared libraries live in `packages/` (e.g., `packages/shared-types/`, `packages/evidence-core/`). Database migrations are in `db/migrations/`. Infrastructure and runtime wiring are in `infra/` and `docker-compose.yml`. Workspace-wide tooling is configured in `biome.json`, `tsconfig.base.json`, and `turbo.json`.

## Build, Test, and Development Commands
- `bun install`: install workspace dependencies.
- `bun run dev`: start all services in watch mode via Turbo.
- `bun run build`: build all apps/packages (`dist/` or `build/` outputs).
- `bun run check`: typecheck all workspaces.
- `bun run lint` / `bun run lint:fix`: run Biome checks (and auto-fix).
- `bun run format`: format code with Biome.
- `bun run test`: run Turbo test pipeline (executes per-package `test` scripts).
- `bun run docker:up` / `bun run docker:down`: start/stop local infra.
- `bun run db:migrate`: run SQL migrations in `db/`.

## Coding Style & Naming Conventions
- TypeScript strict mode (see `tsconfig.base.json`).
- Biome formatting: 2-space indents, double quotes, semicolons as needed, 100-char lines.
- Workspace packages use the `@mindos/*` scope; app and package directories use kebab-case (e.g., `swarm-coordinator`).
- Prefer adding shared schemas/types in `packages/shared-types/` when introducing new domain objects.

## Testing Guidelines
There is no committed test framework or test files yet. `bun run test` will only run if a package defines a `test` script. When adding tests, introduce a package-level `test` script and keep file naming consistent (e.g., `src/**/__tests__/*.test.ts` or `src/**/*.spec.ts`).

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, and sentence-case (e.g., “Add production deployment infrastructure…”).
- PRs should include: a concise summary, rationale, how to run/verify changes, and any config/env updates. Include screenshots for UI/UX changes.

## Environment & Configuration Tips
Copy `.env.example` to `.env` for local development and keep secrets out of git. Production secrets belong in deployment tooling (see `DEPLOYMENT.md`).
