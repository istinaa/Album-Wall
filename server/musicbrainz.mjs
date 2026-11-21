import { artistEquivalent, artistSearchAliases } from './cover-matching.mjs';
import { createSharedTasks, createWorkQueue, waitForRequest } from './request-control.mjs';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseSearch(params) {
  const query = (params.get('q') || '').trim();
  const field = params.get('field') || 'all';
  const kind = params.get('kind') || 'studio';
  const limit = Number(params.get('limit') ?? 20);
  const offset = Number(params.get('offset') ?? 0);
  if (query.length < 2 || query.length > 120) throw new ApiError(400, '请输入 2–120 个字符');
  if (!['all', 'title', 'artist'].includes(field)) throw new ApiError(400, '无效的搜索范围');
  if (!['studio', 'all'].includes(kind)) throw new ApiError(400, '无效的发行类型');
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new ApiError(400, 'limit 必须是 1–25 的整数');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new ApiError(400, 'offset 必须是 0–10000 的整数');
  return { query, field, kind, limit, offset };
}

function escapeLucene(value) {
  return value.replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, '\\$1');
}

export function buildQuery(query, field, kind = 'all') {
  const phrase = `"${escapeLucene(query)}"`;
  const artistPhrases = [...new Set(artistSearchAliases(query).map(value => `"${escapeLucene(value)}"`))];
  const artistTerm = artistPhrases.length > 1 ? `artist:(${artistPhrases.join(' OR ')})` : `artist:${phrase}`;
  const words = query.split(/\s+/).filter(Boolean).map(word => `(releasegroup:"${escapeLucene(word)}" OR artist:"${escapeLucene(word)}")`).join(' AND ');
  const term = field === 'title' ? `releasegroup:${phrase}` : field === 'artist' ? artistTerm :
    `(releasegroup:${phrase}^4 OR ${artistTerm}^4 OR (${words}))`;
  // Filter BEFORE pagination so bootlegs/live recordings cannot bury studio albums.
  return kind === 'studio' ? `(${term}) AND primarytype:album AND NOT secondarytype:*` : term;
}

export function normalizeReleaseGroup(item) {
  const credits = (item['artist-credit'] || []).filter(credit => credit.artist);
  const tags = [...(item.genres || []), ...(item.tags || [])]
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .map(tag => tag.name)
    .filter(Boolean);
  return {
    id: item.id,
    source: 'musicbrainz',
    title: item.title || '未命名唱片',
    titleAliases: [...new Set([...(item.aliases || []).map(alias => alias.name), ...(item.releases || []).filter(release => release.status === 'Official').map(release => release.title)])]
      .filter(title => typeof title === 'string' && title !== item.title && title.length <= 200).slice(0,8),
    artist: credits.map(credit => `${credit.name || credit.artist.name}${credit.joinphrase || ''}`).join('') || '未知艺人',
    artists: credits.map(credit => ({ id: credit.artist.id, name: credit.artist.name,
      aliases: [...new Set((credit.artist.aliases || []).filter(a => a.type !== 'Search hint')
        .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
        .map(a => a.name).filter(name => typeof name === 'string' && name.length <= 200))].slice(0, 8) })),
    year: (item['first-release-date'] || '').slice(0, 4),
    type: item['primary-type'] || '专辑',
    score: Number(item.score || 0),
    releaseCount: Number(item['release-count'] || item.count || 0),
    genres: [...new Set(tags)].slice(0, 10),
    cover: `https://coverartarchive.org/release-group/${item.id}/front-250`
  };
}

function normalized(value) {
  return String(value || '').toLocaleLowerCase().replace(/[’'“”"`]/g, '').replace(/\s+/g, ' ').trim();
}

export function rankReleaseGroups(items, query, field = 'all') {
  const wanted = normalized(query);
  return items
    .map((item, index) => {
      const title = normalized(item.title);
      const artist = normalized(item.artist);
      const exactTitle = title === wanted;
      const exactArtist = artistEquivalent(item.artist, query);
      const titleMatch = title.includes(wanted);
      const artistMatch = artist.includes(wanted);
      const typeBonus = item.type === 'Album' ? 30 : item.type === 'EP' ? 20 : item.type === 'Other' ? 5 : -35;
      const fieldBonus = field === 'title' ? (exactTitle ? 80 : titleMatch ? 40 : -40) :
        field === 'artist' ? (exactArtist ? 80 : artistMatch ? 40 : -40) : 0;
      const matchBonus = (field === 'artist' ? 0 : exactTitle ? 120 : titleMatch ? 55 : 0) + (exactArtist ? 100 : artistMatch ? 45 : 0);
      const yearBonus = item.year ? 5 : 0;
      const popularity = Math.min(70, Math.log2(1 + (item.releaseCount || 0)) * 10);
      return { item, index, rank: matchBonus + fieldBonus + typeBonus + yearBonus + item.score / 10 + popularity };
    })
    .sort((a, b) => b.rank - a.rank ||
      (normalized(a.item.artist) === wanted && normalized(b.item.artist) === wanted
        ? (Number(a.item.year) || 9999) - (Number(b.item.year) || 9999) : 0) || a.index - b.index)
    .map(({ item }) => item);
}

export function createMusicBrainz({
  fetchImpl = fetch,
  intervalMs = 1100,
  ttlMs = 300000,
  maxCache = 200,
  userAgent = process.env.MUSICBRAINZ_USER_AGENT || 'AlbumWall/0.9.0 (personal music library)'
} = {}) {
  const cache = new Map();
  const shared = createSharedTasks();
  const run = createWorkQueue(1, 30);
  let lastStarted = 0;

  async function search(args) {
    // Fetch and rank a complete 100-record window; page within the same cached order.
    const block = Math.floor(args.offset / 100) * 100;
    const data = await getBlock({ ...args, offset: block, limit: 100 });
    const start = args.offset - block;
    const results = data.results.slice(start, start + Math.min(args.limit, 100 - start));
    return { ...data, offset: args.offset, limit: args.limit, results };
  }

  async function getBlock(args) {
    args.signal?.throwIfAborted();
    const key = JSON.stringify([args.query, args.field, args.kind || 'studio', args.offset, args.limit]);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    return shared(key, signal => run(async () => {
      await waitForRequest(lastStarted + intervalMs - Date.now(), signal);
      signal.throwIfAborted();
      lastStarted = Date.now();
      const url = new URL('https://musicbrainz.org/ws/2/release-group/');
      url.search = new URLSearchParams({ query: buildQuery(args.query, args.field, args.kind || 'studio'), fmt: 'json', limit: String(args.limit), offset: String(args.offset) }).toString();
      let response;
      try {
        response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      } catch {
        signal.throwIfAborted();
        throw new ApiError(502, '连接 MusicBrainz 超时或失败，请稍后重试');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status === 429 || response.status === 503 ? 503 : 502, 'MusicBrainz 暂时不可用，请稍后重试');
      }
      const data = await response.json();
      const normalized = (data['release-groups'] || []).map(normalizeReleaseGroup);
      const value = { source: 'musicbrainz', query: args.query, offset: args.offset, limit: args.limit, total: data.count || 0,
        results: rankReleaseGroups(normalized, args.query, args.field).slice(0, args.limit) };
      cache.delete(key);
      cache.set(key, { value, expires: Date.now() + ttlMs });
      if (cache.size > maxCache) cache.delete(cache.keys().next().value);
      return value;
    }, signal), args.signal);
  }
  return { search };
}
