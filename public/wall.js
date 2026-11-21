import { apiUrl } from './api.js';
import { coverLoader } from './cover-loader.js';

const PLACEHOLDER = new URL('./cover-placeholder.svg', import.meta.url).href;

export function coverUrl(album) {
  if (album.source === 'apple') {
    const match = /^apple-(TW|HK|US|GB)-(\d{1,20})$/.exec(album.id);
    return match ? apiUrl(`/api/apple-cover/${match[1]}/${match[2]}?v=1`) : PLACEHOLDER;
  }
  if (album.source !== 'musicbrainz') return PLACEHOLDER;
  const params = new URLSearchParams({ title: album.title, artist: album.artist, year: album.year || '', v: '7' });
  (album.titleAliases || []).slice(0,8).forEach(alias => params.append('titleAlias',alias));
  // Catalogued aliases bridge localized storefront names, including
  // collaborations where more than one credited artist is present.
  (album.artists || []).flatMap(artist => [artist.name, ...(artist.aliases || [])]).slice(0, 15)
    .forEach(alias => params.append('artistAlias', alias));
  return apiUrl('/api/cover/' + encodeURIComponent(album.id) + '?' + params);
}

// The canvas is both the live wall and the export surface: no DOM re-layout or CORS capture.
export function createWall(canvas, { welcome = false } = {}) {
  const context = canvas.getContext('2d', { alpha: false });
  const layer = document.createElement('canvas');
  const scene = layer.getContext('2d', { alpha: false });
  const blurLayer = document.createElement('canvas');
  const blurContext = blurLayer.getContext('2d');
  let albums = [], visible = false, paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let animation, elapsed = 0, previous = 0;
  let width = 0, height = 0, scale = 1;
  let slots = [];
  const images = new Map();
  const releaseCovers = () => { for (const entry of images.values()) entry.release(); images.clear(); };
  const onVisibilityChange = () => { if (document.hidden) releaseCovers(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  function loadCover(album) {
    const url = coverUrl(album);
    if (images.has(url)) return images.get(url);
    const image = new Image();
    const entry = { image, ready: false, release: () => {} };
    image.onload = () => { entry.ready = true; };
    entry.release = coverLoader().subscribe(url, source => { image.src = source; });
    images.set(url, entry);
    return entry;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    width = rect.width; height = rect.height;
    scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = layer.width = blurLayer.width = Math.round(width * scale);
    canvas.height = layer.height = blurLayer.height = Math.round(height * scale);
    draw();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  function draw() {
    if (!width || !height) return;
    const pure = !welcome && document.fullscreenElement === canvas.parentElement;
    const background = pure ? '#111513' : '#e6e9df';
    const foreground = pure ? '#f1f4ee' : '#263a30';
    scene.setTransform(scale, 0, 0, scale, 0, 0);
    scene.fillStyle = background; scene.fillRect(0, 0, width, height);
    slots = [];
    const size = width < 600 ? 145 : welcome ? 194 : 206;
    const gap = 28, pitch = size + gap;
    const rows = 3, rowPitch = size + 48;
    const offsetY = (height - rows * rowPitch) / 2;
    const cycle = Math.max(albums.length, Math.ceil(width / pitch) + 3);
    for (let row = 0; row < rows; row++) {
      const shift = elapsed * (welcome ? 11 : 15) * (1 + row * .12);
      const offset = shift % pitch;
      const first = Math.floor(shift / pitch);
      for (let col = -1; col <= Math.ceil(width / pitch) + 1; col++) {
        if (!albums.length) continue;
        const index = ((first + col + row * Math.ceil(cycle / 3)) % albums.length + albums.length) % albums.length;
        const album = albums[index];
        const x = col * pitch - offset + (row % 2 ? -pitch / 2 : 0);
        const y = offsetY + row * rowPitch + Math.sin((index + row) * 2) * 9;
        const angle = (-8 + ((index * 7 + row * 3) % 13)) * Math.PI / 180;
        scene.save(); scene.translate(x + size / 2, y + size / 2); scene.rotate(angle);
        scene.shadowColor = '#24332a33'; scene.shadowBlur = 19; scene.shadowOffsetX = 4; scene.shadowOffsetY = 10;
        scene.fillStyle = '#fafbf5'; scene.fillRect(-size/2-7, -size/2-7, size+14, size+40);
        scene.shadowColor = 'transparent';
        const cover = visible && !document.hidden ? loadCover(album) : null;
        if (cover?.ready) {
          const im = cover.image, crop = Math.min(im.naturalWidth, im.naturalHeight);
          scene.drawImage(im, (im.naturalWidth-crop)/2, (im.naturalHeight-crop)/2, crop, crop, -size/2, -size/2, size, size);
        } else {
          scene.fillStyle = ['#9c5f49','#747a4d','#48616b','#b19c81','#75727f'][index % 5];
          scene.fillRect(-size/2,-size/2,size,size);
          scene.beginPath(); scene.arc(0,0,size*.35,0,Math.PI*2); scene.fillStyle='#28322bd9';scene.fill();
          scene.beginPath();scene.arc(0,0,size*.09,0,Math.PI*2);scene.fillStyle='#d2dbb3';scene.fill();
        }
        scene.fillStyle=foreground; scene.font='500 10px "Segoe UI", sans-serif';
        scene.save(); scene.beginPath(); scene.rect(-size/2,size/2+3,size,30);scene.clip();
        scene.fillText(album.title,-size/2,size/2+16);
        scene.restore();scene.restore();
        slots.push({ x, y, size, album });
      }
    }
    const shown = new Set(slots.map(slot => coverUrl(slot.album)));
    for (const [url, entry] of images) {
      if (!shown.has(url) || document.hidden) { entry.release(); images.delete(url); }
    }
    context.setTransform(1,0,0,1,0,0);
    context.drawImage(layer,0,0);
    // Progressive blur at both edges, included in the PNG export.
    blurContext.clearRect(0,0,canvas.width,canvas.height);
    blurContext.filter='blur(7px)';blurContext.drawImage(layer,0,0);blurContext.filter='none';
    for (const top of [true,false]) {
      const edge = Math.min(95,height*.18)*scale;
      for(let band=0;band<16;band++) {
        const y=top?edge*band/16:canvas.height-edge*(band+1)/16;
        context.save();context.beginPath();context.rect(0,y,canvas.width,edge/16+1);context.clip();
        context.globalAlpha=(1-band/16)**2;context.drawImage(blurLayer,0,0);context.restore();
      }
      context.save();
      const y0=top?0:canvas.height, y1=top?edge:canvas.height-edge;
      const gradient=context.createLinearGradient(0,y0,0,y1);
      gradient.addColorStop(0, pure ? '#111513ed' : '#e6e9dfed');gradient.addColorStop(1, pure ? '#11151300' : '#e6e9df00');
      context.fillStyle=gradient;context.fillRect(0,top?0:canvas.height-edge,canvas.width,edge);context.restore();
    }
    if (!welcome) {
      context.setTransform(scale,0,0,scale,0,0);
      context.fillStyle=foreground;context.font='600 12px "Segoe UI", sans-serif';
      context.fillText('唱片墙 / ALBUM WALL',22,height-24);
      context.textAlign='right';context.font='10px monospace';
      context.fillText(albums.length+' RECORDS',width-22,height-24);context.textAlign='left';
    }
  }

  function tick(time) {
    if (!visible) return;
    const delta = previous ? Math.min((time-previous)/1000,.1) : 0;
    previous=time;
    if (!paused && !document.hidden) elapsed+=delta;
    // Limit to about 30 fps and redraw paused walls as their artwork arrives.
    if (time - (tick.last || 0) > 32) { draw(); tick.last=time; }
    animation=requestAnimationFrame(tick);
  }
  return {
    setAlbums(items) { albums = items; draw(); },
    show(value) { visible=value; cancelAnimationFrame(animation);previous=0;if(value){resize();animation=requestAnimationFrame(tick);}else releaseCovers(); },
    togglePause() { paused=!paused;return paused; },
    get paused() { return paused; },
    albumAt(x,y) { return slots.findLast(slot=>x>=slot.x&&x<=slot.x+slot.size&&y>=slot.y&&y<=slot.y+slot.size)?.album; },
    async export() {
      draw();
      return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成截图')),'image/png'));
    },
    destroy() { cancelAnimationFrame(animation);resizeObserver.disconnect();releaseCovers();document.removeEventListener('visibilitychange', onVisibilityChange); }
  };
}
