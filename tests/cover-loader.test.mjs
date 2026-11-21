import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverLoader } from '../public/cover-loader.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const image = () => new Response(new Uint8Array([255,216,255]), {headers:{'content-type':'image/jpeg'}});

test('ten rounds of results share downloads and reuse successful covers', async t => {
  const calls = new Map();
  let active = 0, peak = 0, objectUrls = 0;
  const loader = createCoverLoader({concurrency:4, createUrl:() => 'blob:' + ++objectUrls, revokeUrl:() => {}, fetchImpl:async key => {
    calls.set(key, (calls.get(key) || 0) + 1);
    active++; peak = Math.max(peak, active);
    await turn(); active--; return image();
  }});
  t.after(() => loader.dispose());
  for (let round = 0; round < 10; round++) {
    const releases = [];
    const visible = Array.from({length:20}, (_, i) => new Promise(resolve => {
      const key = '/cover/' + (round * 10 + i);
      releases.push(loader.subscribe(key, resolve));
      releases.push(loader.subscribe(key, () => {}));
    }));
    assert.ok((await Promise.all(visible)).every(url => url.startsWith('blob:')));
    releases.forEach(release => release());
  }
  assert.equal(peak, 4);
  assert.equal(calls.size, 110);
  assert.ok([...calls.values()].every(count => count === 1));
});

test('leaving a page cancels active and queued images, freeing slots for a new page', async t => {
  const calls = [], signals = [];
  const loader = createCoverLoader({concurrency:2, createUrl:() => 'blob:new', revokeUrl:() => {}, fetchImpl:async (key, {signal}) => {
    calls.push(key); signals.push(signal);
    if (key === 'new') return image();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  }});
  t.after(() => loader.dispose());
  const releases = ['old1','old2','old3'].map(key => loader.subscribe(key, () => {}));
  const sharedRelease = loader.subscribe('old1', () => {});
  releases.forEach(release => release());
  assert.equal(signals[0].aborted, false, 'another visible consumer still needs this cover');
  sharedRelease();
  assert.equal(signals[0].aborted, true);
  const visible = new Promise(resolve => loader.subscribe('new', resolve));
  assert.equal(await visible, 'blob:new');
  assert.deepEqual(calls, ['old1','old2','new']);
});

test('rate-limited covers honor Retry-After, recover, and stop retrying after leaving the page', async t => {
  let calls = 0, timerId = 0;
  const timers = new Map(), delays = [];
  const loader = createCoverLoader({createUrl:() => 'blob:recovered', revokeUrl:() => {},
    schedule:(callback, delay) => { delays.push(delay); timers.set(++timerId, callback); return timerId; },
    cancel:id => timers.delete(id), fetchImpl:async key => {
      calls++;
      return key === 'recover' && calls > 1 ? image() : new Response('', {status:503,headers:{'retry-after':'120'}});
    }});
  t.after(() => loader.dispose());
  const visible = new Promise(resolve => loader.subscribe('recover', resolve));
  await turn();
  assert.equal(calls, 1);
  assert.equal(delays[0], 120000);
  const retry = timers.get(1); timers.delete(1); retry();
  assert.equal(await visible, 'blob:recovered');
  const release = loader.subscribe('cancel', () => {});
  await turn();
  assert.equal(timers.size, 1);
  release();
  assert.equal(timers.size, 0);
});

test('a confirmed missing cover is not retried on every render', async t => {
  let calls = 0;
  const loader = createCoverLoader({fetchImpl:async () => { calls++; return new Response('', {status:404}); }});
  t.after(() => loader.dispose());
  const release = loader.subscribe('missing', () => {});
  await turn(); release();
  loader.subscribe('missing', () => {});
  await turn();
  assert.equal(calls, 1);
});
