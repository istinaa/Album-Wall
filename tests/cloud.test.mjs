import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSync } from '../public/cloud.js';
import { createRecord, withListeningStatus } from '../public/domain.js';

const album = { id: 'cloud-album-1', source: 'local', title: 'Cloud Album', artist: 'Artist', artists: [{ id: 'artist-1', name: 'Artist' }], year: '2024', type: 'Album', genres: [] };
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };

test('Supabase sync merges newer local and remote records before upsert', async () => {
  const calls = [];
  const remote = withListeningStatus(createRecord({ ...album, id: 'cloud-album-2', title: 'Remote Album' }), 'listened', '2026-01-02T00:00:00.000Z');
  const cloud = createCloudSync(storage(), { fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/auth/v1/signup')) return Response.json({ access_token: 'token', user: { id: 'user-1' } });
    if (options.method === 'POST') return new Response('', { status: 201 });
    return Response.json([{ user_id: 'user-1', album_id: remote.album.id, album: remote.album, status: remote.status, rating: remote.rating,
      note: remote.note, category: remote.category, added_at: remote.addedAt, updated_at: remote.updatedAt, deleted_at: remote.deletedAt }]);
  } });
  await cloud.connect('https://demo.supabase.co', 'a'.repeat(30));
  const local = withListeningStatus(createRecord(album), 'listened', '2026-01-03T00:00:00.000Z');
  const result = await cloud.sync([local]);
  assert.equal(result.count, 2);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
  const upsert = calls.find(call => call.url.includes('/rest/v1/library_records') && call.options.method === 'POST');
  const rows = JSON.parse(upsert.options.body);
  assert.deepEqual(rows.map(row => row.album_id).sort(), ['cloud-album-1', 'cloud-album-2']);
  assert.equal(cloud.status().connected, true);
});

test('Supabase config rejects unsafe endpoints before a network request', async () => {
  const cloud = createCloudSync(storage(), { fetchImpl: async () => { throw new Error('must not request'); } });
  await assert.rejects(() => cloud.connect('http://example.com', 'a'.repeat(30)), /HTTPS/);
});
