import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { loadComponents, mount, settle } from './component-harness.mjs';

const now = '2026-10-18T10:00:00.000Z';
const project = (id) => ({
  id,
  provider: 'github',
  owner: 'fixture',
  repository: id,
  defaultBranch: 'main',
  createdAt: now,
  updatedAt: now,
});
function deployment(id, letter, outcome) {
  return {
    id,
    projectId: id === 'b-first' ? 'project-b' : 'project-a',
    provider: 'github',
    commitSha: letter.repeat(40),
    status: outcome === 'RESTORED' ? 'ROLLED_BACK' : outcome ? 'FAILED' : 'RUNNING',
    stage: outcome ? 'ROLLBACK' : 'BUILD',
    version: 1,
    createdAt: now,
    updatedAt: now,
    activity: [],
    ...(outcome
      ? {
          release: {
            status: outcome === 'RESTORED' ? 'ROLLED_BACK' : 'ROLLBACK_FAILED',
            releaseId: id,
            rollback: {
              mode: 'AUTOMATIC',
              outcome,
              targetDeploymentId: 'target',
              targetReleaseId: 'target',
              targetCommitSha: 'c'.repeat(40),
              completedAt: now,
            },
          },
        }
      : {}),
  };
}
const data = {
  failed: deployment('failed', 'a', 'FAILED'),
  restored: deployment('restored', 'b', 'RESTORED'),
  timeout: deployment('timeout', 'e'),
  'a-page-two': deployment('a-page-two', 'f'),
  'b-first': deployment('b-first', '1'),
};
let loaded;
before(async () => {
  loaded = await loadComponents();
});
after(async () => {
  await loaded?.cleanup();
});

test('failed restoration is labeled attempted; successful restoration is labeled restored', () => {
  for (const id of ['failed', 'restored']) {
    const html = renderToStaticMarkup(
      loaded.components.DeploymentDetail({
        base: data[id],
        detail: data[id],
        stream: 'live',
        error: '',
        retry() {},
      }),
    );
    if (id === 'failed') {
      assert.match(html, /Automatic \/ Failed/);
      assert.match(html, /Attempted release \(not restored\)/);
      assert.match(html, /Attempted commit \(not restored\)/);
      assert.doesNotMatch(html, /Restored release|Restored commit/);
    } else {
      assert.match(html, /Automatic \/ Restored/);
      assert.match(html, /Restored release/);
      assert.match(html, /Restored commit/);
    }
  }
});

test('operator sign-in reports safe errors and returns only the authenticated session', async () => {
  const savedFetch = globalThis.fetch;
  let responseStatus = 401;
  let submitted;
  let signedIn;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://fixture.invalid');
    if (parsed.pathname === '/api/auth/login') {
      submitted = JSON.parse(options.body);
      if (responseStatus === 401) return { ok: false, status: 401 };
      return { ok: true, status: 204 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        operator: { id: 'operator', role: 'operator' },
        csrfToken: 'c'.repeat(43),
        idleExpiresAt: now,
        absoluteExpiresAt: now,
      }),
    };
  };
  const props = {
    state: 'unauthenticated',
    message: '',
    retry() {},
    signedIn(value) {
      signedIn = value;
    },
  };
  const app = mount(() => loaded.components.AuthenticationGate(props));
  try {
    app.input('operatorId').onChange({ target: { value: 'operator' } });
    await settle();
    app.input('password').onChange({ target: { value: 'not-the-password' } });
    await settle();
    app.form().onSubmit({ preventDefault() {} });
    await settle();
    assert.match(app.text(), /identifier or password is invalid/i);
    assert.deepEqual(submitted, {
      operatorId: 'operator',
      password: 'not-the-password',
    });

    responseStatus = 200;
    app.input('password').onChange({ target: { value: 'correct-password' } });
    await settle();
    app.form().onSubmit({ preventDefault() {} });
    await settle();
    assert.equal(signedIn.operator.id, 'operator');
    assert.doesNotMatch(app.text(), /correct-password/);
  } finally {
    app.close();
    globalThis.fetch = savedFetch;
  }
});

test('authentication-unavailable state is distinct from operator sign-in', () => {
  const app = mount(() =>
    loaded.components.AuthenticationGate({
      state: 'unavailable',
      message: 'The authentication service is unavailable.',
      retry() {},
      signedIn() {},
    }),
  );
  try {
    assert.match(app.text(), /ReleaseDeck is unavailable/);
    assert.match(app.text(), /Retry connection/);
    assert.doesNotMatch(app.text(), /Operator identifier/);
  } finally {
    app.close();
  }
});

test('dashboard reports expired sessions and sends session CSRF evidence on logout', async () => {
  const savedFetch = globalThis.fetch;
  const session = {
    operator: { id: 'test-operator', role: 'operator' },
    csrfToken: 'z'.repeat(43),
    idleExpiresAt: now,
    absoluteExpiresAt: now,
  };
  let authFailures = 0;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const expiredProps = {
    session,
    authenticationFailed() {
      authFailures++;
    },
    signedOut() {},
  };
  const expired = mount(() => loaded.components.Dashboard(expiredProps));
  try {
    await settle();
    assert.equal(authFailures, 1);
  } finally {
    expired.close();
  }

  let logoutHeaders;
  let signedOut = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://fixture.invalid');
    if (parsed.pathname === '/api/auth/logout') {
      logoutHeaders = options.headers;
      return { ok: true, status: 204 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ projects: [], nextCursor: null }),
    };
  };
  const activeProps = {
    session,
    authenticationFailed() {},
    signedOut() {
      signedOut++;
    },
  };
  const active = mount(() => loaded.components.Dashboard(activeProps));
  try {
    await settle();
    active.button('Sign out').onClick();
    await settle();
    assert.equal(signedOut, 1);
    assert.equal(logoutHeaders['X-ReleaseDeck-CSRF'], session.csrfToken);
  } finally {
    active.close();
    globalThis.fetch = savedFetch;
  }
});

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const savedFetch = globalThis.fetch;
  const savedEvents = globalThis.EventSource;
  const calls = [],
    stalled = [];
  let active = 0,
    maxActive = 0;
  class Events {
    static all = [];
    listeners = new Map();
    constructor(url) {
      this.url = url;
      Events.all.push(this);
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    close() {}
    emit(value) {
      this.listeners.get('deployment')?.({
        data: JSON.stringify({ deployment: value }),
      });
    }
  }
  globalThis.EventSource = Events;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url, 'http://fixture.invalid');
    calls.push(parsed);
    const respond = (value) => ({ ok: true, status: 200, json: async () => value });
    if (parsed.pathname === '/api/auth/session')
      return respond({
        operator: { id: 'test-operator', role: 'operator' },
        csrfToken: 'c'.repeat(43),
        idleExpiresAt: now,
        absoluteExpiresAt: now,
      });
    if (parsed.pathname === '/api/projects')
      return respond({
        projects: parsed.searchParams.has('cursor')
          ? [project('project-b')]
          : [project('project-a'), project('project-b')],
        nextCursor: parsed.searchParams.has('cursor') ? null : 'projects-page-two',
      });
    const list = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/deployments$/);
    if (list)
      return respond({
        deployments:
          list[1] === 'project-b'
            ? [data['b-first']]
            : parsed.searchParams.has('cursor')
              ? [data['a-page-two']]
              : [data.failed, data.restored, data.timeout],
        nextCursor:
          list[1] === 'project-a' && !parsed.searchParams.has('cursor')
            ? 'a-cursor'
            : null,
      });
    const id = decodeURIComponent(parsed.pathname.split('/').at(-1));
    if (id !== 'timeout') return respond({ deployment: data[id] });
    active++;
    maxActive = Math.max(active, maxActive);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (action) => {
        if (!done) {
          done = true;
          active--;
          action();
        }
      };
      options.signal.addEventListener(
        'abort',
        () => finish(() => reject(new DOMException('aborted', 'AbortError'))),
        { once: true },
      );
      stalled.push({
        signal: options.signal,
        resolve: (value) => finish(() => resolve(respond({ deployment: value }))),
      });
    });
  };
  const dashboardProps = {
    session: {
      operator: { id: 'test-operator', role: 'operator' },
      csrfToken: 'c'.repeat(43),
      idleExpiresAt: now,
      absoluteExpiresAt: now,
    },
    authenticationFailed() {},
    signedOut() {},
  };
  const app = mount(() => loaded.components.Dashboard(dashboardProps));
  return {
    app,
    calls,
    stalled,
    Events,
    active: () => active,
    maxActive: () => maxActive,
    async tick(ms) {
      t.mock.timers.tick(ms);
      await settle();
    },
    close() {
      app.close();
      globalThis.fetch = savedFetch;
      globalThis.EventSource = savedEvents;
      t.mock.timers.reset();
    },
  };
}

test('explicit and automatic project switches reset deployment page/cursor', async (t) => {
  const f = fixture(t);
  try {
    await settle();
    f.app.button('Deployments').onClick();
    await settle();
    f.app.button('Next').onClick();
    await settle();
    assert.match(f.app.text(), /ffffffff/);
    f.app.selectProject('project-b');
    await settle();
    assert.match(f.app.text(), /11111111/);
    assert.match(f.app.text(), /Page 1/);
    f.app.selectProject('project-a');
    await settle();
    f.app.button('Next').onClick();
    await settle();
    f.app.button('Projects').onClick();
    await settle();
    f.app.button('Next').onClick();
    await settle();
    f.app.button('Deployments').onClick();
    await settle();
    assert.match(f.app.text(), /11111111/);
    const b = f.calls.filter(
      (u) => u.pathname === '/api/projects/project-b/deployments',
    );
    assert.equal(b.length, 2);
    assert.ok(b.every((u) => !u.searchParams.has('cursor')));
  } finally {
    f.close();
  }
});

test('stalled fallback is bounded, shared with batch reads, and cannot overwrite newer SSE evidence', async (t) => {
  const f = fixture(t);
  try {
    await settle();
    f.app.button('View deployment eeeeeeee').onClick();
    await settle();
    const stream = f.Events.all.findLast((e) => e.url.includes('/timeout/'));
    stream.onerror();
    stream.onerror();
    await settle();
    assert.match(f.app.text(), /Loading recorded evidence/);
    assert.equal(f.active(), 1);
    await f.tick(8000); // Batch timeout must not cancel the still-needed fallback.
    assert.equal(f.active(), 1);
    await f.tick(2000);
    assert.equal(f.active(), 0);
    assert.equal(f.stalled[0].signal.aborted, true);
    await f.tick(5000); // Page refresh and fallback retry share the next transport.
    assert.equal(f.active(), 1);
    const newer = { ...data.timeout, version: 3, status: 'SUCCESS', stage: 'COMPLETE' };
    stream.emit(newer);
    await settle();
    f.stalled.at(-1).resolve(data.timeout);
    await settle();
    assert.match(f.app.text(), /Success \/ Complete/);
    assert.equal(f.maxActive(), 1);
    f.app.button('View deployment bbbbbbbb').onClick();
    await settle();
    f.Events.all.findLast((e) => e.url.includes('/restored/')).emit(data.restored);
    await settle();
    assert.match(f.app.text(), /Restored release/);
    assert.doesNotMatch(f.app.text(), /Loading recorded evidence/);
  } finally {
    f.close();
  }
});
