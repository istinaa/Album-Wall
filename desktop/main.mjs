import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron';
import { writeFile, readFile, mkdir, rename, unlink, stat, readdir } from 'node:fs/promises';
import { writeFileSync, readFileSync, mkdirSync, renameSync, unlinkSync, statSync, copyFileSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { nodeHttpsFetch } from '../server/node-https.mjs';
import { validateBackup, mergeRecords } from '../public/domain.js';

let server;
let mainWindow;
let serverPort;
let quitting = false;
let windowClosing = false;
const root = fileURLToPath(new URL('../', import.meta.url));
const libraryFileName = 'album-wall.json';
app.setName('Album Wall');
app.setPath('userData', join(app.getPath('appData'), 'AlbumWall'));
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function listen(serverInstance) {
  return new Promise((resolve, reject) => {
    serverInstance.once('error', reject);
    serverInstance.listen(0, '127.0.0.1', () => resolve(serverInstance.address().port));
  });
}

async function createWindow(port) {
  const apiOrigin = 'http://127.0.0.1:' + port;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 580,
    show: false,
    backgroundColor: '#f4f5ef',
    autoHideMenuBar: true,
    title: '唱片墙 · Album Wall',
    icon: join(root, 'desktop/icon.png'),
    webPreferences: { preload: join(root,'desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  mainWindow = window;
  window.on('close', () => { windowClosing = true; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://musicbrainz.org/') || url.startsWith('https://coverartarchive.org/') || url.startsWith('https://music.apple.com/')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(apiOrigin + '/')) event.preventDefault();
  });
  const canFullscreen = (webContents, permission) => permission === 'fullscreen' &&
    webContents === window.webContents && webContents.getURL().startsWith(apiOrigin + '/');
  window.webContents.session.setPermissionCheckHandler(canFullscreen);
  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => callback(canFullscreen(webContents, permission)));
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  // Serve the page over the same loopback HTTP server as the API. This avoids
  // Chromium's Windows asar/file URL failure while keeping all packaged and
  // development paths on one well-tested origin.
  try {
    const rendererUrl = `${apiOrigin}/`;
    await window.loadURL(rendererUrl);
  } catch (error) {
    // Closing the window while its first document is loading is expected and
    // must not turn into a fatal startup dialog.
    if (window.isDestroyed() || windowClosing || quitting || app.isQuitting) return;
    throw error;
  }
}

async function atomicWrite(filePath, contents) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = filePath + `.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, filePath); } catch (error) { try { await unlink(temporary); } catch {} throw error; }
}

function libraryPaths() {
  const directory = join(app.getPath('userData'), 'library');
  return { directory, file: join(directory, libraryFileName), backups: join(directory, 'backups'), config: join(directory, 'config.json') };
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

function validLibrary(value) {
  try {
    return value && value.version === 1 ? { version: 1, records: validateBackup(value) } : null;
  } catch { return null; }
}

function mergeLibraryFiles(...values) {
  const valid = values.map(validLibrary).filter(Boolean);
  if (!valid.length) return null;
  return { version: 1, records: valid.slice(1).reduce((records, file) => mergeRecords(records, file.records), valid[0].records) };
}

async function libraryStatus() {
  const paths = libraryPaths();
  const data = await readJson(paths.file);
  let fileStat = null;
  try { fileStat = await stat(paths.file); } catch {}
  const config = await readJson(paths.config) || {};
  let backups = [];
  try { backups = (await readdir(paths.backups)).filter(name => name.endsWith('.json')).sort().reverse().slice(0, 20); } catch {}
  return { path: paths.file, fileExists: Boolean(fileStat), records: Array.isArray(data?.records) ? data.records.length : 0,
    lastSavedAt: data?.savedAt || fileStat?.mtime?.toISOString() || null, syncFolder: config.syncFolder || null, backups };
}

async function snapshotLibrary(reason = 'manual') {
  const paths = libraryPaths();
  try {
    const source = await readFile(paths.file);
    await mkdir(paths.backups, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.json`;
    await writeFile(join(paths.backups, name), source, { flag: 'wx' });
    return join(paths.backups, name);
  } catch { return null; }
}

async function saveLibrary(data) {
  const paths = libraryPaths();
  const valid = validLibrary(data);
  if (!valid) throw new Error('无效的收藏数据');
  const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), records: valid.records });
  if (Buffer.byteLength(payload, 'utf8') > 5 * 1024 * 1024) throw new Error('收藏数据超过 5 MB');
  let existed = true; try { await stat(paths.file); } catch { existed = false; }
  await snapshotLibrary('before-save');
  await atomicWrite(paths.file, payload);
  if (!existed) await snapshotLibrary('initial-migration');
  const config = await readJson(paths.config) || {};
  if (config.syncFolder) {
    try { await atomicWrite(join(config.syncFolder, libraryFileName), payload); } catch (error) { console.warn('[sync-folder]', error.message); }
  }
  return libraryStatus();
}

// Renderer edits are tiny JSON payloads. Keep a synchronous IPC path for the
// commit itself so the data is on disk before the user can close the window.
// The async path remains available for imports and compatibility with older
// renderers.
function saveLibrarySync(data) {
  const paths = libraryPaths();
  const valid = validLibrary(data);
  if (!valid) throw new Error('无效的收藏数据');
  const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), records: valid.records });
  if (Buffer.byteLength(payload, 'utf8') > 5 * 1024 * 1024) throw new Error('收藏数据超过 5 MB');
  mkdirSync(paths.directory, { recursive: true });
  try {
    mkdirSync(paths.backups, { recursive: true });
    if (statSync(paths.file).isFile()) {
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-before-save-sync.json`;
      copyFileSync(paths.file, join(paths.backups, name));
    }
  } catch { /* A backup must never block the durable write. */ }
  const temporary = paths.file + `.sync-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx' });
  try { renameSync(temporary, paths.file); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  const config = readJsonSync(paths.config) || {};
  if (config.syncFolder) {
    try {
      mkdirSync(config.syncFolder, { recursive: true });
      const remote = join(config.syncFolder, libraryFileName);
      const remoteTemp = remote + `.sync-${process.pid}-${Date.now()}`;
      writeFileSync(remoteTemp, payload, { encoding: 'utf8', flag: 'wx' });
      renameSync(remoteTemp, remote);
    } catch (error) { console.warn('[sync-folder]', error.message); }
  }
  return { version: 1, records: valid.records };
}

function readJsonSync(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}

// A previous renderer could write a syntactically valid library containing
// only the records it had loaded so far.  Such a file must not be treated as
// authoritative: the backups are the durable history and the most complete
// valid snapshot is the safest recovery base.
function bestBackupSync(paths) {
  let best = null;
  try {
    const names = readdirSync(paths.backups).filter(name => name.endsWith('.json'));
    for (const name of names) {
      const candidate = validLibrary(readJsonSync(join(paths.backups, name)));
      if (!candidate) continue;
      if (!best || candidate.records.length > best.value.records.length ||
          (candidate.records.length === best.value.records.length && name > best.name)) {
        best = { name, value: candidate };
      }
    }
  } catch { /* no backups yet */ }
  return best;
}

function recoverFromBestBackupSync(paths, local) {
  const localValid = validLibrary(local);
  const best = bestBackupSync(paths);
  if (!best || (localValid && localValid.records.length >= best.value.records.length)) {
    return { value: local, recovered: false };
  }
  const merged = mergeLibraryFiles(local, best.value);
  return merged ? { value: merged, recovered: true } : { value: local, recovered: false };
}

function libraryStatusSync() {
  const paths = libraryPaths();
  const data = readJsonSync(paths.file);
  let fileStat = null;
  try { fileStat = statSync(paths.file); } catch {}
  const config = readJsonSync(paths.config) || {};
  let backups = [];
  try { backups = readdirSync(paths.backups).filter(name => name.endsWith('.json')).sort().reverse().slice(0, 20); } catch {}
  return {
    path: paths.file,
    fileExists: Boolean(fileStat),
    records: Array.isArray(data?.records) ? data.records.length : 0,
    lastSavedAt: data?.savedAt || fileStat?.mtime?.toISOString() || null,
    syncFolder: config.syncFolder || null,
    backups
  };
}

// The first paint of the desktop app must use the durable file. Keeping this
// path synchronous prevents an empty localStorage value from being rendered
// or persisted while the asynchronous IPC hydration is still in flight.
function loadLibrarySync() {
  const paths = libraryPaths();
  let local = readJsonSync(paths.file);
  const recovery = recoverFromBestBackupSync(paths, local);
  local = recovery.value;
  const config = readJsonSync(paths.config) || {};
  const cloud = config.syncFolder ? readJsonSync(join(config.syncFolder, libraryFileName)) : null;
  const data = mergeLibraryFiles(local, cloud);
  if (recovery.recovered) {
    try { saveLibrarySync(local); } catch (error) { console.warn('[recovery]', error.message); }
  }
  return { data, status: libraryStatusSync() };
}

app.whenReady().then(async () => {
  // app.quit() is asynchronous. A second launch can otherwise reach this
  // callback after failing to acquire the single-instance lock and create a
  // window while Electron is already shutting down, which surfaces as
  // ERR_FAILED during the initial document load.
  if (!hasSingleInstanceLock) return;
  try { unlinkSync(join(app.getPath('userData'), 'startup-error.log')); } catch {}
  Menu.setApplicationMenu(null);
  // The metadata providers use ordinary HTTPS APIs. Node's fetch behaves
  // consistently for their JSON and image responses inside packaged Electron.
  server = createApp({ neteaseFetchImpl: nodeHttpsFetch, cacheDir: join(app.getPath('userData'), 'covers') });
  const port = await listen(server);
  serverPort = port;
  ipcMain.handle('library:load', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无效的收藏请求');
    const paths = libraryPaths();
    let local = await readJson(paths.file);
    let recovered = false;
    // Recover from the most complete valid snapshot even when the main file
    // is syntactically valid but was truncated to only a few records.
    try {
      const names = (await readdir(paths.backups)).filter(name => name.endsWith('.json'));
      let best = null;
      for (const name of names) {
        const candidate = validLibrary(await readJson(join(paths.backups, name)));
        if (!candidate) continue;
        if (!best || candidate.records.length > best.value.records.length ||
            (candidate.records.length === best.value.records.length && name > best.name)) best = { name, value: candidate };
      }
      const localValid = validLibrary(local);
      if (best && (!localValid || localValid.records.length < best.value.records.length)) {
        const merged = mergeLibraryFiles(local, best.value);
        if (merged) { local = merged; recovered = true; }
      }
    } catch { /* no backups yet */ }
    const config = await readJson(paths.config) || {};
    if (recovered) {
      try { await saveLibrary(local); } catch (error) { console.warn('[recovery]', error.message); }
    }
    let cloud = config.syncFolder ? await readJson(join(config.syncFolder, libraryFileName)) : null;
    const data = mergeLibraryFiles(local, cloud);
    return { data, status: await libraryStatus() };
  });
  ipcMain.on('library:load-sync', (event) => {
    if (event.sender !== mainWindow?.webContents) { event.returnValue = { data: null, status: { fileExists: false }, error: '无效的收藏请求' }; return; }
    try { event.returnValue = loadLibrarySync(); }
    catch (error) { event.returnValue = { data: null, status: libraryStatusSync(), error: error?.message || '磁盘收藏无法读取' }; }
  });
  ipcMain.on('renderer:ready', (event, status) => {
    if (event.sender !== mainWindow?.webContents || !status || typeof status !== 'object') return;
    const report = {
      readyAt: new Date().toISOString(),
      records: Number.isInteger(status.records) && status.records >= 0 ? status.records : null,
      error: typeof status.error === 'string' ? status.error.slice(0, 500) : '',
      url: event.senderFrame?.url || ''
    };
    try { writeFileSync(join(app.getPath('userData'), 'startup-health.json'), JSON.stringify(report, null, 2), 'utf8'); } catch {}
  });
  ipcMain.handle('library:save', async (event, data) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无效的收藏请求');
    return saveLibrary(data);
  });
  ipcMain.on('library:save-sync', (event, data) => {
    if (event.sender !== mainWindow?.webContents) { event.returnValue = { ok: false, error: '无效的收藏请求' }; return; }
    try {
      const saved = saveLibrarySync(data);
      event.returnValue = { ok: true, status: { path: libraryPaths().file, records: saved.records.length } };
    } catch (error) {
      event.returnValue = { ok: false, error: error?.message || '磁盘保存失败' };
    }
  });
  ipcMain.handle('library:create-backup', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无效的收藏请求');
    const file = await snapshotLibrary('manual');
    return { file, status: await libraryStatus() };
  });
  ipcMain.handle('library:choose-sync-folder', async (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('无效的收藏请求');
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择云同步文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, status: await libraryStatus() };
    const paths = libraryPaths(); const config = await readJson(paths.config) || {};
    config.syncFolder = result.filePaths[0]; await atomicWrite(paths.config, JSON.stringify(config));
    // Merge an existing sync copy immediately, then mirror the union. This
    // makes choosing a folder a safe recovery/import action instead of waiting
    // for a later edit to discover records that exist only in that folder.
    const local = await readJson(paths.file);
    const remote = await readJson(join(config.syncFolder, libraryFileName));
    const merged = mergeLibraryFiles(local, remote);
    if (merged) await saveLibrary(merged);
    return { canceled: false, data: merged, status: await libraryStatus() };
  });
  ipcMain.handle('save-file', async (event, { bytes, filename } = {}) => {
    if (event.sender !== mainWindow?.webContents || !event.senderFrame?.url?.startsWith(`http://127.0.0.1:${serverPort}/`) ||
      !(bytes instanceof ArrayBuffer) || bytes.byteLength > 50000000 ||
      typeof filename !== 'string' || !/\.(png|json)$/i.test(filename)) throw new Error('无效的导出请求');
    const extension = filename.endsWith('.png') ? 'png' : 'json';
    const result = await dialog.showSaveDialog(mainWindow, { title: '保存唱片墙', defaultPath: join(app.getPath('pictures'), basename(filename)),
      filters: [{ name: extension === 'png' ? 'PNG 图片' : 'JSON 备份', extensions: [extension] }] });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, Buffer.from(bytes));
    return { saved: true };
  });
  await createWindow(port);
}).catch(error => {
  console.error('[desktop]', error);
  if (quitting || app.isQuitting || String(error?.message || '').toLowerCase().includes('destroyed')) { app.quit(); return; }
  try { writeFileSync(join(app.getPath('userData'), 'startup-error.log'), String(error?.stack || error), 'utf8'); } catch {}
  dialog.showErrorBox('唱片墙启动失败', error.message);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) createWindow(serverPort);
});

app.on('before-quit', () => {
  quitting = true;
  if (server) { server.closeAllConnections(); server.close(); }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
