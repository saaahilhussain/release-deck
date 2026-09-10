# ReleaseDeck architecture

This document separates the repository’s current, verified state from the
target shape. Future behavior is labeled as target until implemented and
verified.

## Current state

The repository contains the Phase 1 process foundation plus the implemented and
verified Phase 2 API domain/persistence work, which is awaiting commit/push
approval. It is a pnpm/Turborepo monorepo with three applications and three
useful shared packages. Build, typecheck, test, lint, formatting, runtime
verification, and isolated persistence verification are supported by root
commands.

## Implemented Phase 1 foundation

```text
apps/dashboard (React/Vite presentation shell)
        (no API calls in Phase 1)

apps/api (Express control-plane health endpoint)
        │                     │
        ▼                     ▼
packages/db → MongoDB     packages/runtime → Redis

apps/worker (startup process; connects and waits, no jobs)
        │                     │
        └──── packages/db / packages/runtime ────┘
```

The API requests work and exposes `/health`; it does not execute deployment
pipelines. Startup connects to MongoDB and Redis before listening on loopback
`127.0.0.1:3000`. The health handler pings both dependencies concurrently with
a bounded three-second request timeout and returns `200` only when both are
reachable, otherwise `503`. The worker connects to both dependencies and logs
that it is waiting; it consumes no queue and starts no deployment jobs. The
dashboard is a minimal branded shell at Vite's default `127.0.0.1:5173` and
does not call the API in this phase.

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
a process must be restarted after a lost connection in this foundation.
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

The API validates Phase 2 domain input and persists state. It will request work
after the Phase 3 queue boundary exists. The worker will
load authoritative project/deployment state and run the pipeline. Long-running
CI and deployment operations must never run inside HTTP handlers. Queue,
signed-webhook receipt, and delivery-processing behavior are future work and are
not implemented by Phase 2. BullMQ remains the planned queue technology; no
queue or deployment behavior is implemented yet.

The implemented domain keeps overall deployment status separate from pipeline
stage and records the exact commit SHA. Phase 3 must use the implemented unique
delivery constraint to make GitHub delivery processing idempotent. Status
(`QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `ROLLED_BACK`) describes the outcome;
the worker will drive stage progress in later phases.

## Target deployment and release model

Later phases target immutable versioned releases on Linux/EC2:

```text
/srv/apps/<project>/
  releases/<release>/
  shared/.env
  current → releases/<active-release>
```

Each successful build will create a distinct release. Health-gated promotion
will switch `current`; rollback will activate an already-built known-good
release without rebuilding the old commit. The repository does not implement
SSH, Linux/EC2 deployment, PM2, Nginx, release switching, health checks, or
rollback yet.

## Target observability boundary

Later observability will cover API, worker, deployment duration, outcomes,
rollback count, queue depth, latency, health, and useful structured logs using
the planned OpenTelemetry/Prometheus/Loki/Grafana stack. `packages/observability`
is intentionally deferred until that phase.

## Technology direction

The implemented foundation uses Node.js, Express, React, Vite, TypeScript,
native MongoDB, Redis, Zod, Pino, and ioredis. The product direction retains
BullMQ for asynchronous jobs; SSH to Linux/EC2, PM2, and Nginx belong to remote
release deployment; Server-Sent Events are preferred later for server-to-browser
status and log streams. Phosphor icons and the shadcn-inspired visual system
belong to the later dashboard phase. No technology is added solely for résumé
value.

## Architectural guardrails

Keep controllers thin, validate at boundaries, and keep GitHub and queue
integrations behind focused modules. Prefer identifiers such as `deploymentId`
in queue payloads so MongoDB remains authoritative. Do not introduce a major
technology or package for appearance or résumé value. Authentication and
isolation for untrusted build commands remain explicit future security work. The
Phase 1 process boundary is useful, but it does not yet provide authentication,
authorization, sandboxing, secret isolation, or production-grade reconnect and
telemetry behavior.
