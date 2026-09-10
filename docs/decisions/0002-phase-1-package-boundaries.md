# ADR 0002: Keep Phase 1 package boundaries minimal

Status: Accepted and implemented for Phase 1.

## Context

The intended product has several eventual domains, but an empty monorepo should
not contain packages that only signal future architecture. Phase 1 needs shared
runtime concerns and a database connection boundary without prematurely freezing
domain APIs.

## Decision

Phase 1 uses `packages/db`, `packages/runtime`, and `packages/tsconfig`.
`packages/db` owns native MongoDB connectivity; `packages/runtime` owns Zod
environment validation, app-relative dotenv loading, Pino logging, and Redis
support; `packages/tsconfig` owns shared TypeScript configuration. Defer
`packages/shared`, `packages/deployment-core`, and `packages/observability` until
real consumers justify them.

## Alternatives considered

- Create every planned package immediately: visually complete, but creates empty
  boundaries and premature coupling.
- Keep all shared code in each app: faster to start, but duplicates runtime
  behavior and makes later consistency harder.

## Consequences

The foundation stays understandable and easy to change. Some duplication may
remain temporarily until a real shared contract appears. The package APIs and
tooling configuration are implemented and remain small until later phases
introduce consumers that justify additional boundaries.
