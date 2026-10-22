import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import type { BuildExecutor } from './build-executor.js';
import {
  createGitHubAppAuth,
  GitHubAppAuthenticationError,
  type GitHubAppAuth,
} from './github-app-auth.js';
import {
  authenticatedGitHubFetch,
  GITHUB_CREDENTIAL_HELPER,
} from './github-checkout.js';
import {
  createCiEnvironment,
  githubCredentialEnvironment,
  defaultProcessRunner,
  ProcessCancelledError,
  ProcessTerminationError,
  ProcessTimeoutError,
  type ProcessResult,
  type ProcessRunner,
} from './process.js';
import { createCiRunner } from './runner.js';

const exec = promisify(execFile);
const sha = 'a'.repeat(40);
const url = 'https://github.com/owner/repository.git';
const token = 'installation-token-canary';
const fetchArgs = ['fetch', '--no-tags', '--depth=1', 'origin', sha];
function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    command: 'git',
    args: [],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    ...overrides,
  };
}
const authRequired =
  "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
const input = {
  deploymentId: '123e4567-e89b-12d3-a456-426614174000',
  repositoryUrl: url,
  commitSha: sha,
};
const auth: GitHubAppAuth = { installationToken: async () => token };

function executor(check: () => Promise<void>): BuildExecutor {
  return {
    probe: async () => undefined,
    async open(workspacePath) {
      await check();
      return {
        workspacePath,
        run: async (_stage, _manager, _workingDirectory, options) => {
          assert.equal(options.githubCredential, undefined);
          return result();
        },
        completeBuild: async () => result(),
        collect: async () => undefined,
        close: async () => undefined,
      };
    },
  };
}

test('real Git credential protocol and environment configuration scope helper to the exact GitHub HTTPS path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-helper-test-'));
  try {
    const helperPath = join(root, 'credential.cjs');
    await writeFile(helperPath, GITHUB_CREDENTIAL_HELPER, { mode: 0o600 });
    assert.equal((await readFile(helperPath, 'utf8')).includes(token), false);
    const env = {
      ...createCiEnvironment(root),
      ...githubCredentialEnvironment({
        token,
        helperPath,
        repositoryPath: 'owner/repository.git',
      }),
    };
    await exec('git', ['init', '--quiet'], {
      cwd: root,
      env: createCiEnvironment(root),
    });
    await exec('git', ['remote', 'add', 'origin', url], {
      cwd: root,
      env: createCiEnvironment(root),
    });
    const configBefore = await readFile(join(root, '.git', 'config'), 'utf8');
    const globalConfigPath = join(root, '.gitconfig');
    const globalBefore = '[credential]\n\thelper = !echo hostile-ambient-helper\n';
    await writeFile(globalConfigPath, globalBefore);
    // Running actual `git credential fill` is entirely offline: no GitHub requests.
    const fill = (text: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        import('node:child_process')
          .then(({ spawn }) => {
            const child = spawn('git', ['credential', 'fill'], {
              cwd: root,
              env,
              shell: false,
              windowsHide: true,
            });
            let stdout = '';
            child.stdout.on('data', (chunk) => {
              stdout += String(chunk);
            });
            child.stderr.resume();
            child.once('error', reject);
            child.once('close', (code) => resolve({ code, stdout }));
            child.stdin.end(text + '\n\n');
          })
          .catch(reject);
      });
    const valid = await fill(
      'protocol=https\nhost=github.com\npath=owner/repository.git',
    );
    assert.equal(valid.code, 0);
    assert.ok(valid.stdout.includes(`password=${token}`));
    for (const text of [
      'protocol=https\nhost=example.com\npath=owner/repository.git',
      'protocol=http\nhost=github.com\npath=owner/repository.git',
      'protocol=https\nhost=github.com\npath=other/repository.git',
      'protocol=https\nhost=github.com\npath=owner/other.git',
      'protocol=https\nhost=github.com',
    ]) {
      const refused = await fill(text);
      assert.notEqual(refused.code, 0);
      assert.equal(refused.stdout.includes(token), false);
    }
    assert.equal(await readFile(join(root, '.git', 'config'), 'utf8'), configBefore);
    assert.equal(await readFile(globalConfigPath, 'utf8'), globalBefore);
    const localConfig = (
      await exec('git', ['config', '--local', '--list'], { cwd: root, env })
    ).stdout;
    assert.equal(localConfig.includes(token), false);
    assert.equal(localConfig.includes('credential.helper'), false);
    assert.equal(localConfig.includes('http.extraheader'), false);
    assert.ok(localConfig.includes(url));
    assert.equal(
      (await exec('git', ['config', '--global', '--list'], { cwd: root, env })).stdout,
      '',
    );
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(
      (
        await exec('git', ['config', '--get', 'gc.auto'], { cwd: root, env })
      ).stdout.trim(),
      '0',
    );
    assert.equal(
      (
        await exec('git', ['config', '--get', 'maintenance.auto'], { cwd: root, env })
      ).stdout.trim(),
      'false',
    );
    assert.equal(
      (
        await exec('git', ['config', '--get', 'fetch.recurseSubmodules'], {
          cwd: root,
          env,
        })
      ).stdout.trim(),
      'false',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of [
  'success',
  'failure',
  'timeout',
  'cancel',
  'exception',
  'termination',
  'api-failure',
] as const) {
  test(`authenticated fetch sanitizes all output and clears token/helper/environment before returning: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'releasedeck-auth-cleanup-'));
    let credential: Parameters<typeof githubCredentialEnvironment>[0] | undefined;
    let helperPath: string | undefined;
    const controller = new AbortController();
    try {
      const processRunner: ProcessRunner = {
        async run(command, args, options) {
          assert.equal(command, 'git');
          assert.deepEqual(args, fetchArgs);
          assert.equal(JSON.stringify(args).includes(token), false);
          credential = options.githubCredential;
          assert.equal(credential?.token, token);
          helperPath = credential!.helperPath;
          assert.equal((await readFile(helperPath, 'utf8')).includes(token), false);
          const secretResult = result({ stdout: token, stderr: token });
          if (mode === 'timeout') throw new ProcessTimeoutError(secretResult);
          if (mode === 'termination') throw new ProcessTerminationError();
          if (mode === 'cancel') {
            controller.abort();
            throw new ProcessCancelledError(secretResult);
          }
          if (mode === 'exception') throw new Error(token);
          return result({
            stdout: token,
            stderr: token,
            exitCode: mode === 'failure' ? 128 : 0,
          });
        },
      };
      const operation = authenticatedGitHubFetch(
        mode === 'api-failure'
          ? {
              installationToken: async () => {
                throw new Error(token);
              },
            }
          : auth,
        url,
        fetchArgs,
        processRunner,
        { cwd: join(root, 'checkout'), signal: controller.signal },
      );
      if (mode === 'success' || mode === 'failure') {
        assert.equal(JSON.stringify(await operation).includes(token), false);
      } else {
        await assert.rejects(operation, (error: Error) => {
          if (mode === 'termination')
            assert.ok(error instanceof ProcessTerminationError);
          assert.equal(error.message.includes(token), false);
          assert.equal(JSON.stringify(error).includes(token), false);
          assert.equal(error.cause, undefined);
          return true;
        });
      }
      if (helperPath) await assert.rejects(access(helperPath));
      if (credential) assert.equal(credential.token, '');
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const authenticated of [false, true]) {
  test(`runner preserves exact SHA, safe evidence and credential-free handoff: ${authenticated ? 'private' : 'public without configuration'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'releasedeck-auth-runner-'));
    let tokens = 0;
    let fetches = 0;
    const evidence: unknown[] = [];
    const processRunner: ProcessRunner = {
      async run(command, args, options) {
        assert.equal(command, 'git');
        if (args[0] === 'init')
          await Promise.all([
            writeFile(join(options.cwd, 'package.json'), '{}'),
            writeFile(join(options.cwd, 'package-lock.json'), '{}'),
          ]);
        if (args[0] === 'remote') assert.equal(args.at(-1), url);
        if (args[0] === 'fetch') {
          assert.equal(args.at(-1), sha);
          fetches++;
          if (authenticated && !options.githubCredential)
            return result({ exitCode: 128, stderr: authRequired });
          if (authenticated) assert.equal(options.githubCredential?.token, token);
          return result({
            stdout: authenticated ? token : '',
            stderr: authenticated ? token : '',
          });
        }
        assert.equal(options.githubCredential, undefined);
        return result({ stdout: args[0] === 'rev-parse' ? sha : '' });
      },
    };
    try {
      const output = await createCiRunner({
        workspaceRoot: root,
        processRunner,
        ...(authenticated
          ? {
              githubAppAuth: {
                installationToken: async () => {
                  tokens++;
                  return token;
                },
              },
            }
          : {}),
        buildExecutor: executor(async () => {
          assert.equal(
            (await readdir(root)).some((name) =>
              name.startsWith('.releasedeck-github-'),
            ),
            false,
          );
        }),
      }).run(input, {
        onStageCompleted: (value) => {
          evidence.push(value);
        },
      });
      assert.equal(output.commitSha, sha);
      assert.equal(fetches, authenticated ? 2 : 1);
      assert.equal(tokens, authenticated ? 1 : 0);
      assert.equal(JSON.stringify([evidence, output]).includes(token), false);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('public fetch with configured App does not mint a token; missing auth config fails clearly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-public-first-'));
  try {
    let tokens = 0;
    let requiresAuth = false;
    const processRunner: ProcessRunner = {
      async run(_command, args, options) {
        if (args[0] === 'init')
          await Promise.all([
            writeFile(join(options.cwd, 'package.json'), '{}'),
            writeFile(join(options.cwd, 'package-lock.json'), '{}'),
          ]);
        return result({
          stdout: args[0] === 'rev-parse' ? sha : '',
          ...(requiresAuth && args[0] === 'fetch'
            ? { exitCode: 128, stderr: authRequired }
            : {}),
        });
      },
    };
    await createCiRunner({
      workspaceRoot: root,
      processRunner,
      githubAppAuth: {
        installationToken: async () => {
          tokens++;
          return token;
        },
      },
      buildExecutor: executor(async () => undefined),
    }).run(input);
    assert.equal(tokens, 0);
    requiresAuth = true;
    await assert.rejects(
      createCiRunner({ workspaceRoot: root, processRunner }).run(input),
      /configuration is required/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('network, plain 404, invalid SHA and non-GitHub failures never receive credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-no-auth-retry-'));
  try {
    for (const [repositoryUrl, stderr] of [
      [url, 'fatal: unable to access: Could not resolve host: github.com'],
      [url, 'remote: Repository not found.\nfatal: repository not found'],
      [url, 'fatal: remote error: upload-pack: not our ref ' + sha],
      ['https://example.com/owner/repo.git', authRequired],
      ['file:///fixture', authRequired],
    ] as const) {
      let tokens = 0;
      const processRunner: ProcessRunner = {
        async run(_command, args, options) {
          assert.equal(options.githubCredential, undefined);
          return result(args[0] === 'fetch' ? { exitCode: 128, stderr } : {});
        },
      };
      await assert.rejects(
        createCiRunner({
          workspaceRoot: root,
          processRunner,
          buildExecutor: executor(async () => undefined),
          githubAppAuth: {
            installationToken: async () => {
              tokens++;
              return token;
            },
          },
        }).run({ ...input, repositoryUrl }),
      );
      assert.equal(tokens, 0);
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auth cannot run without a build boundary or attach credentials to build commands', async () => {
  assert.throws(
    () => createCiRunner({ workspaceRoot: tmpdir(), githubAppAuth: auth }),
    /requires isolated build/,
  );
  assert.throws(
    () =>
      defaultProcessRunner.run('npm', ['ci'], {
        cwd: tmpdir(),
        githubCredential: {
          token,
          helperPath: '/helper',
          repositoryPath: 'owner/repo',
        },
      }),
    /restricted to exact-SHA fetch/,
  );
});

test('exact-SHA mismatch after authenticated fetch fails and cleans up before any build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-sha-auth-'));
  let opened = false;
  try {
    const runner = createCiRunner({
      workspaceRoot: root,
      githubAppAuth: auth,
      buildExecutor: executor(async () => {
        opened = true;
      }),
      processRunner: {
        async run(_command, args, options) {
          if (args[0] === 'fetch' && !options.githubCredential)
            return result({ exitCode: 128, stderr: authRequired });
          return result({ stdout: args[0] === 'rev-parse' ? 'b'.repeat(40) : '' });
        },
      },
    });
    await assert.rejects(runner.run(input), /revision did not match/);
    assert.equal(opened, false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('checkout-wide cancellation during API request preserves fencing cancellation and creates no helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-auth-cancel-api-'));
  const controller = new AbortController();
  try {
    const runner = createCiRunner({
      workspaceRoot: root,
      buildExecutor: executor(async () => assert.fail('no build')),
      githubAppAuth: {
        installationToken: async () => {
          controller.abort();
          throw new GitHubAppAuthenticationError(
            'GitHub checkout cancelled',
            'CHECKOUT_CANCELLED',
          );
        },
      },
      processRunner: {
        run: async (_command, args) =>
          result(args[0] === 'fetch' ? { exitCode: 128, stderr: authRequired } : {}),
      },
    });
    await assert.rejects(
      runner.run({ ...input, signal: controller.signal }),
      ProcessCancelledError,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('private runner integrates real JWT signing, mocked token HTTP, authenticated fetch and build handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releasedeck-private-integration-'));
  let requests = 0;
  let fetched = false;
  try {
    const keyPath = join(root, 'worker.pem');
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await writeFile(keyPath, key.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    const provider = await createGitHubAppAuth(
      { appId: '123', installationId: '456', privateKeyPath: keyPath },
      {
        fetch: async (_url, init) => {
          requests++;
          assert.ok(
            new Headers(init?.headers).get('Authorization')?.startsWith('Bearer eyJ'),
          );
          return Response.json(
            {
              token,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions: { contents: 'read' },
            },
            { status: 201 },
          );
        },
      },
    );
    const runner = createCiRunner({
      workspaceRoot: join(root, 'checkouts'),
      githubAppAuth: provider,
      buildExecutor: executor(async () => {
        assert.equal(fetched, true);
        assert.equal(
          (await readdir(join(root, 'checkouts'))).some((name) =>
            name.startsWith('.releasedeck-github-'),
          ),
          false,
        );
      }),
      processRunner: {
        async run(_command, args, options) {
          if (args[0] === 'init')
            await Promise.all([
              writeFile(join(options.cwd, 'package.json'), '{}'),
              writeFile(join(options.cwd, 'package-lock.json'), '{}'),
            ]);
          if (args[0] === 'fetch') {
            if (!options.githubCredential)
              return result({ exitCode: 128, stderr: authRequired });
            assert.equal(options.githubCredential.token, token);
            assert.equal(JSON.stringify(args).includes(token), false);
            fetched = true;
          }
          return result({ stdout: args[0] === 'rev-parse' ? sha : '' });
        },
      },
    });
    assert.equal((await runner.run(input)).commitSha, sha);
    assert.equal(requests, 1);
    assert.deepEqual(await readdir(join(root, 'checkouts')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
