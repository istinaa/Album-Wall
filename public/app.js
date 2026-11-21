import { createRecord, libraryStats, recordCategories, filterRecords, withListeningStatus, rankArtists, rankGenres, ratingDistribution } from './domain.js';
import { LibraryStore, STORAGE_KEY } from './storage.js';
import { catalogApi } from './api.js';
import { createWall, coverUrl } from './wall.js';
import { attachCoverImages, setCoverImage } from './cover-loader.js';
import { artistIdentityGroups } from './artist-identity.js';
import { createCloudSync } from './cloud.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const PLACEHOLDER = new URL('./cover-placeholder.svg', import.meta.url).href;
// localStorage may itself be unavailable in restrictive browser modes.
const desktopLibrary = window.albumWallDesktop?.library ? {
  load: () => window.albumWallDesktop.library.load(),
  loadSync: () => window.albumWallDesktop.library.loadSync?.(),
  save: data => window.albumWallDesktop.library.save(data),
  saveSync: data => window.albumWallDesktop.library.saveSync?.(data),
  createBackup: () => window.albumWallDesktop.library.createBackup(),
  chooseSyncFolder: () => window.albumWallDesktop.library.chooseSyncFolder()
} : null;
const browserStorage = { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
const store = new LibraryStore(browserStorage, { desktop: desktopLibrary });
const cloudSync = createCloudSync(browserStorage);
store.load();

const state = {
  view: 'home', status: 'all', query: '', discoveryQuery: '', artist: '', genre: '', minRating: '', sort: 'recent',
  displayFilters: { status: 'all', artist: '', genre: '', minRating: '', query: '' },
  panelFilters: { status: 'all', artist: '', genre: '', minRating: '0', maxRating: '10', includeUnrated: true, query: '' },
  rankingMetric: 'albums',
  search: { phase: 'idle', items: [], total: 0, nextOffset: 0, query: '', field: 'all', error: '' },
  editing: null, quickRating: null, request: 0, controller: null
};
let activeRangeControl = null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cover = coverUrl;
const active = () => store.records.filter(record => !record.deletedAt);
const findRecord = id => active().find(record => record.album.id === id);
const categories = recordCategories;
const scoreOptions = selected => '<option value="">选择分数…</option>' + Array.from({ length: 21 }, (_, index) => 10 - index * .5)
  .map(score => '<option value="' + score + '"' + (selected === score ? ' selected' : '') + '>' + score.toFixed(1) + '</option>').join('');

function updateDetailRating() {
  const input = $('#ratingInput');
  const output = $('#ratingPreview');
  if (!input || !output) return;
  const unrated = input.dataset.unrated === 'true';
  output.textContent = unrated ? '未评分' : Number(input.value).toFixed(1);
  input.style.setProperty('--rating-progress', (Number(input.value) * 10) + '%');
  input.setAttribute('aria-valuetext', unrated ? '未评分' : Number(input.value).toFixed(1) + ' 分');
  $('#clearRatingBtn')?.toggleAttribute('hidden', unrated);
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
}

const attachCoverFallback = attachCoverImages;

function refreshStats() {
  const stats = libraryStats(store.records);
  $('#statTotal').textContent = stats.total;
  $('#statPlayed').textContent = stats.listened;
  $('#statPercent').textContent = stats.percent + '%';
  $('#statRating').textContent = stats.rating;
  $('#statArtists').textContent = stats.artists;
  $('#storageWarning').hidden = !store.error;
  $('#storageWarning').textContent = store.error || '';
}

function selectOptions(selector, values, selected, label) {
  const element = $(selector);
  element.innerHTML = '<option value="">' + label + '</option>' +
    [...new Set(values)].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(value => '<option value="' + esc(value) + '">' + esc(value) + '</option>').join('');
  element.value = values.includes(selected) ? selected : '';
  return element.value;
}

function refreshFilters() {
  const records = active();
  const artists = artistIdentityGroups(records.flatMap(r => r.album.artists.length ? r.album.artists.map(a => a.name) : [r.album.artist]));
  const artistElement = $('#artistFilter');
  artistElement.innerHTML = '<option value="">所有艺人</option>' + artists.sort((a,b) => a.label.localeCompare(b.label, 'zh-CN')).map(({key,label}) => '<option value="' + esc(key) + '">' + esc(label) + '</option>').join('');
  if (state.artist && artists.some(item => item.key === state.artist || item.label === state.artist)) artistElement.value = artists.find(item => item.key === state.artist || item.label === state.artist).key;
  else { state.artist = ''; artistElement.value = ''; }
  state.genre = selectOptions('#genreFilter', records.flatMap(categories), state.genre, '所有类别');
  $$('[data-status]').forEach(button => {
    const selected = button.dataset.status === state.status;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

function card(album, record, discover) {
  const id = esc(album.id);
  return '<article class="album-card">' +
    '<button class="cover-wrap cover-button" data-open="' + id + '" aria-label="' + esc('查看 ' + album.title + '，' + album.artist) + '">' +
    '<img class="cover" src="' + esc(PLACEHOLDER) + '" data-cover="' + esc(cover(album)) + '" alt="' + esc(album.title) + ' 封面" loading="lazy">' +
    (record?.status === 'listened' ? '<span class="played-dot" title="已听过">✓</span>' : '') +
    '<span class="quick">' + (record ? '编辑聆听记录' : '查看唱片') + '</span></button>' +
    '<div class="album-title" title="' + esc(album.title) + '">' + esc(album.title) + '</div>' +
    '<div class="album-artist" title="' + esc(album.artist) + '">' + esc(album.artist) + '</div>' +
    '<div class="card-meta"><span>' + esc(album.year || '年份未知') + '</span><span>·</span>' +
    (record?.rating !== null && record?.rating !== undefined ? '<span class="star">★ ' + record.rating.toFixed(1) + '</span>' : '<span>' + esc(record ? (record.status === 'listened' ? '听过 · 未评分' : '想听') : album.type) + '</span>') + '</div>' +
    '<div class="listening-actions" role="group" aria-label="' + esc(album.title + ' 聆听状态') + '">' +
    [['wanted', '♡ 想听'], ['listened', '✓ 听过']].map(([status, label]) => '<button class="listen-action" data-mark="' + id + '" data-mark-status="' + status + '" aria-label="' + esc('将 ' + album.title + ' 标记为' + (status === 'wanted' ? '想听' : '听过')) + '" aria-pressed="' + (record?.status === status) + '">' + label + '</button>').join('') + '</div>' +
    (record?.status === 'listened' && state.quickRating === album.id ? '<div class="quick-rating"><label for="quick-rating-' + id + '">★ 直接评分</label>' +
      '<div class="rating-slider"><input id="quick-rating-' + id + '" type="range" min="0" max="10" step="0.5" value="' + (record.rating ?? 0) + '" data-rate="' + id + '" aria-label="' + esc('为 ' + album.title + ' 快速评分') + '"><output data-rate-preview="' + id + '">' + (record.rating === null ? '未评分' : record.rating.toFixed(1)) + '</output></div>' +
      '<button type="button" data-rate-close aria-label="暂不评分">×</button></div>' : '') +
    '</article>';
}

function bindGrid(root = $('#albumGrid')) {
  if (!root) return;
  attachCoverFallback(root);
  root.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openAlbum(button.dataset.open)));
  root.querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', () => markAlbum(button.dataset.mark, button.dataset.markStatus)));
  root.querySelectorAll('[data-rate]').forEach(slider => {
    slider.addEventListener('input', () => {
      const output = document.querySelector('[data-rate-preview="' + slider.dataset.rate + '"]');
      if (output) output.textContent = Number(slider.value).toFixed(1);
      slider.style.setProperty('--rating-progress', (Number(slider.value) * 10) + '%');
    });
    slider.addEventListener('change', () => rateAlbum(slider.dataset.rate, slider.value));
    slider.dispatchEvent(new Event('input'));
  });
  root.querySelectorAll('[data-rate-close]').forEach(button => button.addEventListener('click', () => { state.quickRating = null; render(); }));
  root.querySelectorAll('[data-discover]').forEach(button => button.addEventListener('click', () => setView('discover')));
  root.querySelectorAll('[data-suggestion]').forEach(button => button.addEventListener('click', () => {
    $('#searchInput').value = button.dataset.suggestion;
    $('#searchField').value = 'artist';
    search();
  }));
  root.querySelector('#retryBtn')?.addEventListener('click', () => search(state.search.items.length > 0));
}

function renderLibrary() {
  refreshStats();
  refreshFilters();
  const records = filterRecords(store.records, state);
  records.sort((a, b) => state.sort === 'title' ? a.album.title.localeCompare(b.album.title, 'zh-CN') :
    state.sort === 'rating' ? (b.rating ?? -1) - (a.rating ?? -1) : Date.parse(b.addedAt) - Date.parse(a.addedAt));
  $('#resultCount').textContent = records.length + ' 张';
  $('#pagination').hidden = true;
  if (!active().length) {
    $('#albumGrid').innerHTML = '<div class="empty onboarding"><img src="' + esc(PLACEHOLDER) + '" alt="" class="empty-record"><div class="eyebrow">SIDE A / THE BEGINNING</div><h2>第一张唱片，从这里开始。</h2><p>找到让你心动的专辑，收藏它，再留下你的聆听故事。</p><button class="primary" data-discover>去发现唱片 ↗</button><div class="fine-print">每一段音乐记忆，都值得有一个位置。</div></div>';
  } else if (!records.length) {
    $('#albumGrid').innerHTML = '<div class="empty"><h2>还没有符合条件的唱片</h2><p>试试其他关键词，或切换艺人和类别。</p></div>';
  } else $('#albumGrid').innerHTML = records.map(r => card(r.album, r, false)).join('');
  bindGrid();
}

function panelArtistOptions() {
  return artistIdentityGroups(active().flatMap(r => r.album.artists.length ? r.album.artists.map(a => a.name) : [r.album.artist]));
}

function refreshPanelFilters() {
  const artists = panelArtistOptions();
  const artist = $('#panelArtistFilter');
  artist.innerHTML = '<option value="">所有艺人</option>' + artists.sort((a,b) => a.label.localeCompare(b.label, 'zh-CN')).map(({key,label}) => '<option value="' + esc(key) + '">' + esc(label) + '</option>').join('');
  artist.value = artists.some(item => item.key === state.panelFilters.artist) ? state.panelFilters.artist : '';
  state.panelFilters.artist = artist.value;
  const genres = [...new Set(active().flatMap(categories))].sort((a,b) => a.localeCompare(b, 'zh-CN'));
  const genre = $('#panelGenreFilter');
  genre.innerHTML = '<option value="">所有类别</option>' + genres.map(value => '<option value="' + esc(value) + '">' + esc(value) + '</option>').join('');
  genre.value = genres.includes(state.panelFilters.genre) ? state.panelFilters.genre : '';
  state.panelFilters.genre = genre.value;
  $('#panelStatusFilter').value = state.panelFilters.status;
  $('#panelQueryFilter').value = state.panelFilters.query;
  $('#filterMinRating').value = state.panelFilters.minRating;
  $('#filterMaxRating').value = state.panelFilters.maxRating;
  $('#filterIncludeUnrated').checked = state.panelFilters.includeUnrated;
  updatePanelRangeSummary();
}

function updatePanelRangeSummary() {
  const min = Number(state.panelFilters.minRating);
  const max = Number(state.panelFilters.maxRating);
  const output = $('#filterRatingSummary');
  if (!output) return;
  output.textContent = min === 0 && max === 10 ? '全部评分' : min === max ? min.toFixed(1) + ' 分' : min.toFixed(1) + '–' + max.toFixed(1) + ' 分';
  const left = Math.max(0, Math.min(100, min * 10));
  const right = Math.max(left, Math.min(100, max * 10));
  $('.dual-range')?.style.setProperty('--range-left', left + '%');
  $('.dual-range')?.style.setProperty('--range-right', right + '%');
  updatePanelRangeLayers();
}

// The two native range thumbs overlap when both bounds are equal. Keep the
// bound being edited on top, and choose a useful default at the endpoints so
// a 10/10 (or 0/0) range can always be opened again with one drag.
function updatePanelRangeLayers() {
  const minInput = $('#filterMinRating');
  const maxInput = $('#filterMaxRating');
  if (!minInput || !maxInput) return;
  const min = Number(state.panelFilters.minRating);
  const max = Number(state.panelFilters.maxRating);
  let minZ = 1;
  let maxZ = 2;
  if (min === max && max >= 10) { minZ = 3; maxZ = 2; }
  else if (min === max && min <= 0) { minZ = 1; maxZ = 3; }
  if (activeRangeControl === minInput) minZ = 4;
  if (activeRangeControl === maxInput) maxZ = 4;
  minInput.style.zIndex = String(minZ);
  maxInput.style.zIndex = String(maxZ);
}

function renderPanelResults() {
  const records = filterRecords(active(), state.panelFilters).sort((a,b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  $('#filterResultCount').textContent = records.length + ' 张';
  $('#filterGrid').innerHTML = records.length ? records.map(record => card(record.album, record, false)).join('') : '<div class="empty"><h2>没有符合范围的唱片</h2><p>调整评分滑块或打开“包含未评分唱片”。</p></div>';
  bindGrid($('#filterGrid'));
}

function renderFilterPanel() {
  refreshStats();
  refreshPanelFilters();
  renderPanelResults();
}

function rankingRows(items, metric, type) {
  const sorted = [...items].sort((a,b) => {
    const av = metric === 'average' ? (a.average ?? -1) : a[metric];
    const bv = metric === 'average' ? (b.average ?? -1) : b[metric];
    return bv - av || a.name.localeCompare(b.name, 'zh-CN');
  });
  if (!sorted.length) return '<div class="empty"><h2>收藏还不够多</h2><p>收藏并评分几张唱片后，这里会生成你的个人排行。</p></div>';
  return sorted.slice(0, 20).map((item, index) => {
    const primary = metric === 'average' ? (item.average === null ? '—' : item.average.toFixed(1)) : item[metric];
    const suffix = metric === 'average' ? '/ 10 平均分' : metric === 'albums' ? '张收藏' : '张已听';
    return '<div class="ranking-row"><span class="ranking-position">' + String(index + 1).padStart(2, '0') + '</span><div class="ranking-name"><strong>' + esc(item.name) + '</strong><span>' + item.albums + ' 张收藏 · ' + item.rated + ' 张有评分</span></div><div class="ranking-score"><b>' + primary + '</b><span>' + suffix + '</span></div></div>';
  }).join('');
}

function renderRatingChart(records) {
  const root = $('#ratingChart');
  if (!root) return;
  const buckets = ratingDistribution(records);
  const max = Math.max(1, ...buckets.map(bucket => bucket.count));
  const width = 680;
  const height = 190;
  const pad = { top: 18, right: 18, bottom: 38, left: 28 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const x = index => pad.left + (buckets.length === 1 ? plotWidth / 2 : index * plotWidth / (buckets.length - 1));
  const y = count => pad.top + plotHeight - (count / max) * plotHeight;
  const points = buckets.map((bucket, index) => [x(index), y(bucket.count)]);
  const line = points.map(([pointX, pointY], index) => (index ? 'L' : 'M') + pointX.toFixed(1) + ' ' + pointY.toFixed(1)).join(' ');
  const area = line + ' L ' + x(buckets.length - 1).toFixed(1) + ' ' + (pad.top + plotHeight) + ' L ' + x(0).toFixed(1) + ' ' + (pad.top + plotHeight) + ' Z';
  const grid = [0, .5, 1].map(ratio => {
    const lineY = pad.top + plotHeight * ratio;
    const value = Math.round(max * (1 - ratio));
    return '<line x1="' + pad.left + '" x2="' + (width - pad.right) + '" y1="' + lineY.toFixed(1) + '" y2="' + lineY.toFixed(1) + '" class="chart-grid"/><text x="' + (pad.left - 8) + '" y="' + (lineY + 3).toFixed(1) + '" class="chart-y-label" text-anchor="end">' + value + '</text>';
  }).join('');
  const dots = points.map(([pointX, pointY], index) => '<circle cx="' + pointX.toFixed(1) + '" cy="' + pointY.toFixed(1) + '" r="4" class="chart-dot"><title>' + buckets[index].label + '：' + buckets[index].count + ' 张</title></circle>').join('');
  const labels = buckets.map((bucket, index) => '<text x="' + x(index).toFixed(1) + '" y="' + (height - 12) + '" class="chart-x-label" text-anchor="middle">' + bucket.label + '</text>').join('');
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  root.innerHTML = '<div class="chart-head"><div><strong>评分分布</strong><span>' + total + ' 张已评分</span></div><span class="chart-legend"><i></i>我的评分</span></div>' +
    '<svg class="rating-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="评分分布曲线图">' + grid + '<path d="' + area + '" class="chart-area"></path><path d="' + line + '" class="chart-line"></path>' + dots + labels + '</svg>';
}

function renderRankings() {
  refreshStats();
  const artists = rankArtists(store.records);
  const genres = rankGenres(store.records).sort((a,b) => (b.average ?? -1) - (a.average ?? -1) || b.albums - a.albums);
  $('#rankingCount').textContent = artists.length + ' 位艺人';
  $('#genreRankingCount').textContent = genres.length + ' 个类别';
  $('#rankingMetric').value = state.rankingMetric;
  renderRatingChart(store.records);
  $('#artistRanking').innerHTML = rankingRows(artists, state.rankingMetric, 'artist');
  $('#genreRanking').innerHTML = genres.length ? genres.slice(0, 20).map((item,index) => '<div class="ranking-row"><span class="ranking-position">' + String(index + 1).padStart(2, '0') + '</span><div class="ranking-name"><strong>' + esc(item.name) + '</strong><span>' + item.rated + ' 张有评分</span></div><div class="ranking-score"><b>' + (item.average === null ? '—' : item.average.toFixed(1)) + '</b><span>/ 10 平均分</span></div></div>').join('') : '<div class="empty"><p>给唱片添加类别后，这里会显示类别排行。</p></div>';
}

function renderDiscovery() {
  refreshStats();
  const result = state.search;
  $('#resultCount').textContent = result.phase === 'idle' ? 'MusicBrainz + Apple Music 公开目录' : result.total + ' 个结果';
  $('#pagination').hidden = result.phase !== 'ready' || result.nextOffset >= Math.min(result.total, 10000);
  $('#searchBtn').textContent = result.phase === 'loading' ? '搜索中…' : '搜索';
  $('#albumGrid').setAttribute('aria-busy', String(result.phase === 'loading'));
  if (result.phase === 'idle') {
    $('#albumGrid').innerHTML = '<div class="empty discovery-empty"><div class="eyebrow">FIND YOUR NEXT RECORD</div><h2>下一张，会是什么声音？</h2><p>搜索专辑或艺人，将喜欢的唱片加入你的收藏。</p><div class="suggestions">' +
      ['Radiohead', '王菲', 'Miles Davis', '坂本龍一'].map(name => '<button class="filter" data-suggestion="' + name + '">' + name + ' ↗</button>').join('') + '</div></div>';
  } else {
    let html = result.items.map(album => card(album, findRecord(album.id), true)).join('');
    if (result.phase === 'loading') html += '<div class="loading"><span class="spinner"></span>正在寻找唱片…</div>';
    if (result.phase === 'error') html += '<div class="empty"><p>' + esc(result.error) + '</p><button class="secondary" id="retryBtn">重试</button></div>';
    if (result.phase === 'ready' && !result.items.length) html = '<div class="empty"><h2>没有找到这张唱片</h2><p>试试更短的名称、英文名，或切换搜索范围。</p></div>';
    $('#albumGrid').innerHTML = html;
  }
  bindGrid();
}

const welcomeWall = createWall($('#welcomeCanvas'), { welcome: true });
const displayWall = createWall($('#displayCanvas'));
// The welcome wall is a quiet view of the user's own collection. Rated
// records lead so the preview reflects taste; recent additions break ties.
const wallAlbums = () => active().slice().sort((a, b) => {
  const ratingA = a.rating === null ? -1 : a.rating;
  const ratingB = b.rating === null ? -1 : b.rating;
  return ratingB - ratingA || Date.parse(b.addedAt) - Date.parse(a.addedAt);
}).map(record => record.album);

function renderWelcome() {
  refreshStats();
  const albums = wallAlbums();
  welcomeWall.setAlbums(albums);
  $('#welcomeCaption').textContent = albums.length ? '我的收藏 · ' + albums.length + ' 张唱片' : '还没有收藏';
  welcomeWall.show(albums.length > 0);
}

function renderWallDisplay() {
  refreshStats();
  const all = active();
  const filters = state.displayFilters;
  const wallArtists = artistIdentityGroups(all.flatMap(r => r.album.artists.length ? r.album.artists.map(a => a.name) : [r.album.artist]));
  const wallArtistElement = $('#wallArtistFilter');
  wallArtistElement.innerHTML = '<option value="">所有艺人</option>' + wallArtists.sort((a,b) => a.label.localeCompare(b.label, 'zh-CN')).map(({key,label}) => '<option value="' + esc(key) + '">' + esc(label) + '</option>').join('');
  filters.artist = wallArtists.some(item => item.key === filters.artist || item.label === filters.artist) ? (wallArtists.find(item => item.key === filters.artist || item.label === filters.artist)?.key || '') : '';
  wallArtistElement.value = filters.artist;
  filters.genre = selectOptions('#wallGenreFilter', all.flatMap(categories), filters.genre, '所有类别');
  $('#wallStatusFilter').value = filters.status;
  $('#wallRatingFilter').value = filters.minRating;
  $('#wallQueryFilter').value = filters.query;
  const filtered = filters.status !== 'all' || filters.artist || filters.genre || filters.minRating !== '' || filters.query.trim();
  const records = filterRecords(all, filters).sort((a,b) => Date.parse(b.addedAt)-Date.parse(a.addedAt));
  const preview = !all.length && !filtered;
  const albums = preview ? [] : records.map(record => record.album);
  displayWall.setAlbums(albums);
  $('#wallCount').textContent = preview ? '精选预览 · 尚未收藏' : '展示 ' + albums.length + ' / ' + all.length + ' 张收藏';
  $('#wallFilterSummary').textContent = filters.minRating !== '' ? '我的评分 ≥ ' + Number(filters.minRating).toFixed(1) + ' · 不包含未评分唱片' : '筛选会同时应用于全屏展示与导出截图';
  $('#wallEmpty').hidden = albums.length > 0;
  $('#displayCanvas').hidden = !albums.length;
  $('#exportWallBtn').disabled = !albums.length;
  $('#pauseWallBtn').disabled = !albums.length;
  $('#pauseWallBtn').textContent = displayWall.paused ? '继续滚动' : '暂停滚动';
  displayWall.show(albums.length > 0);
}

async function download(blob, filename) {
  if (window.albumWallDesktop) {
    const result = await window.albumWallDesktop.saveFile({ bytes: await blob.arrayBuffer(), filename });
    return result.saved;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

async function exportWallScreenshot() {
  const button = $('#exportWallBtn');
  button.disabled = true; button.textContent = '正在导出…';
  try {
    const blob = await displayWall.export();
    const saved = await download(blob, '唱片墙-' + new Date().toISOString().slice(0,10) + '.png');
    if (saved) toast('当前墙面已保存为 PNG');
  } catch (error) { toast('截图导出失败：' + error.message); }
  finally { button.disabled = $('#displayCanvas').hidden; button.textContent = '导出 PNG 截图'; }
}
function render() {
  welcomeWall.show(false); displayWall.show(false);
  if (state.view === 'home') renderWelcome();
  else if (state.view === 'discover') renderDiscovery();
  else if (state.view === 'display') renderWallDisplay();
  else if (state.view === 'rankings') renderRankings();
  else if (state.view === 'filters') renderFilterPanel();
  else renderLibrary();
}

function cancelSearch() {
  clearTimeout(search.timer);
  state.controller?.abort();
  state.request += 1;
  if (state.search.phase === 'loading') state.search.phase = state.search.items.length ? 'ready' : 'idle';
}

function setView(view) {
  cancelSearch();
  const wasDiscovery = state.view === 'discover';
  if (wasDiscovery) state.discoveryQuery = $('#searchInput').value;
  state.view = view;
  const discover = view === 'discover';
  if (!discover) state.status = ['wanted', 'listened'].includes(view) ? view : 'all';
  const title = { home: '聆听空间', wall: '我的唱片墙', discover: '发现唱片', listened: '听过的唱片', wanted: '想听清单', rankings: '我的排行', filters: '范围筛选', display: '墙面展示' }[view];
  $('#pageTitle').textContent = title;
  $('#breadcrumb').textContent = title;
  document.title = title + ' · Album Wall';
  const display = view === 'display';
  const home = view === 'home';
  const rankings = view === 'rankings';
  const filters = view === 'filters';
  $('#welcomeSection').hidden = !home;
  $('.hero').hidden = home || display;
  $('.stats').hidden = home || display;
  $('.page-footer').hidden = home || display;
  $('#pageDescription').textContent = discover ? '从熟悉的名字出发，遇见下一段旋律。' : display ? '让收藏的唱片缓慢地流动起来。' : rankings ? '看看哪些艺人和类别，最常出现在你的唱片墙上。' : filters ? '拖动评分范围，快速找出此刻想重听的唱片。' : '把听过的声音，留在属于你的墙上。';
  $('#discoverBtn').hidden = discover || display;
  $('#searchInput').value = discover ? state.discoveryQuery : state.query;
  $('#searchInput').placeholder = discover ? '搜索专辑或艺人，如：王菲、In Rainbows' : '筛选我的唱片、艺人…';
  $('#searchField').hidden = !discover;
  $('#searchKind').hidden = !discover;
  $('#searchBtn').hidden = !discover;
  $('#filterRow').hidden = discover || display || rankings || filters;
  $('#sortSelect').hidden = discover || display || rankings || filters;
  $('#showFilteredWallBtn').hidden = discover || display || rankings || filters;
  $('#librarySection').hidden = display || home || rankings || filters;
  $('#wallDisplay').hidden = !display;
  $('#rankingsSection').hidden = !rankings;
  $('#filterSection').hidden = !filters;
  $('#sectionTitle').firstChild.textContent = discover ? '搜索结果 ' : '唱片库 ';
  $('#libraryCaption').textContent = discover ? 'MUSICBRAINZ + APPLE MUSIC' : 'PERSONAL COLLECTION';
  $$('.nav button').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  render();
  if (discover) $('#searchInput').focus();
}

async function search(loadMore = false) {
  const query = $('#searchInput').value.trim();
  if (query.length < 2) { toast('请输入至少 2 个字符'); return; }
  cancelSearch();
  const request = state.request;
  const field = $('#searchField').value;
  const kind = $('#searchKind').value;
  if (query !== state.search.query || field !== state.search.field || kind !== state.search.kind) loadMore = false;
  const offset = loadMore ? state.search.nextOffset : 0;
  state.discoveryQuery = query;
  state.controller = new AbortController();
  state.search = { ...state.search, phase: 'loading', query, field, kind, error: '', ...(loadMore ? {} : { items: [], total: 0, nextOffset: 0 }) };
  renderDiscovery();
  try {
    const data = await catalogApi.search({ query, field, kind, offset, signal: state.controller.signal });
    if (request !== state.request || state.view !== 'discover') return;
    const items = [...state.search.items, ...data.results];
    state.search = { ...state.search, phase: 'ready', items: [...new Map(items.map(a => [a.id, a])).values()], total: data.total, nextOffset: offset + data.results.length };
    // Stop pagination if upstream unexpectedly returns an empty page.
    if (!data.results.length) state.search.nextOffset = data.total;
  } catch (error) {
    if (request !== state.request || error.name === 'AbortError') return;
    state.search.phase = 'error';
    state.search.error = error.message === 'Failed to fetch' ? '无法连接服务，请检查网络后重试。' : error.message;
  }
  if (request === state.request && state.view === 'discover') renderDiscovery();
}

function markAlbum(id, status) {
  store.load();
  const existing = findRecord(id);
  const album = existing?.album || state.search.items.find(a => a.id === id);
  if (!album) return;
  if (existing?.status === status) {
    if (status === 'listened') {
      state.quickRating = id;
      render();
      requestAnimationFrame(() => document.querySelector('[data-rate="' + id + '"]')?.focus());
    }
    return;
  }
  try {
    store.put(withListeningStatus(existing || createRecord(album), status));
    state.quickRating = status === 'listened' ? id : null;
    render();
    if (status === 'listened') requestAnimationFrame(() => document.querySelector('[data-rate="' + id + '"]')?.focus());
    toast(album.title + (status === 'wanted' ? ' · 已标记想听' : ' · 已标记听过，可以直接评分'));
  }
  catch (error) { toast(error.message); }
}

function rateAlbum(id, value) {
  if (value === '') return;
  store.load();
  const record = findRecord(id);
  if (!record) return;
  try {
    const rating = Number(value);
    store.put({ ...record, status: 'listened', rating, updatedAt: new Date().toISOString() });
    state.quickRating = null;
    render();
    toast(record.album.title + ' · 已评分 ' + rating.toFixed(1));
  } catch (error) { toast(error.message); }
}

function openAlbum(id) {
  const record = findRecord(id);
  const album = record?.album || state.search.items.find(a => a.id === id);
  if (!album) return;
  state.editing = record ? structuredClone(record) : createRecord(album);
  $('#albumHeading').textContent = album.title;
  $('#detailArtist').textContent = album.artist;
  $('#detailMeta').textContent = [album.year || '年份未知', album.type].filter(Boolean).join(' · ');
  $('#detailGenres').innerHTML = (album.genres.length ? album.genres : ['类别待补充']).map(g => '<span class="tag">' + esc(g) + '</span>').join('');
  setCoverImage($('#detailCover'), cover(album));
  $('#detailCover').alt = album.title + ' 封面';
  $('#sourceLink').hidden = !['musicbrainz', 'apple'].includes(album.source);
  if (album.source === 'musicbrainz') {
    $('#sourceLink').textContent = '在 MusicBrainz 查看 ↗';
    $('#sourceLink').href = 'https://musicbrainz.org/release-group/' + album.id;
  } else if (album.source === 'apple') {
    const match = /^apple-(TW|HK|US|GB)-(\d{1,20})$/.exec(album.id);
    $('#sourceLink').textContent = '在 Apple Music 查看 ↗';
    $('#sourceLink').href = match ? `https://music.apple.com/${match[1].toLowerCase()}/album/${match[2]}` : '#';
  }
  $('#statusInput').value = state.editing.status;
  $('#ratingInput').value = state.editing.rating ?? 0;
  $('#ratingInput').dataset.unrated = state.editing.rating === null ? 'true' : 'false';
  updateDetailRating();
  $('#categoryInput').value = state.editing.category;
  $('#noteInput').value = state.editing.note;
  $('#removeBtn').hidden = !record;
  $('#recordError').hidden = true;
  $('#albumDialog').showModal();
}

$('#recordForm').addEventListener('submit', event => {
  event.preventDefault();
  const draft = state.editing;
  const record = { ...draft, status: $('#statusInput').value, rating: $('#ratingInput').dataset.unrated === 'true' ? null : Number($('#ratingInput').value),
    note: $('#noteInput').value, category: $('#categoryInput').value.trim(), updatedAt: new Date().toISOString() };
  try { store.put(record); $('#albumDialog').close(); render(); toast('聆听记录已保存'); }
  catch (error) { $('#recordError').textContent = error.message; $('#recordError').hidden = false; }
});

$('#removeBtn').addEventListener('click', () => {
  try {
    const now = new Date().toISOString();
    store.put({ ...state.editing, updatedAt: now, deletedAt: now });
    $('#albumDialog').close();
    render();
    toast('已移出唱片墙，可从搜索结果重新加入');
  } catch (error) { $('#recordError').textContent = error.message; $('#recordError').hidden = false; }
});

$('#ratingInput').addEventListener('input', () => {
  $('#ratingInput').dataset.unrated = 'false';
  updateDetailRating();
});
$('#clearRatingBtn').addEventListener('click', () => {
  $('#ratingInput').dataset.unrated = 'true';
  updateDetailRating();
});

$$('[data-close]').forEach(button => {
  button.type = 'button';
  button.addEventListener('click', () => $('#' + button.dataset.close).close());
});
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
attachCoverFallback($('#albumDialog'));
$$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
$('#brandHome').addEventListener('click', event => { event.preventDefault(); setView('home'); });
$('#discoverBtn').addEventListener('click', () => setView('discover'));
$$('[data-status]').forEach(button => button.addEventListener('click', () => {
  state.status = button.dataset.status;
  renderLibrary();
}));
$('#sortSelect').addEventListener('change', event => { state.sort = event.target.value; renderLibrary(); });
$('#artistFilter').addEventListener('change', event => { state.artist = event.target.value; renderLibrary(); });
$('#genreFilter').addEventListener('change', event => { state.genre = event.target.value; renderLibrary(); });
$('#ratingFilter').addEventListener('change', event => { state.minRating = event.target.value; renderLibrary(); });
$('#rankingMetric').addEventListener('change', event => { state.rankingMetric = event.target.value; renderRankings(); });
['#filterMinRating', '#filterMaxRating'].forEach(selector => {
  const input = $(selector);
  input.addEventListener('pointerdown', event => {
    activeRangeControl = event.currentTarget;
    updatePanelRangeLayers();
  });
  input.addEventListener('focus', event => {
    activeRangeControl = event.currentTarget;
    updatePanelRangeLayers();
  });
  const release = () => {
    activeRangeControl = null;
    updatePanelRangeLayers();
  };
  input.addEventListener('pointerup', release);
  input.addEventListener('pointercancel', release);
  input.addEventListener('blur', release);
});
$('#filterMinRating').addEventListener('input', event => {
  const value = Number(event.target.value);
  state.panelFilters.minRating = String(Math.min(value, Number(state.panelFilters.maxRating)));
  updatePanelRangeSummary(); renderPanelResults();
});
$('#filterMaxRating').addEventListener('input', event => {
  const value = Number(event.target.value);
  state.panelFilters.maxRating = String(Math.max(value, Number(state.panelFilters.minRating)));
  updatePanelRangeSummary(); renderPanelResults();
});
$('#filterIncludeUnrated').addEventListener('change', event => { state.panelFilters.includeUnrated = event.target.checked; renderFilterPanel(); });
$('#panelStatusFilter').addEventListener('change', event => { state.panelFilters.status = event.target.value; renderFilterPanel(); });
$('#panelArtistFilter').addEventListener('change', event => { state.panelFilters.artist = event.target.value; renderFilterPanel(); });
$('#panelGenreFilter').addEventListener('change', event => { state.panelFilters.genre = event.target.value; renderFilterPanel(); });
$('#panelQueryFilter').addEventListener('input', event => { state.panelFilters.query = event.target.value; renderFilterPanel(); });
$('#resetPanelFiltersBtn').addEventListener('click', () => {
  state.panelFilters = { status: 'all', artist: '', genre: '', minRating: '0', maxRating: '10', includeUnrated: true, query: '' };
  renderFilterPanel();
});
$('#showFilteredWallBtn').addEventListener('click', () => {
  state.displayFilters = { status: state.status, artist: state.artist, genre: state.genre, minRating: state.minRating, query: state.query };
  setView('display');
});
for (const [selector, key] of [['#wallStatusFilter','status'], ['#wallArtistFilter','artist'], ['#wallGenreFilter','genre'], ['#wallRatingFilter','minRating']]) {
  $(selector).addEventListener('change', event => { state.displayFilters[key] = event.target.value; renderWallDisplay(); });
}
$('#wallQueryFilter').addEventListener('input', event => { state.displayFilters.query = event.target.value; renderWallDisplay(); });
$('#resetWallFiltersBtn').addEventListener('click', () => {
  state.displayFilters = { status: 'all', artist: '', genre: '', minRating: '', query: '' };
  renderWallDisplay();
});
const ratingOptions = '<option value="">全部评分</option>' + Array.from({length:21},(_,i)=>i*.5).reverse().map(value=>'<option value="'+value+'">≥ '+value.toFixed(1)+' 分</option>').join('');
$('#ratingFilter').innerHTML = $('#wallRatingFilter').innerHTML = ratingOptions;
$('#searchForm').addEventListener('submit', event => { event.preventDefault(); if (state.view === 'discover') search(); });
$('#searchInput').addEventListener('input', event => {
  if (state.view !== 'discover') { state.query = event.target.value; renderLibrary(); }
  else {
    cancelSearch(); state.search = { ...state.search, phase: 'idle', items: [], total: 0, nextOffset: 0 }; renderDiscovery();
    if (!event.isComposing && event.target.value.trim().length >= 2) search.timer = setTimeout(() => search(), 600);
  }
});
$('#searchInput').addEventListener('compositionend', () => { clearTimeout(search.timer); if (state.view === 'discover' && $('#searchInput').value.trim().length >= 2) search.timer = setTimeout(() => search(), 600); });
$('#searchField').addEventListener('change', () => { if ($('#searchInput').value.trim().length >= 2) search(); });
$('#searchKind').addEventListener('change', () => { if ($('#searchInput').value.trim().length >= 2) search(); });
$('#loadMoreBtn').addEventListener('click', () => search(true));
$('#pauseWallBtn').addEventListener('click', () => {
  const paused = displayWall.togglePause();
  $('#pauseWallBtn').textContent = paused ? '继续滚动' : '暂停滚动';
});
$('#exportWallBtn').addEventListener('click', exportWallScreenshot);
$('#backToLibraryBtn').addEventListener('click', async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  setView('wall');
});
$('#welcomeEnterBtn').addEventListener('click', () => setView(active().length ? 'wall' : 'discover'));
$('#welcomeDisplayBtn').addEventListener('click', () => setView('display'));
$('#fullscreenWallBtn').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen(); else await $('#wallDisplay').requestFullscreen();
  } catch { toast('当前窗口不支持全屏'); }
});
document.addEventListener('fullscreenchange', () => {
  const pure = document.fullscreenElement === $('#wallDisplay');
  document.body.classList.toggle('wall-pure-mode', pure);
  const button = $('#fullscreenWallBtn');
  if (button) {
    button.textContent = pure ? '退出全屏' : '全屏展示';
    button.setAttribute('aria-label', pure ? '退出全屏' : '全屏展示');
  }
  if (state.view === 'display' && !$('#wallDisplay').hidden) displayWall.show(true);
});
$('#displayCanvas').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  const album = displayWall.albumAt(event.clientX-rect.left,event.clientY-rect.top);
  if (album) openAlbum(album.id);
});

$('#settingsBtn').addEventListener('click', async () => {
  $('#settingsDialog').showModal();
  const status = store.diskStatus;
  $('#storageStatus').textContent = status?.path ? `磁盘主文件：${status.path} · 当前 ${active().length} 张` : `当前 ${active().length} 张 · 浏览器兼容存储`;
  const cloud = cloudSync.status();
  $('#supabaseUrl').value = cloudSync.config?.url || '';
  $('#supabaseKey').value = cloudSync.config?.anonKey || '';
  $('#supabaseStatus').textContent = cloud.connected ? `已连接 Supabase · 匿名用户 ${cloud.userId}` : cloud.configured ? '已保存配置，请连接后同步。' : '未配置云端数据库；本地收藏和 JSON 备份仍然可用。';
  $('#syncCloudBtn').disabled = !cloud.connected;
  $('#cloudStatus').textContent = desktopLibrary ? '桌面版会先保存到本机，再按你的选择镜像到同步文件夹。' : '当前浏览器模式使用 JSON 备份；配置 Supabase 后可上传到云端数据库。';
});

$('#connectCloudBtn').addEventListener('click', async () => {
  const button = $('#connectCloudBtn');
  button.disabled = true; button.textContent = '连接中…';
  try {
    const result = await cloudSync.connect($('#supabaseUrl').value, $('#supabaseKey').value);
    $('#supabaseStatus').textContent = '已连接 Supabase · 匿名用户 ' + result.userId;
    $('#syncCloudBtn').disabled = false;
    $('.profile-state').textContent = 'Supabase 已连接';
    toast('云端数据库已连接');
  } catch (error) { $('#supabaseStatus').textContent = error.message; toast('云端连接失败：' + error.message); }
  finally { button.disabled = false; button.textContent = '连接云端'; }
});

$('#syncCloudBtn').addEventListener('click', async () => {
  const button = $('#syncCloudBtn');
  button.disabled = true; button.textContent = '同步中…';
  try {
    const result = await cloudSync.sync(store.records);
    store.import({ version: 1, records: result.records });
    await store.flush();
    render();
    $('#supabaseStatus').textContent = `已同步 ${result.count} 条记录 · ${new Date().toLocaleString()}`;
    toast('本地与云端收藏已合并');
  } catch (error) { $('#supabaseStatus').textContent = error.message; toast('云端同步失败：' + error.message); }
  finally { button.disabled = false; button.textContent = '同步收藏'; }
});

$('#snapshotBtn').addEventListener('click', async () => {
  try {
    await store.flush();
    const result = await store.createBackup();
    if (result?.file) toast('已创建收藏快照'); else toast('当前环境不支持磁盘快照，请导出 JSON');
  } catch (error) { toast('快照创建失败：' + error.message); }
});
$('#chooseSyncBtn').addEventListener('click', async () => {
  if (!desktopLibrary) { toast('请在桌面版中选择同步文件夹'); return; }
  try {
    await store.flush();
    const result = await store.chooseSyncFolder();
    if (!result?.canceled) { await store.flush(); render(); $('#cloudStatus').textContent = '已启用同步文件夹：' + (result.status?.syncFolder || '已选择'); toast('已合并并启用云同步文件夹'); }
  } catch (error) { toast('同步文件夹设置失败：' + error.message); }
});

$('#exportBtn').addEventListener('click', async () => {
  try {
    const blob = new Blob([store.error ? store.raw() : store.export()], { type: 'application/json' });
    const saved = await download(blob, 'album-wall-' + new Date().toISOString().slice(0, 10) + (store.error ? '-recovery' : '') + '.json');
    if (saved) toast('备份已导出');
  } catch { toast('无法访问本地数据，请检查浏览器存储权限'); }
});
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('备份文件不能超过 5 MB');
    const count = store.import(JSON.parse(await file.text()));
    render();
    toast('已合并 ' + count + ' 条记录');
  } catch (error) { toast(error instanceof SyntaxError ? '无法解析 JSON 备份文件' : error.message); }
  finally { event.target.value = ''; }
});
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) { store.load(); render(); }
});
if (window.albumWallDesktop) {
  $('.profile-state').textContent = '保存在此电脑';
  $('#localStorageDescription').textContent = '收藏保存在此电脑的唱片墙应用目录，退出、重启或更新应用后仍会保留。原浏览器的收藏可导出备份后在这里导入。';
}
let desktopHydratedSync = false;
if (desktopLibrary && typeof desktopLibrary.loadSync === 'function') {
  store.hydrateSync();
  desktopHydratedSync = true;
}
setView(desktopLibrary && active().length ? 'wall' : 'home');
if (desktopLibrary && (!desktopHydratedSync || store.diskReadBlocked)) {
  store.hydrate().then(() => {
    if (state.view === 'home' && active().length) setView('wall');
    else render();
    window.albumWallDesktop?.reportReady?.({ records: active().length, error: store.error || '' });
  }).catch(error => {
    if (state.view === 'home' && active().length) setView('wall');
    else render();
    window.albumWallDesktop?.reportReady?.({ records: active().length, error: error?.message || store.error || 'hydrate failed' });
  });
} else if (desktopLibrary) {
  window.albumWallDesktop?.reportReady?.({ records: active().length, error: store.error || '' });
}
if (cloudSync.status().connected) $('.profile-state').textContent = 'Supabase 已连接';
