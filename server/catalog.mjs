import { normalizedArtist, normalizedTitle } from './cover-matching.mjs';
import { rankReleaseGroups } from './musicbrainz.mjs';

const key = album => [normalizedTitle(album.title), normalizedArtist(album.artist), album.year].join('|');

export function mergeCatalogAlbums(musicBrainzAlbums, appleAlbums, query, field = 'all') {
  const merged = [];
  const seen = new Set();
  // Keep MusicBrainz IDs where both sources describe the same release. Its stable
  // release-group ID also lets the cover service use Apple/NetEase as fallbacks.
  for (const album of [...musicBrainzAlbums, ...appleAlbums]) {
    const signature = key(album);
    if (!seen.has(signature)) { seen.add(signature); merged.push(album); }
  }
  return rankReleaseGroups(merged, query, field);
}

export function createCatalog({ musicBrainz, apple }) {
  return {
    async search(args) {
      if (args.offset >= 100) return musicBrainz.search(args);
      const [mbResult, appleResult] = await Promise.allSettled([
        musicBrainz.search({ ...args, offset: 0, limit: 100 }),
        apple.search(args)
      ]);
      if (mbResult.status === 'rejected' && appleResult.status === 'rejected') throw mbResult.reason;
      const mb = mbResult.status === 'fulfilled' ? mbResult.value : { total: 0, results: [] };
      const extra = appleResult.status === 'fulfilled' ? appleResult.value.results : [];
      const mbKeys = new Set(mb.results.map(key));
      const extraCount = new Set(extra.filter(album => !mbKeys.has(key(album))).map(key)).size;
      const combined = mergeCatalogAlbums(mb.results, extra, args.query, args.field).slice(0, 100);
      return {
        source: 'combined', query: args.query, offset: args.offset, limit: args.limit,
        total: Math.max(combined.length, Number(mb.total || 0) + extraCount),
        results: combined.slice(args.offset, args.offset + args.limit)
      };
    }
  };
}
