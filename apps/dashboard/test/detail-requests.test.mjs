import assert from 'node:assert/strict';
import test from 'node:test';

import { createDetailReader } from '../src/detail-requests.ts';

function fixture() {
  const calls = [];
  const read = createDetailReader(
    (path, signal) =>
      new Promise((resolve, reject) => calls.push({ path, signal, resolve, reject })),
  );
  return { read, calls };
}

test('page batch and selected fallback share one in-flight detail read', async () => {
  const { read, calls } = fixture();
  const batch = read('/detail/a', new AbortController().signal);
  const fallback = read('/detail/a', new AbortController().signal);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  calls[0].resolve({ version: 2 });
  assert.deepEqual(await Promise.all([batch, fallback]), [
    { version: 2 },
    { version: 2 },
  ]);
});

test('one consumer timeout does not cancel another; the last abort cancels transport', async () => {
  const { read, calls } = fixture();
  const batch = new AbortController();
  const fallback = new AbortController();
  const a = read('/detail/a', batch.signal);
  const b = read('/detail/a', fallback.signal);
  const rejectedA = assert.rejects(a, { name: 'AbortError' });
  const rejectedB = assert.rejects(b, { name: 'AbortError' });
  await Promise.resolve();
  batch.abort();
  await rejectedA;
  assert.equal(calls[0].signal.aborted, false);
  fallback.abort();
  await rejectedB;
  assert.equal(calls[0].signal.aborted, true);

  const fresh = read('/detail/a', new AbortController().signal);
  await Promise.resolve();
  calls[0].resolve({ version: 1 }); // A late, cancelled transport cannot own the new read.
  await Promise.resolve();
  const peer = read('/detail/a', new AbortController().signal);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  calls[1].resolve({ version: 3 });
  assert.deepEqual(await Promise.all([fresh, peer]), [{ version: 3 }, { version: 3 }]);
});

test('failed reads can retry and different deployment IDs are independent', async () => {
  const { read, calls } = fixture();
  const a = read('/detail/a', new AbortController().signal);
  const b = read('/detail/b', new AbortController().signal);
  const failed = assert.rejects(a, /offline/);
  await Promise.resolve();
  assert.equal(calls.length, 2);
  calls[0].reject(new Error('offline'));
  calls[1].resolve('b');
  await failed;
  assert.equal(await b, 'b');
  const retry = read('/detail/a', new AbortController().signal);
  await Promise.resolve();
  calls[2].resolve('recovered');
  assert.equal(await retry, 'recovered');
});

test('an already-cancelled consumer never starts a read', async () => {
  const { read, calls } = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(read('/detail/a', controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});
