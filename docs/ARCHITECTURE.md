# ReleaseDeck architecture

This document separates the repository’s current, verified state from the
target shape. Future behavior is labeled as target until implemented and
verified.

## Current state

The repository contains the approved Phase 1 process foundation, Phase 2 API
domain/persistence work at commit `447435f`, approved Phase 3 GitHub-to-queue
work at commit `c096926`, and the approved Phase 4 CI runner. It is a
pnpm/Turborepo monorepo with three
applications and six useful shared packages. Build, typecheck, test, lint,
formatting, runtime verification, isolated persistence verification, and
real-service Phase 3, Phase 4, and Phase 5 flows are supported by root commands.
Phase 6 health-gated promotion and rollback is implemented and verified in the
current uncommitted worktree; its commit/push awaits explicit approval. The
Phase 6 verifier uses real MongoDB/Redis/worker/CI with a simulated remote
operation, while Linux fixture tests exercise the fixed remote scripts.

## Implemented Phase 1 foundation

```text
apps/dashboard (React/Vite presentation shell)
        (no API calls in Phase 1)

apps/api (Express control-plane health endpoint)
        │                     │
        ▼                     ▼
packages/db → MongoDB     packages/runtime → Redis

apps/worker (startup process; no jobs in Phase 1)
        │                     │
        └──── packages/db / packages/runtime ────┘
```

The Phase 1 API requested work and exposed `/health`; it did not execute
deployment pipelines. Startup connected to MongoDB and Redis before listening
on loopback `127.0.0.1:3000`. The health handler still pings both dependencies
concurrently with a bounded three-second request timeout and returns `200` only
when both are reachable, otherwise `503`. The dashboard remains a minimal
branded shell at Vite's default `127.0.0.1:5173` and does not call the API.

The `/health` contract should report dependency reachability with bounded checks.
A MongoDB `ping` is a connectivity no-op: it does not establish write
authorization, worker health, or target application health. Operational and
target health remain later concerns.

`packages/db` owns the native MongoDB 7.6.0 `MongoClient` connection, bounded
`ping` operations, client cleanup, and the Phase 2 authoritative domain
persistence boundary. `packages/runtime` owns Zod environment validation,
dotenv loading from the application working directory, Pino structured logging
with redaction, sanitized startup errors, and ioredis connection/ping/close
support. `packages/tsconfig` owns shared TypeScript settings. No
`packages/shared`, `packages/deployment-core`, or `packages/observability` was
added before a useful consumer existed.

API and worker environment examples live beside each app. Required MongoDB and
Redis URLs are validated before startup; credentials are not logged. Redis is
configured with bounded command/connect timeouts and no automatic reconnect, so
a process must currently be restarted after a lost connection.
Shutdown handlers drain the API server (with a five-second bound), close both
dependency clients, and exit with an explicit success or failure code.

## Implemented Phase 2 domain and API

`packages/db` defines Project, Deployment, and WebhookEvent records and maps
them to native MongoDB collections. Records use server-generated UUIDs and
timestamps. GitHub repository coordinates and full 40-character commit SHAs are
normalized before storage. Webhook events retain bounded metadata rather than
raw payloads.

Projects are unique by provider/owner/repository. Webhook events are unique by
provider/delivery identifier so Phase 3 can build idempotent receipt behavior on
a database constraint. Deployment status and pipeline stage are separate,
invalid combinations are rejected, and updates use versioned compare-and-swap
filters so concurrent writers cannot silently overwrite each other. Repositories
provide newest-first opaque cursor pagination with a default limit of 25 and a
maximum of 100.

API startup connects to MongoDB, idempotently ensures the required unique and
query indexes, connects to Redis, constructs services, and only then binds the
HTTP port. Failure at any step closes acquired resources. Normal startup now
requires MongoDB index privileges; a ping alone is no longer sufficient for the
API to become ready.

The Phase 2 HTTP surface is intentionally narrow:

- create, list, and read projects;
- list a project's deployments and read a deployment;
- retain the Phase 1 `/health` contract.

Strict Zod schemas reject unknown fields, malformed IDs/cursors, and out-of-
bounds inputs. JSON bodies are limited to 64 KiB. Controllers only validate,
call application services, and serialize responses; centralized middleware maps
expected errors and sanitizes unexpected failures. Deployment creation and
WebhookEvent recording exist behind internal services/repositories, but no
public route claims to enqueue work or receive a verified webhook.

## Implemented Phase 3 webhook and queue boundary

The API now mounts `POST /api/webhooks/github` before its global JSON parser. A
raw-body parser accepts at most 1 MiB, and the webhook processor requires one
delivery ID, event name, and SHA-256 signature header. It authenticates the
exact bytes with HMAC-SHA256 and constant-time digest comparison before parsing
JSON. `GITHUB_WEBHOOK_SECRET` is required at API startup and covered by logger
redaction. Raw payloads and secrets are neither stored nor logged.

For signed pushes, the API normalizes GitHub repository coordinates, finds a
registered project, and requires the exact `refs/heads/<defaultBranch>` ref.
Unsupported events, unknown projects, non-default branches, deleted refs, and
zero-SHA pushes become terminal `IGNORED` records without deployments. Reuse of
a delivery ID with different signed content is a conflict.

MongoDB is authoritative across the non-transactional MongoDB/Redis boundary.
Recoverable webhook states (`RECEIVED`, `QUEUE_PENDING`, and `QUEUED`), a unique
deployment source link, versioned compare-and-swap transitions, and bounded
pending reconciliation converge retries and process/queue failure windows. The
legacy Phase 2 webhook shape remains readable but is excluded from Phase 3
reconciliation because it lacks recoverable routing data.

`packages/queue` owns BullMQ queue/job names, payload validation, producer and
consumer construction, deterministic job IDs, retries, and lifecycle. A job
contains only `{ deploymentId }`; completed and failed jobs are retained so the
deterministic ID remains the duplicate boundary. The worker reloads authoritative
MongoDB state and atomically claims only `QUEUED/QUEUED` deployments as
`RUNNING/CHECKOUT`. Duplicate or stale jobs do not move state backward. Phase 4
extends this worker claim through CI execution; target deployment remains future
work.

API startup now requires MongoDB/indexes, Redis, and a ready queue before the
HTTP listener binds. Worker startup requires MongoDB/indexes, Redis configured
for BullMQ blocking operations, and a ready consumer. Shutdown stops HTTP and
reconciliation or cancels/drains the consumer before closing its queue and
shared dependency connections.

## Implemented Phase 4 CI execution boundary

`packages/ci-runner` owns disposable workspace allocation, exact full-SHA Git
checkout, fixed lockfile-selected pnpm/npm commands, bounded stdout/stderr,
per-stage and total deadlines, process-tree cancellation that settles only after
bounded tree termination, and verified cleanup.
Commands use argument arrays rather than shell text. Their minimal environment
omits control-plane credentials and points temporary-file variables into the
allocated workspace. Cleanup validates the canonical allocated path and reports
an explicit failure without hiding an earlier CI error.

The worker reloads project coordinates and the deployment commit from MongoDB,
then runs `CHECKOUT`, `INSTALL`, `TEST`, and `BUILD`. It records every result
through versioned compare-and-swap operations guarded by an attempt UUID, lease,
and monotonically increasing fencing token. Only one fresh claim wins; active
duplicates wait for authoritative completion, expired attempts can be reclaimed,
and stale credentials cannot renew or write. Lease renewal rechecks expiry in
the atomic update filter.

CI step state includes bounded output, explicit exit code and signal values,
duration and failure details, and durable cleanup evidence. Unavailable exit or
signal values are stored explicitly as `null`. A terminal command failure
preserves its exact stage and skips later commands. A successful build ends at deployment
`RUNNING/BUILD` with CI status `PASSED`; it does not move to `DEPLOY` or mark the
deployment `SUCCESS`. Queue shutdown first aborts active BullMQ processors and
then drains the consumer before Redis and MongoDB close.

These workspaces provide lifecycle and path isolation, not a security sandbox.
Build commands still run with the worker account's OS privileges. Container or
OS isolation for hostile repositories remains future work. Phase 6 adds health
promotion and rollback beyond this Phase 4 boundary.

## Implemented Phase 5 immutable release deployment

After a successful exact-SHA build, the CI runner invokes a preparation hook
while the disposable workspace still exists. `packages/release-deployer`
creates a deterministic archive outside that workspace, embeds bounded project,
deployment, commit, and digest metadata, and excludes Git state, environment
files, and local caches. The Phase 4 workspace is then removed normally and CI
success is persisted before target mutation begins.

The worker claims a separate MongoDB release attempt guarded by an attempt UUID,
lease, version, and monotonically increasing fencing token. It reopens and
verifies the durable archive, uploads it using fixed OpenSSH/SCP argument arrays,
and runs fixed POSIX scripts on one configured Linux target. Strict known-hosts
checking, identity-only batch authentication, bounded output and time, and
process-tree cancellation apply to transport commands. Password prompts and
arbitrary remote command text are not supported.

The remote layout is implemented as:

```text
<remoteRoot>/<projectId>/
  releases/<deploymentId>/
  shared/.env
  current → releases/<deploymentId>
```

Staging validates the archive digest and embedded identity before publishing an
immutable release directory. An existing directory is reusable only when all
identity and digest metadata match. A per-project remote lock serializes
activations and retention across deployment IDs. Activation atomically replaces `current`,
reloads the fixed project PM2 process, validates and reloads pre-provisioned
Nginx, proves the active target and PM2 PID, and removes only surplus validated
inactive release directories while retaining the active release and at least
one predecessor. Bounded proof is persisted before the deployment reaches
`SUCCESS/COMPLETE`; transport and remote failures follow the worker retry budget
and end at `RETRY_PENDING` or `FAILED/DEPLOY`.

Operators must pre-provision the target account, SSH key and known-hosts file,
`shared/.env`, POSIX `flock`, PM2, the application ecosystem file, and passwordless permission
for only the required Nginx validation/reload operations. Phase 5 activates
directly after infrastructure proof. The Phase 6 extension below adds
application health checks and rollback.

## Implemented Phase 6 health promotion and rollback (uncommitted)

The worker configures a loopback-only HTTP health URL, bounded attempts,
request timeout, interval, and remote deadline. The release-deployer activates a
candidate under the existing per-project lock, re-proves its immutable identity
and process/infrastructure state, and uses target-local curl to require a 2xx
application response before updating `known-good` and `previous-known-good`.
Health response bodies are not persisted. Curl bypasses proxy settings for the
loopback probe.

If a candidate is unhealthy, the locked remote operation restores the validated
previous known-good release directory, reloads PM2/Nginx, repeats health and
identity proof, and records `ROLLED_BACK/ROLLBACK`. A failed restoration records
`FAILED/ROLLBACK` without claiming the predecessor is healthy. An unhealthy
first release has no certified predecessor and records `FAILED/HEALTH_CHECK`.
Retention protects the active and restorable directories and does not delete
invalid directory entries. Legacy Phase 5 records stay readable but are not
implicitly certified healthy.

Manual rollback is an operator-run worker CLI that names the active and desired
previous deployment IDs. MongoDB claims and renews the operation with version,
lease, and fencing guards. The remote predecessor pointer and immutable metadata
must match. A stable request ID is written with source/target identity before
switching `current`, allowing a reclaimed attempt to re-prove a completed switch
after a persistence interruption. Stale pre-mutation requests become a durable
`REJECTED` manual operation while preserving historical deployment success.
An uncertain post-mutation failure does not claim success. There is no public
rollback HTTP route or dashboard control yet.

## Target control and execution planes

The eventual control-plane flow is:

```text
GitHub signed webhook → API → MongoDB authoritative state
                              │
                              └→ Redis/BullMQ job containing deploymentId
                                                     │
                                                     ▼
                                            Worker execution plane
```

The flow through the worker's initial authoritative state claim is implemented
in Phase 3, Phase 4 implements the worker-owned CI portion, Phase 5 extends the
worker through immutable release activation, and Phase 6 gates
`SUCCESS/COMPLETE` on application health and provides rollback outcomes.
Long-running CI and deployment operations must never run inside HTTP handlers.

The implemented domain keeps overall deployment status separate from pipeline
stage and records the exact commit SHA. Phase 3 uses the unique delivery
constraint plus recoverable state to make processing idempotent. Phase 4 adds
leased, fenced CI attempt state so stale workers cannot advance a reclaimed
attempt. Status
(`QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `ROLLED_BACK`) describes the outcome;
the worker drives stage progress through the implemented CI and release flows.

## Implemented deployment and target release evolution

Phase 5 implements immutable versioned releases on one configured Linux target:

```text
/srv/apps/<project>/
  releases/<release>/
  shared/.env
  current → releases/<active-release>
```

Each successful build creates a release keyed by deployment UUID. Phase 6
health-gates promotion and can restore an already-built known-good release
without rebuilding the old commit.

## Target observability boundary

Later observability will cover API, worker, deployment duration, outcomes,
rollback count, queue depth, latency, health, and useful structured logs using
the planned OpenTelemetry/Prometheus/Loki/Grafana stack. `packages/observability`
is intentionally deferred until that phase.

## Technology direction

The implemented system uses Node.js, Express, React, Vite, TypeScript, native
MongoDB, Redis, Zod, Pino, ioredis, BullMQ, Git, and fixed npm/pnpm CI commands.
Remote release deployment uses system OpenSSH, POSIX shell tools, PM2, and
Nginx. Server-Sent Events are preferred later for server-to-browser
status and log streams. Phosphor icons and the shadcn-inspired visual system
belong to the later dashboard phase. No technology is added solely for résumé
value.

## Architectural guardrails

Keep controllers thin, validate at boundaries, and keep GitHub and queue
integrations behind focused modules. Queue payloads contain only `deploymentId`
so MongoDB remains authoritative. Do not introduce a major
technology or package for appearance or résumé value. Authentication and
isolation for untrusted build commands remain explicit future security work.
Phase 4 removes control-plane credentials from child environments and confines
workspace lifecycle beneath a validated root, but it does not provide a hostile-
code sandbox. The system still lacks broader authentication, authorization,
production-grade reconnect, and telemetry behavior. The Phase 6 manual CLI is
operator-controlled; an authorized public rollback route remains future work.
