import { timingSafeEqual } from 'node:crypto';

import { hashOperatorPassword } from './auth.js';

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('credential provisioning requires an interactive terminal');
  }
  process.stdout.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('credential provisioning cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

try {
  const password = await readSecret('Operator password: ');
  const confirmation = await readSecret('Confirm password: ');
  if (!sameSecret(password, confirmation)) throw new Error('passwords do not match');
  const hash = await hashOperatorPassword(password);
  process.stdout.write(`${hash}\n`);
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'credential provisioning failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
