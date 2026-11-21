const configuredOrigin = new URLSearchParams(globalThis.location?.search || '').get('apiOrigin') || '';
const API_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(configuredOrigin) ? configuredOrigin : '';

export function apiUrl(path) {
  return API_ORIGIN ? API_ORIGIN + path : path;
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试');
  return data;
}

export const catalogApi = {
  search({ query, field, kind = 'studio', offset = 0, signal }) {
    const params = new URLSearchParams({ q: query, field, kind, offset: String(offset), limit: '20' });
    return request(`/api/search?${params}`, { signal });
  }
};

// Cloud implementation belongs behind this boundary, after authenticated user identity is available.
export const cloudApi = {
  config: () => request('/api/config'),
  sync: () => request('/api/sync', { method: 'POST' })
};
