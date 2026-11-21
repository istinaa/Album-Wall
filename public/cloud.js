import { mergeRecords, validateBackup, SCHEMA_VERSION } from './domain.js';

export const CLOUD_CONFIG_KEY = 'album-wall:supabase:v1';
const CLOUD_SESSION_KEY = 'album-wall:supabase-session:v1';

const json = async response => {
  const body = await response.text();
  try { return body ? JSON.parse(body) : {}; } catch { return {}; }
};

function normalizeUrl(value) {
  const url = new URL(String(value || '').trim().replace(/\/+$/, ''));
  // Supabase project URLs are HTTPS by default. Local HTTP is accepted only for
  // a developer's local Supabase stack; arbitrary HTTP endpoints are rejected.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Supabase 地址必须使用 HTTPS');
  if (!local && !url.hostname.endsWith('.supabase.co')) throw new Error('请输入 Supabase 项目地址，例如 https://xxxx.supabase.co');
  return url.toString().replace(/\/$/, '');
}

function readConfig(storage) {
  try {
    const config = JSON.parse(storage.getItem(CLOUD_CONFIG_KEY) || 'null');
    if (!config?.url || !config?.anonKey) return null;
    return { url: normalizeUrl(config.url), anonKey: String(config.anonKey).trim() };
  } catch { return null; }
}

export function createCloudSync(storage, { fetchImpl = fetch } = {}) {
  let config = readConfig(storage);
  let session = null;
  try { session = JSON.parse(storage.getItem(CLOUD_SESSION_KEY) || 'null'); } catch { session = null; }

  function saveConfig(url, anonKey) {
    const next = { url: normalizeUrl(url), anonKey: String(anonKey || '').trim() };
    if (next.anonKey.length < 20 || next.anonKey.length > 500) throw new Error('anon key 看起来不完整');
    storage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(next));
    config = next;
    session = null;
    storage.setItem(CLOUD_SESSION_KEY, '');
    return next;
  }

  async function request(path, options = {}, auth = true) {
    if (!config) throw new Error('请先填写 Supabase 项目地址和 anon key');
    const headers = new Headers(options.headers || {});
    headers.set('apikey', config.anonKey);
    if (auth && session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetchImpl(config.url + path, { ...options, headers });
    const body = await json(response);
    if (!response.ok) {
      const message = body?.msg || body?.message || body?.error_description || body?.error;
      throw new Error(message || `Supabase 请求失败（${response.status}）`);
    }
    return body;
  }

  async function connect(url, anonKey) {
    const sameConfig = config?.url === normalizeUrl(url) && config?.anonKey === String(anonKey || '').trim();
    if (sameConfig && session?.access_token && session?.user?.id) {
      await ensureSession();
      return { userId: session.user.id };
    }
    saveConfig(url, anonKey);
    // Supabase's anonymous sign-in creates a normal Auth user and keeps all
    // rows protected by the RLS policies in supabase/migrations/001_library.sql.
    const result = await request('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ data: { album_wall: true } }) }, false);
    if (!result?.access_token || !result?.user?.id) throw new Error('Supabase 未返回登录会话，请在 Auth 中开启匿名登录');
    session = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: result.expires_at,
      user: result.user };
    storage.setItem(CLOUD_SESSION_KEY, JSON.stringify(session));
    return { userId: result.user.id };
  }

  async function ensureSession() {
    if (session?.access_token && session.user?.id && (!session.expires_at || session.expires_at * 1000 > Date.now() + 60000)) return session;
    if (session?.refresh_token) {
      const result = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token })
      }, false);
      if (result?.access_token && result?.user?.id) {
        session = { access_token: result.access_token, refresh_token: result.refresh_token || session.refresh_token,
          expires_at: result.expires_at, user: result.user };
        storage.setItem(CLOUD_SESSION_KEY, JSON.stringify(session));
        return session;
      }
    }
    throw new Error('请先连接 Supabase 云数据库');
  }

  function row(record, userId) {
    return { user_id: userId, album_id: record.album.id, album: record.album, status: record.status,
      rating: record.rating, note: record.note, category: record.category, added_at: record.addedAt,
      updated_at: record.updatedAt, deleted_at: record.deletedAt };
  }

  function record(value) {
    return { album: value.album, status: value.status, rating: value.rating, note: value.note,
      category: value.category, addedAt: value.added_at, updatedAt: value.updated_at, deletedAt: value.deleted_at };
  }

  async function pull() {
    const current = await ensureSession();
    const rows = await request(`/rest/v1/library_records?select=*&user_id=eq.${encodeURIComponent(current.user.id)}&order=updated_at.asc`);
    return validateBackup({ version: SCHEMA_VERSION, records: (Array.isArray(rows) ? rows : []).map(record) });
  }

  async function sync(localRecords) {
    const current = await ensureSession();
    const remoteRecords = await pull();
    const merged = mergeRecords(remoteRecords, validateBackup({ version: SCHEMA_VERSION, records: localRecords }));
    await request('/rest/v1/library_records?on_conflict=user_id%2Calbum_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(merged.map(item => row(item, current.user.id)))
    });
    return { records: merged, count: merged.length, userId: current.user.id };
  }

  function status() { return { configured: Boolean(config), connected: Boolean(session?.access_token), url: config?.url || '', userId: session?.user?.id || '' }; }
  function disconnect() { session = null; storage.setItem(CLOUD_SESSION_KEY, ''); }
  return { connect, pull, sync, saveConfig, status, disconnect, get config() { return config; } };
}
