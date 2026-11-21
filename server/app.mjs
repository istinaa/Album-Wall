import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, createMusicBrainz, parseSearch } from './musicbrainz.mjs';
import { createCoverService } from './covers.mjs';
import { createAppleCatalog, parseAppleId } from './apple.mjs';
import { createCatalog } from './catalog.mjs';
import { createArtworkProviders } from './artwork-providers.mjs';

const workspaceRoot = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function coverSourceHeader(source) {
  // HTTP headers are ISO-8859-1; keep the human-readable Chinese label in
  // the service result but expose an ASCII diagnostic header to Chromium.
  return source === '网易云音乐' ? 'NetEase Music' : String(source || 'unknown').replace(/[^\x20-\x7e]/g, '').trim() || 'unknown';
}

export function createApp({ catalog, fetchImpl = fetch, neteaseFetchImpl = fetchImpl, cacheDir, providerOptions = {} } = {}) {
  const providers = createArtworkProviders({ ...providerOptions, fetchImpl, neteaseFetchImpl });
  const covers = createCoverService({ fetchImpl, neteaseFetchImpl, cacheDir, providers });
  const apple = createAppleCatalog({ fetchImpl, cacheDir, providers, covers });
  const searchCatalog = catalog || createCatalog({ musicBrainz: createMusicBrainz({ fetchImpl }), apple });
  return http.createServer(async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    const signal = controller.signal;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data: https://coverartarchive.org https://archive.org https://*.archive.org; style-src 'self'; script-src 'self'; connect-src 'self' https://*.supabase.co; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        req.resume();
        return json(res, 501, { code: 'CLOUD_NOT_CONFIGURED', error: '云同步尚未接入。数据仅保存在此浏览器，可通过导出备份。' });
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, { error: '不支持此请求方法' });
      }
      if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'album-wall', version: '0.9.0' });
      if (url.pathname === '/api/config') return json(res, 200, { storage: 'local', cloud: { enabled: false, provider: 'supabase' } });
      if (url.pathname === '/api/search') return json(res, 200, await searchCatalog.search({ ...parseSearch(url.searchParams), signal }));
      if (url.pathname.startsWith('/api/apple-cover/')) {
        const parsed = parseAppleId('apple-' + url.pathname.slice('/api/apple-cover/'.length).replace('/', '-'));
        if (!parsed) throw new ApiError(400, '无效的 Apple Music 唱片 ID');
        const cover = await apple.getCover(parsed.country, parsed.collectionId, { signal });
        if (cover) {
          res.writeHead(200, { 'Content-Type': cover.type, 'Cache-Control': 'public, max-age=86400', 'X-Cover-Source': coverSourceHeader(cover.source) });
          return res.end(req.method === 'HEAD' ? undefined : cover.body);
        }
        // A non-2xx response lets the desktop/browser retry a transient
        // provider miss instead of treating the placeholder as a successful
        // permanent image.
        res.writeHead(404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Cover-Source': 'placeholder' });
        return res.end(req.method === 'HEAD' ? undefined : await readFile(resolve(workspaceRoot, 'cover-placeholder.svg')));
      }
      if (url.pathname.startsWith('/api/cover/')) {
        const id = url.pathname.slice('/api/cover/'.length);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, '无效的 MusicBrainz ID');
        const title = (url.searchParams.get('title') || '').slice(0, 1000);
        const artist = (url.searchParams.get('artist') || '').slice(0, 1000);
        const aliases = url.searchParams.getAll('artistAlias').slice(0, 15).map(alias => alias.slice(0, 200));
        const titleAliases = url.searchParams.getAll('titleAlias').slice(0,8).map(alias => alias.slice(0,200));
        const year = (url.searchParams.get('year') || '').slice(0,4);
        const cover = await covers.get(id, title, artist, aliases, { year, titleAliases }, { signal });
        if (cover) {
          res.writeHead(200, { 'Content-Type': cover.type, 'Cache-Control': 'public, max-age=86400', 'X-Cover-Source': coverSourceHeader(cover.source) });
          return res.end(req.method === 'HEAD' ? undefined : cover.body);
        }
        res.writeHead(404, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'X-Cover-Source': 'placeholder' });
        return res.end(req.method === 'HEAD' ? undefined : await readFile(resolve(workspaceRoot, 'cover-placeholder.svg')));
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });

      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, '无效路径'); }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) throw new ApiError(404, '文件不存在');
      const file = resolve(workspaceRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(workspaceRoot.replace(/[\\/]$/, '') + sep) || !mime[extname(file)]) throw new ApiError(404, '文件不存在');
      let body;
      try { body = await readFile(file); } catch { throw new ApiError(404, '文件不存在'); }
      res.writeHead(200, { 'Content-Type': mime[extname(file)], 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      if (signal.aborted || res.destroyed) return;
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      if (!(error instanceof ApiError)) console.error('[api]', error.message);
      json(res, error.status || 500, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' });
    } finally {
      res.removeListener('close', disconnect);
    }
  });
}
