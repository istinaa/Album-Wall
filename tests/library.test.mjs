import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecord, validateBackup, mergeRecords, libraryStats, filterRecords, withListeningStatus, rankArtists, rankGenres } from '../public/domain.js';
import { LibraryStore, STORAGE_KEY } from '../public/storage.js';

const album = { id: 'f5093c06-23e3-404f-afe0-f1e8fc9eaf04', source: 'musicbrainz', title: 'Example',
  artist: 'Artist', artists: [{ id: 'artist-1', name: 'Artist' }], year: '2007', type: 'Album', genres: ['rock'] };
const makeRecord = () => createRecord(album, '2026-01-01T00:00:00.000Z');
const memory = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('one-click status changes preserve ratings, notes, categories and added date', () => {
  const existing = { ...makeRecord(), rating: 8.5, note: '重听', category: '珍藏' };
  const changed = withListeningStatus(existing, 'listened', '2026-03-01T00:00:00.000Z');
  assert.equal(changed.status, 'listened');
  assert.equal(changed.rating, 8.5);
  assert.equal(changed.note, '重听');
  assert.equal(changed.category, '珍藏');
  assert.equal(changed.addedAt, existing.addedAt);
  assert.equal(withListeningStatus(changed, 'wanted').rating, 8.5);
  assert.throws(() => withListeningStatus(existing, 'unknown'));
});

test('wall filters combine inclusively, excluding unrated and deleted records at a rating threshold', () => {
  const records = [null, 0, 8, 8.5, 9, 10].map((rating,i) => ({ ...makeRecord(),
    album: { ...album, id: 'local-'+i, source:'local' }, rating, status:'listened', category:'珍藏' }));
  records[5].deletedAt = '2026-02-01T00:00:00Z';
  assert.deepEqual(filterRecords(records,{minRating:'8.5'}).map(r=>r.rating),[8.5,9]);
  assert.deepEqual(filterRecords(records,{minRating:'0'}).map(r=>r.rating),[0,8,8.5,9]);
  assert.deepEqual(filterRecords(records,{minRating:'8.5', maxRating:'9'}).map(r=>r.rating),[8.5,9]);
  assert.equal(filterRecords(records,{minRating:'8.5', maxRating:'10', includeUnrated:true}).some(r=>r.rating === null), true);
  assert.equal(filterRecords(records,{minRating:'8.5',status:'wanted'}).length,0);
  assert.equal(filterRecords(records,{minRating:'8.5',genre:'珍藏',artist:'Artist',query:'example'}).length,2);
  assert.equal(filterRecords(records,{minRating:'8.5',genre:'jazz'}).length,0);
  assert.equal(filterRecords(records).length,5);
});

test('rankings aggregate localized artists and rated averages', () => {
  const records = [
    { ...makeRecord(), album: { ...album, id: 'local-utada-1', artist: '宇多田ヒカル', artists: [{ id: 'utada', name: '宇多田ヒカル' }] }, rating: 9, status: 'listened' },
    { ...makeRecord(), album: { ...album, id: 'local-utada-2', artist: '宇多田光', artists: [{ id: 'utada', name: '宇多田光' }] }, rating: 8, status: 'listened' },
    { ...makeRecord(), album: { ...album, id: 'local-other', artist: '另一位', artists: [{ id: 'other', name: '另一位' }], genres: ['jazz'] }, rating: null }
  ];
  const artists = rankArtists(records);
  const utada = artists.find(item => item.name === '宇多田ヒカル');
  assert.equal(utada.albums, 2);
  assert.equal(utada.average, 8.5);
  assert.equal(rankGenres(records).find(item => item.name === 'jazz').albums, 1);
});

test('artist filters collapse localized aliases into one identity', () => {
  const records = [
    { ...makeRecord(), album: { ...album, id: 'local-utada-jp', artist: '宇多田ヒカル', artists: [{ id: 'utada', name: '宇多田ヒカル' }] } },
    { ...makeRecord(), album: { ...album, id: 'local-utada-cn', artist: '宇多田光', artists: [{ id: 'utada', name: '宇多田光' }] } }
  ];
  assert.equal(filterRecords(records, { artist: '宇多田光' }).length, 2);
});

test('new records are unrated, wanted; edits survive reload', () => {
  const storage = memory();
  const first = new LibraryStore(storage);
  first.load();
  assert.deepEqual(first.records, []);
  first.put(makeRecord());
  const second = new LibraryStore(storage);
  second.load();
  assert.equal(second.records[0].status, 'wanted');
  assert.equal(second.records[0].rating, null);
  second.put({ ...second.records[0], status: 'listened', rating: 8.5, note: '<script>hello</script>' });
  first.load();
  assert.equal(first.records[0].rating, 8.5);
  assert.equal(first.records[0].note, '<script>hello</script>');
});

test('desktop commits use the synchronous durable bridge', () => {
  const writes = [];
  const desktop = {
    saveSync: payload => { writes.push(payload); return { ok: true, status: { path: 'album-wall.json' } }; },
    save: async () => { throw new Error('async fallback should not run'); }
  };
  const store = new LibraryStore(memory(), { desktop });
  store.put(makeRecord());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].records.length, 1);
  assert.equal(store.diskStatus.path, 'album-wall.json');
});

test('desktop startup hydrates synchronously before the first render', () => {
  const record = makeRecord();
  const local = memory();
  const desktop = {
    loadSync: () => ({ data: { version: 1, records: [record] }, status: { fileExists: true, records: 1 } }),
    saveSync: () => ({ ok: true })
  };
  const store = new LibraryStore(local, { desktop });
  store.hydrateSync();
  assert.equal(store.records.length, 1);
  assert.equal(store.records[0].album.id, record.album.id);
  assert.equal(JSON.parse(local.getItem(STORAGE_KEY)).records.length, 1);
});

test('desktop hydration never overwrites an existing file when its read is unavailable', async () => {
  const writes = [];
  const local = memory();
  const desktop = {
    load: async () => ({ data: null, status: { fileExists: true, path: 'album-wall.json' } }),
    saveSync: payload => { writes.push(payload); return { ok: true }; }
  };
  const store = new LibraryStore(local, { desktop });
  await store.hydrate();
  assert.deepEqual(store.records, []);
  assert.equal(writes.length, 0);
  assert.match(store.error, /未覆盖原文件/);
});

test('desktop load failures keep local records read-only until the file is available', async () => {
  const local = memory();
  local.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records: [makeRecord()] }));
  const store = new LibraryStore(local, { desktop: { load: async () => { throw new Error('file busy'); } } });
  await store.hydrate();
  assert.equal(store.records.length, 1);
  assert.match(store.error, /未覆盖原文件/);
  assert.throws(() => store.put({ ...store.records[0], note: '暂不覆盖' }), /未覆盖原文件/);
});

test('first desktop hydration migrates local records only when no file exists', async () => {
  const writes = [];
  const local = memory();
  const record = makeRecord();
  local.setItem(STORAGE_KEY, JSON.stringify({ version: 1, records: [record] }));
  const desktop = {
    load: async () => ({ data: null, status: { fileExists: false } }),
    saveSync: payload => { writes.push(payload); return { ok: true, status: { records: payload.records.length } }; }
  };
  const store = new LibraryStore(local, { desktop });
  await store.hydrate();
  assert.equal(store.records.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].records.length, 1);
});

test('Apple catalog records survive validation, backup export and reload', () => {
  const apple = { id: 'apple-TW-1847588158', source: 'apple', title: '離開銀色荒原', artist: '裘德',
    artists: [{ id: 'apple-1509854612', name: '裘德' }], year: '2025', type: 'Album', genres: ['華語流行樂'] };
  const storage = memory();
  const store = new LibraryStore(storage);
  store.put(createRecord(apple));
  const reloaded = new LibraryStore(storage);
  reloaded.load();
  assert.equal(reloaded.records[0].album.id, apple.id);
  assert.equal(validateBackup(JSON.parse(reloaded.export()))[0].album.source, 'apple');
  assert.throws(() => createRecord({ ...apple, id: 'apple-CN-1' }));
});

test('statistics exclude tombstones and include a zero score', () => {
  const records = [makeRecord(), { ...makeRecord(), album: { ...album, id: 'local-2', source: 'local' }, rating: 0, status: 'listened' },
    { ...makeRecord(), rating: 10, deletedAt: '2026-01-02T00:00:00Z' }];
  assert.deepEqual(libraryStats(records), { total: 2, listened: 1, percent: 50, rating: '0.0', artists: 1 });
});

test('backup merge keeps newer notes and deletion tombstones, deduplicating albums', () => {
  const old = makeRecord();
  const newer = { ...old, note: 'new', updatedAt: '2026-02-01T00:00:00Z', deletedAt: '2026-02-01T00:00:00Z' };
  assert.deepEqual(mergeRecords([newer], [old]), [newer]);
  assert.deepEqual(mergeRecords([old], [newer]), [newer]);
  const store = new LibraryStore(memory());
  store.put(old);
  store.import({ version: 1, records: [newer] });
  assert.equal(store.records.length, 1);
  assert.ok(store.records[0].deletedAt);
  assert.equal(validateBackup(JSON.parse(store.export())).length, 1);
});

test('invalid imports are atomic and arbitrary image URLs are discarded', () => {
  const storage = memory();
  const store = new LibraryStore(storage);
  store.put(makeRecord());
  const before = storage.getItem(STORAGE_KEY);
  assert.throws(() => store.import({ version: 1, records: [{ ...makeRecord(), rating: 11 }] }));
  assert.throws(() => store.import({ version: 99, records: [] }));
  assert.throws(() => store.import({ version: 1, records: [makeRecord(), makeRecord()] }));
  assert.equal(storage.getItem(STORAGE_KEY), before);
  const record = makeRecord();
  record.album.cover = 'javascript:alert(1)';
  assert.equal(validateBackup({ version: 1, records: [record] })[0].album.cover, undefined);
});

test('corrupt storage is preserved and cannot be overwritten by edits', () => {
  const storage = memory();
  storage.setItem(STORAGE_KEY, '{broken json');
  const store = new LibraryStore(storage);
  store.load();
  assert.ok(store.error);
  assert.throws(() => store.put(makeRecord()));
  assert.equal(store.raw(), '{broken json');
});

test('failed writes do not silently mutate current collection', () => {
  const store = new LibraryStore({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } });
  assert.throws(() => store.put(makeRecord()), /本地保存失败/);
  assert.deepEqual(store.records, []);
});

test('writes reread storage so another tab adding a different album is preserved', () => {
  const storage = memory();
  const a = new LibraryStore(storage);
  const b = new LibraryStore(storage);
  a.load(); b.load();
  a.put(makeRecord());
  b.put({ ...makeRecord(), album: { ...album, id: 'local-2', source: 'local' } });
  assert.equal(b.records.length, 2);
});

test('legacy prototype records migrate once without deleting the original backup', () => {
  const storage = memory();
  const original = JSON.stringify([{ id: '1', title: 'Blue', artist: 'Joni Mitchell', year: '1971', played: true, rating: 9.5, note: 'hello', genre: '民谣' }]);
  storage.setItem('album-wall-data', original);
  const store = new LibraryStore(storage);
  store.load();
  assert.equal(store.records[0].note, 'hello');
  assert.equal(store.records[0].album.source, 'local');
  assert.equal(storage.getItem('album-wall-data'), original);
});
