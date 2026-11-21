import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { createMusicBrainz, parseSearch, buildQuery, rankReleaseGroups, normalizeReleaseGroup } from '../server/musicbrainz.mjs';
import { createRecord } from '../public/domain.js';

const sample = {
  count: 45,
  'release-groups': [{ id: 'f5093c06-23e3-404f-afe0-f1e8fc9eaf04', title: 'Example', 'primary-type': 'Album',
    'first-release-date': '2007-10-10', 'artist-credit': [{ name: 'A', artist: { id: 'a', name: 'A' }, joinphrase: ' & ' },
      { name: 'B', artist: { id: 'b', name: 'B' } }], tags: [{ name: 'rock', count: 5 }] }]
};
const args = query => ({ query, field: 'all', limit: 20, offset: 0 });

test('catalogued artist aliases survive saving and release counts inform ranking', () => {
  const album = normalizeReleaseGroup({ ...sample['release-groups'][0], count: 8,
    'artist-credit': [{ name: '王菲', artist: { id: 'faye', name: '王菲', aliases: [
      { name: 'Faye Wong', primary: true, type: 'Artist name' },
      { name: 'bad encoding', type: 'Search hint' }
    ] } }]
  });
  assert.equal(album.releaseCount, 8);
  assert.deepEqual(createRecord(album).album.artists[0].aliases, ['Faye Wong']);
  assert.throws(() => createRecord({ ...album, artists: [{ id: 'faye', name: '王菲', aliases: ['x'.repeat(201)] }] }));
  const low = { ...album, title: '王菲', releaseCount: 1 };
  const popular = { ...album, title: '浮躁', releaseCount: 30 };
  assert.equal(rankReleaseGroups([low, popular], '王菲', 'artist')[0].title, '浮躁');
});

test('concurrent searches are queued; identical requests coalesce and cache', async () => {
  const starts = [];
  const urls = [];
  const catalog = createMusicBrainz({ intervalMs: 35, fetchImpl: async url => {
    starts.push(Date.now()); urls.push(url);
    return Response.json(sample);
  } });
  const [first, duplicate] = await Promise.all([catalog.search(args('Radiohead')), catalog.search(args('Radiohead')), catalog.search(args('Blue'))]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 30);
  assert.deepEqual(first, duplicate);
  await catalog.search(args('Radiohead'));
  assert.equal(starts.length, 2);
  assert.equal(first.total, 45);
  assert.equal(first.results[0].artist, 'A & B');
  assert.deepEqual(first.results[0].genres, ['rock']);
  assert.match(urls[0].searchParams.get('query'), /artist:/);
});

test('upstream errors do not poison the queue or enter cache', async () => {
  let calls = 0;
  const catalog = createMusicBrainz({ intervalMs: 0, fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : Response.json(sample) });
  await assert.rejects(catalog.search(args('Blue')), error => error.status === 503);
  const result = await catalog.search(args('Blue'));
  assert.equal(result.total, 45);
});

test('studio filtering happens upstream; pagination uses the same ranked result set', async () => {
  let calls=0;
  const catalog=createMusicBrainz({intervalMs:0,fetchImpl:async url=>{
    calls++;
    assert.match(url.searchParams.get('query'), /primarytype:album AND NOT secondarytype:\*/);
    assert.equal(url.searchParams.get('limit'),'100');
    return Response.json({count:3,'release-groups':[
      {...sample['release-groups'][0],id:'a',title:'Future Bootleg','first-release-date':'2025'},
      {...sample['release-groups'][0],id:'b',title:'First Album','first-release-date':'1993'},
      {...sample['release-groups'][0],id:'c',title:'Second Album','first-release-date':'1997'}
    ]});
  }});
  const first=await catalog.search({query:'A & B',field:'artist',kind:'studio',limit:2,offset:0});
  const next=await catalog.search({query:'A & B',field:'artist',kind:'studio',limit:2,offset:2});
  assert.equal(calls,1);
  assert.deepEqual([...first.results,...next.results].map(x=>x.title),['First Album','Second Album','Future Bootleg']);
});

test('query validation rejects invalid limits and escapes Lucene syntax', () => {
  for (const params of ['q=x', 'q=Blue&limit=NaN', 'q=Blue&offset=-1', 'q=Blue&field=bad', 'q=Blue&limit=2.4']) {
    assert.throws(() => parseSearch(new URLSearchParams(params)), error => error.status === 400);
  }
  assert.equal(parseSearch(new URLSearchParams('q=王菲')).query, '王菲');
  assert.equal(buildQuery('Radiohead', 'artist'), 'artist:"Radiohead"');
  assert.match(buildQuery('宇多田光', 'artist'), /宇多田ヒカル/);
  assert.ok(buildQuery('A"B', 'title').includes('A\\"B'));
});

test('release-group ranking puts exact albums before singles and unrelated matches', () => {
  const items = [
    { title: 'Radiohead', artist: 'X-Dream', type: 'Single', year: '1998', score: 100 },
    { title: 'In Rainbows', artist: 'Radiohead', type: 'Album', year: '2007', score: 95 },
    { title: 'Radiohead', artist: 'Radiohead', type: 'Album', year: '1991', score: 85 }
  ];
  assert.equal(rankReleaseGroups(items, 'Radiohead', 'all')[0].artist, 'Radiohead');
  assert.equal(rankReleaseGroups(items, 'In Rainbows', 'all')[0].title, 'In Rainbows');
});

test('HTTP routes serve only public files, validate search, and truthfully reject cloud sync', async t => {
  let calls = 0;
  const server = createApp({ catalog: { search: async query => { calls++; return { ...query, total: 0, results: [] }; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /img-src[^;]+blob:/);
  assert.match(await page.text(), /img-src[^;]+blob:/);
  const css = await fetch(base + '/styles.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  for (const path of ['/.env', '/server.mjs', '/server/app.mjs', '/package.json', '/%2e%2e%5c.env', '/missing']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/api/search?q=x')).status, 400);
  assert.equal(calls, 0);
  const search = await fetch(base + '/api/search?q=Blue&field=artist');
  assert.equal((await search.json()).field, 'artist');
  assert.equal(calls, 1);
  const sync = await fetch(base + '/api/sync', { method: 'POST' });
  assert.equal(sync.status, 501);
  assert.equal((await sync.json()).code, 'CLOUD_NOT_CONFIGURED');
  assert.equal((await (await fetch(base + '/api/config')).json()).cloud.enabled, false);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('cover proxy validates IDs and returns image bytes with cache headers', async t => {
  const server = createApp({ fetchImpl: async () => new Response(new Uint8Array([255, 216, 255]), { status: 200, headers: { 'content-type': 'image/jpeg' } }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/cover/not-an-id')).status, 400);
  const cover = await fetch(base + '/api/cover/f5093c06-23e3-404f-afe0-f1e8fc9eaf04?size=500');
  assert.equal(cover.status, 200);
  assert.match(cover.headers.get('cache-control'), /86400/);
  assert.deepEqual([...new Uint8Array(await cover.arrayBuffer())], [255, 216, 255]);
});

test('Apple cover proxy validates the storefront and resolves artwork through lookup', async t => {
  const server = createApp({ catalog: { search: async () => ({ total: 0, results: [] }) }, fetchImpl: async url => {
    if (String(url).includes('itunes.apple.com/lookup')) return Response.json({ results: [{
      collectionId: 1847588158, artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg'
    }] });
    if (String(url).startsWith('https://is1-ssl.mzstatic.com/')) return new Response(new Uint8Array([255,216,255]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error('Unexpected URL');
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/apple-cover/CN/1847588158')).status, 400);
  const cover = await fetch(base + '/api/apple-cover/TW/1847588158');
  assert.equal(cover.headers.get('x-cover-source'), 'Apple Music');
  assert.deepEqual([...new Uint8Array(await cover.arrayBuffer())], [255,216,255]);
});
