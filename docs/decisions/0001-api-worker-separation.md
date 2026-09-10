# ADR 0001: Separate the API control plane from worker execution

Status: Accepted and implemented at the Phase 1 process boundary.

## Context

ReleaseDeck will receive webhooks and user requests while also running commands
that may take minutes, fail, time out, or need isolated workspaces. Running that
work in an HTTP request would couple request latency and availability to the
deployment pipeline.

## Decision

The API is the control plane: it validates requests, records state, and requests
work. The worker is the execution plane: it loads authoritative state and runs
CI/deployment operations. In Phase 1, the API exposes only a dependency health
endpoint and the worker connects to dependencies then waits. Future queue jobs
should carry identifiers such as `deploymentId`, with MongoDB remaining
authoritative.

## Alternatives considered

- Execute deployments inside API handlers: simpler initially, but causes request
  timeouts, poor crash recovery, and resource contention.
- Put all HTTP and execution code in one process: fewer packages, but weaker
  failure isolation and a less clear scaling boundary.

## Consequences

The boundary improves failure isolation and makes retries and worker scaling
possible. It adds process, queue, and state-transition complexity. Phase 1
establishes the process/package boundary, bounded startup/health probes, and
graceful shutdown, but it does not add a queue or deployment execution. A lost
Redis connection currently requires process restart because automatic reconnect
is intentionally disabled until reliability requirements are designed.
