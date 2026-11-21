import { isArtworkUrl, isNeteaseArtworkUrl, matchArtwork } from './cover-matching.mjs';
import { createSharedTasks, createWorkQueue, ProviderUnavailableError, waitForRequest, retryAfterMs } from './request-control.mjs';

function secureNeteaseArtwork(value) {
  try {
    const url = new URL(value);
    if ((url.hostname === 'music.126.net' || url.hostname.endsWith('.music.126.net')) && url.protocol === 'http:') url.protocol = 'https:';
    return url.toString();
  } catch { return value; }
}

// Shared by catalogue searches and cover lookups. Provider failures are never
// stored as empty search results, and Retry-After applies to the whole provider.
export function createArtworkProviders({ fetchImpl = fetch, neteaseFetchImpl = fetchImpl,
  appleIntervalMs = 3200, neteaseIntervalMs = 700, cooldownMs = 60000, now = Date.now } = {}) {
  const cached = new Map();
  const known = new Map();
  const shared = createSharedTasks();
  const states = new Map();
  const stateFor = name => {
    if (!states.has(name)) states.set(name, { run: createWorkQueue(1), next: 0, until: 0 });
    return states.get(name);
  };
  const unavailable = (name, state) => new ProviderUnavailableError(`${name} 暂时不可用`, (state.until - now()) / 1000);
  const remember = items => {
    for (const item of items) {
      if (isArtworkUrl(item.artworkUrl100) || isNeteaseArtworkUrl(item.artworkUrl100)) {
        known.delete(item.artworkUrl100);
        known.set(item.artworkUrl100, item);
      }
    }
    while (known.size > 4000) known.delete(known.keys().next().value);
  };
  async function request(name, url, signal, transform) {
    const hit = cached.get(url);
    if (hit && hit.until > now()) { remember(hit.items); return hit.items; }
    const state = stateFor(name);
    if (state.until > now()) throw unavailable(name, state);
    return shared(url, sharedSignal => state.run(async () => {
      if (state.until > now()) throw unavailable(name, state);
      await waitForRequest(state.next - now(), sharedSignal);
      sharedSignal.throwIfAborted();
      if (state.until > now()) throw unavailable(name, state);
      state.next = now() + (name === 'Apple Music' ? appleIntervalMs : neteaseIntervalMs);
      try {
        const response = await (name === 'NetEase Music' ? neteaseFetchImpl : fetchImpl)(url, {
          headers: { 'User-Agent': 'AlbumWall/0.9.0', ...(name === 'NetEase Music' ? { Referer: 'https://music.163.com/' } : {}) },
          signal: AbortSignal.any([sharedSignal, AbortSignal.timeout(8000)])
        });
        const retryMs = retryAfterMs(response.headers.get('retry-after'), now());
        if (!response.ok) {
          await response.body?.cancel();
          state.until = now() + Math.max(cooldownMs, retryMs || 0);
          throw unavailable(name, state);
        }
        const data = await response.json();
        if (name === 'NetEase Music' && data.code !== undefined && data.code !== 200) {
          state.until = now() + Math.max(cooldownMs, retryMs);
          throw unavailable(name, state);
        }
        const items = transform(data);
        if (!Array.isArray(items)) throw new Error('无效的唱片查询结果');
        cached.set(url, { items, until: now() + 900000 });
        while (cached.size > 300) cached.delete(cached.keys().next().value);
        remember(items);
        return items;
      } catch (error) {
        if (sharedSignal.aborted) throw sharedSignal.reason;
        if (!(error instanceof ProviderUnavailableError)) state.until = now() + cooldownMs;
        throw unavailable(name, state);
      }
    }, sharedSignal), signal);
  }
  return {
    find: (title, artist, aliases, metadata) => matchArtwork([...known.values()], title, artist, aliases, metadata),
    findApple: collectionId => [...known.values()].find(item => String(item.collectionId) === collectionId && isArtworkUrl(item.artworkUrl100)),
    async searchApple(term, country, signal) {
      const params = new URLSearchParams({ term, entity: 'album', limit: '200', country,
        lang: ['TW', 'HK'].includes(country) ? 'zh_tw' : 'en_us' });
      return request('Apple Music', 'https://itunes.apple.com/search?' + params, signal, data => data.results);
    },
    async lookupApple(country, collectionId, signal) {
      const params = new URLSearchParams({ id: collectionId, entity: 'album', country });
      return request('Apple Music', 'https://itunes.apple.com/lookup?' + params, signal, data => data.results);
    },
    async searchNetease(term, signal) {
      const params = new URLSearchParams({ s: term, type: '10', offset: '0', limit: '100' });
      return request('NetEase Music', 'https://music.163.com/api/search/get?' + params, signal, data => (data.result?.albums || []).map(album => ({
        collectionName: album.name,
        artistName: album.artist?.name || album.artists?.map(item => item.name).join(' & '),
        // NetEase still returns legacy http artwork links. Keep the matcher
        // strict and upgrade only this known public image host to HTTPS.
        artworkUrl100: secureNeteaseArtwork(album.picUrl),
        releaseDate: Number.isFinite(album.publishTime) ? new Date(album.publishTime).toISOString() : '',
        trackCount: album.size
      })));
    }
  };
}
