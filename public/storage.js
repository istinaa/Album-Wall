import { SCHEMA_VERSION, MBID, validateRecord, validateBackup, mergeRecords } from './domain.js';

export const STORAGE_KEY = 'album-wall:library:v1';
const LEGACY_KEY = 'album-wall-data';

function migrateLegacy(data) {
  if (!Array.isArray(data)) throw new Error('旧版收藏格式不正确');
  return data.map((old, index) => {
    const id = old.sourceId || (old.id?.startsWith('mb-') ? old.id.slice(3) : `local-${old.id}`);
    const timestamp = new Date(Date.now() - index).toISOString();
    return validateRecord({
      album: { id, source: MBID.test(id) ? 'musicbrainz' : 'local', title: old.title, artist: old.artist,
        artists: [], year: String(old.year || ''), type: 'Album', genres: [] },
      status: old.played ? 'listened' : 'wanted', rating: typeof old.rating === 'number' ? Math.round(old.rating * 2) / 2 : null,
      note: old.note || '', category: old.genre || '', addedAt: timestamp, updatedAt: timestamp, deletedAt: null
    });
  });
}

export class LibraryStore {
  constructor(storage, { desktop = null } = {}) {
    this.storage = storage; this.desktop = desktop; this.records = []; this.error = null;
    this.diskStatus = null; this.diskReadBlocked = false; this.persistQueue = Promise.resolve();
  }

  load() {
    try {
      const current = this.storage.getItem(STORAGE_KEY);
      if (current !== null) this.records = validateBackup(JSON.parse(current));
      else {
        const legacy = this.storage.getItem(LEGACY_KEY);
        if (legacy !== null) {
          this.records = mergeRecords([], migrateLegacy(JSON.parse(legacy)));
          this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, records: this.records }));
        }
      }
      if (!this.diskReadBlocked) this.error = null;
    } catch {
      this.error = '本地收藏无法读取，原始数据已保留。请先导出原始数据备份，检查浏览器存储设置。';
    }
    return this.records;
  }

  commit(records) {
    if (this.error || this.diskReadBlocked) throw new Error(this.error || '磁盘收藏暂时无法读取，已保留当前数据，未覆盖原文件。');
    const valid = validateBackup({ version: SCHEMA_VERSION, records });
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, records: valid })); }
    catch { throw new Error('本地保存失败：存储空间不足或浏览器禁用了存储。请导出备份。'); }
    this.records = valid;
    if (this.desktop) {
      const payload = { version: SCHEMA_VERSION, records: valid };
      if (typeof this.desktop.saveSync === 'function') {
        const result = this.desktop.saveSync(payload);
        if (result && result.ok === false) {
          this.diskReadBlocked = true;
          this.error = '磁盘保存失败：' + (result.error || '请立即导出备份');
          throw new Error(this.error);
        }
        this.diskStatus = result?.status || this.diskStatus;
      } else {
        this.persistQueue = this.persistQueue.then(() => this.desktop.save(payload)).then(status => { this.diskStatus = status; }, error => {
          this.diskReadBlocked = true;
          this.error = '磁盘保存失败：' + (error?.message || '请立即导出备份');
        });
      }
    }
  }

  // Desktop startup uses a synchronous bridge so the first render is based on
  // the durable file. This closes the gap where an empty renderer
  // localStorage value could appear before asynchronous hydration finished.
  hydrateSync() {
    const localRecords = this.load();
    if (!this.desktop || typeof this.desktop.loadSync !== 'function') return this.records;
    try {
      const result = this.desktop.loadSync();
      this.diskStatus = result?.status || null;
      if (!result?.data) {
        const fileExists = result?.status?.fileExists;
        if (fileExists === false) {
          this.diskReadBlocked = false;
          this.error = null;
          if (localRecords.length === 0) return this.records;
          const payload = { version: SCHEMA_VERSION, records: localRecords };
          const saved = this.desktop.saveSync?.(payload);
          if (saved && saved.ok === false) {
            this.diskReadBlocked = true;
            this.error = '磁盘保存失败：' + (saved.error || '请立即导出备份');
          } else this.diskStatus = saved?.status || this.diskStatus;
        } else if (fileExists !== false) {
          this.diskReadBlocked = true;
          this.error = this.error || result?.error || '磁盘收藏暂时无法读取，已保留当前数据，未覆盖原文件。';
        }
        return this.records;
      }

      const diskRecords = validateBackup(result.data);
      const merged = mergeRecords(diskRecords, localRecords);
      this.diskReadBlocked = false;
      this.records = merged;
      this.error = null;
      this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, records: merged }));
      if (JSON.stringify(merged) !== JSON.stringify(diskRecords)) {
        const saved = this.desktop.saveSync?.({ version: SCHEMA_VERSION, records: merged });
        if (saved && saved.ok === false) {
          this.diskReadBlocked = true;
          this.error = '磁盘保存失败：' + (saved.error || '请立即导出备份');
        } else this.diskStatus = saved?.status || this.diskStatus;
      }
      return this.records;
    } catch (error) {
      this.diskReadBlocked = true;
      if (!this.error) this.error = error?.message || '磁盘收藏无法读取，已保留当前数据，未覆盖原文件。';
      return this.records;
    }
  }

  async hydrate() {
    const localRecords = this.load();
    if (!this.desktop) return this.records;
    try {
      const result = await this.desktop.load();
      this.diskStatus = result?.status || null;
      // `data: null` is different from a valid empty library.  It means the
      // desktop side could not read its file (or the file has not been
      // created yet).  Never turn that uncertainty into an empty overwrite:
      // a renderer can start with an empty localStorage while the durable
      // file is still temporarily unavailable.
      if (!result?.data) {
        const fileExists = result?.status?.fileExists;
        if (fileExists === false) {
          this.diskReadBlocked = false;
          this.error = null;
          // First run after upgrading from the browser version: migrate the
          // records we can read locally into the new desktop store.
          if (localRecords.length === 0) return this.records;
          const payload = { version: SCHEMA_VERSION, records: localRecords };
          if (typeof this.desktop.saveSync === 'function') {
            const saved = this.desktop.saveSync(payload);
            if (saved && saved.ok === false) { this.diskReadBlocked = true; this.error = '磁盘保存失败：' + (saved.error || '请立即导出备份'); }
            else this.diskStatus = saved?.status || this.diskStatus;
          } else {
            this.persistQueue = this.persistQueue.then(() => this.desktop.save(payload)).then(status => { this.diskStatus = status; }, error => {
              this.diskReadBlocked = true;
              this.error = '磁盘保存失败：' + (error?.message || '请立即导出备份');
            });
          }
        } else if (fileExists !== false) {
          this.diskReadBlocked = true;
          this.error = this.error || '磁盘收藏暂时无法读取，已保留当前数据，未覆盖原文件。';
        }
        return this.records;
      }

      const diskRecords = validateBackup(result.data);
      const merged = mergeRecords(diskRecords, localRecords);
      this.diskReadBlocked = false;
      this.records = merged;
      this.error = null;
      this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, records: merged }));
      // Write the merged view back so a renderer upgrade cannot discard
      // records that only exist in localStorage or on disk.
      if (JSON.stringify(merged) !== JSON.stringify(diskRecords)) {
        const payload = { version: SCHEMA_VERSION, records: merged };
        if (typeof this.desktop.saveSync === 'function') {
          const saved = this.desktop.saveSync(payload);
          if (saved && saved.ok === false) { this.diskReadBlocked = true; this.error = '磁盘保存失败：' + (saved.error || '请立即导出备份'); }
          else this.diskStatus = saved?.status || this.diskStatus;
        } else {
          this.persistQueue = this.persistQueue.then(() => this.desktop.save(payload)).then(status => { this.diskStatus = status; }, error => {
            this.diskReadBlocked = true;
            this.error = '磁盘保存失败：' + (error?.message || '请立即导出备份');
          });
        }
      }
      return this.records;
    } catch (error) {
      this.diskReadBlocked = true;
      if (!this.error) this.error = '磁盘收藏无法读取，已保留当前数据，未覆盖原文件。';
      return this.records;
    }
  }

  async flush() { await this.persistQueue; return this.diskStatus; }
  async createBackup() { if (!this.desktop) return null; return this.desktop.createBackup(); }
  async chooseSyncFolder() {
    if (!this.desktop) return null;
    const result = await this.desktop.chooseSyncFolder();
    this.diskStatus = result?.status || this.diskStatus;
    if (!result?.canceled && result?.data) {
      const merged = mergeRecords(this.records, validateBackup(result.data));
      this.records = merged;
      this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, records: merged }));
    }
    return result;
  }

  put(record) {
    // Refresh before changing one record so edits in other tabs are preserved.
    this.load();
    this.commit([...this.records.filter(r => r.album.id !== record.album.id), validateRecord(record)]);
  }

  import(data) {
    const incoming = validateBackup(data);
    this.load();
    this.commit(mergeRecords(this.records, incoming));
    return incoming.length;
  }

  export() { return JSON.stringify({ version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), records: this.records }, null, 2); }
  raw() { return this.storage.getItem(STORAGE_KEY) || this.storage.getItem(LEGACY_KEY) || this.export(); }
}
