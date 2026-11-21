import OpenCC from 'opencc-js/t2cn';

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
const text = value => toSimplified(String(value || '').normalize('NFKC')).toLowerCase()
  .normalize('NFD').replace(/\p{M}/gu, '').trim();
const compact = value => value.replace(/[^\p{L}\p{N}]/gu, '');
// Public catalogues use a mixture of localized, Japanese and romanized artist
// names. These are explicit identity groups rather than fuzzy matching, so a
// similar-looking name can never merge accidentally.
export const artistAliasGroups = [
  ['宇多田ヒカル', '宇多田光', 'Hikaru Utada', 'Utada Hikaru', 'Utada'],
  ['周杰伦', '周杰倫', 'Jay Chou', 'Jay'],
  ['陶喆', '陶喆 David Tao', 'David Tao', 'Tao'],
  ['The Beatles', 'Beatles'],
  ['坂本龍一', '坂本龙一', 'Ryuichi Sakamoto', 'Ryūichi Sakamoto'],
  ['方大同', '方大同 Khalil Fong', 'Khalil Fong'],
  ['陈绮贞', '陳綺貞', 'Cheer Chen'],
  ['蛋堡', 'Soft Lipa']
];
const artistAliases = new Map(artistAliasGroups.flatMap(group => {
  const canonical = compact(text(group[0]));
  return group.map(value => [compact(text(value)), canonical]);
}));
// Only remove edition labels, never live/tribute/remix/single designations.
const edition = /^(?:(?:\d{4}|\d+(?:st|nd|rd|th))\s+)?(?:deluxe|expanded|remaster(?:ed)?|anniversary|stereo|mono|bonus track|special edition|legacy edition|台湾版|香港版|台版|港版|重制版|复刻版|纪念版|豪华版|数位修复版|数字修复版|taiwan version|hong kong version)(?:\s.*)?$/i;

export function normalizedTitle(value) {
  return compact(text(value).replace(/\(\s*the\s+/g, '(').replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (whole, a, b) => edition.test((a || b).trim()) ? '' : whole)
    .replace(/\s[-–—:]\s(.+)$/, (whole, suffix) => edition.test(suffix.trim()) ? '' : whole));
}

export const normalizedArtist = value => artistAliases.get(compact(text(value))) || compact(text(value).replace(/^the\s+/, ''));
export const artistEquivalent = (left, right) => normalizedArtist(left) === normalizedArtist(right);

function artistParts(value) {
  // Some Chinese catalogues concatenate the localized name and its romanized
  // alias without a separator (for example 表情银行MimikBanka). Split at the
  // script boundary before applying the usual collaboration separators.
  const separated = String(value || '').replace(/(?<=[\p{Script=Han}])(?=[\p{Script=Latin}\p{N}])|(?<=[\p{Script=Latin}\p{N}])(?=[\p{Script=Han}])/gu, '|');
  return separated.split(/\s*(?:&|,|、|／|\/| x | feat\.?| featuring | with |\|)\s*/iu)
    .map(part => normalizedArtist(part)).filter(Boolean);
}

// Search providers index localized and romanized names separately. Returning the
// complete explicit group lets callers search all known spellings without using
// unsafe fuzzy matching (which could merge two different artists).
export function artistSearchAliases(value) {
  const key = compact(text(value));
  const group = artistAliasGroups.find(names => names.some(name => compact(text(name)) === key));
  return group ? [...group] : [String(value || '').trim()].filter(Boolean);
}

function titleParts(value) {
  const source = text(value).replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (whole, a, b) => edition.test((a || b).trim()) ? '' : whole);
  const parts = source.match(/\p{Script=Han}+(?:[·・]\p{Script=Han}+)*|[\p{Script=Latin}\p{N}]+(?:['’.-][\p{Script=Latin}\p{N}]+)*(?:\s+[\p{Script=Latin}\p{N}]+(?:['’.-][\p{Script=Latin}\p{N}]+)*)*/gu) || [];
  return new Set(parts.map(normalizedTitle).filter(part =>
    /\p{Script=Han}/u.test(part) ? [...part].length >= 2 : part.length >= 4));
}

export function matchArtwork(items, title, artist, aliases = [], { year = '', titleAliases = [] } = {}) {
  const titles = [title, ...titleAliases];
  const wantedTitles = new Set(titles.map(normalizedTitle).filter(Boolean));
  const wantedArtists = new Set([artist, ...aliases].flatMap(value => artistParts(value)).filter(Boolean));
  if (!wantedTitles.size || !wantedArtists.size) return null;
  const candidates = items.filter(item => artistParts(item.artistName).some(name => wantedArtists.has(name)) &&
    (isArtworkUrl(item.artworkUrl100) || isNeteaseArtworkUrl(item.artworkUrl100)));
  const exact = candidates.find(item => wantedTitles.has(normalizedTitle(item.collectionName)));
  if (exact) return exact;
  // Broader naming conventions require matching artist AND original release year.
  // This covers bilingual subtitles and self-titled debuts, without borrowing a
  // live album, single or compilation with a similar name.
  if (!/^\d{4}$/.test(year)) return null;
  const unsafe = /\b(live|tribute|karaoke|remix|mix|single|compilation|greatest hits)\b|现场|演唱会|致敬|翻唱|精选|混音/iu;
  const baseTitle = value => normalizedTitle(text(value).replace(/\([^)]*\)|\[[^\]]*\]/g, ''));
  const itemParts = item => titleParts(item.collectionName);
  const wantedParts = new Set(titles.flatMap(value => [...titleParts(value)]));
  const sharesTitlePart = item => [...itemParts(item)].some(part => wantedParts.has(part));
  const selfTitled = titles.some(value => wantedArtists.has(normalizedArtist(value)));
  const allowedYearMix = item => new RegExp('(?:^|[^\\d])' + year + '\\s+mix(?:[^\\d]|$)', 'iu').test(String(item.collectionName || ''));
  return candidates.find(item => String(item.releaseDate || '').slice(0,4) === year && item.trackCount >= 4 &&
    (!unsafe.test(text(item.collectionName)) || allowedYearMix(item)) && (
      titles.some(value => baseTitle(value) === baseTitle(item.collectionName)) ||
      sharesTitlePart(item) ||
      (selfTitled && /同名专辑$/.test(text(item.collectionName)) &&
        (!text(item.collectionName).replace(/同名专辑$/, '') || wantedArtists.has(normalizedArtist(text(item.collectionName).replace(/同名专辑$/, '')))))
    )) || null;
}

export function isArtworkUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.mzstatic.com') && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function isNeteaseArtworkUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'music.126.net' || url.hostname.endsWith('.music.126.net')) &&
      !url.username && !url.password && !url.port;
  } catch { return false; }
}
