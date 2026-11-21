import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtworkProviders } from '../server/artwork-providers.mjs';
import { createSharedTasks, createWorkQueue } from '../server/request-control.mjs';
import { createMusicBrainz } from '../server/musicbrainz.mjs';

const artwork = { collectionId: 42, collectionName: 'In Rainbows', artistName: 'Radiohead', artworkUrl100: 'https://is1.mzstatic.com/100x100bb.jpg' };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('NetEase HTTP 200/code 405 cools down queued and new searches, then recovers', async () => {
  let now = 100000, calls = 0;
  const providers = createArtworkProviders({ now: () => now, neteaseIntervalMs: 0, cooldownMs: 60000,
    fetchImpl: async () => ++calls === 1 ? Response.json({ code: 405, message: '操作频繁，请稍候再试' }) :
      Response.json({ code: 200, result: { albums: [{ name: 'In Rainbows', artist: { name: 'Radiohead' }, picUrl: 'https://p2.music.126.net/test/album.jpg' }] } }) });
  const failures = await Promise.allSettled(['Radiohead', 'In Rainbows', '王菲'].map(term => providers.searchNetease(term)));
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.status === 503));
  assert.equal(calls, 1);
  now += 59000;
  await assert.rejects(providers.searchNetease('Radiohead'), error => error.retryAfter === 1);
  assert.equal(calls, 1);
  now += 1001;
  assert.equal((await providers.searchNetease('Radiohead'))[0].collectionName, 'In Rainbows');
  await providers.searchNetease('Radiohead');
  assert.equal(calls, 2, 'the successful response is cached; the rate limit was not cached as an empty result');
});

test('HTTP Retry-After applies across Apple search and lookup while cached artwork stays usable', async () => {
  let now = Date.UTC(2026, 8, 23), calls = 0;
  const providers = createArtworkProviders({ now: () => now, appleIntervalMs: 0, fetchImpl: async () => {
    calls++;
    if (calls === 2) return new Response('', {status: 429, headers: {'retry-after': new Date(now + 120000).toUTCString()}});
    return Response.json({ results: [artwork] });
  } });
  await Promise.all([providers.searchApple('Radiohead', 'US'), providers.searchApple('Radiohead', 'US')]);
  assert.equal(calls, 1);
  await assert.rejects(providers.searchApple('Blue', 'US'), error => error.retryAfter === 120);
  await assert.rejects(providers.lookupApple('TW', '43'), error => error.status === 503);
  assert.equal(calls, 2);
  assert.equal((await providers.searchApple('Radiohead', 'US'))[0].collectionId, 42);
  assert.equal(providers.findApple('42').collectionName, 'In Rainbows');
  now += 120001;
  assert.equal((await providers.searchApple('Blue', 'US')).length, 1);
  assert.equal(calls, 3);
});

test('shared work is cancelled only after its last consumer leaves, and can restart immediately', async () => {
  const shared = createSharedTasks();
  const first = new AbortController(), second = new AbortController();
  let upstream, calls = 0;
  const work = signal => { calls++; upstream = signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})); };
  const a = shared('cover', work, first.signal);
  const b = shared('cover', work, second.signal);
  await turn();
  first.abort();
  await assert.rejects(a, {name:'AbortError'});
  assert.equal(upstream.aborted, false);
  second.abort();
  await assert.rejects(b, {name:'AbortError'});
  assert.equal(upstream.aborted, true);
  assert.equal(calls, 1);
  assert.equal(await shared('cover', async () => 'recovered'), 'recovered');
});

test('cancelled queued work never starts or blocks the next page', async () => {
  const run = createWorkQueue(1);
  let finish, cancelledCalls = 0;
  const first = run(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const cancelled = run(() => { cancelledCalls++; }, controller.signal);
  const next = run(() => 'new page');
  controller.abort();
  await assert.rejects(cancelled, {name:'AbortError'});
  await turn(); finish(); await first;
  assert.equal(await next, 'new page');
  assert.equal(cancelledCalls, 0);
});

test('abandoned MusicBrainz searches release their requests and queue', async () => {
  const calls = [];
  const catalog = createMusicBrainz({intervalMs:0, fetchImpl: async (url, {signal}) => {
    calls.push(String(url));
    if (calls.length === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
    return Response.json({count:0,'release-groups':[]});
  }});
  const first = new AbortController(), queued = new AbortController();
  const args = query => ({query,field:'artist',offset:0,limit:20});
  const a = catalog.search({...args('Radiohead'),signal:first.signal});
  const b = catalog.search({...args('王菲'),signal:queued.signal});
  await turn();
  const rejected = Promise.all([assert.rejects(a, {name:'AbortError'}), assert.rejects(b, {name:'AbortError'})]);
  queued.abort(); first.abort(); await rejected;
  await catalog.search(args('周杰伦'));
  assert.equal(calls.length, 2);
});
