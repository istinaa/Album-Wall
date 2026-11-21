import https from 'node:https';

// Electron's Chromium network stack can stall on music.163.com. This small
// adapter uses Node TLS for that provider and still returns the standard
// Response shape consumed by the cover service.
export function nodeHttpsFetch(input, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    if (url.protocol !== 'https:') return reject(new Error('Only HTTPS is allowed'));
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const request = https.get(url, { headers }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 6 * 1024 * 1024) request.destroy(new Error('Response too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, new Response(Buffer.concat(chunks), {
        status: response.statusCode || 502,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined))
      })));
    });
    const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    request.setTimeout(10000, () => request.destroy(new Error('Request timed out')));
    request.on('error', error => finish(reject, error));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
