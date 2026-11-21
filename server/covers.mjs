import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isArtworkUrl, isNeteaseArtworkUrl, matchArtwork } from './cover-matching.mjs';
import { createArtworkProviders } from './artwork-providers.mjs';
import { createSharedTasks, createWorkQueue, ProviderUnavailableError, waitForRequest, retryAfterMs } from './request-control.mjs';
export { isNeteaseArtworkUrl, matchArtwork } from './cover-matching.mjs';

function titleSearchVariants(value) {
  const source = String(value || '').trim();
  const stripped = source.replace(/[（(][^）)]*[）)]/gu, ' ').replace(/\b(?:live|concert|\d{4}\s+mix)\b/giu, ' ')
    .replace(/[．。·・•:：/\\|]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const parts = /\p{Script=Han}/u.test(source) ? (source.match(/[\p{Script=Han}]{2,}|[\p{Script=Latin}\p{N}]{4,}/gu) || []) : [];
  return [...new Set([source, stripped, ...parts].filter(Boolean))];
}

export function createCoverService({ fetchImpl = fetch, neteaseFetchImpl = fetchImpl, cacheDir,
  timeoutMs = 6000, providers = createArtworkProviders({ fetchImpl, neteaseFetchImpl }), now = Date.now } = {}) {
  const shared = createSharedTasks();
  const run = createWorkQueue(4);
  const memory = new Map();
  const misses = new Map();
  let memoryBytes = 0;
  const imageCooldowns = new Map();

  async function readCached(id) {
    if (memory.has(id)) return memory.get(id);
    if (!cacheDir) return null;
    try {
      const [body, meta] = await Promise.all([readFile(join(cacheDir, id + '.img')), readFile(join(cacheDir, id + '.json'), 'utf8')]);
      const { type, source } = JSON.parse(meta);
      if (body.length && body.length <= 5000000 && /^image\/(jpeg|jpg|png|webp)/i.test(type)) return { body, type, source };
    } catch { /* A cache miss has no effect on the user's library. */ }
    return null;
  }

  async function saveCached(id, result) {
    memoryBytes -= memory.get(id)?.body.length || 0;
    memory.delete(id);
    memory.set(id, result);
    memoryBytes += result.body.length;
    while (memoryBytes > 40 * 1024 * 1024 || memory.size > 300) {
      const first = memory.keys().next().value;
      memoryBytes -= memory.get(first).body.length;
      memory.delete(first);
    }
    if (cacheDir) {
      try {
        await mkdir(cacheDir, { recursive: true });
        await Promise.all([writeFile(join(cacheDir, id + '.img'), result.body),
          writeFile(join(cacheDir, id + '.json'), JSON.stringify({ type: result.type, source: result.source }))]);
      } catch { /* Read-only caches must not hide a successfully fetched cover. */ }
    }
  }

  async function image(url, source, signal, timeout = 6500) {
    signal.throwIfAborted();
    const until = imageCooldowns.get(source) || 0;
    if (until > now()) throw new ProviderUnavailableError(`${source} 封面暂时不可用`, (until - now()) / 1000);
    const request = source === '网易云音乐' ? neteaseFetchImpl : fetchImpl;
    try {
      const response = await request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
      if (!response.ok || !/^image\/(jpeg|jpg|png|webp)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        if (response.status === 404) return null;
        const retryAfter = Math.max(60, retryAfterMs(response.headers.get('retry-after'), now()) / 1000);
        const error = new ProviderUnavailableError(`${source} 封面暂时不可用`, retryAfter);
        // A source-wide image cooldown is warranted only by an explicit rate
        // limit/upstream outage. A malformed image or one network timeout must
        // not hide every other cover that is still available.
        if (response.status === 429 || response.status === 503 || response.headers.has('retry-after')) {
          error.cooldownMs = retryAfter * 1000;
        }
        throw error;
      }
      if (Number(response.headers.get('content-length')) > 5000000) { await response.body?.cancel(); throw new Error('Cover too large'); }
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length || body.length > 5000000) throw new Error('Invalid cover');
      return { body, type: response.headers.get('content-type'), source };
    } catch (error) {
      signal.throwIfAborted();
      const retryAfter = error.retryAfter || 60;
      if (error.cooldownMs) imageCooldowns.set(source, now() + error.cooldownMs);
      throw new ProviderUnavailableError(`${source} 封面暂时不可用`, retryAfter);
    }
  }

  function matchedImage(item, signal) {
    if (isArtworkUrl(item?.artworkUrl100)) return image(item.artworkUrl100.replace(/100x100bb/, '600x600bb'), 'Apple Music', signal);
    if (isNeteaseArtworkUrl(item?.artworkUrl100)) {
      const url = new URL(item.artworkUrl100);
      url.searchParams.set('param', '600y600');
      return image(url.toString(), '网易云音乐', signal);
    }
    return Promise.resolve(null);
  }

  async function resolve(id, title, artist, aliases, metadata, parentSignal) {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(45000)]);
    let transient = false;
    let retryAfter = 30;
    const attempt = async work => {
      try { return await work(); }
      catch (error) {
        if (!signal.aborted) { transient = true; retryAfter = Math.max(retryAfter, error.retryAfter || 30); }
        return null;
      }
    };
    try {
      // Reuse verified artwork from catalogue searches before calling another API.
      const known = providers.find(title, artist, aliases, metadata);
      if (known) {
        const result = await attempt(() => matchedImage(known, signal));
        if (result) return result;
      }
      const titles = [...new Set([title, ...(metadata.titleAliases || [])].flatMap(titleSearchVariants))].slice(0, 3);
      const terms = [...new Set([artist, ...titles.flatMap(name => [name + ' ' + artist, name])].filter(Boolean))];
      const searchProvider = async provider => {
        if (!title || !artist) return null;
        const countries = /\p{Script=Han}/u.test(title + artist) ? ['TW', 'HK', 'US'] : ['US', 'GB', 'TW'];
        // One shared artist query serves many covers; bound individual fallback work.
        const queries = provider === 'apple'
          ? [[artist, countries[0]], ...terms.slice(1, 3).map(term => [term, countries[0]]), [artist, countries[1]], [artist, countries[2]]]
          : terms.slice(0, 5).map(term => [term]);
        for (const [term, country] of queries) {
          signal.throwIfAborted();
          const items = provider === 'apple' ? await providers.searchApple(term, country, signal) : await providers.searchNetease(term, signal);
          const match = matchArtwork(items, title, artist, aliases, metadata);
          if (match) {
            const result = await matchedImage(match, signal);
            if (result) return result;
          }
        }
        return null;
      };
      const archive = () => image('https://coverartarchive.org/release-group/' + id + '/front-500', 'Cover Art Archive', signal, timeoutMs);
      const requireCover = async promise => { const result = await promise; if (!result) throw new Error('No matched artwork'); return result; };
      try {
        return await Promise.any([
          requireCover(attempt(archive)),
          requireCover(attempt(async () => { await waitForRequest(300, signal); return searchProvider('netease'); })),
          requireCover(attempt(async () => { await waitForRequest(600, signal); return searchProvider('apple'); }))
        ]);
      } catch {
        parentSignal.throwIfAborted();
        if (transient || signal.aborted) throw new ProviderUnavailableError('封面服务暂时不可用', retryAfter);
        return null;
      }
    } finally { controller.abort(); }
  }

  async function cachedTask(id, key, work, signal) {
    signal?.throwIfAborted();
    const cached = await readCached(id);
    if (cached) return cached;
    const miss = misses.get(key);
    if (miss && miss.until > now()) {
      if (miss.transient) throw new ProviderUnavailableError('封面服务暂时不可用', (miss.until - now()) / 1000);
      return null;
    }
    return shared(key, sharedSignal => run(async () => {
      sharedSignal.throwIfAborted();
      try {
        const result = await work(sharedSignal);
        if (result) { await saveCached(id, result); misses.delete(key); }
        else misses.set(key, { until: now() + 300000, transient: false });
        return result;
      } catch (error) {
        if (sharedSignal.aborted) throw sharedSignal.reason;
        const retryAfter = error.retryAfter || 30;
        misses.set(key, { until: now() + retryAfter * 1000, transient: true });
        throw new ProviderUnavailableError('封面服务暂时不可用', retryAfter);
      } finally { while (misses.size > 500) misses.delete(misses.keys().next().value); }
    }, sharedSignal), signal);
  }

  return {
    get(id, title, artist, aliases = [], metadata = {}, { signal } = {}) {
      return cachedTask(id, JSON.stringify([id, title, artist, aliases, metadata]),
        sharedSignal => resolve(id, title, artist, aliases, metadata, sharedSignal), signal);
    },
    getApple(country, collectionId, { signal } = {}) {
      if (!['TW', 'HK', 'US', 'GB'].includes(country) || !/^\d{1,20}$/.test(collectionId)) return Promise.resolve(null);
      const id = `apple-${country}-${collectionId}`;
      return cachedTask(id, id, async sharedSignal => {
        const known = providers.findApple(collectionId);
        const item = known || (await providers.lookupApple(country, collectionId, sharedSignal)).find(item => String(item.collectionId) === collectionId);
        return matchedImage(item, sharedSignal);
      }, signal);
    }
  };
}
