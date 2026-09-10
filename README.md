# ReleaseDeck

ReleaseDeck is a learning-focused, self-hosted release and deployment platform.

**Build. Release. Roll back.**

The long-term product will accept verified GitHub webhooks, create asynchronous
deployment jobs, run CI in isolated workspaces, publish immutable releases,
health-check candidates, and promote or roll back safely. The repository is
currently in **Phase 1 — Foundation**. The foundation implementation and
verification are complete, and the user has approved the Phase 1 commit and push.
Phase 2 has not started.

This project values understanding over rapid code generation. The public
architecture and technical decisions are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
[`docs/decisions/`](docs/decisions/).

The approved visual references are preserved in
[`docs/references/`](docs/references/). Frontend implementation is deferred to
Phase 7; early phases must not add fake product behavior merely to resemble the
references. Two reference files were available in this workspace (brand board
and dashboard); the separately mentioned standalone logo file was not supplied
and is intentionally deferred until frontend work.

## Local setup

Use a supported Node release matching `^22.13.0 || ^24.0.0 || ^26.0.0` and pnpm
`10.18.1`. Node 24 LTS is the recommended baseline; the current development
machine uses Node `26.5.1`. Install from the lockfile:

```bash
pnpm install --frozen-lockfile
```

Create app-local environment files (the processes load `.env` from their own
working directories):

```bash
cp apps/api/.env.example apps/api/.env
cp apps/worker/.env.example apps/worker/.env
```

On PowerShell, use `Copy-Item apps/api/.env.example apps/api/.env` and the
equivalent command for `worker`. Edit both files with reachable, auth-aware
`MONGODB_URI` and `REDIS_URL` values. The example MongoDB URI assumes a local
development service configured without authentication; it will not work against
an authentication-required service without credentials and the correct options.
Never commit `.env` files or credentials.

`pnpm dev` builds the shared packages and starts the dashboard at
`127.0.0.1:5173`, the API at `127.0.0.1:3000`, and the waiting worker. MongoDB
and Redis are external development prerequisites; Docker is not required by the
current setup.

The available quality commands are:

| Command               | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `pnpm build`          | Build all packages and applications                                     |
| `pnpm typecheck`      | Type check all workspaces                                               |
| `pnpm test`           | Run workspace tests                                                     |
| `pnpm lint`           | Run ESLint                                                              |
| `pnpm format:check`   | Check Prettier formatting                                               |
| `pnpm format`         | Apply Prettier formatting                                               |
| `pnpm verify:runtime` | Build, then run opt-in integration/failure checks against real services |

`pnpm verify:runtime` is intentionally opt-in. It runs `pnpm build` itself and
requires reachable development MongoDB and Redis. The harness reads
`MONGODB_URI` and `REDIS_URL` from the invoking shell, rather than from either
app’s `.env`; set the same values explicitly when credentials or non-default
ports are needed:

```bash
MONGODB_URI='mongodb://<user>:<password>@127.0.0.1:27018/releasedeck' \
REDIS_URL='redis://127.0.0.1:6380' pnpm verify:runtime
```

In PowerShell, set `$env:MONGODB_URI` and `$env:REDIS_URL` before running
`pnpm verify:runtime`. If neither variable is exported, the harness falls back
to `mongodb://127.0.0.1:27017/releasedeck` and `redis://127.0.0.1:6379`.
It checks health, waiting-worker startup, malformed configuration, unreachable
dependencies, occupied ports, and graceful shutdown; it performs no database
writes or Redis key writes.

For a built API/worker process, run `pnpm build` first, then start each app with
its workspace filter:

```bash
pnpm --filter @releasedeck/api start
pnpm --filter @releasedeck/worker start
```

The filtered commands retain the application working directory, so each process
continues to load its own `.env`. The dashboard currently produces a static
`apps/dashboard/dist` build; a production web server for that artifact belongs
to the later deployment phases.

The Phase 1 dashboard is a presentation-only shell and makes no API calls yet.
Deployment records, queue processing, releases, rollback, live status, and
observability arrive in later phases.
