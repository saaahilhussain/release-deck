import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  GitHubAppAuthenticationError,
  githubRepository,
  type GitHubAppAuth,
} from './github-app-auth.js';
import {
  DEFAULT_TIMEOUT_MS,
  ProcessCancelledError,
  ProcessTimeoutError,
  ProcessTerminationError,
  type ProcessOptions,
  type ProcessResult,
  type ProcessRunner,
  type GitHubCheckoutCredential,
} from './process.js';

// Static trusted code, not a token-bearing file. store/erase are deliberate no-ops.
export const GITHUB_CREDENTIAL_HELPER = `
if (process.argv[2] !== 'get') process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 8192) process.exit(1);
});
process.stdin.on('end', () => {
  const fields = new Map();
  for (const line of input.trimEnd().split('\\n')) {
    const at = line.indexOf('=');
    if (at < 1 || fields.has(line.slice(0, at))) process.exit(1);
    fields.set(line.slice(0, at), line.slice(at + 1));
  }
  if (fields.get('protocol') !== 'https' || fields.get('host') !== 'github.com' ||
      !process.env.RELEASEDECK_CHECKOUT_PATH || !fields.get('path') ||
      fields.get('path')?.toLowerCase() !== process.env.RELEASEDECK_CHECKOUT_PATH ||
      !/^[A-Za-z0-9_.-]{1,4096}$/.test(process.env.RELEASEDECK_CHECKOUT_TOKEN || '')) process.exit(1);
  process.stdout.write('username=x-access-token\\npassword=' + process.env.RELEASEDECK_CHECKOUT_TOKEN + '\\n\\n');
});
`;

export function requiresGitHubAuthentication(
  repositoryUrl: string,
  result: ProcessResult,
): boolean {
  if (!githubRepository(repositoryUrl) || result.exitCode === 0) return false;
  // A plain 404 is ambiguous (typo/deleted repository), so never retry that alone.
  return /^fatal: (?:could not read (?:Username|Password) for 'https:\/\/github\.com(?:\/[A-Za-z0-9._/-]+)?': terminal prompts disabled|Authentication failed for 'https:\/\/github\.com\/[A-Za-z0-9._/-]+')\s*$/m.test(
    result.stderr,
  );
}

async function removeHelper(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    throw new GitHubAppAuthenticationError('GitHub checkout helper cleanup failed');
  }
}

function cleanResult(
  args: readonly string[],
  durationMs: number,
  result?: ProcessResult,
): ProcessResult {
  return {
    command: 'git',
    args,
    durationMs,
    exitCode: result?.exitCode ?? null,
    signal: result?.signal ?? null,
    stdout: '',
    stderr: result?.exitCode === 0 ? '' : 'Authenticated GitHub fetch failed',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

/** Own every token reference/helper until fetch has stopped, before source handoff. */
export async function authenticatedGitHubFetch(
  auth: GitHubAppAuth,
  repositoryUrl: string,
  args: readonly string[],
  processRunner: ProcessRunner,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const repository = githubRepository(repositoryUrl);
  if (!repository)
    throw new GitHubAppAuthenticationError(
      'Unsupported authenticated GitHub repository',
    );
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = () => Math.max(1, deadline - Date.now());
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), remaining());
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  let directory: string | undefined;
  let credential: GitHubCheckoutCredential | undefined;
  try {
    const token = await auth.installationToken(repository, signal, remaining());
    signal.throwIfAborted();
    if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(token)) throw new Error();
    // A sibling under the worker's private checkout root is never copied to builds.
    directory = await mkdtemp(join(dirname(options.cwd), '.releasedeck-github-'));
    const helperPath = join(directory, 'credential.cjs');
    await writeFile(helperPath, GITHUB_CREDENTIAL_HELPER, { mode: 0o600, flag: 'wx' });
    credential = { token, helperPath, repositoryPath: repository.path };
    signal.throwIfAborted();
    const result = await processRunner.run('git', args, {
      ...options,
      signal,
      timeoutMs: remaining(),
      githubCredential: credential,
    });
    // Authenticated subprocess diagnostics are never evidence, even on success.
    return cleanResult(args, Date.now() - started, result);
  } catch (error) {
    if (error instanceof ProcessTerminationError) throw error;
    const result = cleanResult(args, Date.now() - started);
    if (
      options.signal?.aborted ||
      error instanceof ProcessCancelledError ||
      (error instanceof GitHubAppAuthenticationError &&
        error.code === 'CHECKOUT_CANCELLED')
    ) {
      throw new ProcessCancelledError(result);
    }
    if (
      timeout.signal.aborted ||
      error instanceof ProcessTimeoutError ||
      (error instanceof GitHubAppAuthenticationError &&
        error.code === 'CHECKOUT_TIMEOUT')
    ) {
      throw new ProcessTimeoutError(result);
    }
    if (error instanceof GitHubAppAuthenticationError) throw error;
    throw new GitHubAppAuthenticationError('GitHub App authenticated checkout failed');
  } finally {
    clearTimeout(timer);
    if (credential) credential.token = '';
    // Cleanup failure prevents handoff even after a successful fetch.
    if (directory) await removeHelper(directory);
  }
}
