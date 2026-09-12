
// 静态资源缓存（示例音频等），版本化缓存名
const AssetCache = {
  cacheName: 'music-viz-assets-v1',
  _abs(url){ return new URL(url, window.location.href).href; },
  async fetch(url) {
    const absUrl = this._abs(url);
    try {
      const cache = await caches.open(this.cacheName);
      const cached = await cache.match(absUrl, {ignoreSearch: true});
      if (cached) return cached.clone();
      const resp = await fetch(url);
      if (resp.ok) cache.put(absUrl, resp.clone());
      return resp;
    } catch(e) {
      return fetch(url);
    }
  }
};

/* 日志工具 */
const _logBar = document.getElementById('logBar');
function _log(msg, cls){
  const t = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.textContent = '[' + t + '] ' + msg;
  if(_logBar){
    const atBottom = _logBar.scrollHeight - _logBar.scrollTop - _logBar.clientHeight < 30;
    _logBar.appendChild(line);
    while(_logBar.childElementCount > 500) _logBar.removeChild(_logBar.firstChild);
    if(atBottom) _logBar.scrollTop = _logBar.scrollHeight;
  }
  console.log('[MusicViz] ' + msg);
}
function logCopy(){
  const text = _logBar ? _logBar.innerText : '';
  if(!text) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).catch(()=>{});
  }
}
function logClear(){ if(_logBar) _logBar.innerHTML=''; }
function logDownload(){
  const text = _logBar ? _logBar.innerText : '';
  if(!text) return;
  const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'music-viz-log-' + new Date().toISOString().replace(/[:.]/g,'-').slice(0,19) + '.txt';
  a.click();
  URL.revokeObjectURL(url);
}
function logScrollTop(){ if(_logBar) _logBar.scrollTop=0; }
function logScrollBottom(){ if(_logBar) _logBar.scrollTop=_logBar.scrollHeight; }

// 媒体源：多个 jsDelivr 边缘节点 + 本站 Pages 兜底，下载时并发择优
const REPO_GH = 'teecatt/teecatt.github.io';
const REPO_REF = 'master';
const CDN_BASES = [
  { name: 'jsDelivr',        base: 'https://cdn.jsdelivr.net/gh/' },
  { name: 'jsDelivr-Fastly', base: 'https://fastly.jsdelivr.net/gh/' },
  { name: 'jsDelivr-Gcore',  base: 'https://gcore.jsdelivr.net/gh/' },
  { name: 'jsDelivr-CF',     base: 'https://testingcf.jsdelivr.net/gh/' },
];
const DEMO_URLS = CDN_BASES.map(b => b.base + REPO_GH + '@' + REPO_REF + '/music_visualization/demo.ogg');
DEMO_URLS.push('demo.ogg');
function _demoSourceLabel(url){
  const u = String(url);
  if(u.indexOf('://') < 0) return 'Pages';
  for(const b of CDN_BASES){ if(u.indexOf(b.base) === 0) return b.name; }
  try { return new URL(u).hostname; } catch(e) { return '备用源'; }
}
// 单源：完整下载为 Blob（流式回报进度；中止/失败时丢弃不完整分片）
async function _downloadBlobDemo(url, onProgress, signal){
  const r = await fetch(url, signal ? { signal } : undefined);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const total = parseInt((r.headers && r.headers.get && r.headers.get('content-length')) || '0', 10);
  if(!r.body || typeof r.body.getReader !== 'function'){
    const blob = await r.blob();
    if(onProgress) onProgress(blob.size, total > 0 ? total : blob.size);
    return blob;
  }
  const reader = r.body.getReader();
  let chunks = []; let received = 0;
  try {
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      chunks.push(value);
      received += value.byteLength;
      if(onProgress) onProgress(received, total);
    }
  } catch(e) {
    chunks = null; // 中止/失败：清理该镜像的不完整分片
    throw e;
  }
  if(onProgress) onProgress(received, total > 0 ? total : received);
  return new Blob(chunks);
}
// 完整下载竞速：所有镜像同时完整下载，最先完成者胜出；其余立即 abort 并清理不完整分片
async function _raceDownloadDemo(urls){
  const hasAbort = (typeof AbortController !== 'undefined');
  const controllers = urls.map(() => hasAbort ? new AbortController() : null);
  const t0 = performance.now();
  const states = urls.map(u => ({ src: _demoSourceLabel(u), received: 0, total: 0, failed: false }));
  let lastLog = 0;
  const report = () => {
    const now = performance.now();
    if(now - lastLog < 500) return;
    lastLog = now;
    let lead = null;
    for(const s of states){ if(!s.failed && (!lead || s.received > lead.received)) lead = s; }
    if(!lead || lead.received <= 0) return;
    const elapsed = (now - t0) / 1000;
    const speed = lead.received / elapsed / 1024;
    const pct = lead.total > 0 ? (lead.received / lead.total * 100).toFixed(1) + '%' : (lead.received/1024).toFixed(0) + 'KB';
    _log('demo.ogg: 竞速进度 ' + pct + ' 领先[' + lead.src + '] ' + speed.toFixed(0) + 'KB/s');
  };
  const attempts = urls.map((url, i) => _downloadBlobDemo(url, (received, total) => {
    states[i].received = received; states[i].total = total; report();
  }, controllers[i] ? controllers[i].signal : null).then(
    blob => ({ blob, i, url }),
    err => { states[i].failed = true; throw err; }
  ));
  _log('demo.ogg: 完整下载竞速，同时请求 ' + urls.length + ' 个镜像');
  let winner;
  try {
    winner = await (typeof Promise.any === 'function' ? Promise.any(attempts) : new Promise((res, rej) => {
      let n = urls.length; const errs = [];
      attempts.forEach((p, i) => p.then(res, e => { errs[i] = e; if(--n === 0) rej({ errors: errs }); }));
    }));
  } catch(agg) {
    const errs = (agg && agg.errors) || [];
    const first = errs.find(e => e);
    throw (first instanceof Error) ? first : new Error('全部镜像下载失败');
  }
  const elapsed = (performance.now() - t0) / 1000;
  const src = _demoSourceLabel(winner.url);
  const size = winner.blob.size;
  _log('demo.ogg: 镜像[' + src + ']最先完成 ' + (size/1024).toFixed(0) + 'KB，耗时' + elapsed.toFixed(1) + 's，平均' + (size/1024/Math.max(elapsed,0.001)).toFixed(0) + 'KB/s', 'ok');
  // 暂停其余镜像的下载并清理其不完整分片
  let aborted = 0;
  controllers.forEach((c, i) => { if(c && i !== winner.i){ try { c.abort(); aborted++; } catch(e){} } });
  _log('demo.ogg: 已中止其余 ' + aborted + ' 个镜像并清理不完整分片');
  return { blob: winner.blob, url: winner.url, source: src };
}
// 完整下载竞速开关（默认开，可在终端顶部关闭改用首字节竞速）
let raceFullDownload = true;
try { raceFullDownload = localStorage.getItem('raceFull') !== '0'; } catch(e){}
function onRaceFullChange(){
  const el = document.getElementById('raceFullSw');
  raceFullDownload = el ? el.checked : true;
  try { localStorage.setItem('raceFull', raceFullDownload ? '1' : '0'); } catch(e){}
  _log('完整下载竞速：' + (raceFullDownload ? '开' : '关（改用首字节竞速）'));
}
// 首字节竞速：同时请求所有镜像，最先返回响应头者胜出，再读取其 Blob
async function _raceFirstByteDemo(urls){
  const hasAbort = (typeof AbortController !== 'undefined');
  const controllers = urls.map(() => hasAbort ? new AbortController() : null);
  const t0 = performance.now();
  _log('demo.ogg: 首字节竞速，同时请求 ' + urls.length + ' 个镜像');
  const attempts = urls.map((url, i) => fetch(url, controllers[i] ? { signal: controllers[i].signal } : undefined).then(r => {
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return { r, url, i };
  }));
  let winner;
  try {
    winner = await (typeof Promise.any === 'function' ? Promise.any(attempts) : new Promise((res, rej) => {
      let n = urls.length; const errs = [];
      attempts.forEach((p, i) => p.then(res, e => { errs[i] = e; if(--n === 0) rej({ errors: errs }); }));
    }));
  } catch(agg) {
    const errs = (agg && agg.errors) || [];
    const first = errs.find(e => e);
    throw (first instanceof Error) ? first : new Error('全部镜像请求失败');
  }
  const src = _demoSourceLabel(winner.url);
  controllers.forEach((c, i) => { if(c && i !== winner.i){ try { c.abort(); } catch(e){} } });
  const blob = await winner.r.blob();
  const elapsed = (performance.now() - t0) / 1000;
  _log('demo.ogg: 镜像[' + src + ']首字节领先 ' + (blob.size/1024).toFixed(0) + 'KB，耗时' + elapsed.toFixed(1) + 's', 'ok');
  return { blob, url: winner.url, source: src };
}
async function fetchDemo(){
  _log('demo.ogg: 开始加载...');
  const absUrl = AssetCache._abs('demo.ogg');
  try {
    const cache = await caches.open(AssetCache.cacheName);
    const cached = await cache.match(absUrl, {ignoreSearch: true});
    if (cached) {
      _log('demo.ogg: 命中缓存', 'ok');
      return cached.clone();
    }
  } catch(e) {
    _log('demo.ogg: 缓存API不可用 (' + e.name + ': ' + e.message + ')', 'warn');
  }
  let blob = null;
  try {
    const res = raceFullDownload ? await _raceDownloadDemo(DEMO_URLS) : await _raceFirstByteDemo(DEMO_URLS);
    blob = res.blob;
  } catch(e) {
    _log('demo.ogg: 所有镜像下载失败 (' + e.message + ')', 'err');
  }
  if (!blob) { _log('demo.ogg: 所有源均失败', 'err'); throw new Error('demo.ogg 加载失败'); }
  try {
    const cache = await caches.open(AssetCache.cacheName);
    await cache.put(absUrl, new Response(blob));
    _log('demo.ogg: 已写入缓存', 'ok');
  } catch(e) {
    _log('demo.ogg: 写入缓存失败 (' + e.message + ')', 'warn');
  }
  return new Response(blob);
}

"use strict";
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
const stageWrap = document.getElementById('stageWrap');
const canvasStage = document.getElementById('canvasStage');

const CFG = {
  canvas: { w:1280, h:720, zoom:1, bgType:'solid', bgColor:'#000000',
    gradColor1:'#00ced1', gradColor2:'#000000', gradStops:[0,25,50,75,100],
    gradAngle:360, gradRadius:640, bgImage:'', bgBlur:0, bgDarken:0 },
  elements: [], selectedId: null,
  audio: null, audioCtx: null, analyser: null, freq: null, wave: null,
  playing: false, loop: true, volume: 1, smoothing: 0.8,
  fps: 60, showFps: true, showRes: true,
};
window.__CFG = CFG;

/* ============================================================
   配置持久化（localStorage）
   ============================================================ */
const STORAGE_KEY = 'music-viz-config-v1';
let _panelW = 280;
let _saveTimer = null;
function scheduleSave(){
  if(_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveConfig, 300);
}
function saveConfig(){
  try{
    const data={
      v:1,
      canvas: Object.assign({}, CFG.canvas, {bgImage:''}), // 背景图是 object URL，无法持久化
      elements: CFG.elements.map(e=>({id:e.id, type:e.type, params:e.params})),
      fps: CFG.fps, showFps: CFG.showFps, showRes: CFG.showRes,
      loop: CFG.loop, volume: CFG.volume, smoothing: CFG.smoothing,
      panelW: _panelW,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }catch(e){}
}
function loadConfig(){
  let raw=null;
  try{ raw=localStorage.getItem(STORAGE_KEY); }catch(e){}
  if(!raw) return false;
  try{
    const d=JSON.parse(raw);
    if(!d || typeof d!=='object') return false;
    if(d.canvas) Object.assign(CFG.canvas, d.canvas, {bgImage:''});
    if(Array.isArray(d.elements)) CFG.elements=d.elements;
    if(typeof d.fps==='number' && isFinite(d.fps)) CFG.fps=Math.max(30, Math.min(240, Math.round(d.fps)));
    if(typeof d.showFps==='boolean') CFG.showFps=d.showFps;
    if(typeof d.showRes==='boolean') CFG.showRes=d.showRes;
    if(typeof d.loop==='boolean') CFG.loop=d.loop;
    if(typeof d.volume==='number') CFG.volume=d.volume;
    if(typeof d.smoothing==='number') CFG.smoothing=d.smoothing;
    if(typeof d.panelW==='number'){ _panelW=Math.max(180, Math.min(600, d.panelW)); document.documentElement.style.setProperty('--panel-w', _panelW+'px'); }
    return true;
  }catch(e){ return false; }
}
// 重置所有设置（性能面板底部按钮）：清除持久化并恢复出厂默认
function resetAllSettings(){
  try{ localStorage.removeItem(STORAGE_KEY); }catch(e){}
  Object.assign(CFG.canvas, { w:1280, h:720, zoom:1, bgType:'solid', bgColor:'#000000',
    gradColor1:'#00ced1', gradColor2:'#000000', gradStops:[0,25,50,75,100],
    gradAngle:360, gradRadius:640, bgImage:'', bgBlur:0, bgDarken:0 });
  canvas.width=1280; canvas.height=720;
  CFG.elements=[]; CFG.selectedId=null; _eid=0;
  CFG.fps=60; CFG.showFps=true; CFG.showRes=true;
  CFG.loop=true; CFG.volume=1; CFG.smoothing=0.8;
  _panelW=280; document.documentElement.style.setProperty('--panel-w', '280px');
  if(CFG.audio){ CFG.audio.loop=true; CFG.audio.volume=1; }
  const vs=document.getElementById('volSlider'); if(vs) vs.value=1;
  const lb=document.getElementById('loopBtn'); if(lb){ lb.classList.add('active'); lb.innerHTML=LIST_LOOP_ICON; }
  addElement('bars');
  document.getElementById('propsPanel').classList.remove('mobile-open');
  renderLibrary(); renderProps();
  if(_lastTool==='perf') renderPerf();
  fitCanvas();
  _log('已重置所有设置', 'warn');
}

const PLAY_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const PAUSE_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const LIST_LOOP_ICON='<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11 5.466V4H5a4 4 0 0 0-3.584 5.777a.5.5 0 1 1-.896.446A5 5 0 0 1 5 3h6V1.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384l-2.36 1.966a.25.25 0 0 1-.41-.192m3.81.086a.5.5 0 0 1 .67.225A5 5 0 0 1 11 13H5v1.466a.25.25 0 0 1-.41.192l-2.36-1.966a.25.25 0 0 1 0-.384l2.36-1.966a.25.25 0 0 1 .41.192V12h6a4 4 0 0 0 3.585-5.777a.5.5 0 0 1 .225-.67Z"/></svg>';
const NO_LOOP_ICON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
let _ac = null;
function ensureCtx(){ if(!_ac || _ac.state==='closed') _ac = new (window.AudioContext||window.webkitAudioContext)(); return _ac; }

/* ============================================================
   样式定义
   ============================================================ */
const VISUAL_STYLES = [
  {id:'bars',name:'频谱柱',cat:'visualizer'},{id:'bars-mirror',name:'镜像柱',cat:'visualizer'},
  {id:'bars-3d',name:'3D柱',cat:'visualizer'},{id:'waveform-zigzag',name:'锯齿波',cat:'visualizer'},
  {id:'circle-radial',name:'放射圆',cat:'visualizer'},{id:'circle-wave',name:'圆形波',cat:'visualizer'},
  {id:'circle-pulse',name:'脉冲圆',cat:'visualizer'},{id:'circular-bars',name:'圆形柱',cat:'visualizer'},
  {id:'spectrum-line',name:'频谱线',cat:'visualizer'},{id:'spectrum-area',name:'频谱面积',cat:'visualizer'},
];

function defaultElementParams(type){
  const base = { x:50, y:50, w:80, h:30, opacity:1, rotation:0 };
  // 可视化元素 — 含全部高级参数
  return {...base, w:80, h:60, y:50,
    // 颜色系统:多色数组
    colorMode:'gradient', colors:['#ff0000','#0000ff','#00ff00'],
    // 动画包络(attack/release)
    useEnvelope:true, attack:50, release:300,
    // 音频响应
    gain:1.2, smoothing:0.8, barCount:64, lineWidth:3,
    mirror:false, logScale:true, freqMin:20, freqMax:16000,
    glow:false, glowBlur:12, invert:false, rounded:true,
    innerRadius:25,
  };
}

let _eid = 0;
function addElement(type){
  const el = { id:++_eid, type, params:defaultElementParams(type), _env:null };
  el.params.x = 50;
  el.params.y = 50;
  CFG.elements.push(el);
  CFG.selectedId = el.id;
  scheduleSave();
  renderLibrary(); renderProps();
  // 默认不自动展开属性面板（保持关闭，由用户点「属性」按钮打开）
  return el;
}
function getSelected(){ return CFG.elements.find(e=>e.id===CFG.selectedId); }
function removeElement(id){
  CFG.elements = CFG.elements.filter(e=>e.id!==id);
  if(CFG.selectedId===id) CFG.selectedId = null;
  scheduleSave();
  renderProps();
}
function removeSelectedElement(){
  if(CFG.selectedId) removeElement(CFG.selectedId);
}

/* ============================================================
   颜色工具:多色渐变插值
   ============================================================ */
function hexToRgb(hex){
  hex = hex.replace('#','');
  if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  return { r:parseInt(hex.slice(0,2),16), g:parseInt(hex.slice(2,4),16), b:parseInt(hex.slice(4,6),16) };
}
function rgbToHex(r,g,b){
  return '#'+[r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
}
function lerpColor(c1,c2,t){
  const a=hexToRgb(c1), b=hexToRgb(c2);
  return rgbToHex(a.r+(b.r-a.r)*t, a.g+(b.g-a.g)*t, a.b+(b.b-a.b)*t);
}
// 多色均匀梯度:colors 数组, t in [0,1]
function multiColor(colors, t){
  t = Math.max(0, Math.min(1, t));
  if(!colors || colors.length===0) return '#ff3f58';
  if(colors.length===1) return colors[0];
  const seg = 1/(colors.length-1);
  const idx = Math.min(colors.length-2, Math.floor(t/seg));
  const localT = (t - idx*seg)/seg;
  return lerpColor(colors[idx], colors[idx+1], localT);
}
// 渐变颜色查表：按颜色数组缓存 256 级 LUT，避免逐柱逐帧解析 hex
const _gradCache = new Map();
function gradientLUT(colors){
  const key = colors.join(',');
  let lut = _gradCache.get(key);
  if(lut) return lut;
  lut = new Array(256);
  for(let i=0;i<256;i++) lut[i] = multiColor(colors, i/255);
  if(_gradCache.size >= 32) _gradCache.clear();
  _gradCache.set(key, lut);
  return lut;
}
function elemColor(p, t){
  if(p.colorMode==='solid') return p.colors[0] || '#ff3f58';
  if(p.colorMode==='rainbow'){
    // 基于播放进度而非墙钟时间：暂停时颜色随之冻结
    const clock = CFG.audio ? CFG.audio.currentTime : 0;
    return `hsl(${(t*300 + clock*30)%360},100%,60%)`;
  }
  const lut = gradientLUT(p.colors);
  return lut[Math.max(0, Math.min(255, Math.round(t*255)))];
}

/* ============================================================
   包络跟随器 (peak follower with attack/release)
   cur: 当前包络值, target: 目标值(0-1), dt: 秒
   attackMs/releaseMs: 时间常数
   ============================================================ */
function envStep(cur, target, dt, attackMs, releaseMs){
  const atk = Math.max(0.001, attackMs/1000);
  const rel = Math.max(0.001, releaseMs/1000);
  const k = target > cur ? (1 - Math.exp(-dt/atk)) : (1 - Math.exp(-dt/rel));
  return cur + (target - cur) * k;
}

/* ============================================================
   频率数据获取(带包络跟随 + 频率范围过滤)
   ============================================================ */
function getFreqBars(p, el, n, dt){
  if(!CFG.analyser) return new Array(n).fill(0);
  const f = CFG.freq; // 每帧在 render() 中统一取样一次
  const sr = CFG.audioCtx ? CFG.audioCtx.sampleRate : 44100;
  const nyquist = sr/2;
  const minBin = Math.max(0, Math.floor(p.freqMin/nyquist * f.length));
  const maxBin = Math.min(f.length-1, Math.ceil(p.freqMax/nyquist * f.length));
  const range = Math.max(1, maxBin - minBin);
  // 初始化/调整包络数组
  if(!el._env || el._env.length !== n) el._env = new Array(n).fill(0);
  const out = [];
  for(let i=0;i<n;i++){
    let idx;
    if(p.logScale){ idx = minBin + Math.floor(Math.pow(i/n, 1.5) * range); }
    else { idx = minBin + Math.floor((i/n) * range); }
    idx = Math.min(maxBin, Math.max(minBin, idx));
    const target = Math.min(1, (f[idx]/255) * p.gain);
    if(p.useEnvelope && dt > 0){
      el._env[i] = envStep(el._env[i], target, dt, p.attack, p.release);
      out.push(el._env[i]);
    } else {
      out.push(target);
    }
  }
  return out;
}

/* ============================================================
   10种可视化绘制函数
   ============================================================ */
const DRAW = {};

DRAW['bars'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  const bw = W/p.barCount;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i];
    const bh = v*H; if(bh<0.5) continue;
    ctx.fillStyle = elemColor(p, i/p.barCount);
    const x=i*bw+bw*0.12, y=H-bh;
    if(p.rounded){ const r=Math.min(bw*0.3,bh*0.3);
      ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+bw*0.76-r,y);
      ctx.quadraticCurveTo(x+bw*0.76,y,x+bw*0.76,y+r);
      ctx.lineTo(x+bw*0.76,y+bh-r); ctx.quadraticCurveTo(x+bw*0.76,y+bh,x+bw*0.76-r,y+bh);
      ctx.lineTo(x+r,y+bh); ctx.quadraticCurveTo(x,y+bh,x,y+bh-r);
      ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.fill();
    } else ctx.fillRect(x,y,bw*0.76,bh);
  }
};

DRAW['bars-mirror'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  const bw = W/p.barCount, mid = H/2;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i], bh = v*H*0.48; if(bh<0.5) continue;
    ctx.fillStyle = elemColor(p, i/p.barCount);
    const x=i*bw+bw*0.12;
    ctx.fillRect(x,mid-bh,bw*0.76,bh);
    ctx.fillRect(x,mid,bw*0.76,bh);
  }
  ctx.fillStyle='rgba(255,255,255,0.15)'; ctx.fillRect(0,mid-0.5,W,1);
};

DRAW['bars-3d'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  const bw = W/p.barCount, depth = bw*0.5;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i], bh = v*H*0.85; if(bh<0.5) continue;
    const x=i*bw+bw*0.1, y=H-bh, w=bw*0.7;
    const baseColor = elemColor(p, i/p.barCount);
    ctx.fillStyle = baseColor; ctx.fillRect(x,y,w,bh);
    ctx.fillStyle = lerpColor(baseColor,'#ffffff',0.3);
    ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+depth,y-depth*0.6);
      ctx.lineTo(x+w+depth,y-depth*0.6); ctx.lineTo(x+w,y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = lerpColor(baseColor,'#000000',0.35);
    ctx.beginPath(); ctx.moveTo(x+w,y); ctx.lineTo(x+w+depth,y-depth*0.6);
      ctx.lineTo(x+w+depth,y+bh-depth*0.6); ctx.lineTo(x+w,y+bh); ctx.closePath(); ctx.fill();
  }
};

DRAW['waveform-zigzag'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  ctx.beginPath(); ctx.lineWidth = p.lineWidth;
  const bw = W/p.barCount;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i]*p.gain;
    const x = i*bw, y = H/2 - Math.min(1,v)*H*0.45;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    ctx.lineTo(x+bw, H/2 + Math.min(1,v)*H*0.45);
  }
  ctx.strokeStyle = p.colorMode==='solid'?p.colors[0]:multiColor(p.colors,0.5);
  ctx.stroke();
};

DRAW['circle-radial'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  const cx=W/2, cy=H/2, R=Math.min(W,H)*p.innerRadius/100;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i]*p.gain;
    const ang = (i/p.barCount)*Math.PI*2 - Math.PI/2;
    const len = Math.min(1,v)*Math.min(W,H)*0.35;
    const x1=cx+Math.cos(ang)*R, y1=cy+Math.sin(ang)*R;
    const x2=cx+Math.cos(ang)*(R+len), y2=cy+Math.sin(ang)*(R+len);
    ctx.strokeStyle = elemColor(p, i/p.barCount);
    ctx.lineWidth = Math.max(1, (Math.PI*2*R/p.barCount)*0.6);
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  }
};

DRAW['circle-wave'] = function(ctx,p,W,H,el,dt){
  if(!CFG.analyser) return;
  const w = CFG.wave; // 每帧在 render() 中统一取样一次
  const cx=W/2, cy=H/2, R=Math.min(W,H)*0.35;
  ctx.beginPath();
  const n = 180;
  for(let i=0;i<=n;i++){
    const idx = Math.floor((i/n)*w.length);
    const v = (w[idx]-128)/128*p.gain;
    const ang = (i/n)*Math.PI*2;
    const r = R + v*R*0.4;
    const x = cx+Math.cos(ang)*r, y = cy+Math.sin(ang)*r;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.closePath();
  ctx.strokeStyle = p.colorMode==='solid'?p.colors[0]:multiColor(p.colors,0.5);
  ctx.lineWidth = p.lineWidth;
  if(p.glow){ctx.shadowColor=p.colors[0];ctx.shadowBlur=p.glowBlur;}
  ctx.stroke(); ctx.shadowBlur=0;
};

DRAW['circle-pulse'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  let avg=0; bars.forEach(v=>avg+=v); avg/=bars.length;
  const cx=W/2, cy=H/2, baseR=Math.min(W,H)*0.2;
  for(let ring=0;ring<3;ring++){
    const r = baseR + ring*baseR*0.5 + avg*baseR*0.3*(1-ring*0.2);
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle = elemColor(p, ring/3);
    ctx.lineWidth = p.lineWidth*(1-ring*0.2);
    ctx.globalAlpha = 1-ring*0.3; ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.beginPath(); ctx.arc(cx,cy,baseR*0.4+avg*baseR*0.2,0,Math.PI*2);
  ctx.fillStyle = elemColor(p,0.5); ctx.fill();
};

DRAW['circular-bars'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  const cx=W/2, cy=H/2;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i]*p.gain;
    const ang = (i/p.barCount)*Math.PI*2 - Math.PI/2;
    const len = Math.min(1,v)*Math.min(W,H)*0.42;
    ctx.strokeStyle = elemColor(p, i/p.barCount);
    ctx.lineWidth = Math.max(2, (Math.PI*2*Math.min(W,H)*0.15/p.barCount)*0.7);
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(ang)*8, cy+Math.sin(ang)*8);
    ctx.lineTo(cx+Math.cos(ang)*(8+len), cy+Math.sin(ang)*(8+len));
    ctx.stroke();
  }
};

DRAW['spectrum-line'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  ctx.beginPath(); ctx.lineWidth = p.lineWidth;
  for(let i=0;i<p.barCount;i++){
    const v = bars[i]*p.gain;
    const x = (i/p.barCount)*W, y = H - Math.min(1,v)*H*0.9;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.strokeStyle = p.colorMode==='solid'?p.colors[0]:multiColor(p.colors,0.5);
  if(p.glow){ctx.shadowColor=p.colors[0];ctx.shadowBlur=p.glowBlur;}
  ctx.stroke(); ctx.shadowBlur=0;
};

DRAW['spectrum-area'] = function(ctx,p,W,H,el,dt){
  const bars = getFreqBars(p,el,p.barCount,dt);
  ctx.beginPath(); ctx.moveTo(0,H);
  for(let i=0;i<p.barCount;i++){
    const v = bars[i]*p.gain;
    const x = (i/p.barCount)*W, y = H - Math.min(1,v)*H*0.9;
    ctx.lineTo(x,y);
  }
  ctx.lineTo(W,H); ctx.closePath();
  const grad = ctx.createLinearGradient(0,0,0,H);
  grad.addColorStop(0, p.colors[0]);
  grad.addColorStop(1, (p.colors[1]||p.colors[0])+'00');
  ctx.fillStyle = p.colorMode==='solid'?p.colors[0]+'88':grad;
  ctx.fill();
};

/* ============================================================
   背景
   ============================================================ */
let _bgImg = null;
function drawBackground(cfg){
  const c = cfg.canvas;
  ctx.save();
  if(c.bgType==='solid'){ ctx.fillStyle=c.bgColor; ctx.fillRect(0,0,canvas.width,canvas.height); }
  else if(c.bgType==='gradient-linear'||c.bgType==='gradient-radial'){
    let grad;
    if(c.bgType==='gradient-linear'){
      const rad=c.gradAngle*Math.PI/180;
      grad=ctx.createLinearGradient(canvas.width/2-Math.cos(rad)*canvas.width/2, canvas.height/2-Math.sin(rad)*canvas.height/2,
        canvas.width/2+Math.cos(rad)*canvas.width/2, canvas.height/2+Math.sin(rad)*canvas.height/2);
    } else {
      const r=c.gradRadius;
      grad=ctx.createRadialGradient(canvas.width/2,canvas.height/2,0,canvas.width/2,canvas.height/2,r);
    }
    for(let i=0;i<c.gradStops.length;i++){
      const t=i/(c.gradStops.length-1);
      const color=i===0?c.gradColor1:i===c.gradStops.length-1?c.gradColor2:lerpColor(c.gradColor1,c.gradColor2,t);
      grad.addColorStop(c.gradStops[i]/100,color);
    }
    ctx.fillStyle=grad; ctx.fillRect(0,0,canvas.width,canvas.height);
  } else if(c.bgType==='image' && c.bgImage){
    const img=_bgImg;
    if(img&&img.complete){
      if(c.bgBlur>0){ ctx.filter=`blur(${c.bgBlur}px)`; ctx.drawImage(img,0,0,canvas.width,canvas.height); ctx.filter='none'; }
      else { ctx.drawImage(img,0,0,canvas.width,canvas.height); }
      if(c.bgDarken>0){ ctx.fillStyle=`rgba(0,0,0,${c.bgDarken})`; ctx.fillRect(0,0,canvas.width,canvas.height); }
    } else { ctx.fillStyle=c.bgColor; ctx.fillRect(0,0,canvas.width,canvas.height); }
  }
  ctx.restore();
}

/* ============================================================
   主渲染循环 (含 dt 计算 + 低音缩放)
   ============================================================ */
let _lastFrameTime = 0;
let _lastDraw = 0;
// 实时渲染帧率（每 500ms 统计一次实际绘制帧数）
let _fpsFrames = 0, _fpsWindowStart = 0, _fpsValue = 0;
function _updateFps(now){
  _fpsFrames++;
  if(!_fpsWindowStart) _fpsWindowStart = now;
  const elapsed = now - _fpsWindowStart;
  if(elapsed >= 500){
    _fpsValue = Math.round(_fpsFrames * 1000 / elapsed);
    _fpsFrames = 0; _fpsWindowStart = now;
  }
}
function _drawFps(){
  const lines = [];
  if(CFG.showFps) lines.push(_fpsValue + ' FPS');
  if(CFG.showRes) lines.push(canvas.width + '×' + canvas.height);
  if(!lines.length) return;
  const fs = Math.max(10, Math.round(canvas.height * 0.035));
  const pad = Math.round(fs * 0.4);
  const x = Math.round(fs * 0.6), y = Math.round(fs * 0.6);
  const lh = Math.round(fs * 1.35);
  ctx.save();
  ctx.font = '600 ' + fs + 'px ui-monospace,Menlo,Consolas,monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  let maxW = 0;
  for(const t of lines){ maxW = Math.max(maxW, ctx.measureText(t).width); }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - pad, y - pad, maxW + pad * 2, lh * lines.length + pad * 2 - (lh - fs));
  const colors = ['#39d353','#e6edf3'];
  lines.forEach((t,i)=>{ ctx.fillStyle = colors[i] || '#e6edf3'; ctx.fillText(t, x, y + i * lh); });
  ctx.restore();
}
function render(){
  requestAnimationFrame(render);
  const now = performance.now();
  // 按目标帧率节流（受浏览器刷新率上限约束）
  const interval = 1000 / (CFG.fps || 60);
  if(now - _lastDraw < interval - 0.5) return;
  _lastDraw = now;
  _updateFps(now);
  const dt = _lastFrameTime ? Math.min(0.1, (now-_lastFrameTime)/1000) : 0.016;
  _lastFrameTime = now;

  drawBackground(CFG);
  // 每帧只取样一次频谱/时域，供所有元素复用
  if(CFG.analyser){
    CFG.analyser.getByteFrequencyData(CFG.freq);
    CFG.analyser.getByteTimeDomainData(CFG.wave);
  }
  // 只对频谱元素应用缩放，画板和背景保持不变
  ctx.save();
  const sorted = [...CFG.elements].sort((a,b)=>a.params.y - b.params.y);
  for(const el of sorted){
    const p = el.params;
    const ew = canvas.width*p.w/100, eh = canvas.height*p.h/100;
    const ex = canvas.width*p.x/100 - ew/2, ey = canvas.height*p.y/100 - eh/2;
    ctx.save();
    ctx.globalAlpha = p.opacity;
    const cx = ex+ew/2, cy = ey+eh/2;
    ctx.translate(cx, cy);
    // 镜像/翻转在元素中心处生效，对所有效果通用
    if(p.mirror) ctx.scale(-1, 1);
    if(p.invert) ctx.scale(1, -1);
    if(p.rotation) ctx.rotate(p.rotation*Math.PI/180);
    ctx.translate(-ew/2, -eh/2);
    const fn = DRAW[el.type];
    if(fn) fn(ctx, p, ew, eh, el, dt);
    ctx.restore();
  }
  // 选中框（与元素同一坐标系）
  const sel = getSelected();
  if(sel){
    const p = sel.params;
    const ew = canvas.width*p.w/100, eh = canvas.height*p.h/100;
    const ex = canvas.width*p.x/100-ew/2, ey = canvas.height*p.y/100-eh/2;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(88,166,255,0.95)';
    ctx.strokeRect(ex, ey, ew, eh);
    ctx.setLineDash([]);
    const hs = 6;
    ctx.fillStyle = 'rgba(88,166,255,0.95)';
    [[ex,ey],[ex+ew,ey],[ex,ey+eh],[ex+ew,ey+eh]].forEach(([hx,hy])=>ctx.fillRect(hx-hs/2,hy-hs/2,hs,hs));
    ctx.restore();
  }
  ctx.restore();
  if(CFG.showFps||CFG.showRes) _drawFps();
  updateSeekUI();
}

/* ============================================================
   音频
   ============================================================ */
function loadAudio(file){
  if(!file) { _log('loadAudio: file为空', 'err'); return; }
  _log('loadAudio: 加载 ' + file.name + ' (' + (file.size/1024).toFixed(0) + 'KB)');
  if(CFG.audio){ CFG.audio.pause(); CFG.audio.src=''; }
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  audio.crossOrigin = 'anonymous';
  audio.loop=CFG.loop; audio.volume=CFG.volume;
  try {
    const ac = ensureCtx();
    if(ac.state==='suspended') { ac.resume(); _log('AudioContext已恢复'); }
    const src = ac.createMediaElementSource(audio);
    const analyser = ac.createAnalyser();
    analyser.fftSize=2048;
    analyser.smoothingTimeConstant=CFG.smoothing;
    src.connect(analyser); analyser.connect(ac.destination);
    CFG.audio=audio; CFG.audioCtx=ac; CFG.analyser=analyser;
    CFG.freq=new Uint8Array(analyser.frequencyBinCount);
    CFG.wave=new Uint8Array(analyser.fftSize);
  } catch(e) {
    _log('AudioContext/Analyser创建失败: ' + e.message, 'err');
    return;
  }
  document.getElementById('uploadText').textContent=file.name;
  document.getElementById('uploadZone').classList.add('has-audio');
  document.getElementById('uploadHint').style.display='flex';
  document.getElementById('playBtn').disabled=false;
  audio.addEventListener('loadedmetadata', ()=>{ _log('音频metadata已加载, 时长=' + audio.duration.toFixed(1) + 's', 'ok'); updateTimeDisplay(); });
  audio.addEventListener('timeupdate', ()=>updateTimeDisplay());
  audio.addEventListener('error', (e)=>{ _log('音频error事件: code=' + audio.error?.code + ' msg=' + audio.error?.message, 'err'); });
  _log('尝试自动播放...');
  audio.play().then(()=>{
    CFG.playing=true;
    document.getElementById('playBtn').innerHTML=PAUSE_ICON;
    _log('自动播放成功', 'ok');
  }).catch((e)=>{
    _log('自动播放被阻止: ' + e.name + ' - ' + e.message + ' (需用户点击播放按钮)', 'warn');
  });
}
async function togglePlay(){
  if(!CFG.audio) return;
  const ac = ensureCtx();
  if(ac.state==='suspended'){ try{ await ac.resume(); }catch(e){ console.error('resume failed',e); } }
  if(CFG.audio.paused){
    try{ await CFG.audio.play(); }catch(e){ console.error('play failed',e); return; }
    document.getElementById('playBtn').innerHTML=PAUSE_ICON; CFG.playing=true;
  } else {
    CFG.audio.pause();
    document.getElementById('playBtn').innerHTML=PLAY_ICON; CFG.playing=false;
  }
}
function fmtTime(s){ if(!isFinite(s))return'00:00'; const m=Math.floor(s/60),ss=Math.floor(s%60); return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`; }
function updateTimeDisplay(){
  const a=CFG.audio;
  document.getElementById('timeDisplay').textContent=`${fmtTime(a?a.currentTime:0)} / ${fmtTime(a?a.duration:0)}`;
}
let _lastSeekUI = 0;
function updateSeekUI(){
  const a=CFG.audio;
  if(!a||!a.duration) return;
  const now=performance.now();
  if(now-_lastSeekUI<100) return; // 100ms 节流，避免每帧写 DOM
  _lastSeekUI=now;
  document.getElementById('seekFill').style.width=(a.currentTime/a.duration*100)+'%';
}

/* ============================================================
   元素库渲染
   ============================================================ */
function renderLibrary(){
  const body=document.getElementById('libBody');
  const tool=document.querySelector('.ibtn.active')?.dataset.tool||'elements';
  let items=[];
  if(tool==='elements') items=[...VISUAL_STYLES];
  const cats={};
  items.forEach(i=>{ if(!cats[i.cat])cats[i.cat]=[]; cats[i.cat].push(i); });
  const catNames={visualizer:'音频可视化'};
  let html='';
  for(const [cat,list] of Object.entries(cats)){
    html+=`<div class="lib-cat"><div class="lib-cat-title"><span>${catNames[cat]||cat}</span><span class="count">${list.length}</span></div><div class="lib-grid">`;
    for(const item of list){
      html+=`<div class="lib-item" data-type="${item.id}" title="${item.name}">${thumbSVG(item.id)}<div class="label">${item.name}</div></div>`;
    }
    html+=`</div></div>`;
  }
  if(tool==='background'){
    html = `<div style="padding:14px"><div class="lib-cat-title"><span>画布背景</span></div>
      <div class="field"><label>背景类型</label><div class="seg" id="bgTypeSeg">
        <button data-v="solid" class="${CFG.canvas.bgType==='solid'?'active':''}">纯色</button>
        <button data-v="gradient-linear" class="${CFG.canvas.bgType==='gradient-linear'?'active':''}">线性渐变</button>
        <button data-v="gradient-radial" class="${CFG.canvas.bgType==='gradient-radial'?'active':''}">径向渐变</button>
        <button data-v="image" class="${CFG.canvas.bgType==='image'?'active':''}">图片</button>
      </div></div>
      <div class="field" id="bgSolidField"><label>背景颜色</label><div class="color-row"><input type="color" id="bgColor" value="${CFG.canvas.bgColor}"><span style="font-size:11px;color:var(--muted)">${CFG.canvas.bgColor}</span></div></div>
      <div class="field" id="bgGradField" style="display:${CFG.canvas.bgType.startsWith('gradient')?'block':'none'}">
        <label>起始颜色</label><div class="color-row" style="margin-bottom:6px"><input type="color" id="gradColor1" value="${CFG.canvas.gradColor1}"><span style="font-size:11px;color:var(--muted)">${CFG.canvas.gradColor1}</span></div>
        <label>结束颜色</label><div class="color-row" style="margin-bottom:8px"><input type="color" id="gradColor2" value="${CFG.canvas.gradColor2}"><span style="font-size:11px;color:var(--muted)">${CFG.canvas.gradColor2}</span></div>
        <label>渐变分布</label>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
          <span style="font-size:10px;color:var(--muted);width:25px">0%</span>
          <span style="font-size:10px;color:var(--muted);width:25px;text-align:center">25%</span>
          <span style="font-size:10px;color:var(--muted);width:25px;text-align:center">50%</span>
          <span style="font-size:10px;color:var(--muted);width:25px;text-align:center">75%</span>
          <span style="font-size:10px;color:var(--muted);width:25px;text-align:right">100%</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${CFG.canvas.gradStops.map((s,i)=>i===0||i===4?'':`
            <div style="display:flex;align-items:center;gap:4px">
              <span style="font-size:10px;color:var(--muted);width:25px">${[25,50,75][i-1]}%</span>
              <input type="range" data-grad-stop="${i}" min="0" max="100" value="${s}" style="flex:1">
              <span style="font-size:10px;color:var(--muted);width:25px;text-align:right">${s}%</span>
            </div>
          `).join('')}
        </div>
        ${CFG.canvas.bgType==='gradient-linear'?`<label style="margin-top:8px">渐变角度</label><div class="range-row"><input type="range" id="gradAngle" min="0" max="360" value="${CFG.canvas.gradAngle}"><span class="val" id="gradAngleVal">${CFG.canvas.gradAngle}°</span></div>`:''}
        ${CFG.canvas.bgType==='gradient-radial'?`<label style="margin-top:8px">渐变半径</label><div class="range-row"><input type="range" id="gradRadius" min="100" max="1000" value="${CFG.canvas.gradRadius}"><span class="val" id="gradRadiusVal">${CFG.canvas.gradRadius}px</span></div>`:''}
      </div>
      <div class="field" id="bgImgField" style="display:${CFG.canvas.bgType==='image'?'block':'none'}">
        <label>背景图片</label><button onclick="document.getElementById('bgImgInput').click()" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:8px;border-radius:5px;cursor:pointer;font-size:12px">选择图片</button>
        <input type="file" id="bgImgInput" accept="image/*" style="display:none">
        <label style="margin-top:8px">模糊</label><div class="range-row"><input type="range" id="bgBlur" min="0" max="20" value="${CFG.canvas.bgBlur}"><span class="val" id="bgBlurVal">${CFG.canvas.bgBlur}</span></div>
        <label>暗化</label><div class="range-row"><input type="range" id="bgDarken" min="0" max="1" step="0.05" value="${CFG.canvas.bgDarken}"><span class="val" id="bgDarkenVal">${Math.round(CFG.canvas.bgDarken*100)}%</span></div>
      </div></div>`;
  }
  body.innerHTML=html;
  body.querySelectorAll('.lib-item').forEach(el=>el.addEventListener('click',()=>addElement(el.dataset.type)));
  const seg=document.getElementById('bgTypeSeg');
  if(seg) seg.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{CFG.canvas.bgType=b.dataset.v;scheduleSave();renderLibrary();}));
  const bc=document.getElementById('bgColor'); if(bc)bc.addEventListener('input',e=>{CFG.canvas.bgColor=e.target.value;scheduleSave();});
  const g1=document.getElementById('gradColor1'); if(g1)g1.addEventListener('input',e=>{CFG.canvas.gradColor1=e.target.value;scheduleSave();});
  const g2=document.getElementById('gradColor2'); if(g2)g2.addEventListener('input',e=>{CFG.canvas.gradColor2=e.target.value;scheduleSave();});
  body.querySelectorAll('[data-grad-stop]').forEach(inp=>inp.addEventListener('input',e=>{
    const idx=+e.target.dataset.gradStop;
    CFG.canvas.gradStops[idx]=+e.target.value;
    e.target.nextElementSibling.textContent=e.target.value+'%';
    scheduleSave();
  }));
  const ga=document.getElementById('gradAngle'); if(ga)ga.addEventListener('input',e=>{CFG.canvas.gradAngle=+e.target.value;document.getElementById('gradAngleVal').textContent=e.target.value+'°';scheduleSave();});
  const gr=document.getElementById('gradRadius'); if(gr)gr.addEventListener('input',e=>{CFG.canvas.gradRadius=+e.target.value;document.getElementById('gradRadiusVal').textContent=e.target.value+'px';scheduleSave();});
  const bl=document.getElementById('bgBlur'); if(bl)bl.addEventListener('input',e=>{CFG.canvas.bgBlur=+e.target.value;document.getElementById('bgBlurVal').textContent=e.target.value;scheduleSave();});
  const bd=document.getElementById('bgDarken'); if(bd)bd.addEventListener('input',e=>{CFG.canvas.bgDarken=+e.target.value;document.getElementById('bgDarkenVal').textContent=Math.round(e.target.value*100)+'%';scheduleSave();});
  const bi=document.getElementById('bgImgInput'); if(bi)bi.addEventListener('change',e=>loadBgImage(e.target.files[0]));
}
function loadBgImage(file){
  if(!file) return;
  const url=URL.createObjectURL(file);
  _bgImg=new Image(); _bgImg.src=url;
  CFG.canvas.bgImage=url; CFG.canvas.bgType='image';
  renderLibrary();
}

function thumbSVG(id){
  const c1='#ff3f58', c2='#c822ff';
  const defs=`<defs><linearGradient id="tg${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>`;
  if(id.includes('bars')){
    let bars='';
    for(let i=0;i<8;i++){ const h=20+((i*7)%40); bars+=`<rect x="${5+i*11}" y="${65-h}" width="7" height="${h}" rx="2" fill="url(#tg${id})"/>`; }
    return `<svg viewBox="0 0 100 70">${defs}${bars}</svg>`;
  }
  if(id.includes('wave')||id==='spectrum-line'||id==='spectrum-area'){
    return `<svg viewBox="0 0 100 70">${defs}<path d="M5,35 Q15,10 25,35 T45,35 T65,35 T85,35 T95,35" stroke="url(#tg${id})" fill="none" stroke-width="2.5"/></svg>`;
  }
  if(id.includes('circle')||id==='circular-bars'){
    return `<svg viewBox="0 0 100 70">${defs}<circle cx="50" cy="35" r="18" stroke="url(#tg${id})" fill="none" stroke-width="2"/><circle cx="50" cy="35" r="26" stroke="url(#tg${id})" fill="none" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`;
  }
  return `<svg viewBox="0 0 100 70">${defs}<rect x="20" y="20" width="60" height="30" rx="4" stroke="url(#tg${id})" fill="none" stroke-width="2"/></svg>`;
}

/* ============================================================
   属性面板渲染 (含全部高级参数 UI)
   ============================================================ */
function renderProps(){
  const body=document.getElementById('propsBody');
  const sel=getSelected();
  const title=document.getElementById('propsTitle');
  const propsPanel=document.getElementById('propsPanel');
  const delBtn=document.getElementById('propsDelBtn');
  if(!sel){
    title.textContent='属性';
    body.innerHTML=`<div class="empty-props"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg><div>从左侧选择或添加元素<br>点击画布上的元素编辑属性</div></div>`;
    propsPanel.classList.remove('mobile-open');
    if(delBtn) delBtn.style.display='none';
    _syncBackdrop();
    return;
  }
  propsPanel.classList.add('mobile-open');
  // 属性面板与左侧元素面板/性能面板互斥
  document.getElementById('library')?.classList.remove('mobile-open');
  document.getElementById('perfPanel')?.classList.remove('open','mobile-open');
  _syncBackdrop();
  if(delBtn) delBtn.style.display='flex';
  const p=sel.params;
  const isVis=VISUAL_STYLES.some(s=>s.id===sel.type);
  const styleName=VISUAL_STYLES.find(s=>s.id===sel.type)?.name||sel.type;
  title.textContent=styleName;

  let html='';

  if(isVis){
    // 动画包络（最前）
    html+=collapsible('动画包络', true, `
      ${toggleField('启用包络跟随','useEnvelope',p.useEnvelope)}
      <div class="field" style="display:${p.useEnvelope?'block':'none'}">
        <label>上升时间 (Attack) — 激发到峰值的速度</label>
        <div class="range-row"><input type="range" data-field="attack" min="1" max="1000" value="${p.attack}"><span class="val">${p.attack}ms</span></div>
      </div>
      <div class="field" style="display:${p.useEnvelope?'block':'none'}">
        <label>下降时间 (Release) — 静止到最低的速度</label>
        <div class="range-row"><input type="range" data-field="release" min="10" max="2000" value="${p.release}"><span class="val">${p.release}ms</span></div>
      </div>
      ${rangeField('平滑度(Analyser)','smoothing',p.smoothing,0,0.98,0.01,'')}
    `);
    // 音频响应（第二）
    html+=collapsible('音频响应', true, `
      ${rangeField('灵敏度(增益)','gain',p.gain,0.1,5,0.05,'x')}
      ${rangeField('柱数/密度','barCount',p.barCount,8,256,1,'')}
      ${rangeField('线宽','lineWidth',p.lineWidth,1,12,0.5,'px')}
      ${dualRangeField('频率范围','freqMin','freqMax',p.freqMin,p.freqMax,20,20000,'Hz')}
      ${toggleField('对数频率映射','logScale',p.logScale)}
      ${toggleField('镜像','mirror',p.mirror)}
      ${toggleField('垂直翻转','invert',p.invert)}
      ${toggleField('圆角柱','rounded',p.rounded)}
      ${toggleField('发光效果','glow',p.glow)}
      <div class="field" style="display:${p.glow?'block':'none'}">${rangeField('发光强度','glowBlur',p.glowBlur,1,40,1,'px')}</div>
    `);
  }

  // 变换
  html+=collapsible('变换', true, `
    ${rangeField('位置 X','x',p.x,0,100,0.1,'%')}
    ${rangeField('位置 Y','y',p.y,0,100,0.1,'%')}
    ${rangeField('宽度','w',p.w,5,100,0.5,'%')}
    ${rangeField('高度','h',p.h,2,100,0.5,'%')}
    ${rangeField('旋转','rotation',p.rotation,-180,180,1,'°')}
    ${rangeField('不透明度','opacity',p.opacity,0,1,0.01,'')}
  `);

  if(isVis){
    // 颜色系统:多色渐变编辑器
    html+=collapsible('颜色', true, colorEditorHTML(p));
    // 圆形特有
    if(sel.type.includes('circle')||sel.type==='circular-bars'){
      html+=collapsible('圆形参数', false, `${rangeField('内圈半径','innerRadius',p.innerRadius,5,60,1,'%')}`);
    }
  }



  body.innerHTML=html;
  bindPropsFields(sel);
  body.querySelectorAll('.c-head').forEach(h=>h.addEventListener('click',()=>h.parentElement.classList.toggle('open')));
}

/* ============================================================
   性能面板：分辨率 / 帧率
   ============================================================ */
const RES_PRESETS = [
  {label:'360p', w:640, h:360},
  {label:'480p', w:854, h:480},
  {label:'720p', w:1280, h:720},
  {label:'1080p', w:1920, h:1080},
  {label:'2K', w:2560, h:1440},
  {label:'4K', w:3840, h:2160},
];
const FPS_PRESETS = [30,60,90,120,144,240];
const RES_MIN = 100, RES_MAX_W = 4320, RES_MAX_H = 2160;
const FPS_MIN = 30, FPS_MAX = 240;
let _maxFps = 60;
// 采样 requestAnimationFrame 间隔估算浏览器最大帧率。
// 不做「常见刷新率」归一，保留 165/185/240 等非标值；取最快 25% 间隔的均值，
// 避开页面初始化卡顿导致的低估。
function _detectMaxFps(cb){
  const times=[]; const warmup=5, samples=45;
  function tick(t){
    times.push(t);
    if(times.length < warmup+samples){ requestAnimationFrame(tick); return; }
    const deltas=[];
    for(let i=1;i<times.length;i++){ const d=times[i]-times[i-1]; if(d>0) deltas.push(d); }
    deltas.sort((a,b)=>a-b);
    const k=Math.max(1, Math.floor(deltas.length*0.25));
    const fast=deltas.slice(0,k);
    const avg=fast.reduce((s,x)=>s+x,0)/fast.length;
    const fps=avg>0?1000/avg:60;
    _maxFps=Math.max(FPS_MIN, Math.min(FPS_MAX, Math.round(fps)));
    if(cb) cb();
  }
  requestAnimationFrame(tick);
}
function renderPerf(){
  const body=document.getElementById('perfBody');
  if(!body) return;
  const w=CFG.canvas.w, h=CFG.canvas.h, fps=CFG.fps;
  body.innerHTML=`
    <div class="field">
      <label>分辨率（宽 × 高）</label>
      <div class="range-row" style="gap:6px">
        <input type="number" id="perfW" min="${RES_MIN}" max="${RES_MAX_W}" step="1" value="${w}" style="width:100%">
        <span style="color:var(--muted)">×</span>
        <input type="number" id="perfH" min="${RES_MIN}" max="${RES_MAX_H}" step="1" value="${h}" style="width:100%">
      </div>
      <div class="perf-presets" id="perfResPresets">
        ${RES_PRESETS.map(p=>`<button type="button" data-w="${p.w}" data-h="${p.h}">${p.label}</button>`).join('')}
      </div>
      <div class="perf-hint">范围 ${RES_MIN}×${RES_MIN} ~ ${RES_MAX_W}×${RES_MAX_H}</div>
    </div>
    <div class="field">
      <label>帧率（FPS）</label>
      <div class="range-row">
        <input type="number" id="perfFps" min="${FPS_MIN}" max="${FPS_MAX}" step="1" value="${fps}" style="width:100%">
        <span class="val" id="perfFpsMax">上限 ${_maxFps}</span>
      </div>
      <div class="perf-presets" id="perfFpsPresets">
        ${FPS_PRESETS.map(f=>`<button type="button" data-fps="${f}">${f}</button>`).join('')}
      </div>
      <div class="perf-hint">范围 ${FPS_MIN} ~ ${FPS_MAX}；超过浏览器上限 ${_maxFps} 自动取上限</div>
    </div>
    <div class="field"><div class="toggle-row"><label style="margin-bottom:0">显示帧率</label><div class="toggle ${CFG.showFps?'on':''}" data-field="showFps"></div></div></div>
    <div class="field"><div class="toggle-row"><label style="margin-bottom:0">显示分辨率</label><div class="toggle ${CFG.showRes?'on':''}" data-field="showRes"></div></div></div>
    <div class="perf-err" id="perfErr"></div>
    <button type="button" class="perf-reset" id="perfResetBtn">重置所有设置</button>
  `;
  bindPerfFields();
  // 打开面板时重新检测浏览器最大帧率（用户此刻在前台，采样更准）
  _detectMaxFps(()=>{
    const el=document.getElementById('perfFpsMax');
    if(el) el.textContent='上限 '+_maxFps;
  });
}
function bindPerfFields(){
  const body=document.getElementById('perfBody');
  const wEl=document.getElementById('perfW');
  const hEl=document.getElementById('perfH');
  const fEl=document.getElementById('perfFps');
  const err=document.getElementById('perfErr');
  function showErr(msg){ if(err){ err.textContent=msg||''; err.style.display=msg?'block':'none'; } }
  function applyRes(){
    const w=parseInt(wEl.value,10), h=parseInt(hEl.value,10);
    if(!Number.isFinite(w)||!Number.isFinite(h)){ showErr('分辨率必须为数字'); return; }
    if(w<RES_MIN||w>RES_MAX_W||h<RES_MIN||h>RES_MAX_H){ showErr(`分辨率超出范围（${RES_MIN}×${RES_MIN} ~ ${RES_MAX_W}×${RES_MAX_H}）`); return; }
    showErr('');
    setResolution(w,h);
  }
  function applyFps(){
    let f=parseInt(fEl.value,10);
    if(!Number.isFinite(f)){ showErr('帧率必须为数字'); return; }
    if(f<FPS_MIN||f>FPS_MAX){ showErr(`帧率超出范围（${FPS_MIN} ~ ${FPS_MAX}）`); return; }
    showErr('');
    if(f>_maxFps){ f=_maxFps; fEl.value=f; _log('帧率超过浏览器上限，自动取上限 '+_maxFps+'fps','warn'); }
    CFG.fps=f;
    scheduleSave();
    _log('目标帧率设为 '+f+'fps','ok');
  }
  if(wEl) wEl.addEventListener('change',applyRes);
  if(hEl) hEl.addEventListener('change',applyRes);
  if(fEl) fEl.addEventListener('change',applyFps);
  body.querySelectorAll('#perfResPresets button').forEach(b=>b.addEventListener('click',()=>{ wEl.value=b.dataset.w; hEl.value=b.dataset.h; applyRes(); }));
  body.querySelectorAll('#perfFpsPresets button').forEach(b=>b.addEventListener('click',()=>{ fEl.value=b.dataset.fps; applyFps(); }));
  body.querySelectorAll('[data-field="showFps"],[data-field="showRes"]').forEach(t=>{
    t.addEventListener('click',()=>{ const f=t.dataset.field; CFG[f]=!CFG[f]; t.classList.toggle('on',CFG[f]); scheduleSave(); });
  });
  const rb=document.getElementById('perfResetBtn');
  if(rb) rb.addEventListener('click',()=>{ if(typeof confirm!=='function' || confirm('确定重置所有设置吗？')) resetAllSettings(); });
}

/* 多色渐变编辑器 HTML */
function colorEditorHTML(p){
  let items = '';
  p.colors.forEach((c,i)=>{
    items += `<div class="color-list-item">
      <input type="color" data-color-idx="${i}" value="${c}" data-field="color_${i}">
      <span class="color-hex">${c}</span>
      <button class="arrow-btn" data-color-up="${i}" title="上移" ${i===0?'disabled style="opacity:0.3"':''}>▲</button>
      <button class="arrow-btn" data-color-down="${i}" title="下移" ${i===p.colors.length-1?'disabled style="opacity:0.3"':''}>▼</button>
      <button class="del-btn" data-color-del="${i}" title="删除" ${p.colors.length<=1?'disabled style="opacity:0.3"':''}>✕</button>
    </div>`;
  });
  const previewStyle = p.colors.length>1
    ? `background:linear-gradient(90deg, ${p.colors.join(', ')})`
    : `background:${p.colors[0]}`;
  return `
    <div class="field"><label>颜色模式</label><div class="seg" data-field="colorMode">
      <button data-v="solid" class="${p.colorMode==='solid'?'active':''}">纯色</button>
      <button data-v="gradient" class="${p.colorMode==='gradient'?'active':''}">渐变</button>
      <button data-v="rainbow" class="${p.colorMode==='rainbow'?'active':''}">彩虹</button>
    </div></div>
    <div class="field" style="display:${p.colorMode==='gradient'?'block':'none'}">
      <label>渐变颜色(可添加/排序/删除)</label>
      <div class="color-preview" style="${previewStyle}"></div>
      <div class="color-list">${items}</div>
      <button class="color-add-btn" id="colorAddBtn">+ 添加颜色</button>
    </div>
    <div class="field" style="display:${p.colorMode==='solid'?'block':'none'}">
      <label>颜色</label><div class="color-row"><input type="color" data-field="solidColor" value="${p.colors[0]}"><span style="font-size:11px;color:var(--muted)">${p.colors[0]}</span></div>
    </div>
  `;
}

/* 双端点频率滑条 HTML */
function dualRangeField(label, minField, maxField, minVal, maxVal, absMin, absMax, unit){
  return `<div class="field">
    <label>${label}</label>
    <div class="dual-range" data-dual-min="${minField}" data-dual-max="${maxField}" data-abs-min="${absMin}" data-abs-max="${absMax}">
      <div class="track"></div>
      <div class="track-fill" style="left:${(minVal-absMin)/(absMax-absMin)*100}%;right:${100-(maxVal-absMin)/(absMax-absMin)*100}%"></div>
      <input type="range" class="zindex-min" min="${absMin}" max="${absMax}" value="${minVal}" data-field="${minField}">
      <input type="range" class="zindex-max" min="${absMin}" max="${absMax}" value="${maxVal}" data-field="${maxField}">
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:2px">
      <span>${minVal}${unit}</span><span>${maxVal}${unit}</span>
    </div>
  </div>`;
}

function collapsible(title, open, content){
  return `<div class="collapsible ${open?'open':''}"><div class="c-head"><span>${title}</span><span class="arrow">▶</span></div><div class="c-body">${content}</div></div>`;
}
function rangeField(label, field, val, min, max, step, suffix){
  return `<div class="field"><label>${label}</label><div class="range-row"><input type="range" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${val}"><span class="val">${Number(val).toFixed(step<1?2:0)}${suffix}</span></div></div>`;
}
function toggleField(label, field, val){
  return `<div class="field"><div class="toggle-row"><label style="margin-bottom:0">${label}</label><div class="toggle ${val?'on':''}" data-field="${field}"></div></div></div>`;
}

/* 属性面板字段绑定 */
function bindPropsFields(sel){
  const body=document.getElementById('propsBody');
  const p=sel.params;
  body.querySelectorAll('[data-field]').forEach(el=>{
    const field=el.dataset.field;
    if(el.type==='range'){
      el.addEventListener('input',()=>{
        p[field]=parseFloat(el.value);
        const valEl=el.parentElement.querySelector('.val');
        if(valEl) valEl.textContent=parseFloat(el.value).toFixed(parseFloat(el.step)<1?2:0);
        if(field==='smoothing'){ CFG.smoothing=p.smoothing; if(CFG.analyser) CFG.analyser.smoothingTimeConstant=p.smoothing; }
        scheduleSave();
      });
    } else if(el.type==='color'){
      el.addEventListener('input',()=>{
        if(field.startsWith('color_')){
          const idx=parseInt(field.split('_')[1]);
          p.colors[idx]=el.value;
          const hexEl=el.parentElement.querySelector('.color-hex');
          if(hexEl) hexEl.textContent=el.value;
          updateColorPreview(p);
        } else if(field==='solidColor'){
          p.colors[0]=el.value;
        } else {
          p[field]=el.value;
        }
        const s=el.parentElement.querySelector('span');
        if(s&&!s.classList.contains('color-hex')) s.textContent=el.value;
        scheduleSave();
      });
    } else if(el.type==='text'||el.type==='number'){
      el.addEventListener('input',()=>{
        if(field.endsWith('_num')){
          const realField=field.replace('_num','');
          p[realField]=parseFloat(el.value)||0;
          // 同步滑条
          const range=body.querySelector(`[data-field="${realField}"]`);
          if(range) range.value=p[realField];
          updateDualRangeFill(el.closest('.dual-range')||body.querySelector(`[data-dual-min="${realField}"],[data-dual-max="${realField}"]`));
        } else {
          p[field]=el.value;
        }
      });
    } else if(el.tagName==='SELECT'){
      el.addEventListener('change',()=>{p[field]=el.value;});
    } else if(el.classList.contains('toggle')){
      el.addEventListener('click',()=>{
        p[field]=!p[field]; el.classList.toggle('on');
        scheduleSave();
        renderProps();
      });
    } else if(el.classList.contains('seg')){
      el.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
        p[field]=b.dataset.v;
        el.querySelectorAll('button').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        scheduleSave();
        renderProps();
      }));
    }
  });
  // 多色编辑器:上移/下移/删除/添加
  body.querySelectorAll('[data-color-up]').forEach(b=>b.addEventListener('click',()=>{
    const i=parseInt(b.dataset.colorUp);
    if(i>0){ [p.colors[i-1],p.colors[i]]=[p.colors[i],p.colors[i-1]]; scheduleSave(); renderProps(); }
  }));
  body.querySelectorAll('[data-color-down]').forEach(b=>b.addEventListener('click',()=>{
    const i=parseInt(b.dataset.colorDown);
    if(i<p.colors.length-1){ [p.colors[i+1],p.colors[i]]=[p.colors[i],p.colors[i+1]]; scheduleSave(); renderProps(); }
  }));
  body.querySelectorAll('[data-color-del]').forEach(b=>b.addEventListener('click',()=>{
    const i=parseInt(b.dataset.colorDel);
    if(p.colors.length>1){ p.colors.splice(i,1); scheduleSave(); renderProps(); }
  }));
  const addBtn=document.getElementById('colorAddBtn');
  if(addBtn) addBtn.addEventListener('click',()=>{
    p.colors.push('#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'));
    scheduleSave(); renderProps();
  });
  // 双端点滑条同步
  body.querySelectorAll('.dual-range').forEach(dr=>{
    const minInput=dr.querySelector('.zindex-min');
    const maxInput=dr.querySelector('.zindex-max');
    const labels=dr.parentElement.querySelectorAll('span');
    const updateFill=()=>{
      const absMin=parseFloat(dr.dataset.absMin), absMax=parseFloat(dr.dataset.absMax);
      const mn=parseFloat(minInput.value), mx=parseFloat(maxInput.value);
      const fill=dr.querySelector('.track-fill');
      if(fill){
        fill.style.left=((mn-absMin)/(absMax-absMin)*100)+'%';
        fill.style.right=(100-(mx-absMin)/(absMax-absMin)*100)+'%';
      }
      if(labels.length>=2){
        labels[0].textContent=mn+'Hz';
        labels[1].textContent=mx>=1000?(mx/1000)+'kHz':mx+'Hz';
      }
      if(minInput.dataset.field) p[minInput.dataset.field]=mn;
      if(maxInput.dataset.field) p[maxInput.dataset.field]=mx;
    };
    minInput.addEventListener('input',()=>{
      if(parseFloat(minInput.value)>parseFloat(maxInput.value)) minInput.value=maxInput.value;
      updateFill();
    });
    maxInput.addEventListener('input',()=>{
      if(parseFloat(maxInput.value)<parseFloat(minInput.value)) maxInput.value=minInput.value;
      updateFill();
    });
  });
}
function updateColorPreview(p){
  const prev=document.querySelector('.color-preview');
  if(prev&&p.colors.length>1) prev.style.background=`linear-gradient(90deg, ${p.colors.join(', ')})`;
}
function updateDualRangeFill(dr){ if(!dr) return;
  const minInput=dr.querySelector('.zindex-min'), maxInput=dr.querySelector('.zindex-max');
  if(!minInput||!maxInput) return;
  const absMin=parseFloat(dr.dataset.absMin), absMax=parseFloat(dr.dataset.absMax);
  const mn=parseFloat(minInput.value), mx=parseFloat(maxInput.value);
  const fill=dr.querySelector('.track-fill');
  if(fill){ fill.style.left=((mn-absMin)/(absMax-absMin)*100)+'%'; fill.style.right=(100-(mx-absMin)/(absMax-absMin)*100)+'%'; }
}

/* ============================================================
   画布交互：移动 / 四角自由缩放 / 两指等比缩放
   ============================================================ */
let _drag=null;                 // { mode:'move'|'resize', el, ... }
let _pinch=null;                // { el, startDist, startW, startH }
const _pointers=new Map();      // pointerId -> 画布像素坐标

function canvasPos(e){
  const rect=canvas.getBoundingClientRect();
  return { x:(e.clientX-rect.left)/rect.width*canvas.width, y:(e.clientY-rect.top)/rect.height*canvas.height };
}
// 画布像素坐标 -> 元素世界坐标（CSS缩放由getBoundingClientRect自动处理）
function worldPoint(mx,my){
  return { x: mx, y: my };
}
function worldRect(p){
  const ew=canvas.width*p.w/100, eh=canvas.height*p.h/100;
  return { x:canvas.width*p.x/100-ew/2, y:canvas.height*p.y/100-eh/2, w:ew, h:eh };
}
// 元素在画布像素坐标下的矩形（用于命中检测）
function screenRect(p){
  return worldRect(p);
}
const HANDLE_CURSOR={ nw:'nwse-resize', se:'nwse-resize', ne:'nesw-resize', sw:'nesw-resize' };
function getHandleAt(wx,wy,p){
  const r=worldRect(p);
  const hit=16;
  const corners={ nw:[r.x,r.y], ne:[r.x+r.w,r.y], sw:[r.x,r.y+r.h], se:[r.x+r.w,r.y+r.h] };
  for(const k in corners){
    const [hx,hy]=corners[k];
    if(Math.abs(wx-hx)<=hit && Math.abs(wy-hy)<=hit) return k;
  }
  return null;
}
function selectElement(el){
  CFG.selectedId=el.id;
  document.querySelectorAll('.ibtn[data-tool]').forEach(x=>x.classList.remove('active'));
  document.querySelector('.ibtn[data-tool="props"]')?.classList.add('active');
  _lastTool='props';
  renderProps();
}
function clampNum(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }
// 拖动/缩放期间轻量同步属性面板数值控件，避免整面板重建
function syncField(field, value, digits){
  const input=document.getElementById('propsBody').querySelector('[data-field="'+field+'"]');
  if(!input) return;
  input.value=value;
  const v=input.parentElement.querySelector('.val');
  if(v) v.textContent=Number(value).toFixed(digits);
}
function hitElementAt(mx,my){
  for(let i=CFG.elements.length-1;i>=0;i--){
    const r=screenRect(CFG.elements[i].params);
    if(mx>=r.x&&mx<=r.x+r.w&&my>=r.y&&my<=r.y+r.h) return CFG.elements[i];
  }
  return null;
}

canvas.addEventListener('pointerdown',e=>{
  // 全屏：画布内元素不可被选中/点击
  if(document.fullscreenElement||document.webkitFullscreenElement) return;
  const pt=canvasPos(e);
  _pointers.set(e.pointerId, pt);
  // 两指：等比缩放（长宽同比）
  if(_pointers.size===2){
    const pts=[..._pointers.values()];
    const mx=(pts[0].x+pts[1].x)/2, my=(pts[0].y+pts[1].y)/2;
    const el=getSelected() || hitElementAt(mx,my);
    if(el){
      selectElement(el);
      _pinch={ el, startDist:Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y) || 1,
               startW:el.params.w, startH:el.params.h };
    }
    _drag=null;
    e.preventDefault();
    return;
  }
  if(_pointers.size>2) return;

  const wpt=worldPoint(pt.x,pt.y);
  const sel=getSelected();
  if(sel){
    const h=getHandleAt(wpt.x,wpt.y,sel.params);
    if(h){
      _drag={ mode:'resize', el:sel, handle:h, rect:worldRect(sel.params) };
      try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
      e.preventDefault();
      return;
    }
  }
  const hit=hitElementAt(pt.x,pt.y);
  if(hit){
    // 禁止在画布上拖动移动元素：位置只能在属性面板里通过 X/Y 设置
    selectElement(hit);
    e.preventDefault();
  } else {
    CFG.selectedId=null; renderProps();
  }
});

canvas.addEventListener('pointermove',e=>{
  if(document.fullscreenElement||document.webkitFullscreenElement){ canvas.style.cursor='default'; return; }
  if(_pointers.has(e.pointerId)) _pointers.set(e.pointerId, canvasPos(e));
  const pt=canvasPos(e);

  // 两指等比缩放
  if(_pinch && _pointers.size>=2){
    const pts=[..._pointers.values()];
    const d=Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y) || 1;
    const f=d/_pinch.startDist;
    const p=_pinch.el.params;
    p.w=clampNum(_pinch.startW*f, 2, 100);
    p.h=clampNum(_pinch.startH*f, 2, 100);
    syncField('w', p.w, 1); syncField('h', p.h, 1);
    e.preventDefault();
    return;
  }

  // 四角自由（非等比）缩放
  if(_drag && _drag.mode==='resize'){
    const wpt=worldPoint(pt.x,pt.y);
    const { handle, rect }=_drag;
    let left=rect.x, top=rect.y, right=rect.x+rect.w, bottom=rect.y+rect.h;
    const minW=canvas.width*0.02, minH=canvas.height*0.02;
    if(handle.indexOf('w')>=0) left=clampNum(left, right-canvas.width, right-minW);
    if(handle.indexOf('e')>=0) right=clampNum(right, left+minW, left+canvas.width);
    if(handle.indexOf('n')>=0) top=clampNum(top, bottom-canvas.height, bottom-minH);
    if(handle.indexOf('s')>=0) bottom=clampNum(bottom, top+minH, top+canvas.height);
    const p=_drag.el.params;
    p.w=(right-left)/canvas.width*100;
    p.h=(bottom-top)/canvas.height*100;
    p.x=((left+right)/2)/canvas.width*100;
    p.y=((top+bottom)/2)/canvas.height*100;
    syncField('w', p.w, 1); syncField('h', p.h, 1);
    syncField('x', p.x, 1); syncField('y', p.y, 1);
    e.preventDefault();
    return;
  }

  // 悬停：命中四角显示缩放光标，命中元素显示可选中光标
  const wpt=worldPoint(pt.x,pt.y);
  const sel=getSelected();
  const h=sel?getHandleAt(wpt.x,wpt.y,sel.params):null;
  if(h) canvas.style.cursor=HANDLE_CURSOR[h];
  else if(hitElementAt(pt.x,pt.y)) canvas.style.cursor='pointer';
  else canvas.style.cursor='default';
});

function onPointerEnd(e){
  _pointers.delete(e.pointerId);
  let changed=false;
  if(_pinch && _pointers.size<2){ _pinch=null; changed=true; }
  if(_drag && _pointers.size===0){ _drag=null; changed=true; }
  if(changed){ scheduleSave(); renderProps(); }
  if(_pointers.size===0) canvas.style.cursor='default';
}
canvas.addEventListener('pointerup',onPointerEnd);
canvas.addEventListener('pointercancel',onPointerEnd);
canvas.addEventListener('pointerleave',()=>{ if(!_drag&&!_pinch) canvas.style.cursor='default'; });

/* ============================================================
   画布比例 & 缩放
   ============================================================ */
// 直接按像素设置画布分辨率（性能面板）
function setResolution(w,h){
  CFG.canvas.w=w; CFG.canvas.h=h;
  canvas.width=w; canvas.height=h;
  fitCanvas();
  scheduleSave();
  _log('画布分辨率设为 ' + w + '×' + h, 'ok');
}
function applyZoom(){
  const z=CFG.canvas.zoom;
  canvas.style.transform='scale('+z+')';
  canvas.style.transformOrigin='0 0';
  stageWrap.style.width=(canvas.width*z)+'px';
  stageWrap.style.height=(canvas.height*z)+'px';
  // 供全屏 CSS 覆盖移动端强制宽度（!important 需要变量参与）
  const rs=document.documentElement.style;
  rs.setProperty('--canvas-zoom', z);
  rs.setProperty('--canvas-w', canvas.width+'px');
  rs.setProperty('--canvas-h', canvas.height+'px');
}
function fitCanvas(){
  // 等比缩放到「宽高都完整可见」：zoom = min(可用宽/画布宽, 可用高/画布高)，
  // 保证整个绘制区不被上下遮挡、不出现滚动条；终端紧随缩放后的下边界。
  const stage=document.getElementById('canvasStage');
  if(!stage) return;
  const availW=stage.clientWidth;
  if(availW<=0){ CFG.canvas.zoom=1; applyZoom(); return; }
  // 可用高度 = 绘制区总高 - 进度条 - 日志工具条 - 终端最小高度
  const area=document.querySelector('.canvas-area');
  const inFs=!!(document.fullscreenElement||document.webkitFullscreenElement);
  let availH=0;
  if(area){
    const player=area.querySelector('.player-bar');
    const lt=document.getElementById('logToolbar');
    // 全屏时进度条/终端已隐藏，不再为其预留高度
    const logMin=inFs?0:100;
    availH=area.clientHeight-(player?player.offsetHeight:0)-(lt?lt.offsetHeight:0)-logMin-1;
  }
  const zW=availW/canvas.width;
  const zH=availH>0?availH/canvas.height:Infinity;
  CFG.canvas.zoom=Math.max(0.05,Math.min(2,Math.min(zW,zH)));
  applyZoom();
}
// 左侧面板宽度拖拽（PC）：拖动时画布等比缩放，始终完整可见
(function(){
  const rz=document.getElementById('panelResizer');
  if(!rz) return;
  let dragging=false, startX=0, startW=0;
  function currentW(){
    const el=document.querySelector('.library:not(.hidden)') || document.querySelector('.props.open');
    return el ? el.getBoundingClientRect().width : 280;
  }
  rz.addEventListener('pointerdown',e=>{
    dragging=true; startX=e.clientX; startW=currentW();
    rz.classList.add('dragging');
    try{ rz.setPointerCapture(e.pointerId); }catch(_){}
    e.preventDefault();
  });
  rz.addEventListener('pointermove',e=>{
    if(!dragging) return;
    const w=Math.max(180, Math.min(600, startW+(e.clientX-startX)));
    _panelW=w;
    document.documentElement.style.setProperty('--panel-w', w+'px');
    fitCanvas();
  });
  function end(){ if(!dragging) return; dragging=false; rz.classList.remove('dragging'); scheduleSave(); }
  rz.addEventListener('pointerup',end);
  rz.addEventListener('pointercancel',end);
  window.addEventListener('pointerup',end);
})();
/* ============================================================
   事件绑定
   ============================================================ */
document.getElementById('uploadZone').addEventListener('click',()=>document.getElementById('fileInput').click());
document.getElementById('fileInput').addEventListener('change',e=>loadAudio(e.target.files[0]));
document.getElementById('playBtn').addEventListener('click',togglePlay);
document.getElementById('volSlider').addEventListener('input',e=>{CFG.volume=+e.target.value;if(CFG.audio)CFG.audio.volume=CFG.volume;});
document.getElementById('loopBtn').addEventListener('click',function(){
  CFG.loop=!CFG.loop; this.classList.toggle('active',CFG.loop);
  this.innerHTML=CFG.loop?LIST_LOOP_ICON:NO_LOOP_ICON;
  if(CFG.audio) CFG.audio.loop=CFG.loop;
});
const seekBar=document.getElementById('seekBar');
let _seekDragging=false;
let _seekPreviewPct=0;
function seekPreview(clientX){
  if(!CFG.audio||!CFG.audio.duration) return;
  const rect=seekBar.getBoundingClientRect();
  _seekPreviewPct=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width));
  document.getElementById('seekFill').style.width=(_seekPreviewPct*100)+'%';
  const sec=CFG.audio.duration*_seekPreviewPct;
  document.getElementById('timeDisplay').textContent=`${fmtTime(sec)} / ${fmtTime(CFG.audio.duration)}`;
}
function seekApply(){
  if(!CFG.audio||!CFG.audio.duration) return;
  CFG.audio.currentTime=_seekPreviewPct*CFG.audio.duration;
}
seekBar.addEventListener('mousedown',e=>{_seekDragging=true;seekPreview(e.clientX);});
document.addEventListener('mousemove',e=>{if(_seekDragging)seekPreview(e.clientX);});
document.addEventListener('mouseup',()=>{if(_seekDragging){seekApply();_seekDragging=false;}});
seekBar.addEventListener('touchstart',e=>{_seekDragging=true;seekPreview(e.touches[0].clientX);e.preventDefault();},{passive:false});
document.addEventListener('touchmove',e=>{if(_seekDragging)seekPreview(e.touches[0].clientX);});
document.addEventListener('touchend',()=>{if(_seekDragging){seekApply();_seekDragging=false;}});
let _lastTool='elements';
let _panelTimer=null;
function _panelOpen(){
  const lib=document.getElementById('library');
  const propsPanel=document.getElementById('propsPanel');
  const perfPanel=document.getElementById('perfPanel');
  return (lib && lib.classList.contains('mobile-open')) ||
         (propsPanel && (propsPanel.classList.contains('open')||propsPanel.classList.contains('mobile-open'))) ||
         (perfPanel && (perfPanel.classList.contains('open')||perfPanel.classList.contains('mobile-open')));
}
function _syncBackdrop(){
  const bd=document.getElementById('panelBackdrop');
  if(bd) bd.classList.toggle('show', _panelOpen());
}
function _closeAllPanels(){
  const lib=document.getElementById('library');
  const propsPanel=document.getElementById('propsPanel');
  const perfPanel=document.getElementById('perfPanel');
  if(lib) lib.classList.remove('mobile-open','hidden');
  if(propsPanel) propsPanel.classList.remove('open','mobile-open');
  if(perfPanel) perfPanel.classList.remove('open','mobile-open');
  document.querySelectorAll('.ibtn[data-tool]').forEach(x=>x.classList.remove('active'));
  _lastTool=null;
  fitCanvas();
  _syncBackdrop();
}
document.querySelectorAll('.ibtn[data-tool]').forEach(b=>b.addEventListener('click',()=>{
  const lib=document.getElementById('library');
  const propsPanel=document.getElementById('propsPanel');
  const perfPanel=document.getElementById('perfPanel');
  const tool=b.dataset.tool;
  const isActive=b.classList.contains('active');
  if(_panelTimer) clearTimeout(_panelTimer);
  document.querySelectorAll('.ibtn[data-tool]').forEach(x=>x.classList.remove('active'));
  lib.classList.remove('mobile-open','hidden');
  propsPanel.classList.remove('open','mobile-open');
  perfPanel.classList.remove('open','mobile-open');
  if(isActive){
    _lastTool=null;
  }else{
    b.classList.add('active');
    _lastTool=tool;
    if(tool==='props'){
      // 属性/性能面板与左侧元素面板共用左侧位置：打开时隐藏元素面板
      lib.classList.add('hidden');
      void propsPanel.offsetHeight;
      renderProps();
      propsPanel.classList.add('open','mobile-open');
    }else if(tool==='perf'){
      lib.classList.add('hidden');
      void perfPanel.offsetHeight;
      renderPerf();
      perfPanel.classList.add('open','mobile-open');
    }else{
      void lib.offsetHeight;
      _panelTimer=setTimeout(()=>{
        renderLibrary();
        lib.classList.add('mobile-open');
      },30);
    }
  }
  if(tool==='props'||tool==='perf') fitCanvas(); // 面板开合改变可用宽度，重新按宽度适配
  _syncBackdrop();
}));
document.getElementById('panelBackdrop').addEventListener('click',e=>{
  // 移动端点击右侧 1/3：仅收起面板，不做任何其他响应
  e.preventDefault();
  e.stopPropagation();
  _closeAllPanels();
});
// 全屏：全屏绘制区；全屏时画布元素不可选中/点击，双击任意位置退出
let _isFullscreen=false;
const _fsBtn=document.getElementById('fsToggleBtn');
const _fsTarget=document.querySelector('.canvas-area');
function _fsRequest(el, fn){ if(el && typeof el[fn]==='function'){ el[fn](); } }
function _toggleFullscreen(){
  if(!(document.fullscreenElement||document.webkitFullscreenElement)){
    _fsRequest(_fsTarget,'requestFullscreen'); _fsRequest(_fsTarget,'webkitRequestFullscreen');
  }else{
    _fsRequest(document,'exitFullscreen'); _fsRequest(document,'webkitExitFullscreen');
  }
}
function _onFsChange(){
  _isFullscreen=!!(document.fullscreenElement||document.webkitFullscreenElement);
  if(_fsBtn) _fsBtn.classList.toggle('active',_isFullscreen);
  if(_isFullscreen){ CFG.selectedId=null; renderProps(); } // 全屏不可选中元素
  requestAnimationFrame(()=>fitCanvas());
  setTimeout(fitCanvas,150);
}
if(_fsBtn) _fsBtn.addEventListener('click',_toggleFullscreen);
document.addEventListener('fullscreenchange',_onFsChange);
document.addEventListener('webkitfullscreenchange',_onFsChange);
document.addEventListener('dblclick',()=>{
  if(document.fullscreenElement||document.webkitFullscreenElement){
    _fsRequest(document,'exitFullscreen'); _fsRequest(document,'webkitExitFullscreen');
  }
});
window.addEventListener('keydown',e=>{
  if(e.code==='Space'&&!e.target.matches('input,select,textarea')){e.preventDefault();togglePlay();}
  if(e.code==='Delete'&&CFG.selectedId){removeElement(CFG.selectedId);}
});
/* ============================================================
   初始化
   ============================================================ */
const _restored = loadConfig(); // 从 localStorage 恢复分辨率/帧率/元素等设置
if(_restored){
  canvas.width=CFG.canvas.w||1280; canvas.height=CFG.canvas.h||720;
  _eid = CFG.elements.reduce((m,e)=>Math.max(m, e.id||0), 0);
}else{
  // 无历史配置：默认 1280×720
  canvas.width=1280; canvas.height=720; CFG.canvas.w=1280; CFG.canvas.h=720;
}
document.getElementById('volSlider').value = CFG.volume;
document.getElementById('loopBtn').classList.toggle('active', CFG.loop);
document.getElementById('loopBtn').innerHTML=CFG.loop?LIST_LOOP_ICON:NO_LOOP_ICON;
const _rfs=document.getElementById('raceFullSw'); if(_rfs) _rfs.checked=raceFullDownload;
_detectMaxFps();
renderLibrary();
if(_restored && CFG.elements.length){
  CFG.selectedId=null;
  renderProps();
}else{
  // 默认添加一个居中元素（x/y=50），但不自动展开属性面板
  addElement('bars');
}
document.getElementById('propsPanel').classList.remove('mobile-open');
_lastTool=null;
_syncBackdrop();
// 等布局完成后按宽度适配一次（PC 端绘制区宽度自动撑满左右控件边界）
requestAnimationFrame(()=>{ render(); fitCanvas(); });
window.addEventListener('resize',()=>{ fitCanvas(); _syncBackdrop(); });

// 自动加载演示音频
_log('页面初始化完成, 开始加载demo音频...');
fetchDemo().then(r=>r.blob()).then(blob=>{
  _log('demo.blob就绪 ' + (blob.size/1024).toFixed(0) + 'KB, 创建File对象...', 'ok');
  const file=new File([blob],'demo.ogg',{type:'audio/ogg'});
  loadAudio(file);
}).catch((e)=>{
  _log('demo加载失败: ' + (e && e.message ? e.message : e), 'err');
});
