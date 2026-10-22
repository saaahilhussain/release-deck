import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  MAX_APPLICATION_ROOT_BYTES,
  readReleaseDeckBuildPlan,
  resolveApplicationRoot,
  validateApplicationRoot,
} from './index.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-project-config-'));
  await mkdir(join(root, 'server', 'nested'), { recursive: true });
  return root;
}

test('manifest defaults preserve the root required-build contract', async () => {
  const root = await fixture();
  try {
    assert.deepEqual(await readReleaseDeckBuildPlan(root), {
      applicationRoot: '.',
      build: 'required',
    });
    await writeFile(join(root, '.releasedeck.json'), '{"schemaVersion":1}');
    assert.deepEqual(await readReleaseDeckBuildPlan(root), {
      applicationRoot: '.',
      build: 'required',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('schema 1 accepts a nested application root and intentionally omitted build', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, '.releasedeck.json'),
      JSON.stringify({ schemaVersion: 1, applicationRoot: 'server', build: 'none' }),
    );
    assert.deepEqual(await readReleaseDeckBuildPlan(root), {
      applicationRoot: 'server',
      build: 'none',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifest rejects unknown schemas, keys, and build modes', async () => {
  const root = await fixture();
  try {
    for (const manifest of [
      {},
      { schemaVersion: 2 },
      { schemaVersion: 1, command: 'npm run anything' },
      { schemaVersion: 1, build: 'optional' },
      { schemaVersion: 1, applicationRoot: null },
      { schemaVersion: 1, build: null },
    ]) {
      await writeFile(join(root, '.releasedeck.json'), JSON.stringify(manifest));
      await assert.rejects(readReleaseDeckBuildPlan(root));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('application-root syntax accepts only bounded repository-relative POSIX paths', () => {
  assert.equal(validateApplicationRoot('.'), '.');
  assert.equal(validateApplicationRoot('server'), 'server');
  assert.equal(validateApplicationRoot('服务/应用'), '服务/应用');
  assert.equal(
    validateApplicationRoot('é'.repeat(MAX_APPLICATION_ROOT_BYTES / 2)),
    'é'.repeat(MAX_APPLICATION_ROOT_BYTES / 2),
  );
  for (const value of [
    '/server',
    'C:/server',
    'C:server',
    'server\\nested',
    '..',
    '../server',
    'server/../client',
    'server//nested',
    'server/',
    './server',
    'server/./nested',
    'server\u0000nested',
    'server\u001fnested',
    '\ud800',
    '\udc00',
    'x'.repeat(MAX_APPLICATION_ROOT_BYTES + 1),
    `${'é'.repeat(MAX_APPLICATION_ROOT_BYTES / 2)}a`,
  ]) {
    assert.throws(() => validateApplicationRoot(value), Error, String(value));
  }
});

test('filesystem validation rejects symlinked roots and intermediate components', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'releasedeck-project-outside-'));
  try {
    assert.equal(await resolveApplicationRoot(root, '.'), resolve(root));
    assert.equal(await resolveApplicationRoot(root, 'server'), resolve(root, 'server'));
    for (const [name, target] of [
      ['linked-root', outside],
      ['linked-parent', outside],
    ] as const) {
      try {
        if (name === 'linked-root') {
          await symlink(
            target,
            join(root, 'linked-root'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          await assert.rejects(resolveApplicationRoot(root, 'linked-root'));
        } else {
          await symlink(
            target,
            join(root, 'linked-parent'),
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          await assert.rejects(resolveApplicationRoot(root, 'linked-parent/nested'));
        }
      } catch (error) {
        if (
          process.platform === 'win32' &&
          (error as NodeJS.ErrnoException).code === 'EPERM'
        ) {
          t.diagnostic('symlink creation is unavailable on this Windows host');
          return;
        }
        throw error;
      }
    }
    await assert.rejects(resolveApplicationRoot(root, '../outside'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
