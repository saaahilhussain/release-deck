import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { startApi } from '../apps/api/dist/server.js';

// Opt-in integration checks. Requires built apps and running development services.
// API startup ensures Phase 2 indexes; no domain records or Redis keys are written.
const root = new URL('../', import.meta.url);
const environment = {
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  HOST: '127.0.0.1',
  MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/releasedeck',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
};
const children = new Set();

async function waitFor(predicate, label, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function launch(app, overrides = {}, withSignalBridge = false) {
  // Windows kill(SIGTERM) terminates a process without invoking JS handlers.
  // The IPC bridge deliberately tests the registered handler, not OS delivery.
  const bridge = `
    process.on('message', (message) => {
      if (message === 'shutdown') process.emit('SIGTERM', 'SIGTERM');
    });
    await import('./dist/index.js');
    if (process.exitCode) process.disconnect();
  `;
  const child = spawn(
    process.execPath,
    withSignalBridge ? ['--input-type=module', '-e', bridge] : ['dist/index.js'],
    {
      cwd: fileURLToPath(new URL(`apps/${app}/`, root)),
      env: { ...environment, ...overrides },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', ...(withSignalBridge ? ['ipc'] : [])],
    },
  );
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = once(child, 'exit').then(([code]) => {
    children.delete(child);
    return code;
  });
  return { child, exited, output: () => output };
}

async function waitForExit(run) {
  await waitFor(
    () => run.child.exitCode !== null || run.child.signalCode !== null,
    'process exit',
  );
  return run.exited;
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function expectFailure(app, overrides, reason) {
  const run = launch(app, overrides);
  assert.equal(await waitForExit(run), 1, `${app}: ${reason} must exit 1`);
  assert.match(run.output(), /startup failed/);
  assert.doesNotMatch(run.output(), /phase01-secret/);
  console.log(`PASS ${app}: ${reason}, bounded nonzero exit`);
}

try {
  const port = await unusedPort();
  const api = launch('api', { PORT: String(port) }, true);
  await waitFor(() => api.output().includes('api started'), 'API startup');
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'healthy',
    dependencies: { mongodb: 'available', redis: 'available' },
  });
  assert.equal(response.headers.get('x-powered-by'), null);
  console.log('PASS API: real MongoDB/Redis health probes return 200');

  const degradedPort = await unusedPort();
  const degraded = await startApi({ ...environment, PORT: degradedPort });
  try {
    // Drop only this API instance's client connection, never the shared service.
    await degraded.services.mongo.close();
    const unavailable = await fetch(`http://127.0.0.1:${degradedPort}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      status: 'unavailable',
      dependencies: { mongodb: 'unavailable', redis: 'available' },
    });
    console.log('PASS API: closed real MongoDB client produces HTTP 503');
  } finally {
    await degraded.close();
  }

  const worker = launch('worker', {}, true);
  await waitFor(
    () => worker.output().includes('worker connected and waiting'),
    'worker startup',
  );
  console.log('PASS worker: connects and waits without starting deployment jobs');

  await expectFailure('api', { PORT: String(port) }, 'occupied listen port');
  for (const app of ['api', 'worker']) {
    await expectFailure(app, { LOG_LEVEL: 'phase01-secret' }, 'invalid environment');
    await expectFailure(app, { REDIS_URL: 'redis://' }, 'malformed Redis URL');
    await expectFailure(app, { MONGODB_URI: 'mongodb://' }, 'malformed MongoDB URI');
    await expectFailure(
      app,
      { MONGODB_URI: `mongodb://127.0.0.1:${await unusedPort()}/releasedeck` },
      'unreachable MongoDB',
    );
    await expectFailure(
      app,
      { REDIS_URL: `redis://127.0.0.1:${await unusedPort()}` },
      'unreachable Redis after MongoDB connects',
    );
  }

  // Accept TCP connections but never answer the database protocol. Refusal-only
  // tests cannot demonstrate that a reachable, stalled service has a deadline.
  const sockets = new Set();
  const blackhole = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  blackhole.listen(0, '127.0.0.1');
  await once(blackhole, 'listening');
  const stalledPort = blackhole.address().port;
  try {
    await expectFailure(
      'api',
      { MONGODB_URI: `mongodb://127.0.0.1:${stalledPort}/releasedeck` },
      'stalled MongoDB handshake',
    );
    await expectFailure(
      'api',
      { REDIS_URL: `redis://127.0.0.1:${stalledPort}` },
      'stalled Redis handshake',
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => blackhole.close(resolve));
  }

  for (const [name, run] of [
    ['api', api],
    ['worker', worker],
  ]) {
    run.child.send('shutdown');
    assert.equal(await waitForExit(run), 0, `${name} shutdown must exit 0`);
    assert.match(run.output(), /shutting down/);
    console.log(
      `PASS ${name}: registered SIGTERM handler closes resources and exits 0 (IPC simulation)`,
    );
  }
} finally {
  for (const child of children) child.kill();
}
