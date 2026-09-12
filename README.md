# ReleaseDeck

ReleaseDeck is a learning-focused, self-hosted release and deployment platform.

**Build. Release. Roll back.**

The long-term product will accept verified GitHub webhooks, create asynchronous
deployment jobs, run CI in isolated workspaces, publish immutable releases,
health-check candidates, and promote or roll back safely. Implementation and
verification for **Phase 3 — GitHub to queue** are complete, approved, and
pushed. Verified webhook receipt now ends at the worker's initial deployment
claim; CI commands and target deployment do not exist yet.

This project values understanding over rapid code generation. The public
architecture is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

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
`MONGODB_URI` and `REDIS_URL` values, and set a private
`GITHUB_WEBHOOK_SECRET` in the API environment. The example MongoDB URI assumes a local
development service configured without authentication; it will not work against
an authentication-required service without credentials and the correct options.
Never commit `.env` files or credentials.

`pnpm dev` builds the shared packages and starts the dashboard at
`127.0.0.1:5173`, the API at `127.0.0.1:3000`, and the queue-consuming worker.
MongoDB and Redis are external development prerequisites; Docker is not
required by the current setup.

The available quality commands are:

| Command                   | Purpose                                                                      |
| ------------------------- | ---------------------------------------------------------------------------- |
| `pnpm build`              | Build all packages and applications                                          |
| `pnpm typecheck`          | Type check all workspaces                                                    |
| `pnpm test`               | Run workspace tests                                                          |
| `pnpm lint`               | Run ESLint                                                                   |
| `pnpm format:check`       | Check Prettier formatting                                                    |
| `pnpm format`             | Apply Prettier formatting                                                    |
| `pnpm verify:runtime`     | Build, then run opt-in integration/failure checks against real services      |
| `pnpm verify:persistence` | Build, verify repositories against an isolated database, and clean it safely |
| `pnpm verify:phase3`      | Build, exercise signed delivery through BullMQ and worker, and clean MongoDB |

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
It checks health, queue-worker startup, malformed configuration, unreachable
dependencies, occupied ports, and graceful shutdown. API startup idempotently
ensures MongoDB indexes and initializes the queue boundary.

`pnpm verify:persistence` accepts the same shell-provided `MONGODB_URI`. It
selects a randomly named `releasedeck_phase2_verify_*` database through the
connected client, verifies uniqueness, cursor pagination, guarded concurrent
updates, webhook delivery uniqueness, and required indexes, then drops only that
generated database and closes the client. Use a development service where the
configured account can create indexes and temporary databases.

`pnpm verify:phase3` accepts both shell-provided service URLs. It creates a
randomly named `releasedeck_phase3_verify_*` MongoDB database, sends eight
concurrent signed copies of one push, verifies one event, one deployment, the
retained UUID-only BullMQ job, the worker's guarded claim, and delivery-ID
conflict handling, then drops only that generated MongoDB database. Run it
against development services: it uses a random BullMQ namespace and removes
only that namespace after both queue clients close.

## Phase 2 API

Phase 2 exposes only routes whose behavior is real:

| Method | Route                                  | Behavior                                     |
| ------ | -------------------------------------- | -------------------------------------------- |
| `POST` | `/api/projects`                        | Create a normalized GitHub-backed project    |
| `GET`  | `/api/projects`                        | List projects with bounded cursor pagination |
| `GET`  | `/api/projects/:projectId`             | Read one project                             |
| `GET`  | `/api/projects/:projectId/deployments` | List that project's deployments              |
| `GET`  | `/api/deployments/:deploymentId`       | Read one deployment                          |

Requests are strictly validated and JSON bodies are limited to 64 KiB. List
routes accept `limit` (default 25, maximum 100) and an opaque `cursor`. The API
returns stable JSON errors for invalid input, missing records, conflicts,
oversized bodies, and sanitized internal failures.

## Phase 3 webhook and queue boundary

`POST /api/webhooks/github` accepts JSON bodies up to 1 MiB. It verifies
`X-Hub-Signature-256` against the exact raw bytes before parsing, requires one
bounded delivery/event header value, and stores only a payload digest and
bounded routing state—not the raw payload. Signed pushes create work only for a
registered repository's exact configured default branch. Irrelevant signed
deliveries are recorded as ignored and return `204`; accepted deliveries return
`202`; conflicting delivery-ID reuse returns `409`.

MongoDB is authoritative across the MongoDB/Redis boundary. Recoverable webhook
states and a unique source link converge retries on one deployment. BullMQ jobs
contain only `{ deploymentId }` and use that UUID as their deterministic job
ID. The worker reloads the deployment and atomically moves only
`QUEUED/QUEUED` to `RUNNING/CHECKOUT`; checkout and later CI stages remain
Phase 4 work.

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

The dashboard remains a presentation-only shell and makes no API calls yet.
CI execution, releases, rollback, live status, and observability arrive in
later phases.
