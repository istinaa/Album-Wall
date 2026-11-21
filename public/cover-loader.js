const PLACEHOLDER = new URL('./cover-placeholder.svg', import.meta.url).href;

// DOM cards and canvas walls share this loader. One URL has one request, and
// requests with no remaining visible consumer are cancelled, including retries.
export function createCoverLoader({ fetchImpl = globalThis.fetch, concurrency = 4,
  createUrl = blob => URL.createObjectURL(blob), revokeUrl = url => URL.revokeObjectURL(url),
  schedule = setTimeout, cancel = clearTimeout, maxEntries = 160 } = {}) {
  const entries = new Map();
  const queue = [];
  let active = 0;
  let disposed = false;
  const evict = () => {
    let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0);
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries && bytes <= 40 * 1024 * 1024) break;
      if (entry.listeners.size || entry.controller || entry.queued) continue;
      if (entry.result) revokeUrl(entry.result);
      bytes -= entry.bytes || 0;
      entries.delete(key);
    }
  };
  const enqueue = entry => {
    if (disposed || entry.queued || entry.controller || !entry.listeners.size) return;
    entry.queued = true;
    queue.push(entry);
    pump();
  };
  const pump = () => {
    while (!disposed && active < concurrency && queue.length) {
      const entry = queue.shift();
      entry.queued = false;
      if (!entry.listeners.size) continue;
      const controller = new AbortController();
      entry.controller = controller;
      active++;
      (async () => {
        try {
          const response = await fetchImpl(entry.key, { signal: controller.signal });
          if (!response.ok) {
            const header = response.headers.get('retry-after');
            const after = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
            await response.body?.cancel();
            if (response.status === 404 || response.status === 400) { entry.missingUntil = Date.now() + 300000; return; }
            const error = new Error('Cover temporarily unavailable');
            error.retryMs = after;
            throw error;
          }
          const blob = await response.blob();
          if (!/^image\/(jpeg|jpg|png|webp)/i.test(blob.type) || blob.size > 5000000 || !blob.size) throw new Error('Invalid cover image');
          if (controller.signal.aborted || disposed) return;
          entry.result = createUrl(blob);
          entry.bytes = blob.size;
          entry.attempts = 0;
          entry.retryAt = 0;
          for (const listener of entry.listeners) listener(entry.result);
        } catch (error) {
          if (controller.signal.aborted || disposed) return;
          entry.attempts++;
          const retryMs = Math.max(error.retryMs || 0, Math.min(300000, 10000 * 2 ** (entry.attempts - 1)));
          entry.retryAt = Date.now() + retryMs;
          entry.timer = schedule(() => { entry.timer = null; enqueue(entry); }, retryMs);
        } finally {
          entry.controller = null;
          active--;
          // A new view may have subscribed while the old request was aborting.
          if (controller.signal.aborted && entry.listeners.size && !disposed) enqueue(entry);
          pump();
          evict();
        }
      })();
    }
  };
  return {
    subscribe(key, listener) {
      if (disposed) return () => {};
      if (key === PLACEHOLDER) { listener(PLACEHOLDER); return () => {}; }
      let entry = entries.get(key);
      if (!entry) { entry = { key, listeners: new Set(), attempts: 0 }; entries.set(key, entry); }
      entry.listeners.add(listener);
      if (entry.result) listener(entry.result);
      else if (!entry.timer && !(entry.missingUntil > Date.now())) {
        const wait = (entry.retryAt || 0) - Date.now();
        if (wait > 0) entry.timer = schedule(() => { entry.timer = null; enqueue(entry); }, wait);
        else enqueue(entry);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.listeners.delete(listener);
        if (!entry.listeners.size) {
          entry.controller?.abort();
          if (entry.timer) { cancel(entry.timer); entry.timer = null; }
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          entry.queued = false;
        }
        evict();
      };
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        entry.controller?.abort();
        if (entry.timer) cancel(entry.timer);
        if (entry.result) revokeUrl(entry.result);
        entry.listeners.clear();
      }
      queue.length = 0;
      entries.clear();
    }
  };
}

let sharedLoader;
export const coverLoader = () => sharedLoader ||= createCoverLoader();
const observed = new Map();
let visibility;
function observeImages() {
  if (visibility) return;
  visibility = new IntersectionObserver(changes => {
    for (const change of changes) {
      const state = observed.get(change.target);
      if (!state) continue;
      if (change.isIntersecting && !document.hidden && !state.release) {
        state.release = coverLoader().subscribe(state.url, url => { change.target.src = url; });
      } else if (!change.isIntersecting) { state.release?.(); state.release = null; }
    }
  }, { rootMargin: '120px' });
  new MutationObserver(() => {
    for (const [img, state] of observed) {
      if (img.isConnected) continue;
      state.release?.();
      visibility.unobserve(img);
      observed.delete(img);
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    for (const [img, state] of observed) {
      state.release?.(); state.release = null;
      visibility.unobserve(img);
      if (!document.hidden) visibility.observe(img);
    }
  });
}

export function setCoverImage(img, url) {
  observeImages();
  observed.get(img)?.release?.();
  visibility.unobserve(img);
  img.src = PLACEHOLDER;
  observed.set(img, { url, release: null });
  visibility.observe(img);
}

export function attachCoverImages(root) {
  root.querySelectorAll('img[data-cover]').forEach(img => {
    if (observed.get(img)?.url !== img.dataset.cover) setCoverImage(img, img.dataset.cover);
  });
}
