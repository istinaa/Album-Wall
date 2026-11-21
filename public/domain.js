export const SCHEMA_VERSION = 1;
export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APPLE_ALBUM_ID = /^apple-(TW|HK|US|GB)-\d{1,20}$/;
import { artistIdentityKey } from './artist-identity.js';

const string = (value, max) => typeof value === 'string' && value.length <= max;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateRecord(record) {
  const a = record?.album;
  if (!a || !string(a.id, 100) || !a.id || !string(a.title, 1000) || !a.title ||
      !string(a.artist, 1000) || !['musicbrainz', 'apple', 'local'].includes(a.source) ||
      (a.titleAliases !== undefined && (!Array.isArray(a.titleAliases) || a.titleAliases.length > 8 || !a.titleAliases.every(alias => string(alias, 200)))) ||
      (a.source === 'musicbrainz' && !MBID.test(a.id)) ||
      (a.source === 'apple' && !APPLE_ALBUM_ID.test(a.id)) ||
      !string(a.year, 10) || !string(a.type, 100) ||
      !Array.isArray(a.genres) || a.genres.length > 20 || !a.genres.every(g => string(g, 100)) ||
      !Array.isArray(a.artists) || a.artists.length > 100 || !a.artists.every(artist => string(artist.id, 100) && string(artist.name, 1000) &&
        (artist.aliases === undefined || (Array.isArray(artist.aliases) && artist.aliases.length <= 8 && artist.aliases.every(alias => string(alias, 200)))))) {
    throw new Error('唱片数据格式不正确');
  }
  if (!['wanted', 'listened'].includes(record.status) ||
      (record.rating !== null && (!Number.isFinite(record.rating) || record.rating < 0 || record.rating > 10 || record.rating * 2 % 1 !== 0)) ||
      !string(record.note, 5000) || !string(record.category, 100) ||
      !date(record.addedAt) || !date(record.updatedAt) || (record.deletedAt !== null && !date(record.deletedAt))) {
    throw new Error('聆听记录格式不正确（评分为 0–10 分，每半分一档）');
  }
  // Explicit projection prevents arbitrary imported properties from reaching app state.
  return {
    album: { id: a.id, source: a.source, title: a.title, ...(a.titleAliases ? { titleAliases: [...a.titleAliases] } : {}), artist: a.artist, year: a.year, type: a.type,
      artists: a.artists.map(({ id, name, aliases }) => ({ id, name, ...(aliases ? { aliases: [...aliases] } : {}) })), genres: [...a.genres] },
    status: record.status, rating: record.rating, note: record.note, category: record.category,
    addedAt: new Date(record.addedAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(),
    deletedAt: record.deletedAt === null ? null : new Date(record.deletedAt).toISOString()
  };
}

export function createRecord(album, now = new Date().toISOString()) {
  return validateRecord({ album, status: 'wanted', rating: null, note: '', category: '', addedAt: now, updatedAt: now, deletedAt: null });
}

export function withListeningStatus(record, status, now = new Date().toISOString()) {
  return validateRecord({ ...record, status, updatedAt: now });
}

export function recordCategories(record) {
  return [...new Set([record.category, ...record.album.genres].filter(Boolean))];
}

export function filterRecords(records, { status = 'all', artist = '', genre = '', minRating = '', maxRating = '', includeUnrated = false, query = '' } = {}) {
  const term = query.toLocaleLowerCase().trim();
  const artistKey = artist ? artistIdentityKey(artist) : '';
  return records.filter(record => !record.deletedAt &&
    (status === 'all' || record.status === status) &&
    (!artistKey || artistIdentityKey(record.album.artist) === artistKey || record.album.artists.some(a => artistIdentityKey(a.name) === artistKey)) &&
    (!genre || recordCategories(record).includes(genre)) &&
    (minRating === '' || (record.rating !== null && record.rating >= Number(minRating)) || (includeUnrated && record.rating === null)) &&
    (maxRating === '' || (record.rating !== null && record.rating <= Number(maxRating)) || (includeUnrated && record.rating === null)) &&
    (!term || [record.album.title, record.album.artist, record.note, ...recordCategories(record)].join(' ').toLocaleLowerCase().includes(term)));
}

function rankingLabel(records, key, fallback) {
  const match = records.find(record => artistIdentityKey(record.album.artist) === key);
  return match?.album.artist || fallback;
}

// Aggregates active records for the rankings page. A collaboration is counted
// under its primary album artist once, while localized names share one key.
export function rankArtists(records) {
  const map = new Map();
  for (const record of records.filter(item => !item.deletedAt)) {
    const key = artistIdentityKey(record.album.artist);
    const current = map.get(key) || { key, name: rankingLabel(records, key, record.album.artist), albums: 0, rated: 0, ratingTotal: 0, listened: 0 };
    current.albums += 1;
    if (record.status === 'listened') current.listened += 1;
    if (record.rating !== null) { current.rated += 1; current.ratingTotal += record.rating; }
    map.set(key, current);
  }
  return [...map.values()].map(item => ({ ...item, average: item.rated ? item.ratingTotal / item.rated : null }));
}

export function rankGenres(records) {
  const map = new Map();
  for (const record of records.filter(item => !item.deletedAt)) {
    for (const genre of recordCategories(record)) {
      const current = map.get(genre) || { name: genre, albums: 0, rated: 0, ratingTotal: 0 };
      current.albums += 1;
      if (record.rating !== null) { current.rated += 1; current.ratingTotal += record.rating; }
      map.set(genre, current);
    }
  }
  return [...map.values()].map(item => ({ ...item, average: item.rated ? item.ratingTotal / item.rated : null }));
}

export function validateBackup(data) {
  if (data?.version !== SCHEMA_VERSION || !Array.isArray(data.records) || data.records.length > 20000) {
    throw new Error('不是受支持的唱片墙备份文件');
  }
  const records = data.records.map(validateRecord);
  if (new Set(records.map(r => r.album.id)).size !== records.length) throw new Error('备份中有重复的唱片 ID');
  return records;
}

// Preserve tombstones. Newest updatedAt wins; ties keep the existing local entry.
export function mergeRecords(existing, incoming) {
  const byId = new Map(existing.map(r => [r.album.id, r]));
  for (const candidate of incoming) {
    const previous = byId.get(candidate.album.id);
    if (!previous || Date.parse(candidate.updatedAt) > Date.parse(previous.updatedAt)) byId.set(candidate.album.id, candidate);
  }
  return [...byId.values()];
}

export function libraryStats(records) {
  const active = records.filter(r => !r.deletedAt);
  const ratings = active.filter(r => r.rating !== null);
  const artists = new Set(active.flatMap(r => r.album.artists.length ? r.album.artists.map(a => artistIdentityKey(a.name || a.id)) : [artistIdentityKey(r.album.artist)]));
  const listened = active.filter(r => r.status === 'listened').length;
  return { total: active.length, listened, percent: active.length ? Math.round(listened / active.length * 100) : 0,
    rating: ratings.length ? (ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length).toFixed(1) : '—', artists: artists.size };
}

// Keep the buckets stable so the chart can be compared as the library grows.
// Ratings are stored in half-point increments; unrated records are intentionally
// excluded from the distribution rather than being treated as zero.
export function ratingDistribution(records) {
  const buckets = [
    { label: '0–2', min: 0, max: 2, count: 0 },
    { label: '2–4', min: 2, max: 4, count: 0 },
    { label: '4–6', min: 4, max: 6, count: 0 },
    { label: '6–8', min: 6, max: 8, count: 0 },
    { label: '8–9', min: 8, max: 9, count: 0 },
    { label: '9–10', min: 9, max: 10, count: 0 }
  ];
  for (const record of records.filter(item => !item.deletedAt && item.rating !== null)) {
    const rating = Number(record.rating);
    const bucket = buckets.find((item, index) => rating >= item.min && (rating < item.max || (index === buckets.length - 1 && rating <= item.max)));
    if (bucket) bucket.count += 1;
  }
  return buckets;
}
