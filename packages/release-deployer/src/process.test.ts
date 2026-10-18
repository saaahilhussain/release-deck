import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { defaultCommandExecutor } from './process.js';

for (const [platform, programData] of [
  ['win32', 'C:\\ProgramData'],
  ['win32', undefined],
  ['linux', 'C:\\ProgramData'],
] as const) {
  test(`executor filters child environment on ${platform} with ProgramData ${programData === undefined ? 'absent' : 'present'}`, async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const originalProgramData = process.env.ProgramData;
    const originalSentinel = process.env.RELEASEDECK_ENV_TEST_SECRET;
    const cwd = tmpdir();
    try {
      Object.defineProperty(process, 'platform', { value: platform });
      if (programData === undefined) delete process.env.ProgramData;
      else process.env.ProgramData = programData;
      process.env.RELEASEDECK_ENV_TEST_SECRET = 'must-not-reach-child';

      const result = await defaultCommandExecutor.run(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        { cwd, timeoutMs: 5_000, outputLimitBytes: 65_536 },
      );
      assert.equal(result.exitCode, 0);
      const environment = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
      assert.equal(
        environment.ProgramData,
        platform === 'win32' ? programData : undefined,
      );
      assert.equal(environment.PATH, process.env.PATH);
      for (const key of ['HOME', 'TEMP', 'TMP', 'TMPDIR']) {
        assert.equal(environment[key], cwd);
      }
      assert.equal(environment.RELEASEDECK_ENV_TEST_SECRET, undefined);
      const allowed = new Set(
        [
          'PATH',
          'SystemRoot',
          'WINDIR',
          'PATHEXT',
          'ComSpec',
          'SYSTEMDRIVE',
          'HOME',
          'TEMP',
          'TMP',
          'TMPDIR',
          // Windows supplies these account variables even to a filtered child.
          ...(originalPlatform.value === 'win32'
            ? [
                'HOMEDRIVE',
                'HOMEPATH',
                'LOGONSERVER',
                'USERDOMAIN',
                'USERNAME',
                'USERPROFILE',
              ]
            : []),
          ...(platform === 'win32' && programData !== undefined ? ['ProgramData'] : []),
        ].map((key) => key.toLowerCase()),
      );
      assert.deepEqual(
        Object.keys(environment).filter((key) => !allowed.has(key.toLowerCase())),
        [],
      );
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      if (originalProgramData === undefined) delete process.env.ProgramData;
      else process.env.ProgramData = originalProgramData;
      if (originalSentinel === undefined)
        delete process.env.RELEASEDECK_ENV_TEST_SECRET;
      else process.env.RELEASEDECK_ENV_TEST_SECRET = originalSentinel;
    }
  });
}
