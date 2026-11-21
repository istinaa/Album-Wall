import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppleCatalog, normalizeAppleAlbum, parseAppleId } from '../server/apple.mjs';
import { createCatalog, mergeCatalogAlbums } from '../server/catalog.mjs';

const jude = (overrides = {}) => ({ collectionId: 1847588158, collectionName: '離開銀色荒原', artistId: 1509854612,
  artistName: '裘德', releaseDate: '2025-10-24T07:00:00Z', trackCount: 10, primaryGenreName: '華語流行樂',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music211/example/100x100bb.jpg', ...overrides });

test('Apple catalog keeps exact artist albums and excludes singles and namesake artists', async () => {
  const catalog = createAppleCatalog({ fetchImpl: async url => {
    const country = new URL(url).searchParams.get('country');
    return Response.json({ results: country === 'TW' ? [jude(), jude({ collectionId: 2, collectionName: '新手 - Single', trackCount: 1 }),
      jude({ collectionId: 3, artistName: 'Marie-Josèphe Jude', collectionName: 'Piano Works' })] : [] });
  } });
  const result = await catalog.search({ query: '裘德', field: 'artist', kind: 'studio' });
  assert.deepEqual(result.results.map(album => album.title), ['離開銀色荒原']);
  assert.equal(result.results[0].id, 'apple-TW-1847588158');
  assert.deepEqual(parseAppleId(result.results[0].id), { country: 'TW', collectionId: '1847588158' });
  assert.equal(parseAppleId('apple-CN-1'), null);
});

test('combined catalog adds a newer Apple album and keeps MusicBrainz for duplicates', async () => {
  const existing = { id: 'mb-old', source: 'musicbrainz', title: '裘德', artist: '裘德', artists: [], year: '2023', type: 'Album', genres: [], score: 100, releaseCount: 2 };
  const appleDuplicate = normalizeAppleAlbum(jude({ collectionId: 10, collectionName: '裘德', releaseDate: '2023-12-26T08:00:00Z' }), 'TW');
  const newAlbum = normalizeAppleAlbum(jude(), 'TW');
  assert.deepEqual(mergeCatalogAlbums([existing], [appleDuplicate, newAlbum], '裘德', 'artist').map(album => album.id), ['mb-old', 'apple-TW-1847588158']);
  const catalog = createCatalog({
    musicBrainz: { search: async () => ({ total: 1, results: [existing] }) },
    apple: { search: async () => ({ total: 2, results: [appleDuplicate, newAlbum] }) }
  });
  const result = await catalog.search({ query: '裘德', field: 'artist', kind: 'studio', offset: 0, limit: 20 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.results.map(album => album.id), ['mb-old', 'apple-TW-1847588158']);
});

test('Apple cover lookup only proxies verified mzstatic artwork', async () => {
  const calls = [];
  const catalog = createAppleCatalog({ fetchImpl: async url => {
    calls.push(String(url));
    if (String(url).includes('/lookup?')) return Response.json({ results: [jude()] });
    return new Response(new Uint8Array([255,216,255]), { headers: { 'content-type': 'image/jpeg' } });
  } });
  const cover = await catalog.getCover('TW', '1847588158');
  assert.equal(cover.source, 'Apple Music');
  assert.match(calls[1], /^https:\/\/is1-ssl\.mzstatic\.com\//);
  assert.equal(await catalog.getCover('CN', '1847588158'), null);
});
