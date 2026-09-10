import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InvalidTransitionError,
  createProject,
  createQueuedDeployment,
  encodeCursor,
  decodeCursor,
  transitionDeployment,
} from './index.js';

const sha = '0123456789abcdef0123456789abcdef01234567';

test('project coordinates and deployment SHA are normalized and bounded', () => {
  const project = createProject({ owner: 'Acme', repository: 'Release-Deck' });
  assert.equal(project.provider, 'github');
  assert.equal(project.owner, 'acme');
  assert.equal(project.repository, 'release-deck');

  const deployment = createQueuedDeployment({
    projectId: project.id,
    commitSha: sha.toUpperCase(),
  });
  assert.equal(deployment.commitSha, sha);
  assert.equal(deployment.status, 'QUEUED');
  assert.equal(typeof deployment.stage, 'string');
});

test('deployment transition is pure, guarded, and versioned', () => {
  const current = createQueuedDeployment({
    projectId: '01234567-89ab-4cde-8012-3456789abcde',
    commitSha: sha,
  });
  const next = transitionDeployment(current, {
    expectedVersion: 1,
    status: 'RUNNING',
    stage: 'CHECKOUT',
  });
  assert.equal(current.version, 1);
  assert.equal(next.version, 2);
  assert.equal(next.status, 'RUNNING');
  assert.equal(next.stage, 'CHECKOUT');
  assert.throws(
    () => transitionDeployment(next, { expectedVersion: 1, status: 'SUCCESS' }),
    InvalidTransitionError,
  );
  assert.throws(
    () =>
      transitionDeployment(next, {
        expectedVersion: 2,
        status: 'SUCCESS',
        stage: 'BUILD',
      }),
    InvalidTransitionError,
  );
  assert.throws(
    () => transitionDeployment(current, { expectedVersion: 1, stage: 'COMPLETE' }),
    InvalidTransitionError,
  );
  assert.throws(
    () => transitionDeployment(next, { expectedVersion: 2, stage: 'QUEUED' }),
    InvalidTransitionError,
  );
  assert.throws(
    () => transitionDeployment(next, { expectedVersion: 2, stage: 'ROLLBACK' }),
    InvalidTransitionError,
  );
});

test('domain validation cannot be bypassed by non-HTTP callers', () => {
  assert.throws(() => createProject({ owner: 'bad/owner', repository: 'repo' }));
  assert.throws(() => createProject({ owner: 'owner', repository: '../repo' }));
  assert.throws(() =>
    createQueuedDeployment({ projectId: 'not-a-uuid', commitSha: sha }),
  );
});

test('cursor round-trips an ordering position without exposing its representation', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const cursor = encodeCursor({ createdAt, id: 'record-1' });
  assert.notEqual(cursor, JSON.stringify({ createdAt, id: 'record-1' }));
  const decoded = decodeCursor(cursor);
  assert.equal(decoded.id, 'record-1');
  assert.equal(decoded.createdAt.toISOString(), createdAt.toISOString());
  assert.throws(() => decodeCursor('not-json'));
});
