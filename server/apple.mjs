import { artistEquivalent, artistSearchAliases, normalizedArtist, normalizedTitle } from './cover-matching.mjs';
import { createArtworkProviders } from './artwork-providers.mjs';
import { createCoverService } from './covers.mjs';
import { createSharedTasks } from './request-control.mjs';

const APPLE_ID = /^apple-(TW|HK|US|GB)-(\d{1,20})$/;
const unsafeStudio = /\b(single|ep|live|remix|mix|karaoke|tribute|greatest hits|compilation)\b|单曲|單曲|迷你专辑|迷你專輯|现场|現場|演唱会|演唱會|混音|精选|精選|翻唱|致敬/iu;

export function parseAppleId(value) {
  const match = APPLE_ID.exec(String(value || ''));
  return match ? { country: match[1], collectionId: match[2] } : null;
}

function relevant(item, query, field) {
  const wanted = normalizedTitle(query);
  const title = normalizedTitle(item.collectionName);
  const artist = normalizedArtist(item.artistName);
  const exactArtist = artistEquivalent(item.artistName, query);
  if (!wanted) return false;
  if (field === 'artist') return exactArtist;
  if (field === 'title') return title.includes(wanted);
  return exactArtist || title.includes(wanted);
}

function studio(item) {
  return Number(item.trackCount) >= 4 && !unsafeStudio.test(String(item.collectionName || ''));
}

export function normalizeAppleAlbum(item, country) {
  return {
    id: `apple-${country}-${item.collectionId}`,
    source: 'apple',
    title: item.collectionName || '未命名唱片',
    artist: item.artistName || '未知艺人',
    artists: [{ id: `apple-${item.artistId || normalizedArtist(item.artistName)}`, name: item.artistName || '未知艺人' }],
    year: String(item.releaseDate || '').slice(0, 4),
    type: Number(item.trackCount) >= 4 ? 'Album' : Number(item.trackCount) > 1 ? 'EP' : 'Single',
    score: 0,
    releaseCount: 0,
    genres: item.primaryGenreName ? [item.primaryGenreName] : []
  };
}

function albumKey(album) {
  return [normalizedTitle(album.title), normalizedArtist(album.artist), album.year].join('|');
}

export function createAppleCatalog({ fetchImpl = fetch, cacheDir,
  providers = createArtworkProviders({ fetchImpl }), covers = createCoverService({ fetchImpl, cacheDir, providers }) } = {}) {
  const shared = createSharedTasks();

  async function search({ query, field = 'all', kind = 'studio', signal }) {
    const key = JSON.stringify([query, field, kind]);
    return shared(key, async sharedSignal => {
      const chinese = /\p{Script=Han}/u.test(query);
      const countries = chinese ? ['TW', 'HK', 'US'] : ['US', 'GB', 'TW'];
      const aliases = field === 'title' ? [] : artistSearchAliases(query).filter(term => term !== query);
      const requests = countries.map(country => ({ country, term: query }));
      if (aliases.length) requests.splice(1, 0, { country: countries[0], term: aliases[0] });
      const albums = [];
      const seen = new Set();
      // Stop at a useful storefront; do not launch every alias in three
      // regions concurrently. Raw artwork remains in the shared provider cache.
      for (const { country, term } of requests) {
        sharedSignal.throwIfAborted();
        const items = await providers.searchApple(term, country, sharedSignal);
        for (const item of items) {
          if (!item.collectionId || !item.artistName || !item.collectionName || !relevant(item, query, field)) continue;
          if (kind === 'studio' && !studio(item)) continue;
          const album = normalizeAppleAlbum(item, country);
          const signature = albumKey(album);
          if (!seen.has(signature)) { seen.add(signature); albums.push(album); }
        }
        if (albums.length) break;
      }
      return { source: 'apple', query, total: albums.length, results: albums };
    }, signal);
  }

  return { search, getCover: covers.getApple };
}
