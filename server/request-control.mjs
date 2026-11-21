import { setTimeout as delay } from 'node:timers/promises';

// A cancelled page releases its queue entries immediately. Subscribers to the
// same request share work, but one subscriber cannot abort the others.
export function createSharedTasks() {
  const pending = new Map();
  return (key, work, signal) => {
    signal?.throwIfAborted();
    let entry = pending.get(key);
    if (!entry) {
      entry = { controller: new AbortController(), users: 0 };
      pending.set(key, entry);
      entry.promise = Promise.resolve().then(() => work(entry.controller.signal)).finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
    }
    entry.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (callback, value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', abort);
        entry.users--;
        if (!entry.users) {
          entry.controller.abort();
          if (pending.get(key) === entry) pending.delete(key);
        }
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
      if (signal?.aborted) abort();
    });
  };
}

export function createWorkQueue(concurrency = 4, maxWaiting = 100) {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift();
      job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) { job.reject(job.signal.reason); continue; }
      active++;
      Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  };
  return (work, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (waiting.length >= maxWaiting) return reject(new ProviderUnavailableError('封面请求较多', 5));
    const job = { work, signal, resolve, reject };
    job.abort = () => { const index = waiting.indexOf(job); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); };
    signal?.addEventListener('abort', job.abort, { once: true });
    waiting.push(job);
    pump();
  });
}

export class ProviderUnavailableError extends Error {
  constructor(message, retryAfter = 30) {
    super(message);
    this.status = 503;
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const milliseconds = Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
}

export const waitForRequest = (ms, signal) => ms > 0 ? delay(ms, undefined, { signal }) : Promise.resolve();
