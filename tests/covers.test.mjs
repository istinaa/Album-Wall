import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverService as coverService, isNeteaseArtworkUrl, matchArtwork } from '../server/covers.mjs';
import { createArtworkProviders } from '../server/artwork-providers.mjs';

const createCoverService = options => coverService({ ...options, providers: createArtworkProviders({
  fetchImpl: options.fetchImpl, appleIntervalMs: 0, neteaseIntervalMs: 0
}) });

const id = '6e335887-60ba-38f0-95af-fae7774336bf';
const item = { collectionName: 'In Rainbows', artistName: 'Radiohead', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg' };

test('fallback rejects covers by different artists, unsafe URLs, or unrelated titles', () => {
  assert.equal(matchArtwork([{...item,artistName:'Tribute Band'}], 'In Rainbows', 'Radiohead'), null);
  assert.equal(matchArtwork([{...item,collectionName:'Live in Rainbows'}], 'In Rainbows', 'Radiohead'), null);
  assert.equal(matchArtwork([{...item,artworkUrl100:'http://localhost/secret'}], 'In Rainbows', 'Radiohead'), null);
  assert.equal(matchArtwork([item], 'IN RAINBOWS', 'Radiohead'), item);
  const chinese = { ...item, collectionName: '浮躁', artistName: 'Faye Wong' };
  assert.equal(matchArtwork([chinese], '浮躁', '王菲'), null);
  assert.equal(matchArtwork([chinese], '浮躁', '王菲', ['Faye Wong']), chinese);
  assert.equal(matchArtwork([{ ...chinese, collectionName: '浮躁 (Live)' }], '浮躁', '王菲', ['Faye Wong']), null);
});

test('explicit localized artist identities match across Japanese and Chinese names', () => {
  const utada = { ...item, collectionName: 'First Love', artistName: '宇多田ヒカル' };
  assert.equal(matchArtwork([utada], 'First Love', '宇多田光'), utada);
  assert.equal(matchArtwork([utada], 'First Love', 'Hikaru Utada'), utada);
});

test('CAA failure falls back to matched artwork and coalesces duplicate requests', async () => {
  const calls = [];
  const service = createCoverService({ fetchImpl: async url => {
    calls.push(url);
    if (url.includes('coverartarchive')) throw new Error('Unreachable');
    if (url.includes('itunes.apple')) return Response.json({ results: [item] });
    return new Response(new Uint8Array([255,216,255]), { headers: { 'content-type':'image/jpeg' } });
  } });
  const [a,b] = await Promise.all([service.get(id, 'In Rainbows', 'Radiohead'),service.get(id, 'In Rainbows', 'Radiohead')]);
  assert.equal(a.source,'Apple Music');
  assert.deepEqual(a,b);
  assert.equal(calls.filter(url => url.includes('coverartarchive')).length, 1);
  assert.equal(calls.filter(url => url.includes('itunes.apple')).length, 1);
  assert.equal(calls.filter(url => url.includes('mzstatic')).length, 1);
  assert.ok(calls.some(url => /600x600bb/.test(url)));
  const fetched = calls.length;
  await service.get(id,'In Rainbows','Radiohead');
  assert.equal(calls.length, fetched);
});

test('confirmed missing artwork and empty provider results yield a cached miss', async () => {
  let calls=0;
  const service = createCoverService({ fetchImpl: async url => {
    calls++;
    if (url.includes('itunes')) return Response.json({results:[]});
    if (url.includes('music.163')) return Response.json({code:200,result:{albums:[]}});
    return new Response('', {status:404});
  } });
  assert.equal(await service.get(id,'In Rainbows','Radiohead'),null);
  const fetched = calls;
  assert.equal(await service.get(id,'In Rainbows','Radiohead'),null);
  assert.equal(calls, fetched);
});

test('Chinese covers match simplified/traditional names and regional editions without accepting live or tribute albums', () => {
  const jay = { ...item, collectionName: '葉惠美', artistName: '周杰倫' };
  assert.equal(matchArtwork([jay], '叶惠美', '周杰伦'), jay);
  const eason = { ...item, collectionName: '認了吧 (台灣版)', artistName: '陳奕迅' };
  assert.equal(matchArtwork([eason], '认了吧', '陈奕迅'), eason);
  const beatles = { ...item, collectionName: 'Abbey Road (2019 Mix)', artistName: 'The Beatles' };
  assert.equal(matchArtwork([beatles], 'Abbey Road', 'The Beatles'), null);
  const remaster = { ...beatles, collectionName: 'Abbey Road (Remastered)' };
  assert.equal(matchArtwork([remaster], 'Abbey Road', 'Beatles'), remaster);
  for (const suffix of ['(Live)', '(Tribute)', '现场版', ' - Single', '(Remix)']) {
    assert.equal(matchArtwork([{ ...jay, collectionName: '葉惠美 ' + suffix }], '叶惠美', '周杰伦'), null);
  }
  assert.equal(matchArtwork([{ ...jay, artworkUrl100: 'https://is1.mzstatic.com@localhost/file' }], '叶惠美', '周杰伦'), null);
});

test('Apple failure cools down all storefronts instead of trying every region', async () => {
  const countries = [];
  const service = createCoverService({ fetchImpl: async url => {
    if (url.includes('coverartarchive')) throw new Error('Unreachable');
    if (url.includes('itunes.apple')) {
      const country = new URL(url).searchParams.get('country'); countries.push(country);
      return new Response('', { status: 503 });
    }
    if (url.includes('music.163')) return Response.json({code:200,result:{albums:[]}});
    return new Response(new Uint8Array([255,216,255]), { headers: { 'content-type': 'image/jpeg' } });
  } });
  await assert.rejects(service.get(id, '黑色柳丁', '陶喆'), error => error.status === 503);
  assert.deepEqual(countries, ['TW']);
});

test('self-titled and subtitle matches require the original year and reject unrelated versions', () => {
  const debut = { ...item, collectionName: '同名專輯', artistName: '周杰倫', releaseDate: '2000-11-06', trackCount: 10 };
  assert.equal(matchArtwork([debut], 'Jay', '周杰伦', ['Jay'], {year:'2000'}), debut);
  assert.equal(matchArtwork([debut], 'Jay', '周杰伦', ['Jay'], {year:'2001'}), null);
  assert.equal(matchArtwork([debut], '范特西', '周杰伦', ['Jay'], {year:'2000'}), null);
  const tao = { ...debut, collectionName:'陶喆同名專輯', artistName:'陶喆', releaseDate:'1997-12-06' };
  assert.equal(matchArtwork([tao], '陶喆', '陶喆', [], {year:'1997'}), tao);
  const white = { ...debut, collectionName:'The Beatles (The White Album)', artistName:'The Beatles', releaseDate:'1968-11-22', trackCount:32 };
  assert.equal(matchArtwork([white], 'The Beatles', 'The Beatles', [], {year:'1968'}), white);
  assert.equal(matchArtwork([{...white,collectionName:'The Beatles (Live)'}], 'The Beatles', 'The Beatles', [], {year:'1968'}), null);
  assert.equal(matchArtwork([{...white,trackCount:1}], 'The Beatles', 'The Beatles', [], {year:'1968'}), null);
  assert.equal(matchArtwork([{...item,collectionName:'六九樂章',artistName:'陶喆'}], 'Opus 69', '陶喆', [], {titleAliases:['六九樂章']} )?.collectionName,'六九樂章');
});

test('regional catalogs may keep one half of a bilingual album title', () => {
  const dreamer = { ...item, collectionName:'The Dreamer', artistName:'方大同', releaseDate:'2024-10-18', trackCount:10 };
  assert.equal(matchArtwork([dreamer], '夢想家The Dreamer', '方大同', [], { year:'2024' }), dreamer);
  const groupies = { ...item, collectionName:'吉他手', artistName:'陳綺貞', releaseDate:'2002-08-02', trackCount:13 };
  assert.equal(matchArtwork([groupies], 'Groupies 吉他手', '陈绮贞', [], { year:'2002' }), groupies);
  assert.equal(matchArtwork([{ ...dreamer, artistName:'另一位歌手' }], '夢想家 The Dreamer', '方大同', [], { year:'2024' }), null);
  assert.equal(matchArtwork([{ ...dreamer, releaseDate:'2023-10-18' }], '夢想家 The Dreamer', '方大同', [], { year:'2024' }), null);
  assert.equal(matchArtwork([{ ...groupies, trackCount:1 }], 'Groupies 吉他手', '陳綺貞', [], { year:'2002' }), null);
  assert.equal(matchArtwork([{ ...groupies, collectionName:'另一張唱片' }], 'Groupies 吉他手', '陳綺貞', [], { year:'2002' }), null);
});

test('popular Chinese albums match punctuation, concatenated artist aliases, and dated mixes', () => {
  const artwork = 'https://is1.mzstatic.com/image/100x100bb.jpg';
  const netease = 'https://p2.music.126.net/cover-id/album.jpg';
  assert.equal(matchArtwork([{ collectionName: '卡拉OK.台北.我', artistName: '张雨生', artworkUrl100: artwork, releaseDate: '1994-09-05', trackCount: 13 }], '卡拉OK Live．台北．我', '張雨生', ['张雨生'], { year: '1994' })?.collectionName, '卡拉OK.台北.我');
  assert.equal(matchArtwork([{ collectionName: '飞出迷楼 (2017 Mix)', artistName: '晝夜生The Paramecia & 蘇紫旭', artworkUrl100: artwork, releaseDate: '2017-10-25', trackCount: 7 }], '飞出迷楼 (Out of the Labyrinth)', '苏紫旭 & The Paramecia', [], { year: '2017' })?.collectionName, '飞出迷楼 (2017 Mix)');
  assert.equal(matchArtwork([{ collectionName: '狗日子（Dog Days）', artistName: '表情银行MimikBanka', artworkUrl100: netease, releaseDate: '2022-06-28', trackCount: 8 }], '狗日子', '表情银行', [], { year: '2022' })?.collectionName, '狗日子（Dog Days）');
});

test('parenthetical the is ignored when catalogues spell a classic album differently', () => {
  const white = { ...item, collectionName: 'The Beatles (The White Album)', artistName: 'The Beatles' };
  assert.equal(matchArtwork([white], 'The Beatles (White Album)', 'The Beatles'), white);
});

test('title-only fallback keeps artist validation when a localized search misses', async () => {
  const terms = [];
  const service = createCoverService({ fetchImpl: async url => {
    if (url.includes('coverartarchive')) return new Response('', { status: 404 });
    if (url.includes('itunes.apple')) {
      const term = new URL(url).searchParams.get('term');
      terms.push(term);
      return Response.json({ results: term === '浮躁' ? [{ ...item, collectionName: '浮躁', artistName: 'Faye Wong' }] : [] });
    }
    return new Response(new Uint8Array([255,216,255]), { headers: { 'content-type': 'image/jpeg' } });
  } });
  const result = await service.get(id, '浮躁', '王菲', ['Faye Wong']);
  assert.equal(result.source, 'Apple Music');
  assert.deepEqual(terms, ['王菲', '浮躁 王菲', '浮躁']);
});

test('unavailable cover service returns a retryable failure and backs off repeated requests', async () => {
  let calls = 0;
  const service = createCoverService({ fetchImpl: async () => { calls++; throw new Error('Network down'); } });
  await assert.rejects(service.get(id,'In Rainbows','Radiohead'), error => error.status === 503 && error.retryAfter >= 30);
  const fetched = calls;
  await assert.rejects(service.get(id,'In Rainbows','Radiohead'), error => error.status === 503);
  assert.equal(calls, fetched);
});

test('one artwork timeout does not freeze other covers from the same provider', async () => {
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  let imageCalls = 0;
  const service = createCoverService({ fetchImpl: async url => {
    const value = String(url);
    if (value.includes('coverartarchive')) return new Response('', {status:404});
    if (value.includes('itunes.apple.com/search')) {
      const title = new URL(value).searchParams.get('term').includes('Second') ? 'Second Album' : 'First Album';
      return Response.json({results:[{...item, collectionName:title, artworkUrl100:'https://is1.mzstatic.com/' + title.replaceAll(' ','-') + '/100x100bb.jpg'}]});
    }
    if (value.startsWith('https://is1.mzstatic.com/First-Album')) throw new Error('Connection timed out');
    if (value.startsWith('https://is1.mzstatic.com/')) { imageCalls++; return new Response(new Uint8Array([255,216,255]), {headers:{'content-type':'image/jpeg'}}); }
    return Response.json({results:[]});
  }});
  await assert.rejects(service.get(firstId,'First Album','Radiohead'), error => error.status === 503);
  const second = await service.get(secondId,'Second Album','Radiohead');
  assert.equal(second.source, 'Apple Music');
  assert.equal(imageCalls, 1);
});

test('NetEase fallback safely fills 收敛水 when Apple has no matching release', async () => {
  const service = createCoverService({ fetchImpl: async url => {
    const value = String(url);
    if (value.includes('coverartarchive')) return new Response('', { status: 404 });
    if (value.includes('itunes.apple')) return Response.json({ results: [] });
    if (value.includes('music.163.com')) return Response.json({ result: { albums: [{
      name: '收敛水', artist: { name: '蛋堡' }, artists: [{ name: '蛋堡' }], publishTime: 1248192000000,
      size: 14, picUrl: 'http://p2.music.126.net/cover-id/album.jpg'
    }] } });
    if (value.startsWith('https://p2.music.126.net/')) return new Response(new Uint8Array([255,216,255]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error('Unexpected URL: ' + value);
  } });
  const result = await service.get('0164d77e-0e07-42e4-9f28-c03b39a8ece5', '收斂水', '蛋堡', [], { year: '2009', titleAliases: ['Lotion', '收敛水'] });
  assert.equal(result.source, '网易云音乐');
  assert.ok(isNeteaseArtworkUrl('https://p2.music.126.net/cover-id/album.jpg'));
  assert.equal(isNeteaseArtworkUrl('https://music.126.net.example.com/album.jpg'), false);
});
