# ReleaseDeck

ReleaseDeck is a self-hosted release and deployment platform for connecting
GitHub projects and managing software delivery workflows.

> ReleaseDeck is still under active development. Features and setup may change,
> and it is not yet recommended for production use.

## Prerequisites

- Node.js `22.13.x` or later in the 22.x line, `24.x`, or `26.x`
- pnpm `10.18.1`
- Running MongoDB and Redis services

## Run locally

Install dependencies from the repository root:

```bash
pnpm install --frozen-lockfile
```

Create the local environment files:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
```

On PowerShell:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
```

Review both `.env` files and update the MongoDB and Redis URLs if your services
do not use the default local addresses. Replace `GITHUB_WEBHOOK_SECRET` in the
API environment with a private value containing at least 16 characters.

Start ReleaseDeck:

```bash
pnpm dev
```

Once running:

- Dashboard: <http://127.0.0.1:5173>
- API health check: <http://127.0.0.1:3000/health>

The dashboard reads real projects, deployment evidence, release health, and
rollback outcomes through the API. It shows bounded persisted activity rather
than raw CI output. Rollback execution remains an operator action outside the
browser. In development, Vite proxies API requests to `127.0.0.1:3000`; a
separately hosted dashboard needs equivalent same-origin `/api` routing.

## Development commands

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```
