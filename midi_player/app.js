
// ===== 调试终端：重定向console输出到页面 =====
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);
let _debugContentEl = null;
let debugEnabled = true; // 调试总开关：关闭后无日志采集、无监控、无渲染降级自动弹出

// 将 console 参数安全转为字符串：对象走 JSON，循环引用等异常时回退 String
// 音色 id -> 界面显示名（如 clavinet -> 古钢琴），用于日志与状态区
function timbreDisplayName(id){
  if(id === '__synth__') return '合成钢琴';
  const sel = document.getElementById('timbreSel');
  if(sel && sel.options){
    for(let i = 0; i < sel.options.length; i++){ if(sel.options[i].value === id) return sel.options[i].textContent; }
  }
  return id;
}
// 统一资源标签：显示名（中文）-[原始文件名]
function _baseName(file){ return String(file).split('/').pop(); }
function _songDisplayName(file){ return _baseName(file).replace(/\.[^.]+$/, ''); }
function _timbreLabel(id){ return '音色[' + timbreDisplayName(id) + ']-[' + id + ']'; }
function _songId(file){ return '[' + _songDisplayName(file) + ']-[' + _baseName(file) + ']'; }
function _songLabel(file){ return '谱面' + _songId(file); }

function _fmtArgs(args){
  return args.map(a => {
    if(typeof a === 'object' && a !== null){
      try{ return JSON.stringify(a); }catch(e){ return String(a); }
    }
    return String(a);
  }).join(' ');
}

// 日志颜色：蓝色 info（下载等）、绿色（正常/恢复）、黄色 warn、红色 error
function _debugColor(type, msg) {
  if(msg.indexOf('[INFO]') >= 0) return '#4ea1ff';
  if(msg.indexOf('[OK]') >= 0) return '#2fbf6f';
  if(type === 'warn') return '#ff0';
  if(type === 'error') return '#f44';
  return '#0f0';
}

// 进度条上方的实时状态区（乐谱/音色下载进度、完成提示、调试日志）
let _statusTimer = null;
function setStatus(text, sticky){
  const el = document.getElementById('statusText');
  if(!el) return;
  el.textContent = text || '';
  if(_statusTimer){ clearTimeout(_statusTimer); _statusTimer = null; }
  if(text && !sticky){ _statusTimer = setTimeout(() => { el.textContent = ''; }, 3500); }
}
// 调试面板是唯一滚动容器（日志区不单独滚动）
function _debugPanelScrollEl(){
  // 面板本身 overflow:hidden，真正的滚动容器是终端 .dbg-log
  return document.getElementById('debugTerminalContent');
}
function _appendDebug(msg, type) {
  // 调试信息本就只有音频调试：详细日志不再打印 [AudioDebug] 前缀（保留 [INFO]/[WARN]/[OK] 等级）
  const clean = String(msg).replace(/\[AudioDebug\]\s*/g, '');
  // 调试面板未展开时，把最新 INFO 日志精简后显示到状态区（再去掉等级前缀）
  const _dp = document.getElementById('debugPanel');
  if(type === 'log' && (!_dp || !_dp.classList.contains('open'))){
    setStatus(clean.replace(/^\[[A-Za-z]+\]\s*/, ''));
  }
  if(!_debugContentEl) {
    _debugContentEl = document.getElementById('debugTerminalContent');
  }
  const time = new Date().toLocaleTimeString();
  const color = _debugColor(type, clean);
  const line = document.createElement('div');
  line.style.color = color;
  line.style.wordBreak = 'break-all';
  line.textContent = '[' + time + '] ' + clean;
  if(_debugContentEl) {
    // 仅当用户原本就在底部附近时才自动跟随；否则保持当前位置，不打断查看历史
    const panel = _debugPanelScrollEl();
    const atBottom = panel ? (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40) : true;
    _debugContentEl.appendChild(line);
    // 限制DOM行数，防止调试输出本身造成内存/渲染压力
    while(_debugContentEl.childElementCount > 300){
      _debugContentEl.removeChild(_debugContentEl.firstChild);
    }
    if(atBottom && panel) panel.scrollTop = panel.scrollHeight;
  }
}

// ===== 公共 CDN 竞速日志能力 =====
// 进行中每 0.5s 覆盖同一行；完成后由 _raceLogFinal 固化为最终结果行（保留，用于指示性能）。
let _raceLogEl = null;
function _raceLog(text){
  if(!debugEnabled) return;
  const term = document.getElementById('debugTerminalContent');
  if(!term) return;
  const line = '[' + new Date().toLocaleTimeString() + '] ' + text;
  if(_raceLogEl && _raceLogEl.parentNode === term){
    _raceLogEl.textContent = line; // 原地覆盖上一条竞速日志
  } else {
    _raceLogEl = document.createElement('div');
    _raceLogEl.style.color = _debugColor('log', text);
    _raceLogEl.style.wordBreak = 'break-all';
    _raceLogEl.textContent = line;
    const panel = _debugPanelScrollEl();
    const atBottom = panel ? (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40) : true;
    term.appendChild(_raceLogEl);
    while(term.childElementCount > 300){ term.removeChild(term.firstChild); }
    if(atBottom && panel) panel.scrollTop = panel.scrollHeight;
  }
}
// 竞速结束：把进行中的行改写成最终结果并「固化」（下次竞速另起新行），不删除，用于指示性能
function _raceLogFinal(text){
  const term = document.getElementById('debugTerminalContent');
  if(debugEnabled && term){
    const line = '[' + new Date().toLocaleTimeString() + '] ' + text;
    if(_raceLogEl && _raceLogEl.parentNode === term){
      _raceLogEl.textContent = line;
      _raceLogEl.style.color = _debugColor('log', text);
    } else {
      const el = document.createElement('div');
      el.style.color = _debugColor('log', text);
      el.style.wordBreak = 'break-all';
      el.textContent = line;
      term.appendChild(el);
      while(term.childElementCount > 300){ term.removeChild(term.firstChild); }
    }
  }
  _raceLogEl = null; // 固化：后续竞速另起一行
}
// 字节数格式化：3.6MB / 520KB / 800B
function _fmtSize(n){
  n = Number(n) || 0;
  if(n >= 1024*1024) return (n/1024/1024).toFixed(1) + 'MB';
  if(n >= 1024) return (n/1024).toFixed(0) + 'KB';
  return n + 'B';
}

// 静态媒体「需传输体积」表（字节）：由脚本探测生成，避免运行时逐个 HEAD 探测。
// - 谱面：仓库内 midi/*.mid.br 的实际文件大小（精确）
// - 音色：jsDelivr 对 soundfonts/*-ogg.js 返回的 br Content-Length（浏览器实际传输量）
// 注意：文件更新后需重新生成（见 README）。
const MEDIA_BR_SIZES = {
  "midi/Rush E 3.mid": 97614,
  "midi/The Sound of Silence.mid": 3601,
  "midi/concurrent_44_500ms.mid": 246,
  "midi/concurrent_88_100ms.mid": 301,
  "midi/concurrent_88_10ms.mid": 302,
  "midi/concurrent_88_250ms.mid": 304,
  "midi/concurrent_88_500ms.mid": 305,
  "midi/concurrent_88_50ms.mid": 302,
  "soundfonts/acoustic_bass": 1312318,
  "soundfonts/acoustic_grand_piano": 1594679,
  "soundfonts/acoustic_guitar_nylon": 1232847,
  "soundfonts/acoustic_guitar_steel": 1337754,
  "soundfonts/alto_sax": 1358889,
  "soundfonts/baritone_sax": 1090241,
  "soundfonts/bassoon": 1853279,
  "soundfonts/brass_ensemble": 1683696,
  "soundfonts/brass_section": 1683696,
  "soundfonts/bright_acoustic_piano": 1655436,
  "soundfonts/celesta": 1011245,
  "soundfonts/cello": 2576777,
  "soundfonts/church_organ": 1614583,
  "soundfonts/clarinet": 1363706,
  "soundfonts/clavinet": 1618536,
  "soundfonts/contrabass": 1092325,
  "soundfonts/distortion_guitar": 1814863,
  "soundfonts/drawbar_organ": 1416455,
  "soundfonts/electric_bass_finger": 1031639,
  "soundfonts/electric_bass_pick": 1105987,
  "soundfonts/electric_grand_piano": 1277773,
  "soundfonts/electric_guitar_clean": 1290951,
  "soundfonts/electric_guitar_jazz": 1220594,
  "soundfonts/electric_piano_1": 1193793,
  "soundfonts/electric_piano_2": 1370200,
  "soundfonts/flute": 2005155,
  "soundfonts/french_horn": 1639372,
  "soundfonts/fretless_bass": 1279207,
  "soundfonts/harpsichord": 1468820,
  "soundfonts/honkytonk_piano": 1606478,
  "soundfonts/lead_1_square": 2591163,
  "soundfonts/lead_2_sawtooth": 2409417,
  "soundfonts/lead_7_fifths": 3052410,
  "soundfonts/marimba": 535879,
  "soundfonts/oboe": 1634473,
  "soundfonts/orchestral_harp": 1289153,
  "soundfonts/overdriven_guitar": 1867723,
  "soundfonts/pad_4_choir": 2140300,
  "soundfonts/pan_flute": 1513250,
  "soundfonts/percussive_organ": 1542136,
  "soundfonts/piccolo": 1900589,
  "soundfonts/pizzicato_strings": 898691,
  "soundfonts/recorder": 1175271,
  "soundfonts/rock_organ": 1765436,
  "soundfonts/soprano_sax": 1494042,
  "soundfonts/string_ensemble_1": 2138236,
  "soundfonts/string_ensemble_2": 2143193,
  "soundfonts/tenor_sax": 1859968,
  "soundfonts/trombone": 1313395,
  "soundfonts/trumpet": 1705998,
  "soundfonts/tuba": 832051,
  "soundfonts/tubular_bells": 1377313,
  "soundfonts/vibraphone": 1184997,
  "soundfonts/viola": 2165049,
  "soundfonts/violin": 2300194,
  "soundfonts/xylophone": 471137,
};
function _mediaBrSize(relPath){
  const v = MEDIA_BR_SIZES[relPath];
  return (typeof v === 'number' && v > 0) ? v : 0;
}
// 生成「需下载体积」标签（br 压缩后的传输体积）；无数据返回 null
function _makeSizeSpan(bytes){
  if(!bytes) return null;
  const s = document.createElement('span');
  s.className = 'size';
  s.textContent = _fmtSize(bytes);
  s.title = '需下载体积（br 压缩后，实际传输量）约 ' + bytes + ' 字节';
  return s;
}

// ===== 可视化帧率上限 =====
// 0 = 不限（跟随显示器刷新率，如 60/120/144Hz）；>0 时每帧不足 1000/cap 毫秒则跳过绘制。
// 渲染降级时临时压到 DEGRADE_FPS_CAP，减轻主线程与 GPU 负载。
const FPS_CAP_OPTIONS = [0, 30, 60, 90, 120];
const DEGRADE_FPS_CAP = 30;
let renderFpsCap = 0;
let _lastLoopTs = 0;
function _effectiveFpsCap(){
  if(typeof PerfArbiter !== 'undefined' && PerfArbiter.degraded){
    return renderFpsCap > 0 ? Math.min(renderFpsCap, DEGRADE_FPS_CAP) : DEGRADE_FPS_CAP;
  }
  return renderFpsCap;
}
function _syncFpsCapLabel(){
  const v = document.getElementById('fpsCapVal');
  if(!v) return;
  const cap = _effectiveFpsCap();
  v.textContent = cap > 0 ? (cap + 'fps') : '不限';
}
function onFpsCapChange(){
  const sl = document.getElementById('fpsCapSlider');
  renderFpsCap = (sl ? FPS_CAP_OPTIONS[parseInt(sl.value, 10)] : 0) || 0;
  try{ localStorage.setItem('renderFpsCap', String(renderFpsCap)); }catch(e){}
  _lastLoopTs = 0;
  _syncFpsCapLabel();
}
function _loadFpsCap(){
  try{
    const v = parseInt(localStorage.getItem('renderFpsCap'), 10);
    if(FPS_CAP_OPTIONS.indexOf(v) >= 0) renderFpsCap = v;
  }catch(e){}
  const sl = document.getElementById('fpsCapSlider');
  if(sl) sl.value = String(Math.max(0, FPS_CAP_OPTIONS.indexOf(renderFpsCap)));
  _syncFpsCapLabel();
}

console.log = function(...args) {
  _origLog(...args);
  if(!debugEnabled) return;
  const msg = _fmtArgs(args);
  if(msg.includes('AudioDebug')) _appendDebug(msg, 'log');
};
// 高频告警折叠：同一类消息 1.5s 内只记录一次，其余计数汇总，避免刷屏与主线程开销
const _warnFold = {};
console.warn = function(...args) {
  _origWarn(...args);
  if(!debugEnabled) return;
  const msg = _fmtArgs(args);
  if(!msg.includes('AudioDebug')) return;
  const key = msg.slice(0, 28);
  const now = performance.now();
  const rec = _warnFold[key] || (_warnFold[key] = {t: 0, n: 0});
  if(now - rec.t < 1500){ rec.n++; return; }
  const folded = rec.n > 0 ? ('（同类告警已折叠 ' + rec.n + ' 次）') : '';
  rec.t = now; rec.n = 0;
  _appendDebug(msg + folded, 'warn');
};
console.error = function(...args) {
  _origError(...args);
  if(!debugEnabled) return;
  const msg = _fmtArgs(args);
  if(msg.includes('AudioDebug')) _appendDebug(msg, 'error');
};

// ===== 调试总开关（默认开启）=====
function setDebugEnabled(on){
  debugEnabled = !!on;
  try{ localStorage.setItem('debugEnabled', debugEnabled ? '1' : '0'); }catch(e){}
  document.body.classList.toggle('dbg-off', !debugEnabled);
  const cb = document.getElementById('dbgEnabled');
  if(cb) cb.checked = debugEnabled;
}
function onDebugEnabledChange(){
  const cb = document.getElementById('dbgEnabled');
  setDebugEnabled(cb ? cb.checked : true);
  if(debugEnabled){
    console.log('[AudioDebug][INFO] 调试已开启');
    // 为减少性能影响：透明度 20%（较暗）、模糊 0%
    const tp = document.getElementById('panelTransparency');
    const bl = document.getElementById('panelBlur');
    if(tp) tp.value = '20';
    if(bl) bl.value = '0';
    applyPanelAppearance();
    // 渲染降级自动弹出默认打开
    const auto = document.getElementById('dbgAutoOpen');
    if(auto && !auto.checked){ auto.checked = true; onDbgAutoOpenChange(); }
    setStatus('为减少性能影响，已设透明度 20%、模糊 0%');
  }
  const dp = document.getElementById('debugPanel');
  if(dp && dp.classList.contains('open')){
    if(debugEnabled) _syncDebugPanelHeight();
    else { dp.style.maxHeight = ''; dp.style.height = ''; }
  }
}

// 面板透明度 / 背景模糊：透明滑块 100 = 全透明（alpha 0），0 = 全黑
// 菜单面板、调试面板、选谱弹层、谱面管理弹窗共享同一组值并绑定
function _panelTargets(){
  const list = [
    document.getElementById('controlPanel'),
    document.getElementById('debugPanel'),
    document.getElementById('paletteRow'),
    document.getElementById('manageModal')
  ];
  document.querySelectorAll('.csel-pop').forEach(el => list.push(el));
  return list;
}
function _applyAllAppearance(transparency, blurPct){
  const alpha = Math.max(0, Math.min(1, (100 - transparency) / 100));
  const blurPx = blurPct * 0.2;                          // 100% -> 20px
  const bf = blurPx > 0 ? ('blur(' + blurPx.toFixed(1) + 'px)') : 'none';
  _panelTargets().forEach(el => {
    if(!el) return;
    el.style.background = 'rgba(0,0,0,' + alpha + ')';
    el.style.backdropFilter = bf;
    el.style.webkitBackdropFilter = bf;
  });
  const setV = (id, v) => { const e = document.getElementById(id); if(e) e.value = v; };
  setV('panelTransparency', transparency);
  setV('panelBlur', blurPct);
  const tpct = document.getElementById('transparencyPct');
  if(tpct) tpct.textContent = Math.round(transparency) + '%';
  const bpct = document.getElementById('blurPct');
  if(bpct) bpct.textContent = Math.round(blurPct) + '%';
  try{
    localStorage.setItem('panelTransparency', String(transparency));
    localStorage.setItem('panelBlur', String(blurPct));
  }catch(e){}
}
function applyPanelAppearance(){
  const tp = document.getElementById('panelTransparency');
  const bl = document.getElementById('panelBlur');
  _applyAllAppearance(tp ? parseFloat(tp.value) : 40, bl ? parseFloat(bl.value) : 0);
}
// ===== 统一下拉面板：从控制行下方展开，最大高度约渲染区 2/3 =====
// 四个下拉触发按钮：面板展开时图标顺时针旋转 180°，收起时逆时针转回（CSS 过渡）
const DROP_TOGGLE_MAP = [
  ['manageModal', '#manageBtn svg'],
  ['controlPanel', '#settingsBtn svg'],
  ['paletteRow', '#paletteToggleIcon'],
  ['paletteEditor', '#paletteEditBtn svg'],
  ['debugPanel', '#debugToggleBtn svg'],
];
function syncDropToggleIcons(){
  DROP_TOGGLE_MAP.forEach(([pid, sel]) => {
    const panel = document.getElementById(pid);
    const icon = document.querySelector(sel);
    if(!panel || !icon) return;
    // 与配色面板一致：收起时旋转 180°，展开时转回
    icon.style.transform = panel.classList.contains('open') ? '' : 'rotate(180deg)';
  });
}
function _closeDropPanelsOnly(except){
  document.querySelectorAll('.drop-panel.open').forEach(p => { if(p !== except) p.classList.remove('open'); });
  const pe = document.getElementById('paletteEditor');
  if(pe && pe !== except) pe.classList.remove('open'); // 选色面板不参与互斥判断，但同样需要收起
  syncDropToggleIcons(); // 因打开其他面板 / 点击面板外而收起时，同步旋转图标
}
// 关闭所有下拉面板 + 选谱/音色下拉（互斥）
function closeAllDropPanels(except){
  _closeDropPanelsOnly(except);
  if(typeof closeAllCustomSelects === 'function') closeAllCustomSelects();
}
// 点击面板 / 触发按钮 / 下拉以外区域：关闭所有
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if(t && t.closest && (t.closest('.drop-panel') || t.closest('.drop-trigger') || t.closest('.csel') || t.closest('.csel-pop'))) return;
  // 上传/播放控制/重播/全屏等非下拉触发按钮：不关闭已打开的面板
  if(t && t.closest && t.closest('.ctl-btn') && !t.closest('.drop-trigger')) return;
  closeAllDropPanels();
}, true);
// 调试面板：从控制行下方展开（CSS absolute 定位）
function toggleDebugPanel(){
  const p = document.getElementById('debugPanel');
  if(!p) return;
  const willOpen = !p.classList.contains('open');
  closeAllDropPanels(p);
  p.classList.toggle('open');
  syncDropToggleIcons();
  if(willOpen){
    if(debugEnabled) _syncDebugPanelHeight();
    else { p.style.maxHeight = ''; p.style.height = ''; }
  }
}
// 调试面板最大高度为视口 65%（底部阈值较 75% 上收 10%）
function _syncDebugPanelHeight(){
  const dp = document.getElementById('debugPanel');
  if(!dp) return;
  const vh = window.innerHeight || 800;
  const h = Math.round(vh * 0.65);
  dp.style.maxHeight = h + 'px';
  dp.style.height = '';
}

// 性能降级时是否自动展开调试区（默认勾选）
let dbgAutoOpen = true;
function onDbgAutoOpenChange(){
  const cb = document.getElementById('dbgAutoOpen');
  dbgAutoOpen = !!(cb && cb.checked);
  try{ localStorage.setItem('dbgAutoOpen', dbgAutoOpen ? '1' : '0'); }catch(e){}
}
// 渲染降级时自动弹出调试面板并滚到日志底部
function autoOpenDebugPanel(){
  if(!debugEnabled || !dbgAutoOpen) return;
  const panel = document.getElementById('debugPanel');
  if(panel){ closeAllDropPanels(panel); panel.classList.add('open'); syncDropToggleIcons(); _syncDebugPanelHeight(); }
  // 等一帧让面板完成布局，再滚到最新
  requestAnimationFrame(() => { if(typeof scrollDebugBottom === 'function') scrollDebugBottom(); });
}

function clearDebugTerminal() {
  const el = document.getElementById('debugTerminalContent');
  if(el) el.innerHTML = '';
}
// ===== 二次确认弹窗 =====
let _confirmCb = null;
function _showConfirm(msg, cb){
  const m = document.getElementById('confirmModal');
  const t = document.getElementById('confirmMsg');
  if(t) t.textContent = msg;
  _confirmCb = cb;
  if(m) m.style.display = 'flex';
}
function closeConfirm(){
  const m = document.getElementById('confirmModal');
  if(m) m.style.display = 'none';
  _confirmCb = null;
}
function confirmOk(){
  const cb = _confirmCb;
  closeConfirm();
  if(cb) cb();
}
function confirmClearDebug(){ _showConfirm('确定要清空所有调试日志吗？', clearDebugTerminal); }
function confirmResetAll(){ _showConfirm('确定要重置所有设置吗？页面将刷新，缺失的默认音色与谱面会自动重新下载。', resetAllSettings); }
// 调试面板展开且调试开启时：任意按钮点击后把终端滚到最新
document.addEventListener('click', (e) => {
  if(!debugEnabled) return;
  const dp = document.getElementById('debugPanel');
  if(!dp || !dp.classList.contains('open')) return;
  const btn = e.target && e.target.closest ? e.target.closest('button') : null;
  if(!btn) return;
  const oc = btn.getAttribute('onclick') || '';
  if(oc.indexOf('scrollDebugTop') >= 0) return; // 置顶按钮例外
  setTimeout(() => { if(typeof scrollDebugBottom === 'function') scrollDebugBottom(); }, 0);
});
function scrollDebugTop(){
  const p = _debugPanelScrollEl();
  if(p) p.scrollTop = 0;
}
function scrollDebugBottom(){
  const p = _debugPanelScrollEl();
  if(p) p.scrollTop = p.scrollHeight;
}
// lucide:copy-check —— 复制成功反馈（矢量勾，替代文字 copied）
const COPY_CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 15 2 2 4-4"/><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
function _copyFeedback(ok){
  const btn = document.getElementById('debugCopyBtn');
  if(!btn) return;
  // 保存原始 innerHTML（按钮内是 SVG，textContent 为空，旧实现恢复时会把图标清空）
  if(!btn._origHTML) btn._origHTML = btn.innerHTML;
  btn.innerHTML = ok ? COPY_CHECK_ICON : '<span style="font-size:10px">failed</span>';
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.innerHTML = btn._origHTML; }, 1200);
}
function _copyFallback(text){
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    _copyFeedback(ok);
  }catch(e){ _copyFeedback(false); }
}
function copyDebugTerminal(){
  const el = document.getElementById('debugTerminalContent');
  if(!el) return;
  const text = el.innerText || '';
  if(!text){ _copyFeedback(false); return; }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(() => _copyFeedback(true), () => _copyFallback(text));
  } else {
    _copyFallback(text);
  }
}
// 下载日志文本
function downloadDebugLog(){
  const el = document.getElementById('debugTerminalContent');
  const text = el ? (el.innerText || '') : '';
  try{
    const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = 'midi-player-debug-' + ts + '.log';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }catch(e){}
}

// 初始化：恢复调试开关、面板外观与自动展开勾选
(function(){
  try{
    const d = localStorage.getItem('debugEnabled');
    if(d !== null) debugEnabled = d === '1';
    const t = localStorage.getItem('panelTransparency');
    const b = localStorage.getItem('panelBlur');
    if(t !== null){ const el = document.getElementById('panelTransparency'); if(el) el.value = t; }
    if(b !== null){ const el = document.getElementById('panelBlur'); if(el) el.value = b; }
    const s = localStorage.getItem('dbgAutoOpen');
    if(s !== null) dbgAutoOpen = s === '1';
  }catch(e){}
  const cb = document.getElementById('dbgEnabled');
  if(cb) cb.checked = debugEnabled;
  const ac = document.getElementById('dbgAutoOpen');
  if(ac) ac.checked = dbgAutoOpen;
  document.body.classList.toggle('dbg-off', !debugEnabled);
  applyPanelAppearance();
})();


/* ============================================================
 * 1. 音频上下文
 * ========================================================== */
let audioCtx = null;
let masterGain = null;
let outputAnalyser = null;

function initAudio(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;
  // 在 master 与 destination 之间插一个 Analyser，用于探测"实际输出是否静音"
  outputAnalyser = audioCtx.createAnalyser();
  outputAnalyser.fftSize = 2048;
  masterGain.connect(outputAnalyser);
  outputAnalyser.connect(audioCtx.destination);
  // 监听AudioContext状态变化
  audioCtx.addEventListener('statechange', () => {
    console.log('[AudioDebug][INFO] AudioContext状态变化:', audioCtx.state, '时间:', audioCtx.currentTime.toFixed(2));
  });
  console.log('[AudioDebug][INFO] AudioContext已创建 sampleRate=' + audioCtx.sampleRate +
    ' baseLatency=' + (audioCtx.baseLatency != null ? (audioCtx.baseLatency * 1000).toFixed(1) + 'ms' : 'N/A') +
    ' outputLatency=' + (audioCtx.outputLatency != null ? (audioCtx.outputLatency * 1000).toFixed(1) + 'ms' : 'N/A') +
    ' state=' + audioCtx.state);
  if(debugEnabled) AudioDebugMonitor.init();
  // 预热合成钢琴预渲染缓冲区（约 8ms），避免首个合成音符触发一次性主线程构建
  setTimeout(() => { try{ _getSynthLoopBuffers(); }catch(e){} }, 0);
  // 后台加载合成钢琴 AudioWorklet（渐进增强）；失败则保持预渲染缓冲区方案
  setTimeout(() => { try{ _initSynthWorklet(); }catch(e){} }, 0);
}

/* ============================================================
 * 1.5 性能诊断监控（重点排查：音频线程过载 / 节点泄漏 / 主线程长任务）
 * ========================================================== */
/* 性能仲裁：2 秒窗口。窗口内累计的性能问题（严重丢帧/音符积压/音频时钟停摆/时间戳异常）
   达到阈值 -> 同时降级渲染与音频；窗口内问题低于阈值 -> 恢复完整渲染与播放。 */
const PerfArbiter = {
  degraded: false,
  windowSize: 2,       // 仲裁窗口：2 秒
  DEGRADE_AT: 3,       // 2 秒内累计问题次数达到该值 -> 降级
  RECOVER_AT: 1,       // 2 秒内累计问题次数低于等于该值 -> 恢复
  perSecond: [],
  push(info){
    this.perSecond.push(info);
    while(this.perSecond.length > this.windowSize) this.perSecond.shift();
    const total = this.perSecond.reduce((s, x) => s + x.total, 0);
    if(!this.degraded && this.perSecond.length >= this.windowSize && total >= this.DEGRADE_AT){
      this.degraded = true;
      const parts = [];
      if(info.drop) parts.push('丢帧');
      if(info.backlog) parts.push('积压');
      if(info.stall) parts.push('停摆');
      if(info.ts) parts.push('时间戳');
      console.warn('[AudioDebug] 最近 ' + this.windowSize + 's出现' + total +
        '次性能问题，分别是' + parts.join('、') + '，触发渲染降级');
      applyDegradation(true);
      // 按勾选设置自动展开调试区（不自动收起）
      if(debugEnabled) autoOpenDebugPanel();
    } else if(this.degraded && this.perSecond.length >= this.windowSize && total <= this.RECOVER_AT){
      this.degraded = false;
      console.log('[AudioDebug][OK] 性能问题已缓解，恢复完整渲染。');
      applyDegradation(false);
    }
  }
};

// 渲染 + 音频同步降级/恢复
function applyDegradation(on){
  // 音频：降低复音上限、提高同音重触发下限
  SoundfontLoader.MAX_VOICES = on ? 64 : 128;
  const base = SoundfontLoader.baseRetriggerFloor || 0;
  SoundfontLoader.retriggerFloor = on ? Math.max(base, 0.03) : base;
  // 渲染：降级时把帧率上限临时压到 DEGRADE_FPS_CAP，减少主线程/GPU 负载（比仅抽帧 LOD 更平滑）
  _lastLoopTs = 0;
  _syncFpsCapLabel();
  if(on) console.log('[AudioDebug][INFO] 渲染降级：帧率上限临时降为 ' + _effectiveFpsCap() + 'fps（原 ' + (renderFpsCap || '不限') + '）');
  else console.log('[AudioDebug][INFO] 渲染恢复：帧率上限回到 ' + (renderFpsCap || '不限'));
}

const AudioDebugMonitor = {
  inited: false,
  lastReport: 0,
  frames: 0,          // 本次统计窗口内 playLoop 帧数
  frameMsSum: 0,
  notesTriggered: 0,
  skippedNotes: 0,
  drawMsSum: 0,
  lastFrameAudioTime: 0,
  audioStalls: 0,
  severeDrops: 0,     // 本窗口内帧间隔 >100ms 的严重丢帧次数
  timestampAnomalies: 0, // 音频时钟回退等时间戳异常次数
  lastAt: 0,
  lastAudioTime: 0,
  lastWall: 0,
  rc: null,
  rcAvg: 0,
  rcUnderrun: 0,
  rmsLast: 0,
  rmsMinWindow: 1,
  lastLoudTime: 0,
  _rmsBuf: null,
  lastLiveNodes: null,
  liveGrowthReports: 0,

  init(){
    if(!debugEnabled) return;
    if(this.inited) return;
    this.inited = true;
    this.lastAudioTime = audioCtx ? audioCtx.currentTime : 0;
    this.lastWall = performance.now();

    // AudioRenderCapacity：直接反映音频渲染线程负载，是判断"UI不卡但声音卡"的关键指标
    try{
      if(audioCtx && audioCtx.renderCapacity){
        this.rc = audioCtx.renderCapacity;
        this.rc.onupdate = (e) => {
          this.rcAvg = e.averageLoad;
          this.rcUnderrun = Math.max(this.rcUnderrun, e.underrunRatio);
          if(e.peakLoad > 0.9 || e.underrunRatio > 0.02){
            console.warn('[AudioDebug] 音频渲染线程过载! avg=' + e.averageLoad.toFixed(3) +
              ' peak=' + e.peakLoad.toFixed(3) + ' underrunRatio=' + e.underrunRatio.toFixed(4));
          }
        };
        this.rc.start({updateInterval: 1});
        console.log('[AudioDebug][INFO] renderCapacity 已启用（音频渲染线程负载监控，Chrome 116+）');
      }
      // 不支持 renderCapacity 的浏览器静默跳过（Firefox/Safari 及旧版 Chrome），不再刷日志
    }catch(e){ console.warn('[AudioDebug] renderCapacity 启动失败:', e.message || e); }

    // 主线程长任务监控（>50ms），判断GC/解析是否阻塞主线程
    try{
      if(window.PerformanceObserver){
        new PerformanceObserver((list) => {
          for(const entry of list.getEntries()){
            if(entry.duration > 100){
              console.warn('[AudioDebug] 主线程长任务 ' + entry.duration.toFixed(0) + 'ms');
            }
          }
        }).observe({entryTypes: ['longtask']});
      }
    }catch(e){}
  },

  // 每帧调用：记录帧耗时与触发音符数
  frame(ms, notes){
    if(!debugEnabled) return;
    this.frames++;
    this.frameMsSum += ms;
    this.notesTriggered += notes;
  },

  // 每帧调用：记录 drawScene 耗时
  drawFrame(ms){
    if(!debugEnabled) return;
    this.drawMsSum += ms;
  },

  // 采样实际输出音量（RMS），用于探测"界面在跑但没声音"
  sampleRms(){
    if(!debugEnabled || !outputAnalyser) return;
    const buf = this._rmsBuf || (this._rmsBuf = new Float32Array(outputAnalyser.fftSize));
    outputAnalyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for(let i = 0; i < buf.length; i++){ const v = buf[i]; sum += v * v; }
    const rms = Math.sqrt(sum / buf.length);
    this.rmsLast = rms;
    if(rms < this.rmsMinWindow) this.rmsMinWindow = rms;
    if(rms > 0.001) this.lastLoudTime = performance.now();
  },

  // 主动暂停 / 恢复播放时重置时钟基线：避免恢复后第一次汇总把暂停时长误判为"停摆"
  resetClocks(){
    this.lastWall = performance.now();
    this.lastAudioTime = audioCtx ? audioCtx.currentTime : 0;
    this.lastReport = 0;
    // 主动暂停/停止的间隔不算“停摆”：清掉上一帧音频时钟，
    // 否则恢复播放的首帧会把暂停时长当成长时间停摆并误报
    this.lastFrameAudioTime = 0;
  },

  // 每秒汇总一次
  report(){
    if(!debugEnabled) return;
    if(typeof SoundfontLoader === 'undefined') return;
    const now = performance.now();
    if(now - this.lastReport < 1000) return;
    const winSec = (now - this.lastReport) / 1000;
    this.lastReport = now;

    const at = audioCtx ? audioCtx.currentTime : 0;
    const wallDelta = now - this.lastWall;
    const audioDeltaMs = (at - this.lastAudioTime) * 1000;
    // 页面隐藏时音频被浏览器挂起属正常（相当于自动暂停），不做时钟停摆/输出静音判定
    const visible = (typeof document === 'undefined') || !document.hidden;
    // 音频时钟停摆检测：真实时间在走，但 audioCtx.currentTime 几乎不前进
    if(visible && wallDelta > 1200 && audioDeltaMs < wallDelta * 0.3){
      this.audioStalls++;
      console.warn('[AudioDebug] 音频时钟疑似停摆! wall+' + wallDelta.toFixed(0) +
        'ms 但 audioTime+' + audioDeltaMs.toFixed(0) + 'ms state=' + (audioCtx ? audioCtx.state : 'null'));
    }
    this.lastWall = now;
    this.lastAudioTime = at;

    const d = SoundfontLoader.debug;
    const sampleLive = d.srcCreated - d.onendedFired;
    // 合成钢琴 voice：缓冲区方案用 synthVoices 计数；AudioWorklet 方案用其回报的 voice 数
    const synthLive = SoundfontLoader.synthVoices.length +
      ((typeof _synthWorkletVoices !== 'undefined' && _synthWorkletReady) ? _synthWorkletVoices : 0);
    const liveNodes = sampleLive + synthLive;
    const activeKeys = SoundfontLoader.activeSources.filter(s => s !== null).length;

    // 输出静音探测：仅「欣赏模式」有意义（音符应自动发声）。
    // 音游模式由用户按键决定发声，音符间隔静音属正常，不监测。
    const playing = (typeof isPlaying !== 'undefined') && isPlaying;
    const autoSounding = _autoSoundingMode();
    const silentSec = this.lastLoudTime ? (now - this.lastLoudTime) / 1000 : 0;
    if(autoSounding && playing && visible && this.notesTriggered > 0 && silentSec > 1.5){
      console.warn('[AudioDebug] ★输出静音 ' + silentSec.toFixed(1) + 's 但仍在触发音符! rms=' +
        this.rmsLast.toFixed(6) + ' minRms=' + this.rmsMinWindow.toFixed(6) +
        ' state=' + (audioCtx ? audioCtx.state : 'null') +
        ' liveNodes=' + liveNodes + ' activeKeys=' + activeKeys +
        ' created=' + d.srcCreated + ' ended=' + d.onendedFired);
    }

    // 本秒性能问题计数：严重丢帧 / 音符积压 / 音频时钟停摆 / 时间戳异常
    const fps = this.frames / winSec;
    const stallDelta = this.audioStalls - (this._lastStallCount || 0);
    this._lastStallCount = this.audioStalls;
    if(this.lastAt && at < this.lastAt - 0.001) this.timestampAnomalies++;
    this.lastAt = at;
    const info = {
      drop: this.severeDrops,
      backlog: this.skippedNotes > 0 ? 1 : 0,
      stall: stallDelta,
      ts: this.timestampAnomalies
    };
    info.total = info.drop + info.backlog + info.stall + info.ts;
    if(playing && this.frames > 0){
      PerfArbiter.push(info);
    }
    // 具体告警（折叠机制会限频）
    if(playing && this.skippedNotes > 0){
      console.warn('[AudioDebug] 音符积压：跳过 ' + this.skippedNotes + ' 个');
    }
    // 帧率告警阈值随「帧率上限」自适应：未限速时仍以 30fps 为界，限速 30 时不会误报
    const _fpsCap = _effectiveFpsCap();
    const _fpsFloor = Math.min(30, (_fpsCap || 60) * 0.7);
    if(playing && this.frames > 0 && fps < _fpsFloor){
      console.warn('[AudioDebug][WARN] 帧率偏低 fps=' + fps.toFixed(0) +
        ' 预期' + (_fpsCap || 60) + 'fps' +
        ' drawMs=' + (this.drawMsSum / this.frames).toFixed(1) +
        ' schedMs=' + (this.frameMsSum / this.frames).toFixed(1));
    }
    // 清零本秒问题计数
    this.severeDrops = 0;
    this.timestampAnomalies = 0;

    // 不再输出周期性汇总；仅在异常/降级/恢复时输出 warn 或 info
    // 存活节点持续增长 = 泄漏信号（onended 未触发 / disconnect 未执行）
    if(this.lastLiveNodes != null && liveNodes > this.lastLiveNodes + 50){
      this.liveGrowthReports++;
      if(this.liveGrowthReports >= 3){
        console.warn('[AudioDebug] 存活节点持续增长! live=' + liveNodes +
          '（疑似泄漏：onended未触发或disconnect未执行）');
        this.liveGrowthReports = 0;
      }
    } else {
      this.liveGrowthReports = 0;
    }
    this.lastLiveNodes = liveNodes;
    // 窗口统计清零
    this.frames = 0; this.frameMsSum = 0;
    this.notesTriggered = 0; this.skippedNotes = 0;
    this.drawMsSum = 0;
    this.rmsMinWindow = 1;
  }
};
// 是否处于「音符应自动发声」的模式（欣赏模式）；音游模式不监测输出静音
function _autoSoundingMode(){
  try{ return typeof playMode === 'undefined' || playMode === 'appreciate'; }catch(e){ return true; }
}
// 仅在播放时运行诊断，暂停时不做无谓的采样与汇总
setInterval(() => {
  if(debugEnabled && typeof isPlaying !== 'undefined' && isPlaying){
    AudioDebugMonitor.report();
    SoundfontLoader.debugReport();
  }
}, 1000);
setInterval(() => {
  if(debugEnabled && typeof isPlaying !== 'undefined' && isPlaying) AudioDebugMonitor.sampleRms();
}, 200);


/* ============================================================
 * 2. 音色加载器（Soundfont + Cache API）
 * ========================================================== */
// 静态资源缓存（MIDI谱等），版本化缓存名
const AssetCache = {
  cacheName: 'midi-player-assets-v1',
  // 统一转绝对路径，避免相对路径在不同URL下解析不同导致缓存失效
  _abs(url){ return new URL(url, window.location.href).href; },
  async fetch(url) {
    const absUrl = this._abs(url);
    try {
      const cache = await caches.open(this.cacheName);
      // ignoreSearch忽略查询参数，提高匹配率
      const cached = await cache.match(absUrl, {ignoreSearch: true});
      if (cached) return cached.clone();
      const resp = await fetch(url);
      if (resp.ok) cache.put(absUrl, resp.clone());
      return resp;
    } catch(e) {
      return fetch(url);
    }
  },
  // 仅查缓存（不发起网络请求）：用于判断谱面是否已下载
  async has(url) {
    try{
      const cache = await caches.open(this.cacheName);
      const cached = await cache.match(this._abs(url), {ignoreSearch: true});
      return !!cached;
    }catch(e){ return false; }
  },
  // 列表等需要"每次最新"的资源：始终走网络，命中后更新缓存，避免旧列表残留
  async fetchFresh(url) {
    const absUrl = this._abs(url);
    const resp = await fetch(url, {cache: 'no-store'});
    try{
      const cache = await caches.open(this.cacheName);
      if(resp.ok) cache.put(absUrl, resp.clone());
    }catch(e){}
    return resp;
  }
};
// 清理旧版本资产缓存（例如曾用过的 v2），避免残留占用空间
try{
  if(window.caches && caches.keys){
    caches.keys().then(keys => keys.forEach(k => {
      if(k.indexOf('midi-player-assets-') === 0 && k !== AssetCache.cacheName) caches.delete(k);
    })).catch(() => {});
  }
}catch(e){}

// ===== 媒体源：多个国内可用镜像 + 本站 Pages 兜底，完整下载竞速 =====
// 中国大陆访问各镜像速度差异大：同一资源同时向所有镜像发起「完整下载」，最先完成者胜出，
// 其余立即 abort 并丢弃不完整分片。冷启动管线保证同一时刻只竞速一个资源，避免多资源抢带宽。
const REPO_GH = 'teecatt/teecatt.github.io';
const REPO_REF = 'master';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO_GH + '/' + REPO_REF + '/';
const _encPath = p => String(p).split('/').map(encodeURIComponent).join('/');
// prefix 同时用于拼接与来源识别；资源 URL = prefix + encode('midi_player/' + 相对路径)
const CDN_BASES = [
  { name: 'jsDelivr',        prefix: 'https://cdn.jsdelivr.net/gh/' + REPO_GH + '@' + REPO_REF + '/' },
  { name: 'jsDelivr-Fastly', prefix: 'https://fastly.jsdelivr.net/gh/' + REPO_GH + '@' + REPO_REF + '/' },
  { name: 'jsDelivr-Gcore',  prefix: 'https://gcore.jsdelivr.net/gh/' + REPO_GH + '@' + REPO_REF + '/' },
  { name: 'jsDelivr-CF',     prefix: 'https://testingcf.jsdelivr.net/gh/' + REPO_GH + '@' + REPO_REF + '/' },
  { name: 'ghproxy.net',     prefix: 'https://ghproxy.net/' + RAW_BASE },
  { name: 'gh-proxy.com',    prefix: 'https://gh-proxy.com/' + RAW_BASE },
  { name: 'ghfast.top',      prefix: 'https://ghfast.top/' + RAW_BASE },
  { name: 'gh.llkk.cc',      prefix: 'https://gh.llkk.cc/' + RAW_BASE },
  { name: 'gh.xxooo.cf',     prefix: 'https://gh.xxooo.cf/' + RAW_BASE },
  { name: 'statically',      prefix: 'https://cdn.statically.io/gh/' + REPO_GH + '/' + REPO_REF + '/' },
  { name: 'githack',         prefix: 'https://raw.githack.com/' + REPO_GH + '/' + REPO_REF + '/' },
];
// midi_player 内的相对路径 -> [各镜像..., 本站同源 Pages 兜底]
function _mediaUrls(relPath){
  const clean = String(relPath).replace(/^\.\//, '');
  const enc = _encPath('midi_player/' + clean);
  const urls = CDN_BASES.map(b => b.prefix + enc);
  urls.push(clean);
  return urls;
}
// 从 URL 推断可读来源名（用于日志/状态区）
function _sourceLabel(url){
  const u = String(url);
  if(u.indexOf('://') < 0) return 'Pages';
  for(const b of CDN_BASES){ if(u.indexOf(b.prefix) === 0) return b.name; }
  try{ return new URL(u).hostname; }catch(e){ return '备用源'; }
}
// 完整下载竞速开关（默认开）：开=所有镜像同时完整下载、最快完成者胜出；
// 关=仅竞速首字节响应，胜出源再流式读取。
let raceFullDownload = true;
try{
  const _rf = localStorage.getItem('raceFull');
  if(_rf !== null) raceFullDownload = _rf === '1';
  const _rfEl = document.getElementById('raceFullSw');
  if(_rfEl) _rfEl.checked = raceFullDownload;
}catch(e){}
function onRaceFullChange(){
  const cb = document.getElementById('raceFullSw');
  raceFullDownload = !!(cb && cb.checked);
  try{ localStorage.setItem('raceFull', raceFullDownload ? '1' : '0'); }catch(e){}
}
// Promise.any 兼容封装：返回最先成功的结果；全部失败时抛出含 errors 数组的对象
function _promiseAny(ps){
  if(typeof Promise.any === 'function') return Promise.any(ps);
  return new Promise((resolve, reject) => {
    let pending = ps.length; const errs = [];
    if(!pending) return reject(new Error('无可用源'));
    ps.forEach((p, i) => Promise.resolve(p).then(resolve, e => { errs[i] = e; if(--pending === 0) reject({ errors: errs }); }));
  });
}
// 并发择优：同时请求所有候选源，最先成功返回响应的胜出，其余候选 abort（首字节竞速模式用）
async function _raceFetch(urls){
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if(!list.length) throw new Error('无可用源');
  const hasAbort = (typeof AbortController !== 'undefined');
  const controllers = list.map(() => hasAbort ? new AbortController() : null);
  const attempts = list.map((url, i) => (async () => {
    const resp = await fetch(url, controllers[i] ? { signal: controllers[i].signal } : undefined);
    if(!resp.ok) throw new Error('HTTP ' + resp.status);
    return { resp, i, url };
  })());
  let winner;
  try{
    winner = await _promiseAny(attempts);
  }catch(agg){
    const errs = (agg && agg.errors) || [];
    const first = errs.find(e => e);
    throw (first instanceof Error) ? first : new Error('全部源下载失败');
  }
  controllers.forEach((c, i) => { if(c && i !== winner.i){ try{ c.abort(); }catch(e){} } });
  return { resp: winner.resp, url: winner.url, index: winner.i, list };
}
// 流式读取响应为 Blob 并回报百分比（首字节竞速模式用）
async function _readBlobWithProgress(resp, onProgress){
  const total = (resp.headers && resp.headers.get) ? parseInt(resp.headers.get('content-length') || '0', 10) : 0;
  if(!resp.body || !total || !resp.body.getReader){
    const blob = new Blob([await resp.arrayBuffer()]);
    if(onProgress) onProgress(100);
    return blob;
  }
  const reader = resp.body.getReader();
  const chunks = []; let received = 0;
  while(true){
    const {done, value} = await reader.read();
    if(done) break;
    chunks.push(value); received += value.length;
    if(onProgress) onProgress(received / total * 100);
  }
  const blob = new Blob(chunks);
  if(onProgress) onProgress(100);
  return blob;
}
// 单源：完整下载为 Blob（流式回报 (received, total)；中止/失败时丢弃已收分片）
async function _downloadBlobFrom(url, onProgress, signal){
  const resp = await fetch(url, signal ? { signal } : undefined);
  if(!resp.ok) throw new Error('HTTP ' + resp.status);
  const total = (resp.headers && resp.headers.get) ? parseInt(resp.headers.get('content-length') || '0', 10) : 0;
  if(!resp.body || !total || !resp.body.getReader){
    const blob = new Blob([await resp.arrayBuffer()]);
    if(onProgress) onProgress(blob.size, total > 0 ? total : blob.size);
    return blob;
  }
  const reader = resp.body.getReader();
  let chunks = []; let received = 0;
  try{
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      chunks.push(value); received += value.length;
      if(onProgress) onProgress(received, total);
    }
  }catch(e){
    chunks = null; // 中止/失败：清理该镜像的不完整分片
    throw e;
  }
  if(onProgress) onProgress(received, total > 0 ? total : received);
  return new Blob(chunks);
}
// 完整下载竞速（公共能力）：所有镜像同时完整下载，最先完成者胜出；其余立即 abort 并丢弃不完整分片。
// 进行中每 0.5s 覆盖一行进度；完成后由 _raceLogFinal 固化为最终性能行（保留，不被刷掉）。
async function _raceDownloadFull(list, onProgress, label){
  if(!list.length) throw new Error('无可用源');
  const hasAbort = (typeof AbortController !== 'undefined');
  const controllers = list.map(() => hasAbort ? new AbortController() : null);
  const states = list.map(url => ({ src: _sourceLabel(url), received: 0, total: 0, failed: false }));
  const tag = label || '文件';
  const t0 = performance.now();
  let lastLog = 0, bestPct = 0, done = false;
  const report = () => {
    if(done) return;
    const now = performance.now();
    if(now - lastLog < 500) return; // 每 0.5s 一次
    lastLog = now;
    let lead = null;
    for(const s of states){ if(!s.failed && (!lead || s.received > lead.received)) lead = s; }
    if(!lead || lead.received <= 0) return;
    const elapsed = Math.max((now - t0) / 1000, 0.001);
    const speed = lead.received / elapsed / 1024;
    const pctTxt = lead.total > 0 ? (lead.received / lead.total * 100).toFixed(0) + '%' : '?';
    _raceLog('竞速[' + tag + '] 领先: [' + lead.src + '] ' + _fmtSize(lead.received) + '/' +
      (lead.total > 0 ? _fmtSize(lead.total) : '?') + ' ~ ' + pctTxt + ' 平均' + speed.toFixed(0) + 'KB/s');
  };
  const attempts = list.map((url, i) => _downloadBlobFrom(
    url,
    (received, total) => {
      states[i].received = received; states[i].total = total;
      if(total > 0){
        const pct = received / total * 100;
        if(pct > bestPct){ bestPct = pct; if(onProgress) onProgress(bestPct); }
      }
      report();
    },
    controllers[i] ? controllers[i].signal : null
  ).then(blob => ({ blob, i, url }), err => { states[i].failed = true; throw err; }));
  let winner;
  try{
    winner = await _promiseAny(attempts);
  }catch(agg){
    done = true;
    _raceLogFinal('竞速[' + tag + '] 全部镜像失败');
    const errs = (agg && agg.errors) || [];
    const first = errs.find(e => e);
    throw (first instanceof Error) ? first : new Error('全部源下载失败');
  }
  done = true;
  controllers.forEach((c, i) => { if(c && i !== winner.i){ try{ c.abort(); }catch(e){} } });
  if(onProgress) onProgress(100);
  const secs = (performance.now() - t0) / 1000;
  const avg = winner.blob.size / Math.max(secs, 0.001) / 1024;
  _raceLogFinal('竞速[' + tag + '] 完成 <- [' + _sourceLabel(winner.url) + '] ' +
    _fmtSize(winner.blob.size) + ' 用时' + secs.toFixed(2) + 's 平均' + avg.toFixed(0) + 'KB/s');
  try{ winner.blob._netSize = states[winner.i].total || winner.blob.size; }catch(e){}
  return { blob: winner.blob, url: winner.url, index: winner.i };
}
// 首字节竞速（开关关闭时）：胜出源流式读取，若读取中途失败则按顺序回退其余候选
async function _fetchByFirstByte(list, onProgress, label, quiet){
  const tag = label || '文件';
  const winner = await _raceFetch(list);
  const order = [winner.index, ...list.map((_, i) => i).filter(i => i !== winner.index)];
  let lastErr;
  const t0 = performance.now();
  for(const idx of order){
    try{
      let resp;
      if(idx === winner.index){ resp = winner.resp; }
      else { resp = await fetch(list[idx]); if(!resp.ok) throw new Error('HTTP ' + resp.status); }
      const blob = await _readBlobWithProgress(resp, onProgress);
      try{
        const net = parseInt((resp.headers && resp.headers.get) ? (resp.headers.get('content-length') || '0') : '0', 10);
        blob._netSize = net > 0 ? net : blob.size;
      }catch(e){ blob._netSize = blob.size; }
      const secs = (performance.now() - t0) / 1000;
      // 不再额外打「下载成功」蓝字：竞速最终行已含来源/体积/速度/文件名
      _raceLogFinal('竞速[' + tag + '] 完成 <- [' + _sourceLabel(list[idx]) + '] ' +
        _fmtSize(blob.size) + ' 用时' + secs.toFixed(2) + 's');
      return blob;
    }catch(e){
      lastErr = e; if(onProgress) onProgress(0);
      if(!quiet) console.log('[AudioDebug][INFO] ' + tag + '从' + _sourceLabel(list[idx]) + '下载失败');
    }
  }
  _raceLogFinal('竞速[' + tag + '] 全部镜像失败');
  throw lastErr || new Error('下载失败');
}
// 下载入口：默认「完整下载竞速」，可在设置面板关闭改用「首字节竞速」
async function _fetchBlobWithProgress(urls, onProgress, label, quiet){
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if(raceFullDownload){
    try{
      // 竞速最终行已含来源/体积/速度/文件名，不再重复打「下载成功」蓝字
      const res = await _raceDownloadFull(list, onProgress, label);
      return res.blob;
    }catch(e){
      if(!quiet) console.log('[AudioDebug][INFO] ' + (label || '文件') + '全部镜像下载失败：' + (e && e.message ? e.message : e));
      throw e;
    }
  }
  return _fetchByFirstByte(list, onProgress, label, quiet);
}

// ===== 谱面压缩传输：只传 brotli（.mid.br），客户端解压 =====
// 仓库已删除原始 .mid 与 .gz：传输一律使用 br 压缩后的文件（体积最小）。
// 解压优先原生 DecompressionStream('brotli')；不支持时惰性加载自定义 WASM 解码器。
const _NATIVE_BROTLI = (function(){
  try{ if(typeof DecompressionStream === 'function'){ new DecompressionStream('brotli'); return true; } }catch(e){}
  return false;
})();
const _NATIVE_GZIP = (function(){
  try{ if(typeof DecompressionStream === 'function'){ new DecompressionStream('gzip'); return true; } }catch(e){}
  return false;
})();
let _brotliWasmMod = null;
let _brotliWasmLoading = null;
// 惰性加载自定义 WASM brotli 解码器；返回模块（decompress(Uint8Array)->Uint8Array）
async function _loadBrotliWasm(){
  if(_brotliWasmMod) return _brotliWasmMod;
  if(_brotliWasmLoading) return _brotliWasmLoading;
  _brotliWasmLoading = (async () => {
    console.log('[AudioDebug][INFO] br 解码器：原生不支持，开始加载自定义 WASM 解码器');
    const mod = await import('./vendor/brotli_dec_wasm.js');
    console.log('[AudioDebug][INFO] br 解码器：JS 模块已加载，开始竞速下载 brotli_dec_wasm_bg.wasm');
    // WASM 二进制同样走多镜像完整下载竞速（竞速结果会打印来源/体积/速度/文件名）
    const wasmBlob = await _fetchBlobWithProgress(
      _mediaUrls('vendor/brotli_dec_wasm_bg.wasm'), null,
      'WASM[brotli_dec_wasm_bg.wasm]', true);
    const wasmBuf = await wasmBlob.arrayBuffer();
    console.log('[AudioDebug][INFO] br 解码器：初始化 WASM (' + _fmtSize(wasmBuf.byteLength) + ')…');
    await mod.default({ module_or_path: wasmBuf });
    _brotliWasmMod = mod;
    console.log('[AudioDebug][INFO] br 解码器：WASM 解码器就绪');
    return mod;
  })();
  try{ return await _brotliWasmLoading; }
  finally{ _brotliWasmLoading = null; }
}
// 校验是否为 MIDI 文件头 "MThd"
function _looksLikeMidi(buf){
  if(!buf || buf.byteLength < 4) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x4D && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;
}
// 原生 DecompressionStream 解压；写入与读取并发，避免背压死锁
async function _decompressNative(ab, fmt){
  const ds = new DecompressionStream(fmt);
  const writer = ds.writable.getWriter();
  const writeP = writer.write(new Uint8Array(ab)).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks = []; let total = 0;
  for(;;){
    const r = await reader.read();
    if(r.done) break;
    chunks.push(r.value); total += r.value.length;
  }
  await writeP;
  const out = new Uint8Array(total); let off = 0;
  for(const c of chunks){ out.set(c, off); off += c.length; }
  return out.buffer;
}
// brotli 解压：原生优先，否则 WASM
async function _decompressBrotli(ab){
  if(_NATIVE_BROTLI) return _decompressNative(ab, 'brotli');
  const mod = await _loadBrotliWasm();
  const out = mod.decompress(new Uint8Array(ab));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
try{
  console.log('[AudioDebug][INFO] br 解压支持：原生 DecompressionStream(brotli)=' + _NATIVE_BROTLI +
    '，原生 gzip=' + _NATIVE_GZIP + (_NATIVE_BROTLI ? '（无需 WASM）' : '（将使用自定义 WASM 解码器）'));
  const _brEl = document.getElementById('brSupportInfo');
  if(_brEl) _brEl.textContent = 'br 解压：' + (_NATIVE_BROTLI
    ? '原生支持 DecompressionStream(brotli)'
    : '原生不支持 → 使用自定义 WASM 解码器');
}catch(e){}
// 谱面下载：只取 .mid.br，客户端解压（原文已删除，不再回退）
async function _fetchMediaBlob(relPath, onProgress, quiet){
  if(!/\.midi?$/i.test(relPath)){
    return _fetchBlobWithProgress(_mediaUrls(relPath), onProgress, _songLabel(relPath), quiet);
  }
  const label = _songLabel(relPath + '.br');
  const blob = await _fetchBlobWithProgress(_mediaUrls(relPath + '.br'), onProgress, label, quiet);
  const ab = await blob.arrayBuffer();
  // 服务端若已按 Content-Encoding 自动解压，则已是 MIDI，直接用
  if(_looksLikeMidi(ab)){
    if(!quiet) console.log('[AudioDebug][INFO] ' + label + ' 服务端已自动解压，未压缩体积 ' + _fmtSize(ab.byteLength));
    return new Blob([ab]);
  }
  const out = await _decompressBrotli(ab);
  if(!_looksLikeMidi(out)) throw new Error('br 解压结果不是有效 MIDI');
  if(!quiet){
    const ratio = out.byteLength / ab.byteLength;
    const saved = (1 - ab.byteLength / out.byteLength) * 100;
    console.log('[AudioDebug][INFO] ' + label + ' br解压 ' + _fmtSize(ab.byteLength) + ' -> ' +
      _fmtSize(out.byteLength) + '（压缩比 ' + ratio.toFixed(1) + '×，传输节省 ' + saved.toFixed(1) + '%）');
  }
  return new Blob([out]);
}

// 合成钢琴「预渲染」：解析式预计算每个音高的无缝循环波形，直接作为 AudioBuffer
// 交给 BufferSource 播放，与采样音色同构（每音符 1 Source + 1 Gain）。
// 相比旧的「每音符 1 振荡器 + PeriodicWave」：
//   ① 缓冲区采样率 = AudioContext.sampleRate，播放时零重采样
//      （采样音色由 decodeAudioData 一次性重采样到 ctx 采样率，播放时同样零重采样，
//        故二者播放开销相当）；
//   ② 单声道、全部 88 音仅约 130KB，无需 decodeAudioData、无需 OfflineAudioContext；
//   ③ 每音高按 Nyquist 限制谐波数，天然无混叠；
//   ④ 循环体内各谐波均为整数周期，循环点无缝，无爆音。
// 力度/时长仍由动态包络 Gain 控制，音色与旧实现一致。
const SYNTH_HARMONICS = 16;
const SYNTH_LOOP_MIN_SAMPLES = 96; // 高音区保证每个循环至少这么多采样，降低相位量化误差
let _synthLoopBuffers = null;      // midi -> AudioBuffer
function _getSynthLoopBuffers(){
  if(_synthLoopBuffers) return _synthLoopBuffers;
  const sr = audioCtx.sampleRate;
  const amp = new Float32Array(SYNTH_HARMONICS + 1);
  // 三角波奇次谐波（幅度 ∝ 1/n²，符号交替），基频归一为 0.9
  for(let n = 1; n <= SYNTH_HARMONICS; n += 2){
    const sign = (n % 4 === 1) ? 1 : -1;
    amp[n] += 0.9 * sign / (n * n);
  }
  // 叠加原实现的两个正弦泛音：2 次 0.35、3 次 0.18
  amp[2] += 0.35;
  amp[3] += 0.18;
  const map = {};
  const nyq = sr / 2;
  const twoPi = 2 * Math.PI;
  for(let midi = 21; midi <= 108; midi++){
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const period = sr / f;
    const cycles = Math.max(1, Math.ceil(SYNTH_LOOP_MIN_SAMPLES / period));
    const N = Math.max(8, Math.round(period * cycles));
    const kmax = Math.min(SYNTH_HARMONICS, Math.floor(nyq / f));
    const buf = audioCtx.createBuffer(1, N, sr);
    const data = buf.getChannelData(0);
    for(let i = 0; i < N; i++){
      let s = 0;
      for(let k = 1; k <= kmax; k++){
        const a = amp[k];
        if(a) s += a * Math.sin(twoPi * k * cycles * i / N);
      }
      data[i] = s;
    }
    map[midi] = buf;
  }
  _synthLoopBuffers = map;
  let samples = 0;
  for(const k in map) samples += map[k].length;
  console.log('[AudioDebug][INFO] 合成钢琴预渲染完成：88 音，共 ' + (samples * 4 / 1024).toFixed(0) +
    'KB 单声道 @ ' + (sr / 1000).toFixed(1) + 'kHz（与 AudioContext 同采样率，播放零重采样）');
  return map;
}

// 兜底：极端情况下若无法创建 AudioBuffer，退回单振荡器 PeriodicWave 方案
let _synthPeriodicWave = null;
function _getSynthPeriodicWave(){
  if(_synthPeriodicWave) return _synthPeriodicWave;
  const real = new Float32Array(SYNTH_HARMONICS + 1);
  const imag = new Float32Array(SYNTH_HARMONICS + 1);
  for(let n = 1; n <= SYNTH_HARMONICS; n += 2){
    const sign = (n % 4 === 1) ? 1 : -1;
    imag[n] += 0.9 * sign / (n * n);
  }
  imag[2] += 0.35;
  imag[3] += 0.18;
  // disableNormalization:true 保持与旧「三振荡器叠加」一致的谐波幅度
  _synthPeriodicWave = audioCtx.createPeriodicWave(real, imag, {disableNormalization: true});
  return _synthPeriodicWave;
}

// ===== 合成钢琴 AudioWorklet（渐进增强）=====
// 把整个合成器放进一个 AudioWorkletProcessor：所有 voice 在同一节点内以数值合成，
// 每音符 0 个 Web Audio 节点、零节点创建/销毁、零 GC —— 比采样音色更抗卡顿。
// 处理器源码用 Blob URL 内联，不产生额外网络请求；就绪前/失败时回退上面的预渲染缓冲区方案。
const SYNTH_WORKLET_SRC = `
class SynthProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.voices = [];
    this.tables = [];
    this.tableSize = 2048;
    this.maxVoices = 128;
    this._buildTables();
    this.port.onmessage = (e) => this._onMsg(e.data);
    this._reportAcc = 0;
  }
  // 每八度一张波形表，谐波按该八度最高音的 Nyquist 限幅，避免混叠
  _buildTables(){
    const H = 16;
    const amp = new Float32Array(H + 1);
    for(let n = 1; n <= H; n += 2){ const s = (n % 4 === 1) ? 1 : -1; amp[n] += 0.9 * s / (n * n); }
    amp[2] += 0.35; amp[3] += 0.18;
    const N = this.tableSize;
    for(let oct = 0; oct < 10; oct++){
      const fTop = 27.5 * Math.pow(2, oct + 1);
      const kmax = Math.max(1, Math.min(H, Math.floor((sampleRate / 2) / fTop)));
      const t = new Float32Array(N + 1);
      for(let i = 0; i < N; i++){
        let s = 0;
        for(let k = 1; k <= kmax; k++){ const a = amp[k]; if(a) s += a * Math.sin(2 * Math.PI * k * i / N); }
        t[i] = s;
      }
      t[N] = t[0];
      this.tables.push(t);
    }
  }
  _tableFor(freq){
    let oct = Math.floor(Math.log2(Math.max(1e-6, freq / 27.5)));
    if(oct < 0) oct = 0; if(oct > 9) oct = 9;
    return this.tables[oct];
  }
  _onMsg(m){
    if(!m) return;
    if(m.type === 'note'){
      if(this.voices.length >= this.maxVoices) this.voices.shift();
      const freq = m.freq > 0 ? m.freq : 440;
      this.voices.push({
        midi: m.midi, table: this._tableFor(freq), phase: 0,
        inc: freq * this.tableSize / sampleRate,
        vel: Math.max(0.0001, m.vel || 0.4), dur: Math.max(0.01, m.dur || 0.5),
        t: 0, releasing: false
      });
    } else if(m.type === 'off'){
      for(let i = 0; i < this.voices.length; i++){ if(this.voices[i].midi === m.midi) this.voices[i].releasing = true; }
    } else if(m.type === 'allOff'){
      this.voices.length = 0;
    }
  }
  process(inputs, outputs){
    const out = outputs[0] && outputs[0][0];
    if(!out) return true;
    const N = out.length;
    for(let i = 0; i < N; i++) out[i] = 0;
    const ts = this.tableSize, sr = sampleRate, attack = 0.008;
    for(let vi = this.voices.length - 1; vi >= 0; vi--){
      const v = this.voices[vi];
      const table = v.table, vel = v.vel, dur = v.dur;
      const decayRatio = 0.0008 / vel;
      for(let i = 0; i < N; i++){
        v.t += 1 / sr;
        let env;
        if(v.t < attack){ env = vel * (v.t / attack); }
        else {
          const p = Math.min(1, (v.t - attack) / Math.max(0.001, dur - attack));
          env = vel * Math.pow(decayRatio, p);
        }
        if(v.releasing) env *= 0.85;
        const idx = v.phase | 0;
        const frac = v.phase - idx;
        const s0 = table[idx], s1 = table[idx + 1];
        out[i] += (s0 + (s1 - s0) * frac) * env;
        v.phase += v.inc;
        if(v.phase >= ts) v.phase -= ts;
      }
      if(v.releasing || v.t > dur + 0.05) this.voices.splice(vi, 1);
    }
    this._reportAcc += N;
    if(this._reportAcc >= sr * 0.5){ this._reportAcc = 0; this.port.postMessage({ type: 'voices', n: this.voices.length }); }
    return true;
  }
}
registerProcessor('synth-processor', SynthProcessor);
`;
let _synthWorkletNode = null;
let _synthWorkletReady = false;
let _synthWorkletLoading = null;
let _synthWorkletFailed = false;
let _synthWorkletVoices = 0;
// 调试面板：显示当前合成钢琴实际走的是哪条路径
function _updateSynthPathInfo(){
  const el = document.getElementById('synthPathInfo');
  if(!el) return;
  let txt;
  if(_synthWorkletReady) txt = 'AudioWorklet（每音符 0 节点，最抗卡顿）';
  else if(_synthWorkletFailed) txt = '预渲染缓冲区（AudioWorklet 不可用，已回退）';
  else if(_synthWorkletLoading) txt = 'AudioWorklet 加载中…（暂用预渲染缓冲区）';
  else txt = '预渲染缓冲区（AudioWorklet 未初始化）';
  el.textContent = '合成钢琴：' + txt;
}
function _initSynthWorklet(){
  if(_synthWorkletReady || _synthWorkletLoading) return _synthWorkletLoading;
  if(!audioCtx || !audioCtx.audioWorklet){
    _synthWorkletFailed = true; _updateSynthPathInfo();
    return null;
  }
  _synthWorkletLoading = (async () => {
    const blob = new Blob([SYNTH_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try{ await audioCtx.audioWorklet.addModule(url); }
    finally{ try{ URL.revokeObjectURL(url); }catch(e){} }
    const node = new AudioWorkletNode(audioCtx, 'synth-processor', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]
    });
    node.port.onmessage = (e) => { if(e.data && e.data.type === 'voices') _synthWorkletVoices = e.data.n; };
    node.connect(masterGain);
    _synthWorkletNode = node;
    _synthWorkletReady = true;
    _updateSynthPathInfo();
    console.log('[AudioDebug][INFO] 合成钢琴 AudioWorklet 已启用（每音符 0 节点、无节点 churn）');
    return node;
  })().catch((e) => {
    console.warn('[AudioDebug][WARN] AudioWorklet 初始化失败，回退预渲染缓冲区方案：' + (e && e.message ? e.message : e));
    _synthWorkletFailed = true;
    _synthWorkletLoading = null;
    _updateSynthPathInfo();
    return null;
  });
  _updateSynthPathInfo();
  return _synthWorkletLoading;
}

const SoundfontLoader = {
  cacheName: 'midi-player-soundfont-cache-v1',
  cdnBase: './soundfonts/',
  loaded: {},
  current: '__synth__',
  cachedNames: new Set(), // 已写入缓存的音色名（供音色列表同步显示下载/删除状态）
  loading: null,
  noteToMidi: {},
  activeSources: new Array(109).fill(null),
  synthVoices: [], // 合成钢琴分支的音源节点，登记以便 stopAll 能停掉
  activeSynth: {}, // midi -> synth voice，用于同音打断
  activeVoices: [], // 全局活跃voice（sample+synth），用于复音上限与抢占
  MAX_VOICES: 128,  // 全局复音上限，防止音频线程过载
  lastTriggerTime: new Array(109).fill(0), // 每音高上次触发时间（audio time）
  retriggerFloor: 0, // 自适应同音重触发下限（秒）；高密度谱面下 >0，用于限制节点创建率
  baseRetriggerFloor: 0, // 未降级时的基准下限，降级/恢复时据此调整
  // ===== 调试统计 =====
  debug: {
    playNoteCalls: 0,
    srcCreated: 0,
    onendedFired: 0,
    errors: 0,
    lastReportTime: 0,
    lastState: 'running',
    lastLeakWarn: 0,         // 上次泄漏告警时的存活节点数
    bufferNullLogged: false, // 是否已打印过 buffer 为 null 的告警
    synthWarned: false,      // 是否已打印过回退合成钢琴的告警
  },
  timbreGain: { 'acoustic_grand_piano': 10.0, 'clavinet': 5.0 }, // 硬编码音色增益：三角钢琴1000%, 古钢琴500%

  init(){
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    for(let oct = 0; oct <= 8; oct++){
      for(let i = 0; i < 12; i++){
        const midi = oct * 12 + i + 12;
        if(midi >= 21 && midi <= 108) this.noteToMidi[names[i] + oct] = midi;
      }
    }
  },

  async load(name, onProgress, opts){
    const switchCurrent = !opts || opts.switchCurrent !== false;
    if(name === '__synth__'){ this.current = '__synth__'; return; }
    if(this.loaded[name] && this.loaded[name].ready){ if(switchCurrent) this.current = name; return; }
    if(this.loading) await this.loading;
    this.loading = this._doLoad(name, onProgress);
    await this.loading;
    this.loading = null;
    if(switchCurrent) this.current = name;
  },

  // 校验内容是否为合法音色 JS：防止把 HTML 错误页或截断文件当 JS 解析
  _isSoundfontText(text, name){
    if(!text || text.length < 1024) return false;
    if(text.indexOf('MIDI.Soundfont') < 0) return false;
    if(text.indexOf(name) < 0) return false;
    return /}\s*$/.test(text); // 截断文件停在 base64 中间，结尾无 }
  },

  // 解析音色文本；失败时抛出带诊断信息的错误（而非笼统的 token 错误）
  _parseSoundfont(text, name){
    let raw;
    try{
      const MIDI = { Soundfont: {} };
      const fn = new Function('MIDI', text + '\nreturn MIDI.Soundfont["' + name + '"];');
      raw = fn(MIDI);
    }catch(e){
      throw new Error('音色内容不是合法JS（疑似截断或错误页）: ' +
        text.slice(0, 80).replace(/\s+/g, ' '));
    }
    if(!raw || typeof raw !== 'object') throw new Error('音色数据解析失败');
    return raw;
  },

  // 读取音色文本：优先缓存（内容校验通过），否则走网络并回写缓存
  async _fetchSoundfontText(name, urls, absUrl, cache, onProgress){
    if(typeof urls === 'string') urls = [urls];
    if(cache){
      try{
        const cached = await cache.match(absUrl, {ignoreSearch: true});
        if(cached){
          const t = await cached.text();
          if(this._isSoundfontText(t, name)){ if(onProgress) onProgress(1); return { text: t, fromCache: true, source: '缓存' }; }
          // 坏缓存：删除该条，强制走网络，避免永久命中
          await cache.delete(absUrl);
          console.warn('[AudioDebug][WARN] 检测到损坏的音色缓存并已清除: ' + _timbreLabel(name));
        }
      }catch(e){}
    }
    // 多镜像完整下载竞速获取音色文本（进度 0..1）
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    const source = '竞速镜像';
    let text, netSize = 0;
    try{
      const blob = await _fetchBlobWithProgress(list, (p) => {
        if(onProgress) onProgress(p / 100);
      }, _timbreLabel(name), true);
      netSize = blob._netSize || blob.size;
      text = await blob.text();
      if(onProgress) onProgress(1);
    }catch(e){
      console.warn('[AudioDebug][WARN] ' + _timbreLabel(name) + '下载失败：' + (e && e.message ? e.message : e));
      throw e;
    }
    if(!this._isSoundfontText(text, name)){
      throw new Error('音色文件内容异常（非JS，可能被截断或网络返回错误页）: ' +
        text.slice(0, 80).replace(/\s+/g, ' '));
    }
    if(cache){
      // 直接用已校验的 text 构造 Response 写缓存：
      // 旧写法 text=await resp.text() 后再 resp.clone() 会因 body 已消费而抛错，
      // 导致好响应永远写不进缓存。
      const mk = () => new Response(text, {headers: {'Content-Type': 'application/javascript; charset=utf-8'}});
      try{
        await cache.put(absUrl, mk());
      }catch(e){
        // 存储空间不足时，清理一半旧缓存后重试
        try{
          const keys = await cache.keys();
          for(let i = 0; i < Math.floor(keys.length / 2); i++) await cache.delete(keys[i]);
          await cache.put(absUrl, mk());
        }catch(e2){}
      }
    }
    return { text: text, fromCache: false, source: source, netSize: netSize };
  },

  // 扫描音色缓存，重建 cachedNames 集合
  async refreshCachedNames(){
    const set = new Set();
    try{
      const cache = await caches.open(this.cacheName);
      const keys = await cache.keys();
      keys.forEach(req => {
        const m = req.url.match(/\/soundfonts\/(.+)-ogg\.js(?:\?.*)?$/);
        if(m) set.add(decodeURIComponent(m[1]));
      });
    }catch(e){}
    this.cachedNames = set;
    return set;
  },

  // 删除已缓存的音色（正在使用的音色不可删除）
  async deleteCached(name){
    if(this.current === name) throw new Error('正在使用该音色，无法删除');
    const url = this.cdnBase + name + '-ogg.js';
    const absUrl = new URL(url, window.location.href).href;
    try{
      const cache = await caches.open(this.cacheName);
      await cache.delete(absUrl, {ignoreSearch: true});
    }catch(e){}
    this.cachedNames.delete(name);
    delete this.loaded[name];
    return true;
  },

  async _doLoad(name, onProgress){
    // 候选源：jsDelivr CDN -> 本站 Pages；缓存 key 仍用本站绝对路径，兼容旧缓存
    const urls = _mediaUrls('soundfonts/' + name + '-ogg.js');
    const absUrl = new URL(this.cdnBase + name + '-ogg.js', window.location.href).href;
    if(onProgress) onProgress(0, '正在下载音色…');
    let cache = null;
    try{ cache = await caches.open(this.cacheName); }catch(e){}
    let res = await this._fetchSoundfontText(name, urls, absUrl, cache, (frac) => { if(onProgress) onProgress(frac * 0.9, '正在下载音色…'); });
    if(onProgress) onProgress(0.5, res.fromCache ? '从缓存读取音色…' : '下载完成，解析中…');
    let raw;
    try{
      raw = this._parseSoundfont(res.text, name);
    }catch(e){
      // 缓存内容能过格式校验却解析失败：删除该条并强制走网络重试一次
      if(!res.fromCache) throw e;
      if(cache){ try{ await cache.delete(absUrl); }catch(_){} }
      res = await this._fetchSoundfontText(name, urls, absUrl, cache, (frac) => { if(onProgress) onProgress(frac * 0.9, '正在下载音色…'); });
      raw = this._parseSoundfont(res.text, name);
    }
    this.loaded[name] = { raw: raw, buffers: {}, ready: true };
    this.cachedNames.add(name);
    // 后台/前台下载完成：刷新设置面板音色列表的下载/删除状态
    if(typeof _onTimbreCached === 'function'){ try{ _onTimbreCached(name); }catch(e){} }
    // 网络下载的来源/体积/速度已由竞速最终行打印；这里只补缓存命中与压缩收益提示
    if(res.fromCache){
      console.log('[AudioDebug][INFO] ' + _timbreLabel(name) + '从缓存加载成功!');
    } else if(res.netSize > 0){
      const rawLen = res.text.length; // 音色为 ASCII base64，字符数≈字节数
      if(res.netSize < rawLen * 0.98){
        console.log('[AudioDebug][INFO] ' + _timbreLabel(name) + ' HTTP压缩传输 ' + _fmtSize(res.netSize) +
          ' -> ' + _fmtSize(rawLen) + '（压缩比 ' + (rawLen / res.netSize).toFixed(1) + '×，传输节省 ' +
          ((1 - res.netSize / rawLen) * 100).toFixed(1) + '%）');
      }
    }
    if(onProgress) onProgress(1, '音色加载完成');
  },

  async _getBuffer(name, midi){
    if(!audioCtx) initAudio(); // 确保audioCtx已初始化，避免decodeAudioData失败
    const entry = this.loaded[name];
    if(!entry) return null;
    if(entry.buffers[midi]) return entry.buffers[midi];
    const noteName = this._midiToNote(midi);
    let dataUri = entry.raw[noteName];
    if(!dataUri){
      let bestDist = 999, bestKey = null;
      for(const k in entry.raw){
        const m = this.noteToMidi[k];
        if(m && Math.abs(m - midi) < bestDist){ bestDist = Math.abs(m - midi); bestKey = k; }
      }
      if(bestKey) dataUri = entry.raw[bestKey];
    }
    if(!dataUri) return null;
    const base64 = dataUri.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    let buffer = null;
    try{
      buffer = await audioCtx.decodeAudioData(bytes.buffer);
    }catch(e){
      console.error('[AudioDebug] decodeAudioData失败! name=', name, 'midi=', midi,
        'noteName=', noteName, 'dataUri长度=', dataUri ? dataUri.length : 0,
        'bytes长度=', bytes.length, '错误=', e.message || e);
      return null;
    }
    entry.buffers[midi] = buffer;
    return buffer;
  },

  _midiToNote(midi){
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + Math.floor(midi / 12 - 1);
  },

  // 预解码指定音色的所有88个音（默认当前音色）；不改变 current，便于后台预解码后再无缝切换
  async predecodeAll(name){
    name = name || this.current;
    if(name === '__synth__') return;
    // 分批解码，每批8个，避免同时解码88个导致主线程阻塞、音频时间线暂停
    const batchSize = 8;
    const midis = [];
    for(let midi = 21; midi <= 108; midi++) midis.push(midi);
    for(let i = 0; i < midis.length; i += batchSize){
      const batch = midis.slice(i, i + batchSize);
      await Promise.all(batch.map(m => this._getBuffer(name, m)));
    }
  },

  // ===== 全局复音管理：注册/注销/抢占 =====
  _registerVoice(v){
    v._start = audioCtx ? audioCtx.currentTime : 0;
    this.activeVoices.push(v);
    // 超过上限则抢占最早开始的voice，保证音频线程活跃voice有界
    while(this.activeVoices.length > this.MAX_VOICES){
      this._stealOldest();
    }
  },
  _unregisterVoice(v){
    const i = this.activeVoices.indexOf(v);
    if(i >= 0) this.activeVoices.splice(i, 1);
  },
  _stealOldest(){
    if(!this.activeVoices.length) return;
    let oldest = this.activeVoices[0];
    for(const v of this.activeVoices){ if(v._start < oldest._start) oldest = v; }
    const t = audioCtx ? audioCtx.currentTime : 0;
    try{
      if(oldest.kind === 'sample'){
        oldest.gain.gain.cancelScheduledValues(t);
        oldest.gain.gain.setValueAtTime(oldest.gain.gain.value, t);
        oldest.gain.gain.linearRampToValueAtTime(0, t + 0.005);
        oldest.src.stop(t + 0.01);
      } else if(oldest.kind === 'synth'){
        oldest.env.gain.cancelScheduledValues(t);
        oldest.env.gain.setValueAtTime(oldest.env.gain.value, t);
        oldest.env.gain.linearRampToValueAtTime(0, t + 0.005);
        oldest.oscs.forEach(o => { try{ o.stop(t + 0.01); }catch(e){} });
      }
    }catch(e){}
    this._unregisterVoice(oldest);
    if(oldest.kind === 'synth' && this.activeSynth[oldest.midi] === oldest) delete this.activeSynth[oldest.midi];
    if(oldest.kind === 'sample' && this.activeSources[oldest.midi] && this.activeSources[oldest.midi].src === oldest.src) this.activeSources[oldest.midi] = null;
  },

  // 停止所有正在播放的音符（切换音色时调用）
  stopAll(){
    const t = audioCtx ? audioCtx.currentTime : 0;
    let stopped = 0;
    for(let i = 0; i < this.activeSources.length; i++){
      const s = this.activeSources[i];
      if(s){
        try{
          s.gain.gain.cancelScheduledValues(t);
          s.gain.gain.setValueAtTime(s.gain.gain.value, t);
          s.gain.gain.linearRampToValueAtTime(0, t + 0.01);
          s.src.stop(t + 0.02);
        }catch(e){}
        this.activeSources[i] = null;
        stopped++;
      }
    }
    if(stopped > 0) console.log('[AudioDebug][INFO] stopAll停止了', stopped, '个 note');
    // AudioWorklet 合成器：一次性释放所有 voice
    if(_synthWorkletReady && _synthWorkletNode){
      try{ _synthWorkletNode.port.postMessage({ type: 'allOff' }); }catch(e){}
      _synthWorkletVoices = 0;
    }
    // 合成钢琴分支的音源节点也必须停掉
    if(this.synthVoices.length){
      const n = this.synthVoices.length;
      for(const v of this.synthVoices){
        try{ v.oscs.forEach(o => o.stop(t + 0.02)); }catch(e){}
      }
      this.synthVoices.length = 0;
      console.log('[AudioDebug][INFO] stopAll停止了', n, '个 note（合成钢琴）');
    }
    this.activeSynth = {};
    this.activeVoices.length = 0;
    this.lastTriggerTime.fill(0);
  },

  // 松开某个琴键：立即停止该 midi 正在发声的 voice（用户敲击抬起手指时用）
  stopNote(midi){
    const t = audioCtx ? audioCtx.currentTime : 0;
    // AudioWorklet 合成器：释放该音高的 voice
    if(_synthWorkletReady && _synthWorkletNode){
      try{ _synthWorkletNode.port.postMessage({ type: 'off', midi: midi }); }catch(e){}
    }
    for(let i = this.activeVoices.length - 1; i >= 0; i--){
      const v = this.activeVoices[i];
      if(v.midi !== midi) continue;
      try{
        if(v.kind === 'sample'){
          v.gain.gain.cancelScheduledValues(t);
          v.gain.gain.setValueAtTime(v.gain.gain.value, t);
          v.gain.gain.linearRampToValueAtTime(0, t + 0.01);
          v.src.stop(t + 0.02);
        } else if(v.kind === 'synth'){
          v.env.gain.cancelScheduledValues(t);
          v.env.gain.setValueAtTime(v.env.gain.value, t);
          v.env.gain.linearRampToValueAtTime(0, t + 0.01);
          v.oscs.forEach(o => { try{ o.stop(t + 0.02); }catch(e){} });
        }
      }catch(e){}
      this._unregisterVoice(v);
      if(v.kind === 'synth' && this.activeSynth[midi] === v) delete this.activeSynth[midi];
      if(v.kind === 'sample' && this.activeSources[midi] && this.activeSources[midi].src === v.src) this.activeSources[midi] = null;
    }
  },

  // 定期节点泄漏检测（每5秒一次，仅异常时告警）
  debugReport(){
    const now = performance.now();
    if(now - this.debug.lastReportTime < 5000) return;
    this.debug.lastReportTime = now;
    // 节点泄漏检测：阈值500，且只在差值比上次增长超过200时告警，避免频繁输出
    const leakCount = this.debug.srcCreated - this.debug.onendedFired;
    if(leakCount > 500 && leakCount - (this.debug.lastLeakWarn || 0) > 200){
      this.debug.lastLeakWarn = leakCount;
      console.warn('[AudioDebug] 节点泄漏! created=' + this.debug.srcCreated +
        ' ended=' + this.debug.onendedFired + ' leak=' + leakCount);
    }
  },

  playNote(midi, velocity, duration){
    if(!audioCtx) return;
    const t = audioCtx.currentTime;
    this.debug.playNoteCalls++;
    // 检测AudioContext状态异常
    if(audioCtx.state !== 'running'){
      if(this.debug.lastState !== audioCtx.state){
        console.warn('[AudioDebug] AudioContext状态异常:', audioCtx.state, '时间:', t.toFixed(2));
        this.debug.lastState = audioCtx.state;
      }
    }
    // 自适应同音聚合：仅当谱面整体密度极高时才启用，
    // 限制每个音高的重触发频率，从而限制 BufferSource 创建率（节点 churn）。
    // 普通密度谱面 floor=0，完全逐音符忠实。
    if(this.retriggerFloor > 0 && t - this.lastTriggerTime[midi] < this.retriggerFloor){
      return;
    }
    this.lastTriggerTime[midi] = t;
    // 使用真实时长；仅用 1ms epsilon 防止 0/无效调度（不再强制 30ms）
    const d = Math.max(duration, 0.001);
    if(this.current !== '__synth__'){
      const entry = this.loaded[this.current];
      // 超出钢琴范围的音符映射到最近有效键，避免永远 miss
      const keyMidi = midi >= 21 && midi <= 108 ? midi : (midi < 21 ? 21 : 108);
      const buffer = entry ? entry.buffers[keyMidi] : null;
      // 调试：首次buffer为null时打印详细信息
      if(!buffer && !this.debug.bufferNullLogged){
        this.debug.bufferNullLogged = true;
        console.warn('[AudioDebug] buffer为null! current=', this.current,
          'entry存在=', !!entry, 'entry.ready=', entry ? entry.ready : 'N/A',
          'buffers键数=', entry ? Object.keys(entry.buffers).length : 'N/A',
          'midi=', midi, '时间=', t.toFixed(2));
      }
      if(buffer){
        // 同音新音符触发：打断上一个，10ms快速淡出
        const prev = this.activeSources[keyMidi];
        if(prev){
          try{
            prev.gain.gain.cancelScheduledValues(t);
            prev.gain.gain.setValueAtTime(prev.gain.gain.value, t);
            prev.gain.gain.linearRampToValueAtTime(0, t + 0.01);
            prev.src.stop(t + 0.02);
            // 延迟disconnect，等淡出完成
            const oldSrc = prev.src, oldGain = prev.gain;
            setTimeout(() => {
              try{ oldSrc.disconnect(); oldGain.disconnect(); }catch(e){}
            }, 50);
            this._unregisterVoice(prev);
          }catch(e){}
        }
        let src, g;
        try{
          src = audioCtx.createBufferSource();
          src.buffer = buffer;
          g = audioCtx.createGain();
          this.debug.srcCreated++;
        }catch(e){
          this.debug.errors++;
          console.error('[AudioDebug] 创建节点失败:', e, '已创建:', this.debug.srcCreated, '时间:', t.toFixed(2));
          return;
        }
        const tg = this.timbreGain[this.current] || 3.0; // 未配置的音色默认300%增益
        // 时长自适应包络：短音符按比例缩短起音/收尾，避免事件时间倒挂
        const attack = Math.min(0.005, d * 0.5);
        const release = Math.min(0.02, d * 0.5);
        const peak = 0.4 * velocity * tg;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + attack);
        g.gain.setValueAtTime(peak, t + Math.max(attack, d - release));
        g.gain.linearRampToValueAtTime(0, t + d);
        src.connect(g); g.connect(masterGain);
        src.start();
        src.stop(t + d + 0.05);
        const voice = {kind: 'sample', midi: keyMidi, src, gain: g};
        this.activeSources[keyMidi] = voice;
        this._registerVoice(voice);
        src.onended = () => {
          this.debug.onendedFired++;
          this._unregisterVoice(voice);
          // 主动断开连接，帮助GC回收
          try{ src.disconnect(); g.disconnect(); }catch(e){}
          if(this.activeSources[keyMidi] && this.activeSources[keyMidi].src === src) this.activeSources[keyMidi] = null;
          // 解除闭包引用
          src.onended = null;
        };
        return;
      }
      // buffer未就绪（预解码未完成），返回不播放，不回退合成钢琴
      return;
    }
    // 只有current为__synth__时才走合成钢琴
    if(!this.debug.synthWarned){
      this.debug.synthWarned = true;
      console.log('[AudioDebug][INFO] 当前使用合成钢琴音色（current=__synth__，预渲染循环波形 / AudioWorklet），时间=', t.toFixed(2));
    }
    const synthDur = Math.max(duration, 0.001); // 真实时长，仅 1ms epsilon
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    // 渐进增强：AudioWorklet 就绪时走单节点合成器（每音符 0 节点、零 churn）
    if(_synthWorkletReady && _synthWorkletNode){
      try{
        _synthWorkletNode.port.postMessage({ type: 'off', midi: midi }); // 同音先释放
        _synthWorkletNode.port.postMessage({ type: 'note', midi: midi, freq: f, vel: 0.4 * velocity, dur: synthDur });
      }catch(e){}
      return;
    }
    // 同音打断：与 sample 分支一致，避免同音叠加导致 voice 爆炸
    const prevS = this.activeSynth[midi];
    if(prevS){
      try{
        const st = audioCtx.currentTime;
        prevS.env.gain.cancelScheduledValues(st);
        prevS.env.gain.setValueAtTime(prevS.env.gain.value, st);
        prevS.env.gain.linearRampToValueAtTime(0, st + 0.01);
        prevS.oscs.forEach(o => { try{ o.stop(st + 0.02); }catch(e){} });
      }catch(e){}
      this._unregisterVoice(prevS);
      delete this.activeSynth[midi];
    }
    const t0 = audioCtx.currentTime;
    const env = audioCtx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(0.4 * velocity, t0 + Math.min(0.008, synthDur * 0.5));
    env.gain.exponentialRampToValueAtTime(0.0008, t0 + synthDur);
    env.connect(masterGain);
    // 每音符节点数 7 -> 2：预渲染循环波形经 BufferSource 播放（与采样分支同构）。
    // 缓冲区与 ctx 同采样率，音频线程开销与采样音色相当，高密度谱面更不易卡顿。
    let oscs;
    const loopBuf = _getSynthLoopBuffers()[midi] || null;
    if(loopBuf){
      const src = audioCtx.createBufferSource();
      src.buffer = loopBuf;
      src.loop = true;
      src.connect(env);
      // 尾部仅保留 30ms 余量（原 200ms），缩短音源存活时间、降低活动 voice 数
      src.start(t0); src.stop(t0 + synthDur + 0.03);
      oscs = [src];
    } else {
      const o = audioCtx.createOscillator();
      o.setPeriodicWave(_getSynthPeriodicWave());
      o.frequency.value = f;
      o.connect(env);
      o.start(t0); o.stop(t0 + synthDur + 0.03);
      oscs = [o];
    }
    // 登记 voice，并在结束时清理，避免音源节点累积
    const voice = { kind: 'synth', midi, oscs, env };
    this.synthVoices.push(voice);
    this.activeSynth[midi] = voice;
    this._registerVoice(voice);
    oscs[oscs.length - 1].onended = () => {
      try{ env.disconnect(); oscs.forEach(o => o.disconnect()); }catch(e){}
      const idx = this.synthVoices.indexOf(voice);
      if(idx >= 0) this.synthVoices.splice(idx, 1);
      this._unregisterVoice(voice);
      if(this.activeSynth[midi] === voice) delete this.activeSynth[midi];
    };
  }
};
SoundfontLoader.init();

/* ============================================================
 * 自定义下拉（替代原生 select）
 * 原生 <option> 在桌面端由系统绘制，深色主题下常出现白底白字。
 * 这里保留原生 select 作为数据源（.value/.selectedIndex/.options/.innerHTML 全部照常可用），
 * 仅在其旁渲染一套可完全自定义样式的弹层列表，双向同步。
 * ========================================================== */
const _cselCloses = [];
function closeAllCustomSelects(){ _cselCloses.slice().forEach(fn => { try{ fn(); }catch(e){} }); }
function initCustomSelect(select, opts){
  if(!select) return null;
  opts = opts || {};
  const searchable = opts.search !== false;
  select.style.display = 'none';
  select.setAttribute('aria-hidden', 'true');

  const wrap = document.createElement('div');
  wrap.className = 'csel';
  if(select.style.flex) wrap.style.flex = select.style.flex;
  wrap.innerHTML =
    '<button type="button" class="csel-trigger" aria-haspopup="listbox" aria-expanded="false">' +
      '<span class="csel-label"></span>' +
      '<svg class="csel-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</button>' +
    '<div class="csel-pop" role="listbox">' +
      (searchable ? '<input class="csel-search" type="text" placeholder="搜索…" autocomplete="off">' : '') +
      '<div class="csel-list"></div>' +
    '</div>';
  select.parentNode.insertBefore(wrap, select.nextSibling);

  const trigger = wrap.querySelector('.csel-trigger');
  const labelEl = wrap.querySelector('.csel-label');
  const pop = wrap.querySelector('.csel-pop');
  const list = wrap.querySelector('.csel-list');
  const search = wrap.querySelector('.csel-search');
  // 弹层挂到 body：避免移动端抽屉的 transform 使 fixed 相对面板定位、以及 overflow 裁剪
  document.body.appendChild(pop);
  let activeIndex = -1;

  function currentOption(){
    return select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
  }
  function syncLabel(){
    const o = currentOption();
    labelEl.textContent = o ? o.textContent : (opts.placeholder || '请选择');
    labelEl.title = labelEl.textContent;
  }
  function makeOpt(o){
    const d = document.createElement('div');
    d.className = 'csel-opt' + (o.selected ? ' selected' : '');
    d.setAttribute('role', 'option');
    d.setAttribute('aria-selected', o.selected ? 'true' : 'false');
    const t = document.createElement('span');
    t.className = 'csel-opt-label';
    t.textContent = o.textContent;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    c.setAttribute('class', 'csel-check');
    c.setAttribute('viewBox', '0 0 24 24');
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', 'currentColor');
    c.setAttribute('stroke-width', '3');
    c.setAttribute('stroke-linecap', 'round');
    c.setAttribute('stroke-linejoin', 'round');
    c.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
    d.appendChild(t);
    if(opts.actions){
      const act = opts.actions(o);
      if(act){ act.classList.add('csel-act'); d.appendChild(act); }
    }
    d.appendChild(c);
    d.addEventListener('click', function(e){
      if(e.target && e.target.closest && e.target.closest('.csel-act')) return;
      choose(o);
    });
    return d;
  }
  function buildList(){
    const q = (search && search.value ? search.value : '').trim().toLowerCase();
    const _prevScroll = list.scrollTop;
    list.textContent = '';
    let any = false;
    Array.prototype.forEach.call(select.children, function(node){
      if(node.tagName === 'OPTGROUP'){
        const items = Array.prototype.filter.call(node.children, function(o){
          return !q || o.textContent.toLowerCase().indexOf(q) >= 0;
        });
        if(!items.length) return;
        any = true;
        const g = document.createElement('div');
        g.className = 'csel-group';
        g.textContent = node.label || '';
        list.appendChild(g);
        items.forEach(function(o){ list.appendChild(makeOpt(o)); });
      } else if(node.tagName === 'OPTION'){
        if(q && node.textContent.toLowerCase().indexOf(q) < 0) return;
        any = true;
        list.appendChild(makeOpt(node));
      }
    });
    if(!any){
      const e = document.createElement('div');
      e.className = 'csel-empty';
      e.textContent = '无匹配项';
      list.appendChild(e);
    }
    activeIndex = -1;
    list.scrollTop = _prevScroll;
  }
  function choose(o){
    if(opts.canChoose && !opts.canChoose(o)) return;
    select.value = o.value;
    syncLabel();
    close();
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function position(){
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    const spaceBelow = window.innerHeight - r.bottom - gap - 8;
    const spaceAbove = r.top - gap - 8;
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    pop.style.left = r.left + 'px';
    pop.style.width = r.width + 'px';
    pop.style.maxHeight = Math.max(160, Math.min(420, openUp ? spaceAbove : spaceBelow)) + 'px';
    if(openUp){ pop.style.top = 'auto'; pop.style.bottom = (window.innerHeight - r.top + gap) + 'px'; }
    else { pop.style.bottom = 'auto'; pop.style.top = (r.bottom + gap) + 'px'; }
  }
  function onDocDown(e){ if(!wrap.contains(e.target) && !pop.contains(e.target)) close(); }
  function open(){
    closeAllCustomSelects();
    if(typeof _closeDropPanelsOnly === 'function') _closeDropPanelsOnly(wrap.closest ? wrap.closest('.drop-panel') : null); // 与其它面板互斥，但保留本下拉所在的面板
    // 全屏时 body 外的节点不会被渲染：把弹层挂到全屏元素内
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const host = fsEl || document.body;
    if(pop.parentNode !== host) host.appendChild(pop);
    if(search) search.value = '';
    buildList();
    wrap.classList.add('open');
    pop.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    position();
    // 不自动聚焦搜索框：避免点击列表即唤醒输入法（用户可手动点搜索框）
    document.addEventListener('pointerdown', onDocDown, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
  }
  function close(){
    if(!wrap.classList.contains('open')) return;
    wrap.classList.remove('open');
    pop.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
  }
  function moveActive(delta){
    const items = Array.prototype.slice.call(list.querySelectorAll('.csel-opt'));
    if(!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    items.forEach(function(el, i){ el.classList.toggle('active', i === activeIndex); });
    try{ items[activeIndex].scrollIntoView({block: 'nearest'}); }catch(e){}
  }
  trigger.addEventListener('click', function(e){
    e.stopPropagation();
    if(wrap.classList.contains('open')) close(); else open();
  });
  trigger.addEventListener('keydown', function(e){
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if(!wrap.classList.contains('open')) open();
      else moveActive(e.key === 'ArrowDown' ? 1 : -1);
    } else if(e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      if(wrap.classList.contains('open')) close(); else open();
    } else if(e.key === 'Escape'){ close(); }
  });
  if(search){
    search.addEventListener('input', function(){ buildList(); });
    search.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){ close(); trigger.focus(); }
      else if(e.key === 'Enter'){ const items = list.querySelectorAll('.csel-opt'); if(activeIndex >= 0 && items[activeIndex]) items[activeIndex].click(); }
      else if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){ e.preventDefault(); moveActive(e.key === 'ArrowDown' ? 1 : -1); }
    });
  }

  // 双向同步：程序修改 value / selectedIndex / 子节点时刷新显示
  try{
    const valDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    const idxDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    if(valDesc && idxDesc){
      Object.defineProperty(select, 'value', {
        configurable: true,
        get(){ return valDesc.get.call(this); },
        set(v){ valDesc.set.call(this, v); syncLabel(); if(wrap.classList.contains('open')) buildList(); }
      });
      Object.defineProperty(select, 'selectedIndex', {
        configurable: true,
        get(){ return idxDesc.get.call(this); },
        set(v){ idxDesc.set.call(this, v); syncLabel(); if(wrap.classList.contains('open')) buildList(); }
      });
    }
  }catch(e){ console.warn('[AudioDebug] 自定义下拉属性同步初始化失败', e); }
  new MutationObserver(function(){ syncLabel(); if(wrap.classList.contains('open')) buildList(); })
    .observe(select, {childList: true, subtree: true});

  _cselCloses.push(close);
  syncLabel();
  return {refresh: function(){ syncLabel(); buildList(); }, element: wrap};
}
let _timbreSelect = null;
try{
  _timbreSelect = initCustomSelect(document.getElementById('timbreSel'), {
    search: true,
    actions: _makeTimbreAction
  });
  initCustomSelect(document.getElementById('songSel'), {search: true});
}catch(e){ console.warn('[AudioDebug] 自定义下拉初始化失败', e); }
try{ SoundfontLoader.refreshCachedNames(); }catch(e){}
// 音色下载完成后刷新音色下拉列表的下载/删除按钮状态（由 SoundfontLoader._doLoad 调用）
function _onTimbreCached(){ try{ if(_timbreSelect) _timbreSelect.refresh(); }catch(e){} }

// opts.auto=true：谱面配置的音色自动切换（不打断正在播放的音符）
// 谱面默认音色自动切换：默认音色本地不存在时，先回滚合成钢琴并后台下载；
// 下载完成后仅在「用户未主动切其他音色」且「当前谱面未播完」时自动切回。
let _timbreAutoSwitch = null; // { file, name, disp, gen }
let _timbreGen = 0;           // 代际：切歌/手动切音色/播完时递增，使旧的下载回调失效
let currentSongKey = null;    // 当前选中谱面（含前缀，如 builtin:midi/x.mid）
let _songEnded = false;       // 当前谱面是否已播完
function _invalidateTimbreAutoSwitch(){ _timbreGen++; _timbreAutoSwitch = null; }

async function onTimbreChange(opts){
  const auto = !!(opts && opts.auto);
  if(!auto) _invalidateTimbreAutoSwitch(); // 用户主动切音色：作废谱面默认音色的自动切换
  const sel = document.getElementById('timbreSel');
  const name = sel.value;
  const disp = timbreDisplayName(name);
  initAudio();
  // 切换音色前停止所有正在播放的音符，避免新旧音色叠加导致音量暴增
  SoundfontLoader.stopAll();
  if(name === '__synth__'){
    SoundfontLoader.current = '__synth__';
    return;
  }
  // 未下载的音色：直接下载并切换（不再要求先点下载按钮）
  const needDownload = !SoundfontLoader.cachedNames.has(name);
  try{
    setStatus('音色[' + disp + ']' + (needDownload ? '下载中…' : '加载中…'));
    await SoundfontLoader.load(name, (p) => {
      if(p < 1) setStatus('音色[' + disp + ']下载 ' + Math.round(p * 100) + '%');
    });
    await SoundfontLoader.predecodeAll();
    setStatus('音色[' + disp + ']完成!');
  }catch(e){
    setStatus('音色[' + disp + ']加载失败，已回退合成钢琴');
    sel.value = '__synth__';
    SoundfontLoader.current = '__synth__';
  }
}

// 应用谱面配置的默认音色：
// - 合成钢琴：谱面本就配置合成钢琴，属于正常选择，不是「加载失败回退」
// - 已缓存：直接切换
// - 本地不存在：提示后回滚合成钢琴，后台下载，下载完成后按条件自动切回
async function _applySongDefaultTimbre(file, fname, timbre){
  const sel = document.getElementById('timbreSel');
  const disp = timbreDisplayName(timbre);
  const songDisp = _songDisplayName(file);
  if(timbre === '__synth__'){
    sel.value = '__synth__';
    SoundfontLoader.current = '__synth__';
    console.log('[AudioDebug][INFO] 谱面' + _songId(file) + ' 默认使用合成钢琴音色');
    return;
  }
  if(SoundfontLoader.cachedNames.has(timbre)){
    if(sel.value !== timbre){ sel.value = timbre; await onTimbreChange({auto: true}); }
    return;
  }
  // 本地不存在：回滚合成钢琴，记录待切换动作，并后台下载（不阻塞当前播放）
  sel.value = '__synth__';
  SoundfontLoader.current = '__synth__';
  const prompt = '谱面[' + songDisp + ']默认使用音色[' + disp + ']。音色[' + disp + ']本地不存在，回滚到合成钢琴';
  setStatus(prompt);
  console.log('[AudioDebug][INFO] ' + prompt);
  const gen = ++_timbreGen;
  _timbreAutoSwitch = { file, name: timbre, disp, gen };
  SoundfontLoader.load(timbre, (p) => {
    if(p < 1 && _timbreAutoSwitch && _timbreAutoSwitch.gen === gen){
      setStatus('音色[' + disp + ']后台下载 ' + Math.round(p * 100) + '%');
    }
  }, {switchCurrent: false}).then(() => {
    // 若已被用户主动切音色 / 切歌 / 播完作废，则不再自动切换
    if(!(_timbreAutoSwitch && _timbreAutoSwitch.gen === gen)) return;
    if(_songEnded || currentSongKey !== ('builtin:' + file)){ _timbreAutoSwitch = null; return; }
    _timbreAutoSwitch = null;
    sel.value = timbre;
    return SoundfontLoader.predecodeAll(timbre).then(() => {
      SoundfontLoader.current = timbre;
      const msg = '音色[' + disp + ']下载成功，谱面[' + songDisp + ']音色自动切换到[' + disp + ']';
      console.log('[AudioDebug][INFO] ' + msg);
      setStatus(msg);
    });
  }).catch((e) => {
    if(_timbreAutoSwitch && _timbreAutoSwitch.gen === gen){
      _timbreAutoSwitch = null;
      console.warn('[AudioDebug][WARN] 谱面默认音色[' + disp + ']下载失败：' + (e && e.message ? e.message : e));
      setStatus('音色[' + disp + ']下载失败，继续使用合成钢琴');
    }
  });
}

// 内置谱默认音色配置：谱子文件名 -> 音色id
const songDefaultTimbre = {
  'Rush E 3.mid': 'clavinet', // 古钢琴
  'The Sound of Silence.mid': '__synth__', // 合成钢琴
};

// 记录用户是否已与页面交互（绕过自动播放限制；避免"加载完成前点击过"导致后续不再起播）
let userGestureSeen = false;
(function(){
  const mark = () => {
    userGestureSeen = true;
    try{ if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); }catch(e){}
  };
  ['pointerdown', 'touchstart', 'keydown', 'click'].forEach(ev =>
    document.addEventListener(ev, mark, {capture: true, passive: true}));
})();

// ===== 冷启动优先级管线 =====
// 进页面后按优先级「独占带宽、顺序下载」，避免并发抢占带宽：
//   P0  默认谱面（Rush E3，brotli 压缩）—— 独占下载；完成后立即用合成钢琴起播
//   P1  默认音色（古钢琴）—— 与 P0 起播同时开始独占下载；期间不下载其它任何资源
//   P2  预配置的内置必下音色与谱面 —— 古钢琴就绪后才开始
// 迁移 Cloudflare 后同源即可获得低延迟与压缩，不再需要多镜像竞速。
const COLD_START = {
  sheet: 'midi/Rush E 3.mid',                         // P0：优先独占下载的默认谱面
  timbre: 'clavinet',                                  // P1：默认谱面就绪后独占下载的音色（古钢琴）
  mandatorySheets: ['midi/The Sound of Silence.mid'],  // P2：预配置必下谱面
  mandatoryTimbres: [],                                // P2：预配置必下音色（古钢琴已在 P1 下载）
};

(function(){
  const hint = document.getElementById('timbreHint');
  let midiBuf = null;
  let autoPlayTriggered = false;    // 是否已触发自动播放（避免重复播放）
  let timbreReady = false;          // 默认音色是否已加载并预解码完成
  let timbreFailed = false;         // 默认音色是否加载失败
  let startedWithFallback = false;  // 是否已用合成钢琴抢跑
  const DEFAULT_SONG = COLD_START.sheet.split('/').pop();

  // 轻量提示：显示在进度条上方的状态区（不再用遮挡点击的浮层）
  function showToast(msg){ setStatus(msg); }
  window.showToast = showToast;

  // 开始播放（只在首次调用时真正触发）
  function startPlaybackOnce(){
    if(!midiBuf || autoPlayTriggered) return;
    autoPlayTriggered = true;
    initAudio();
    if(audioCtx.state === 'suspended'){
      audioCtx.resume().catch(() => {});
      if(userGestureSeen){
        // 用户此前已交互过（例如点过菜单），直接起播
        startPlay();
      } else {
        const startOnInteract = () => {
          audioCtx.resume();
          startPlay();
          document.removeEventListener('click', startOnInteract);
          document.removeEventListener('touchstart', startOnInteract);
        };
        document.addEventListener('click', startOnInteract);
        document.addEventListener('touchstart', startOnInteract);
        if(hint) hint.textContent = '点击页面即可开始播放（浏览器自动播放限制）';
      }
    } else {
      startPlay();
    }
  }

  // 音色未就绪：用合成钢琴立即起播，避免等待下载
  function startWithFallback(){
    if(timbreReady) return;
    if(!timbreFailed) startedWithFallback = true;
    SoundfontLoader.current = '__synth__';
    if(hint && !timbreFailed) hint.textContent = '古钢琴下载中… 先用合成钢琴播放';
    startPlaybackOnce();
  }

  // P1：下载默认音色并预解码（不切 current），完成后无缝切换
  async function loadDefaultTimbre(){
    const timbreName = COLD_START.timbre;
    if(!timbreName || timbreName === '__synth__'){
      timbreReady = true;
      if(hint) hint.textContent = '当前：合成钢琴';
      return;
    }
    // 同步下拉菜单选中状态
    const timbreSel = document.getElementById('timbreSel');
    if(timbreSel && timbreSel.value !== timbreName) timbreSel.value = timbreName;
    try{
      // switchCurrent:false —— 先保持合成钢琴，等预解码完成再切，避免解码期间丢音
      await SoundfontLoader.load(timbreName, (p, msg) => {
        if(hint && !startedWithFallback) hint.textContent = msg + ' ' + Math.round(p * 100) + '%';
        if(p < 1) setStatus('音色[' + timbreDisplayName(timbreName) + ']下载 ' + Math.round(p * 100) + '%');
      }, {switchCurrent: false});
      if(hint && !startedWithFallback) hint.textContent = '音色预解码中…';
      await SoundfontLoader.predecodeAll(timbreName);
      timbreReady = true;
      // 无缝升级：仅改 current，后续音符用新音色，已发声的旧 voice 自然衰减
      SoundfontLoader.current = timbreName;
      const label = (timbreSel && timbreSel.options[timbreSel.selectedIndex]) ? timbreSel.options[timbreSel.selectedIndex].text : timbreName;
      if(hint) hint.textContent = '当前音色：' + label + ' ✓ 就绪';
      if(startedWithFallback) showToast('音色[' + timbreDisplayName(timbreName) + ']已就绪，已切换');
    }catch(e){
      timbreFailed = true;
      console.warn('[AudioDebug] 默认音色加载失败 name=' + timbreName + ' 错误=' + (e && e.message ? e.message : e));
      SoundfontLoader.current = '__synth__';
      if(hint) hint.textContent = '当前：合成钢琴（音色加载失败）';
      showToast('音色[' + timbreDisplayName(timbreName) + ']加载失败，回退合成钢琴');
    }
  }

  // 启动管线：P0 谱面 -> （起播合成钢琴 + P1 古钢琴）-> P2 预配置必下资源
  // 冷启动 = 默认谱面本地无缓存（首次访问或清过缓存）；刷新命中缓存属热启动，不应再打「冷启动」。
  (async function coldStart(){
    // 以默认谱面是否已在本地缓存判定：谱面是阻塞起播的主资源，刷新后必然命中缓存
    let isCold = true, sheetCached = false;
    try{ sheetCached = await AssetCache.has(COLD_START.sheet); }catch(e){}
    isCold = !sheetCached;
    const tag = isCold ? '冷启动' : '热启动(缓存)';
    const from = isCold ? '独占下载' : '读取缓存';

    // 谱面未缓存（需解压）且原生不支持 br 时：WASM 解码器与默认谱面并行下载，
    // 避免解压要等谱面下完才开始。谱面已缓存（热启动）则无需 WASM。
    if(!sheetCached && !_NATIVE_BROTLI){
      console.log('[AudioDebug][INFO] ' + tag + '：原生不支持 br，WASM 解码器与默认谱面并行下载');
      _loadBrotliWasm().catch(() => {});
    }

    // ---- P0：默认谱面 ----
    console.log('[AudioDebug][INFO] ' + tag + ' P0：' + from + '默认谱面 ' + _songLabel(COLD_START.sheet));
    try{
      const resp = await fetchMedia(COLD_START.sheet, (p) => {
        if(p < 100) setStatus('谱面[' + _songDisplayName(DEFAULT_SONG) + ']下载 ' + Math.round(p) + '%');
      });
      const buf = await resp.arrayBuffer();
      midiBuf = buf;
      parseAndPlayMidi(buf, DEFAULT_SONG);
      refreshManageRowState(COLD_START.sheet); // 下载完成，更新管理面板该行状态
      // P0 完成：立即用合成钢琴起播（不等音色）
      startWithFallback();
    }catch(e){
      if(hint) hint.textContent = 'MIDI加载失败：' + e.message;
      return; // 谱面失败则不继续下载音色
    }

    // ---- P1：起播的同时，下载默认音色 ----
    console.log('[AudioDebug][INFO] ' + tag + ' P1：' + from + '默认音色 ' + _timbreLabel(COLD_START.timbre));
    await loadDefaultTimbre();

    // ---- P2：古钢琴就绪后，再下载预配置的内置必下音色与谱面 ----
    const sheets = COLD_START.mandatorySheets.filter(f => f !== COLD_START.sheet);
    const timbres = COLD_START.mandatoryTimbres.filter(t => t !== COLD_START.timbre);
    if(sheets.length || timbres.length){
      console.log('[AudioDebug][INFO] ' + tag + ' P2：预配置必下资源（谱面 ' + sheets.length + ' / 音色 ' + timbres.length + '）');
    }
    for(const f of sheets){
      try{
        await fetchMedia(f, null, true);
        refreshManageRowState(f);
      }catch(e){}
    }
    for(const t of timbres){
      try{ await SoundfontLoader.load(t, null, {switchCurrent:false}); }catch(e){}
    }
  })();
})();

// 加载谱子列表
// IndexedDB：存储用户上传的 MIDI
const DB_NAME = 'midi-player-db';
const STORE = 'user-songs';
function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if(!req.result.objectStoreNames.contains(STORE)){
        req.result.createObjectStore(STORE, {keyPath: 'name'});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveUserSong(name, buf){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({name, data: buf});
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getUserSongs(){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function deleteUserSong(name){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getUserSong(name){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result ? req.result.data : null);
    req.onerror = () => reject(req.error);
  });
}

// 内置谱删除状态（localStorage）：记录被用户删除的内置谱文件
function getDeletedBuiltin(){
  try{ return new Set(JSON.parse(localStorage.getItem('deletedBuiltin') || '[]')); }catch(e){ return new Set(); }
}
function saveDeletedBuiltin(set){
  try{ localStorage.setItem('deletedBuiltin', JSON.stringify([...set])); }catch(e){}
}
// 演示谱面：删除为虚假删除（只标识，不删缓存），重置后自动恢复
const _SOFT_DELETE = new Set(['midi/Rush E 3.mid']);
function _isSoftDeleted(file){ return _SOFT_DELETE.has(file); }

// 内置谱列表：每次会话联网刷新（no-store），失败回退缓存；并检测被废弃的内置谱
let _builtinListCache = null;
async function _getBuiltinList(){
  if(_builtinListCache) return _builtinListCache;
  // 先取旧缓存列表，用于对比出「之前存在、后来废弃」的内置谱
  let oldList = null;
  try{
    const cache = await caches.open(AssetCache.cacheName);
    const cached = await cache.match(AssetCache._abs('midi/list.json'), {ignoreSearch: true});
    if(cached && cached.ok) oldList = await cached.clone().json();
  }catch(e){}
  let list = null;
  try{
    // 联网刷新，帮老用户拿到最新内置谱表（绕过 HTTP 缓存）
    const resp = await AssetCache.fetchFresh('midi/list.json');
    if(resp.ok) list = await resp.json();
  }catch(e){}
  if(!list) list = oldList; // 离线/失败：沿用旧缓存
  if(!list) return _builtinListCache || [];
  _builtinListCache = list;
  // 对比新旧列表：废弃的内置谱转入「我的上传」，绝不主动删除用户缓存中的谱面
  if(oldList){
    const oldFiles = new Set(oldList.map(s => s.file));
    const newFiles = new Set(list.map(s => s.file));
    const added = [...newFiles].filter(f => !oldFiles.has(f));
    const removed = [...oldFiles].filter(f => !newFiles.has(f));
    if(added.length || removed.length){
      console.log('[AudioDebug][INFO] 内置谱表已更新：新增 ' + added.length + ' 首、废弃 ' + removed.length + ' 首');
    }
    const deleted = getDeletedBuiltin();
    const deprecated = removed.filter(f => !deleted.has(f));
    if(deprecated.length) await _migrateDeprecatedBuiltins(deprecated);
  }
  return list;
}
// 被废弃的内置谱：若用户本地缓存过，则复制为「我的上传」用户谱（保留原缓存，绝不删除）
async function _migrateDeprecatedBuiltins(files){
  let existing;
  try{ existing = new Set((await getUserSongs()).map(s => s.name)); }catch(e){ existing = new Set(); }
  for(const file of files){
    const name = file.split('/').pop();
    if(existing.has(name)) continue;
    let buf = null;
    try{
      const cache = await caches.open(AssetCache.cacheName);
      const cached = await cache.match(AssetCache._abs(file), {ignoreSearch: true});
      if(cached && cached.ok) buf = await cached.clone().arrayBuffer();
    }catch(e){}
    if(!buf) continue; // 用户没缓存过：不主动下载废弃谱，也不新增记录
    try{
      await saveUserSong(name, buf);
      existing.add(name);
      console.log('[AudioDebug][INFO] ' + _songLabel(file) + ' 内置谱已废弃，已转入「我的上传」（原缓存保留，未删除）');
    }catch(e){}
  }
}
// 带进度的下载（jsDelivr -> Pages 回退），用于「重新下载」时在按钮上显示百分比
async function _fetchWithProgress(relPath, onProgress, quiet){
  const absUrl = AssetCache._abs(relPath);
  const blob = await _fetchMediaBlob(relPath, onProgress, quiet);
  try{
    const cache = await caches.open(AssetCache.cacheName);
    await cache.put(absUrl, new Response(blob));
  }catch(e){}
  return blob;
}
// 缓存优先 + CDN/Pages 回退：用于切歌等需要 Response 的场景
// quiet=true 时（后台预取）不打印来源日志
async function fetchMedia(relPath, onProgress, quiet){
  const absUrl = AssetCache._abs(relPath);
  try{
    const cache = await caches.open(AssetCache.cacheName);
    const cached = await cache.match(absUrl, {ignoreSearch: true});
    if(cached){
      if(onProgress) onProgress(100);
      if(!quiet) console.log('[AudioDebug][INFO] ' + _songLabel(relPath) + '从缓存加载成功!');
      return cached.clone();
    }
  }catch(e){}
  const blob = await _fetchWithProgress(relPath, onProgress, quiet);
  return new Response(blob);
}
// 探测未下载谱面的体积（HEAD 优先，失败回退 GET Range），用于下载前提示
async function _probeMediaSize(relPath){
  // 谱面一律传 br 压缩变体，探测其体积最贴近真实传输量
  const candidates = [];
  if(/\.midi?$/i.test(relPath)) candidates.push(relPath + '.br');
  else candidates.push(relPath);
  for(const p of candidates){
    const urls = _mediaUrls(p);
    for(const u of urls){
      try{
        const r = await fetch(u, {method: 'HEAD', mode: 'cors'});
        if(r && r.ok){
          const len = parseInt((r.headers && r.headers.get) ? (r.headers.get('content-length') || '0') : '0', 10);
          if(len > 0) return len;
        }
      }catch(e){}
    }
  }
  return 0;
}
// 切换到指定谱面并播放（key 形如 builtin:xxx / user:xxx）
async function _switchToSong(key){
  const sel = document.getElementById('songSel');
  let opt = sel ? [...sel.options].find(o => o.value === key) : null;
  if(sel && !opt){
    opt = document.createElement('option');
    opt.value = key;
    opt.textContent = _songDisplayName(String(key).replace(/^(builtin:|user:)/, ''));
    sel.appendChild(opt);
  }
  if(sel) sel.value = key;
  await onSongChange(key);
}

async function loadSongList(){
  const sel = document.getElementById('songSel');
  sel.innerHTML = '';
  const deleted = getDeletedBuiltin();
  // 内置谱（排除已删除）
  try{
    const list = await _getBuiltinList();
    for(const song of list){
      if(deleted.has(song.file)) continue;
      // 测试谱（list.json 中 test:true）仅在本地下过时才出现在选谱列表，
      // 避免初始状态只下载 2 首正式谱、列表却列出一堆未下载的测试谱。
      if(song.test){
        let has = false;
        try{ has = await AssetCache.has(song.file); }catch(e){}
        if(!has) continue;
      }
      const opt = document.createElement('option');
      opt.value = 'builtin:' + song.file;
      opt.textContent = song.name;
      sel.appendChild(opt);
    }
  }catch(e){}
  // 用户上传谱
  try{
    const userSongs = await getUserSongs();
    userSongs.forEach(song => {
      const opt = document.createElement('option');
      opt.value = 'user:' + song.name;
      opt.textContent = song.name;
      sel.appendChild(opt);
    });
  }catch(e){}
}
loadSongList();

// 图标（Feather 线性）
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
// 音色列表项右侧动作：已缓存显示垃圾桶，未缓存显示下载（带百分比）；点击未下载项会直接下载并切换
function _makeTimbreAction(o){
  if(o.value === '__synth__') return null;
  const box = document.createElement('span');
  // 需下载体积（br 压缩后传输量）：标注在垃圾桶/下载按钮旁边
  const sz = _makeSizeSpan(_mediaBrSize('soundfonts/' + o.value));
  if(sz) box.appendChild(sz);
  const btn = document.createElement('button');
  btn.type = 'button';
  box.appendChild(btn);
  function render(){
    if(SoundfontLoader.cachedNames.has(o.value)){
      _btnIcon(btn, TRASH_ICON, 'del', '删除', function(e){
        if(e && e.stopPropagation) e.stopPropagation();
        if(SoundfontLoader.current === o.value){ setStatus('正在使用该音色，无法删除'); return; }
        SoundfontLoader.deleteCached(o.value).then(function(){
          setStatus('已删除音色：' + o.textContent);
          render(); // 只重绘本按钮，不重建整个列表（避免列表滚动位置跳动）
        }).catch(function(err){ setStatus('删除失败：' + (err && err.message ? err.message : err)); });
      });
    } else {
      _btnIcon(btn, DOWNLOAD_ICON, 'dl', '下载', function(e){
        if(e && e.stopPropagation) e.stopPropagation();
        _btnLoading(btn, 0);
        SoundfontLoader.load(o.value, function(p){
          if(p < 1) _btnLoading(btn, p * 100);
        }, {switchCurrent: false}).then(function(){
          setStatus('音色下载完成：' + o.textContent);
          render(); // 只重绘本按钮，不重建整个列表（避免列表滚动位置跳动）
        }).catch(function(err){
          setStatus('音色下载失败：' + (err && err.message ? err.message : err));
          render();
        });
      });
    }
  }
  render();
  return box;
}

// 谱面管理面板：透明度 / 模糊度与菜单面板共享同一组值（滑块只在设置面板）
function _syncManageAppearanceFromPanel(){ /* 滑块已移至设置面板，无需同步 */ }
function applyManageAppearance(){ applyPanelAppearance(); }

// 谱面管理行：仅名称 + 右侧垃圾桶/下载图标（无文字标签）；操作时就地显示加载/百分比
const SPINNER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
function _btnLoading(btn, pct){
  btn.disabled = true;
  btn.classList.add('loading');
  btn.innerHTML = (pct == null) ? SPINNER_ICON : '<span class="btn-pct">' + Math.round(pct) + '%</span>';
}
function _btnIcon(btn, icon, cls, title, handler){
  btn.disabled = false;
  btn.classList.remove('loading');
  btn.className = 'icon-btn ' + cls;
  btn.innerHTML = icon;
  btn.title = title;
  btn.onclick = handler;
}
function _makeManageRow(name, kind, file, isDeleted, cached){
  const row = document.createElement('div');
  row.className = 'manage-row';
  if(file) row.dataset.file = file;
  const nm = document.createElement('span');
  nm.className = 'name';
  nm.textContent = name;
  row.appendChild(nm);
  const btn = document.createElement('button');
  if(kind === 'user'){
    _btnIcon(btn, TRASH_ICON, 'del', '删除', () => _onDeleteUser(name, btn, row));
  } else if(isDeleted || !cached){
    // 未下载（或已标记删除）显示下载图标；已缓存才显示删除
    const title = isDeleted ? '重新下载' : '下载';
    _btnIcon(btn, DOWNLOAD_ICON, 'dl', title, () => (isDeleted ? _onRedownloadBuiltin(file, btn) : _onDownloadBuiltin(file, btn)));
  } else {
    _btnIcon(btn, TRASH_ICON, 'del', '删除', () => _onDeleteBuiltin(file, btn));
  }
  // 需下载体积（br 压缩后传输量）：标注在垃圾桶/下载按钮旁边
  if(kind === 'builtin' && file){
    const sz = _makeSizeSpan(_mediaBrSize(file));
    if(sz) row.appendChild(sz);
  }
  row.appendChild(btn);
  // 点击行（非操作按钮）切换到该谱面播放；未下载则直接下载并切换（不再弹窗确认）。
  // 下载/删除属"管理动作"，不算直接点击谱面：按钮处理器会调用 _btnLoading
  // 替换 innerHTML，使 e.target 脱离文档、closest('button') 失效，故用
  // composedPath（派发时快照）判断是否来自按钮。
  row.addEventListener('click', (e) => {
    const path = (e.composedPath && e.composedPath()) || [];
    if(path.some(el => el && el.tagName === 'BUTTON')) return;
    if(e.target && e.target.closest && e.target.closest('button')) return;
    _onManageRowClick(name, kind, file, isDeleted);
  });
  return row;
}
async function _onManageRowClick(name, kind, file, isDeleted){
  try{
    if(kind === 'user'){
      closeManageModal();
      await _switchToSong('user:' + name);
      return;
    }
    const cached = await AssetCache.has(file);
    if(cached){
      // 若曾被标记删除，先恢复（软删除时缓存仍在）
      const set = getDeletedBuiltin();
      if(set.has(file)){ set.delete(file); saveDeletedBuiltin(set); await loadSongList(); }
      closeManageModal();
      await _switchToSong('builtin:' + file);
      return;
    }
    // 未下载：直接下载并切换（不再二次确认弹窗）
    try{
      setStatus('谱面[' + name + '] 下载中…');
      await _fetchWithProgress(file, (p) => setStatus('谱面[' + name + '] 下载 ' + Math.round(p) + '%'));
      const set = getDeletedBuiltin();
      if(set.has(file)){ set.delete(file); saveDeletedBuiltin(set); }
      await loadSongList();
      closeManageModal();
      await _switchToSong('builtin:' + file);
    }catch(e){
      setStatus('谱面[' + name + '] 下载失败');
    }
  }catch(e){
    setStatus('谱面加载失败：' + (e && e.message ? e.message : e));
  }
}
async function _onDeleteUser(name, btn, row){
  _btnLoading(btn);
  await deleteSong(name);
  row.remove();
}
async function _onDeleteBuiltin(file, btn){
  _btnLoading(btn);
  await deleteBuiltinSong(file);
  _btnIcon(btn, DOWNLOAD_ICON, 'dl', '重新下载', () => _onRedownloadBuiltin(file, btn));
}
async function _onRedownloadBuiltin(file, btn){
  _btnLoading(btn, 0);
  await redownloadBuiltinSong(file, (p) => _btnLoading(btn, p));
  _btnIcon(btn, TRASH_ICON, 'del', '删除', () => _onDeleteBuiltin(file, btn));
}
// 未下载的内置谱：点击下载（不播放），完成后就地把下载图标换成删除图标
async function _onDownloadBuiltin(file, btn){
  _btnLoading(btn, 0);
  try{
    await _fetchWithProgress(file, (p) => _btnLoading(btn, p));
  }catch(e){
    _btnIcon(btn, DOWNLOAD_ICON, 'dl', '下载', () => _onDownloadBuiltin(file, btn));
    setStatus('谱面[' + _songDisplayName(file.split('/').pop()) + ']下载失败');
    return;
  }
  _btnIcon(btn, TRASH_ICON, 'del', '删除', () => _onDeleteBuiltin(file, btn));
  await loadSongList();
}
// 后台自动下载完成后，实时刷新已打开的谱面管理行状态（面板未打开时为空操作）
async function refreshManageRowState(file){
  const rows = document.querySelectorAll('#manageList .manage-row');
  let row = null;
  for(const r of rows){ if(r.dataset && r.dataset.file === file){ row = r; break; } }
  if(!row) return;
  const btn = row.querySelector('button');
  if(!btn) return;
  const deleted = getDeletedBuiltin();
  const cached = await AssetCache.has(file);
  if(deleted.has(file) || !cached){
    const title = deleted.has(file) ? '重新下载' : '下载';
    _btnIcon(btn, DOWNLOAD_ICON, 'dl', title, () => (deleted.has(file) ? _onRedownloadBuiltin(file, btn) : _onDownloadBuiltin(file, btn)));
  } else {
    _btnIcon(btn, TRASH_ICON, 'del', '删除', () => _onDeleteBuiltin(file, btn));
  }
}

// 谱面管理：二次点击收起
function toggleManageModal(){
  const m = document.getElementById('manageModal');
  if(m && m.classList.contains('open')){ closeManageModal(); return; }
  openManageModal();
}
// 重置所有设置：清空本站设置项并刷新
async function resetAllSettings(){
  // 重置所有设置项 + 恢复演示谱面标记 + 下载缺失的默认资源
  const keys = ['panelTransparency', 'panelBlur', 'dbgAutoOpen', 'debugEnabled',
                'menuBtnPos', 'paletteCustom', 'paletteV2', 'raceFull'];
  try{ keys.forEach(k => localStorage.removeItem(k)); }catch(e){}
  // 恢复演示谱面（Rush E3）标记：从「已删除」集合中移除
  try{
    const set = getDeletedBuiltin();
    _SOFT_DELETE.forEach(f => set.delete(f));
    saveDeletedBuiltin(set);
  }catch(e){}
  // 下载缺失的默认音色与谱面（静默，不阻塞重载）
  try{
    const NEED_TIMBRES = ['clavinet'];
    for(const t of NEED_TIMBRES){
      if(!SoundfontLoader.cachedNames.has(t))
        SoundfontLoader.load(t, null, {switchCurrent:false}).catch(()=>{});
    }
    fetchMedia('midi/Rush E 3.mid', null, true).catch(()=>{});
    fetchMedia('midi/The Sound of Silence.mid', null, true).catch(()=>{});
  }catch(e){}
  try{ location.reload(); }catch(e){}
}
async function openManageModal(){
  const modal = document.getElementById('manageModal');
  const list = document.getElementById('manageList');
  closeAllDropPanels(modal);
  modal.classList.add('open');
  syncDropToggleIcons();
  applyPanelAppearance();
  const frag = document.createDocumentFragment();
  // 用户上传谱
  try{
    const userSongs = await getUserSongs();
    const header = document.createElement('div');
    header.className = 'manage-section';
    header.textContent = '我的上传';
    frag.appendChild(header);
    if(userSongs.length === 0){
      const empty = document.createElement('div');
      empty.className = 'manage-empty';
      empty.textContent = '暂无上传谱面';
      frag.appendChild(empty);
    }
    userSongs.forEach(s => frag.appendChild(_makeManageRow(s.name, 'user', null, false)));
  }catch(e){}
  // 内置谱：已删除的显示「下载」，未删除的显示「删除」
  try{
    const builtin = await _getBuiltinList();
    const deleted = getDeletedBuiltin();
    const header = document.createElement('div');
    header.className = 'manage-section';
    header.textContent = '内置谱面';
    frag.appendChild(header);
    // 初始状态按真实缓存判断：未下载显示「下载」，已下载显示「删除」
    for(const s of builtin){
      const cached = await AssetCache.has(s.file);
      frag.appendChild(_makeManageRow(s.name, 'builtin', s.file, deleted.has(s.file), cached));
    }
  }catch(e){}
  list.textContent = '';
  list.appendChild(frag);
}
function closeManageModal(){
  const modal = document.getElementById('manageModal');
  if(modal) modal.classList.remove('open');
  syncDropToggleIcons();
}
// 公开接口（供测试/外部调用）：只做操作 + 刷新选谱下拉，不重开管理面板
async function deleteSong(name){
  await deleteUserSong(name);
  await loadSongList();
}
async function deleteBuiltinSong(file){
  const set = getDeletedBuiltin(); set.add(file); saveDeletedBuiltin(set);
  if(_isSoftDeleted(file)){
    console.log('[AudioDebug][INFO] ' + _songLabel(file) + ' 已标记删除（演示谱面，保留缓存）');
    await loadSongList();
    return;
  }
  // 真正清理本地缓存：删除该谱面已下载的数据（含 CDN/Pages 两种键名，避免残留）
  let freed = 0;
  try{
    const cache = await caches.open(AssetCache.cacheName);
    const keys = await cache.keys();
    const targets = keys.filter(req => {
      const u = req.url;
      return u.indexOf(file.split('/').pop()) >= 0;
    });
    for(const req of targets){
      try{
        const resp = await cache.match(req);
        if(resp){ const b = await resp.clone().blob(); freed += b.size; }
        await cache.delete(req);
      }catch(e){}
    }
  }catch(e){}
  // 删除该内置谱配置的默认音色（若不再被其它未删除的内置谱使用、且不是当前音色）
  try{
    const fname = file.split('/').pop();
    const t = songDefaultTimbre[fname];
    if(t && t !== '__synth__' && t !== SoundfontLoader.current){
      const stillNeeded = Object.keys(songDefaultTimbre).some(f => {
        if(f === fname) return false;
        if(set.has('midi/' + f) || set.has(f)) return false;
        return songDefaultTimbre[f] === t;
      });
      if(!stillNeeded){
        try{ await SoundfontLoader.deleteCached(t); }catch(e){}
      }
    }
  }catch(e){}
  if(freed > 0) console.log('[AudioDebug][INFO] ' + _songLabel(file) + ' 已删除，释放本地缓存 ' + (freed/1024/1024).toFixed(2) + 'MB');
  else console.log('[AudioDebug][INFO] ' + _songLabel(file) + ' 已删除（无本地缓存）');
  await loadSongList();
}
async function redownloadBuiltinSong(file, onProgress){
  const set = getDeletedBuiltin(); set.delete(file); saveDeletedBuiltin(set);
  try{ await _fetchWithProgress(file, onProgress); }catch(e){ try{ await AssetCache.fetch(file); }catch(_){} }
  await loadSongList();
}

async function onSongChange(val){
  if(!val) return;
  stopPlay();
  currentSongKey = val;
  _invalidateTimbreAutoSwitch(); // 切歌：作废上一首的默认音色自动切换
  // 谱面 + 音色合并为同一条日志：切换: xxx.mid - xxx 音色
  {
    const fname = String(val).replace(/^(builtin:|user:)/, '').split('/').pop();
    const tName = songDefaultTimbre[fname] || SoundfontLoader.current || '__synth__';
    console.log('[AudioDebug][INFO] 切换: ' + fname + ' - ' + timbreDisplayName(tName) + ' 音色');
  }
  try{
    let buf, name;
    if(val.startsWith('builtin:')){
      const file = val.substring(8);
      const resp = await fetchMedia(file);
      if(!resp.ok) throw new Error('加载失败 HTTP ' + resp.status);
      buf = await resp.arrayBuffer();
      name = file.split('/').pop();
      console.log('[AudioDebug][INFO] ' + _songLabel(name) + ' 已加载 (' + (buf.byteLength/1024).toFixed(0) + 'KB)');
    } else if(val.startsWith('user:')){
      name = val.substring(5);
      buf = await getUserSong(name);
      if(!buf) throw new Error('本地缓存中未找到');
      console.log('[AudioDebug][INFO] ' + _songLabel(name) + '（本地缓存）已读取 (' + (buf.byteLength/1024).toFixed(0) + 'KB)');
    }
    parseAndPlayMidi(buf, name);
    // 内置谱按配置应用默认音色（本地不存在时回滚合成钢琴并排队自动切换）
    if(val.startsWith('builtin:')){
      const file = val.substring(8);
      const fname = file.split('/').pop();
      const defaultTimbre = songDefaultTimbre[fname];
      if(defaultTimbre) await _applySongDefaultTimbre(file, fname, defaultTimbre);
    }
    // 切换后自动播放
    initAudio();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    startPlay();
  }catch(e){
    showToast('谱子加载失败：' + e.message);
  }
}

// 通用：解析MIDI并准备播放
function parseAndPlayMidi(buf, filename){
  const midi = new Midi(buf);
  allNotes = [];
  let maxTime = 0;
  midi.tracks.forEach(track => {
    track.notes.forEach(note => {
      allNotes.push({midi: note.midi, time: note.time, duration: note.duration, velocity: note.velocity});
      if(note.time + note.duration > maxTime) maxTime = note.time + note.duration;
    });
  });
  allNotes.sort((a, b) => a.time - b.time);
  totalDuration = maxTime;
  _songEnded = false; // 新谱面：重置「已播完」标记
  // 根据整首谱面平均密度设置自适应同音重触发下限（仅高密度 black-MIDI 生效）
  const density = totalDuration > 0 ? allNotes.length / totalDuration : 0;
  SoundfontLoader.baseRetriggerFloor =
    density <= 1000 ? 0 :
    density <= 3000 ? 0.008 :
    density <= 6000 ? 0.02 :
    density <= 12000 ? 0.035 : 0.05;
  SoundfontLoader.retriggerFloor = SoundfontLoader.baseRetriggerFloor;
  SoundfontLoader.lastTriggerTime.fill(0);
  // 谱面密度 = 全曲音符总数 / 全曲时长(秒)，即整首的平均音符密度（音符/s）
  console.log('[AudioDebug][INFO] 谱面密度=' + density.toFixed(2) + ' 音符/s（=' + allNotes.length +
    ' 音符 / ' + totalDuration.toFixed(2) + 's，全曲平均），自适应同音重触发下限=' +
    SoundfontLoader.retriggerFloor + 's');
  document.getElementById('statTracks').textContent = '轨道：' + midi.tracks.length;
  document.getElementById('statTotal').textContent = '音符：' + allNotes.length;
  document.getElementById('statPlayed').textContent = '已播：0/' + allNotes.length;
  document.getElementById('statPercent').textContent = '0.00%';
  document.getElementById('playBtn').disabled = false;
  document.getElementById('replayBtn').disabled = false;
  document.getElementById('nextBtn').disabled = false;
  document.getElementById('loopBtn').disabled = false;
  document.getElementById('totalTime').textContent = formatTime(totalDuration);
  currentTime = 0;
  nextNoteIndex = 0;
  updateProgress();
  drawScene([], 0, 0, 0);
}

/* ============================================================
 * 3. MIDI 解析
 * ========================================================== */
let allNotes = []; // {midi, time, duration, velocity}
let totalDuration = 0;

function onMidiFile(event){
  const file = event.target.files[0];
  if(!file) return;
  const fname = file.name || '';
  // 非 .mid / .midi 格式：直接拒绝并告警
  if(!/\.midi?$/i.test(fname)){
    console.warn('[AudioDebug][WARN] 上传文件非 MIDI 格式：' + _songId(fname));
    showToast('仅支持 .mid / .midi 文件');
    event.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async function(e){
    try{
      stopPlay();
      const buf = e.target.result;
      parseAndPlayMidi(buf, file.name);
      if(!allNotes.length){
        throw new Error('谱面为空或格式错误（未解析到任何音符）');
      }
      console.log('[AudioDebug][INFO] ' + _songLabel(fname) + ' 上传解析成功，共 ' + allNotes.length + ' 个音符');
      // 上传后自动播放
      initAudio();
      if(audioCtx.state === 'suspended') audioCtx.resume();
      startPlay();
      // 保存到 IndexedDB 并刷新播放列表
      try{
        await saveUserSong(file.name, buf);
        await loadSongList();

        // 选中刚上传的
        const sel = document.getElementById('songSel');
        for(let i=0;i<sel.options.length;i++){
          if(sel.options[i].value === 'user:' + file.name){
            sel.selectedIndex = i; break;
          }
        }
      }catch(err){
        console.warn('[AudioDebug][WARN] 保存到本地缓存失败:', err);
      }
    }catch(err){
      console.warn('[AudioDebug][WARN] ' + _songLabel(fname) + ' 解析失败：' + (err && err.message ? err.message : err));
      showToast('解析失败：' + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
  event.target.value = '';
}

function formatTime(sec){
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ============================================================
 * 4. 播放控制
 * ========================================================== */
let isPlaying = false;
let lastStatUpdate = 0;
let currentTime = 0;
let playStartTime = 0;
let playSpeed = 1;
let nextNoteIndex = 0;
let rafId = null;
const activeKeySet = new Set();
let loopMode = 'list'; // 'list' 列表循环 | 'one' 单曲循环
let playMode = 'appreciate';   // 'appreciate' 欣赏模式（自动发声） | 'perform' 演奏模式（需点击琴键发声）
let pianoHeightPct = 16;       // 钢琴（键盘区）高度占绘制区比例，范围 5-50（首帧由横竖屏默认值决定）
let pianoWidthScale = 1;       // 钢琴宽度缩放（菜单滑块），1x-4x；缩放后渲染区与音符轨道同步变化
let viewOffsetX = 0;           // 钢琴水平偏移（canvas 设备像素），由偏移滑块控制
const PIANO_MIN_SCALE = 1;
const PIANO_MAX_SCALE = 4;

// 音游模式开关：开 = 音游模式（音符只下落、需点击琴键发声）；关 = 欣赏模式（默认，音符自动发声）
// 标签固定显示「音游模式」四个字，默认关闭（即欣赏模式）。
function onPlayModeChange(){
  const sw = document.getElementById('playModeSw');
  playMode = (sw && sw.checked) ? 'perform' : 'appreciate';
  if(playMode === 'perform') SoundfontLoader.stopAll(); // 音游模式：停止自动排程的音符
}
// 横竖屏两套默认钢琴高度：竖屏（移动端）15%，横屏（PC / 全屏旋转）25%
const PIANO_HEIGHT_DEFAULT = { portrait: 15, landscape: 25 };
// 用户手动改过的值，按方向分别记忆；null 表示该方向仍用默认值
const _pianoHeightOverride = { portrait: null, landscape: null };
let _pianoOrientation = null; // 'portrait' | 'landscape'
// 判断渲染区方向：高 > 宽为竖屏，否则横屏（宽度不小于高度）
function _pianoLayoutOrientation(){
  const r = canvas.getBoundingClientRect();
  return (r.height > r.width) ? 'portrait' : 'landscape';
}
function _syncPianoHeightUI(){
  const s = document.getElementById('pianoHeightSlider');
  if(s) s.value = pianoHeightPct;
  const val = document.getElementById('pianoHeightVal');
  if(val) val.textContent = Math.round(pianoHeightPct) + '%';
}
// 在 resizeCanvas 开头调用：方向变化时套用该方向的值（用户手动改过则用其值，否则用默认）
function _syncPianoHeightForOrientation(){
  const o = _pianoLayoutOrientation();
  if(o === _pianoOrientation) return;
  _pianoOrientation = o;
  const v = (_pianoHeightOverride[o] != null) ? _pianoHeightOverride[o] : PIANO_HEIGHT_DEFAULT[o];
  pianoHeightPct = Math.max(5, Math.min(50, v));
  _syncPianoHeightUI();
}
// 钢琴高度（键盘区占绘制区比例）调节；fromUser=true 时按当前方向记忆用户值
function _setPianoHeightPct(v, fromUser){
  pianoHeightPct = Math.max(5, Math.min(50, v));
  if(fromUser && _pianoOrientation) _pianoHeightOverride[_pianoOrientation] = pianoHeightPct;
  _syncPianoHeightUI();
  try{ resizeCanvas(); }catch(e){}
}
function onPianoHeightChange(){
  const s = document.getElementById('pianoHeightSlider');
  const fallback = (_pianoOrientation && _pianoHeightOverride[_pianoOrientation] != null)
    ? _pianoHeightOverride[_pianoOrientation]
    : (PIANO_HEIGHT_DEFAULT[_pianoOrientation] || 25);
  _setPianoHeightPct(s ? (parseFloat(s.value) || fallback) : fallback, true);
}

// 播放控制图标（Feather 线性风格；currentColor 使其自动融入任意主题配色）
const _svgIcon = (inner, size) => '<svg width="' + (size || 14) + '" height="' + (size || 14) +
  '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">' + inner + '</svg>';
// 填充型图标（Bootstrap / Solar 实心等），可指定 viewBox 边长
const _fillIcon = (inner, size, vb) => '<svg width="' + (size || 14) + '" height="' + (size || 14) +
  '" viewBox="0 0 ' + (vb || 24) + ' ' + (vb || 24) + '" fill="currentColor" style="flex-shrink:0">' + inner + '</svg>';
const PLAY_ICON = _svgIcon('<polygon points="5 3 19 12 5 21 5 3"/>');
const PAUSE_ICON = _svgIcon('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>');
// 列表循环 / 单曲循环（Bootstrap Icons bi:repeat / bi:repeat-1，16 网格实心）
const LIST_LOOP_ICON = _fillIcon('<path d="M11 5.466V4H5a4 4 0 0 0-3.584 5.777a.5.5 0 1 1-.896.446A5 5 0 0 1 5 3h6V1.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384l-2.36 1.966a.25.25 0 0 1-.41-.192m3.81.086a.5.5 0 0 1 .67.225A5 5 0 0 1 11 13H5v1.466a.25.25 0 0 1-.41.192l-2.36-1.966a.25.25 0 0 1 0-.384l2.36-1.966a.25.25 0 0 1 .41.192V12h6a4 4 0 0 0 3.585-5.777a.5.5 0 0 1 .225-.67Z"/>', 14, 16);
const ONE_LOOP_ICON = _fillIcon('<path d="M11 4v1.466a.25.25 0 0 0 .41.192l2.36-1.966a.25.25 0 0 0 0-.384l-2.36-1.966a.25.25 0 0 0-.41.192V3H5a5 5 0 0 0-4.48 7.223a.5.5 0 0 0 .896-.446A4 4 0 0 1 5 4zm4.48 1.777a.5.5 0 0 0-.896.446A4 4 0 0 1 11 12H5.001v-1.466a.25.25 0 0 0-.41-.192l-2.36 1.966a.25.25 0 0 0 0 .384l2.36 1.966a.25.25 0 0 0 .41-.192V13h6a5 5 0 0 0 4.48-7.223Z"/><path d="M9 5.5a.5.5 0 0 0-.854-.354l-1.75 1.75a.5.5 0 1 0 .708.708L8 6.707V10.5a.5.5 0 0 0 1 0z"/>', 14, 16);
// 不循环（播完暂停）：mdi:repeat-off（带斜杠的循环箭头）
const NO_LOOP_ICON = _fillIcon('<path d="M2 5.27L3.28 4L20 20.72L18.73 22l-3-3H7v3l-4-4l4-4v3h6.73L7 10.27V11H5V8.27zM17 13h2v4.18l-2-2zm0-8V2l4 4l-4 4V7H8.82l-2-2z"/>', 14, 24);

function togglePlay(){
  initAudio();
  if(audioCtx.state === 'suspended') audioCtx.resume();
  if(isPlaying){
    pausePlay();
  } else {
    startPlay();
  }
}

function startPlay(){
  if(!allNotes.length) return;
  // 防止重复启动导致多个 rAF 循环同时推进 nextNoteIndex
  if(rafId) cancelAnimationFrame(rafId);
  isPlaying = true;
  if(typeof AudioDebugMonitor !== 'undefined') AudioDebugMonitor.resetClocks();
  playStartTime = audioCtx.currentTime - currentTime / playSpeed;
  nextNoteIndex = lowerBound(allNotes, currentTime);
  const _pb = document.getElementById('playBtn');
  _pb.innerHTML = PAUSE_ICON; _pb.title = '暂停';
  rafId = requestAnimationFrame(playLoop);
  schedulePaletteAutoCollapse(); // 3s 内未切换配色/点全屏则自动收起配色栏
}

function pausePlay(){
  isPlaying = false;
  if(typeof AudioDebugMonitor !== 'undefined') AudioDebugMonitor.resetClocks();
  cancelPaletteAutoCollapse(); // 暂停后不再自动收起配色面板
  if(rafId) cancelAnimationFrame(rafId);
  rafId = null;
  // 已经排程到音频线程的音符不会自己停，必须显式停止
  SoundfontLoader.stopAll();
  currentTime = (audioCtx.currentTime - playStartTime) * playSpeed;
  const _pb = document.getElementById('playBtn');
  _pb.innerHTML = PLAY_ICON; _pb.title = '播放';
  requestStaticRedraw(); // 清掉暂停瞬间可能残留的按键高亮
}

function stopPlay(){
  isPlaying = false;
  if(typeof AudioDebugMonitor !== 'undefined') AudioDebugMonitor.resetClocks();
  if(rafId) cancelAnimationFrame(rafId);
  rafId = null;
  // 停止所有已排程/正在播放的音符
  SoundfontLoader.stopAll();
  currentTime = 0;
  nextNoteIndex = 0;
  const _pb = document.getElementById('playBtn');
  _pb.innerHTML = PLAY_ICON; _pb.title = '播放';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('curTime').textContent = '0:00';
  if(allNotes.length > 0){
    document.getElementById('statPlayed').textContent = '已播：0/' + allNotes.length;
    document.getElementById('statPercent').textContent = '0.00%';
  }
  drawScene([], 0, 0, 0);
}

function replayPlay(){
  stopPlay();
  setTimeout(() => { initAudio(); startPlay(); }, 50);
}

// 下一首：切到列表中的下一首（到底回到第一首）
function nextSong(){
  const sel = document.getElementById('songSel');
  if(!sel || sel.options.length === 0) return;
  const nextIdx = (sel.selectedIndex + 1) % sel.options.length;
  sel.selectedIndex = nextIdx;
  onSongChange(sel.value);
}

function toggleLoop(){
  loopMode = loopMode === 'list' ? 'one' : (loopMode === 'one' ? 'none' : 'list');
  const btn = document.getElementById('loopBtn');
  btn.innerHTML = loopMode === 'one' ? ONE_LOOP_ICON : (loopMode === 'none' ? NO_LOOP_ICON : LIST_LOOP_ICON);
  btn.title = loopMode === 'one' ? '单曲循环' : (loopMode === 'none' ? '不循环（播完暂停）' : '列表循环');
}

function toggleMenu(){
  const panel = document.getElementById('controlPanel');
  if(!panel) return;
  closeAllDropPanels(panel);
  panel.classList.toggle('open');
  syncDropToggleIcons();
}

// 菜单/调试按钮组：二者都可拖动，捆绑一起移动；轻点各自触发对应功能
(function(){
  const group = document.getElementById('fabGroup');
  const menuBtn = document.querySelector('.menu-btn');
  if(!group || !menuBtn) return;
  let fadeTimer = null;
  function showMenuBtn(){
    group.classList.remove('faded');
    if(fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => group.classList.add('faded'), 2000);
  }
  window.showMenuBtn = showMenuBtn;
  // 初始显示，2秒后淡出
  showMenuBtn();
  // 页面任意交互时显现
  document.addEventListener('touchstart', () => { if(!group.classList.contains('hidden-btn')) showMenuBtn(); }, {passive:true});
  document.addEventListener('mousemove', () => { if(!group.classList.contains('hidden-btn')) showMenuBtn(); });

  // 位置边界：移动端限制在 10%~90% 高度；PC 允许整屏自由摆放
  function fabBounds(){
    const H = window.innerHeight, W = window.innerWidth;
    const gh = group.offsetHeight || 57;
    const gw = group.offsetWidth || 26;
    const isMobile = W <= 800;
    const minTop = isMobile ? Math.round(H * 0.1) : 4;
    const maxTop = isMobile ? Math.max(minTop, Math.round(H * 0.9) - gh) : Math.max(minTop, H - gh - 4);
    return { minTop, maxTop, minLeft: 4, maxLeft: Math.max(4, W - gw - 4) };
  }
  function clampFabGroup(){
    const b = fabBounds();
    const r = group.getBoundingClientRect();
    let top = r.top, left = r.left, changed = false;
    if(top < b.minTop){ top = b.minTop; changed = true; }
    if(top > b.maxTop){ top = b.maxTop; changed = true; }
    if(left < b.minLeft){ left = b.minLeft; changed = true; }
    if(left > b.maxLeft){ left = b.maxLeft; changed = true; }
    if(changed){
      group.style.left = Math.round(left) + 'px';
      group.style.top = Math.round(top) + 'px';
      group.style.right = 'auto'; group.style.bottom = 'auto';
      group.style.transform = 'none';
      try{ localStorage.setItem('menuBtnPos', JSON.stringify({x: Math.round(left), y: Math.round(top)})); }catch(e){}
    }
  }
  window.clampFabGroup = clampFabGroup;

  // 恢复拖拽位置（移动端与 PC 均恢复；PC 不再吸附左右侧）
  const saved = localStorage.getItem('menuBtnPos');
  if(saved){
    try{
      const pos = JSON.parse(saved);
      group.style.left = pos.x + 'px';
      group.style.top = pos.y + 'px';
      group.style.right = 'auto';
      group.style.bottom = 'auto';
      group.style.transform = 'none';
    }catch(e){}
  }
  // 恢复/布局后校正位置，防止保存的坐标落在屏幕外
  setTimeout(clampFabGroup, 50);
  window.addEventListener('resize', clampFabGroup);
  window.addEventListener('orientationchange', () => setTimeout(clampFabGroup, 300));
  if(window.visualViewport) window.visualViewport.addEventListener('resize', () => clampFabGroup());

  let isDragging = false, moved = false, tapAction = null;
  let startX, startY, startLeft, startTop;
  function onDown(action){
    return function(e){
      tapAction = action;
      isDragging = true; moved = false;
      const p = e.touches ? e.touches[0] : e;
      startX = p.clientX; startY = p.clientY;
      const r = group.getBoundingClientRect();
      startLeft = r.left; startTop = r.top;
      group.style.transition = 'none'; // 拖动时禁用过渡，确保跟手
      group.classList.remove('faded'); // 拖动时保持不透明
      if(fadeTimer) clearTimeout(fadeTimer);
      e.preventDefault();
    };
  }
  function onMove(e){
    if(!isDragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - startX, dy = p.clientY - startY;
    if(Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    const b = fabBounds();
    const nl = Math.max(b.minLeft, Math.min(b.maxLeft, startLeft + dx));
    const nt = Math.max(b.minTop, Math.min(b.maxTop, startTop + dy));
    group.style.left = Math.round(nl) + 'px'; group.style.top = Math.round(nt) + 'px';
    group.style.right = 'auto'; group.style.bottom = 'auto';
    group.style.transform = 'none';
    e.preventDefault();
  }
  function onUp(){
    if(!isDragging) return;
    isDragging = false;
    if(moved){
      group.style.transition = '';
      // 仅移动端吸附左右侧（以屏幕中轴线为分界）；PC 鼠标交互不吸附，停留在落点
      if(window.innerWidth <= 800){
        const centerX = group.offsetLeft + group.offsetWidth / 2;
        const screenCenter = window.innerWidth / 2;
        const snapX = centerX < screenCenter ? 4 : (window.innerWidth - group.offsetWidth - 4);
        group.style.left = snapX + 'px';
      }
      clampFabGroup();
      localStorage.setItem('menuBtnPos', JSON.stringify({x: group.offsetLeft, y: group.offsetTop}));
      showMenuBtn();
    } else {
      group.style.transition = '';
      if(tapAction) tapAction();
    }
    tapAction = null;
  }
  menuBtn.addEventListener('mousedown', onDown(toggleMenu));
  menuBtn.addEventListener('touchstart', onDown(toggleMenu), {passive:false});
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, {passive:false});
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);
})();

// 回到前台自动续播（不因失焦暂停）
// 前后台切换：后台时冻结播放头（不推进时间、不丢谱），回前台从原处续播。
// 轻量做法：不挂起 AudioContext、不加遮罩，只重定位时间基准并停止已发声的音符。
document.addEventListener('visibilitychange', () => {
  if(document.hidden){
    if(!isPlaying || !audioCtx) return;
    // 记录当前歌曲时间，并停掉已排程/正在发声的音符，避免回前台后重叠
    currentTime = (audioCtx.currentTime - playStartTime) * playSpeed;
    SoundfontLoader.stopAll();
    // 后台冻结属正常：把“最近有声时间”拉到现在并重置诊断基线，避免恢复后误报静音/停摆
    AudioDebugMonitor.lastLoudTime = performance.now();
    AudioDebugMonitor.resetClocks();
    if(rafId) cancelAnimationFrame(rafId);
    rafId = null;
    return;
  }
  if(!isPlaying || !totalDuration) return;
  // 浏览器可能在后台挂起音频上下文，回到前台时恢复
  initAudio();
  if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  // 关键：以冻结时的 currentTime 重设时间基准，
  // 否则会用后台期间流逝的 audioCtx.currentTime 一次性跳播、丢掉中间谱面
  playStartTime = audioCtx.currentTime - currentTime / playSpeed;
  nextNoteIndex = lowerBound(allNotes, currentTime);
  AudioDebugMonitor.lastLoudTime = performance.now();
  AudioDebugMonitor.resetClocks(); // 清 lastFrameAudioTime/lastWall，避免把后台空档误判为丢帧/停摆
  // 安全兜底：若渲染循环已停止则重新拉起
  if(!rafId) rafId = requestAnimationFrame(playLoop);
});

// 进度条拖拽
let isSeeking = false;
function startSeek(event){
  if(!totalDuration) return;
  isSeeking = true;
  event.preventDefault();
  doSeek(event);
  document.addEventListener('mousemove', doSeek);
  document.addEventListener('mouseup', endSeek);
  document.addEventListener('touchmove', doSeek, {passive:false});
  document.addEventListener('touchend', endSeek);
}
function doSeek(event){
  if(!totalDuration) return;
  event.preventDefault();
  const bar = document.getElementById('progressBar');
  const rect = bar.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  currentTime = pct * totalDuration;
  if(isPlaying){
    playStartTime = audioCtx.currentTime - currentTime / playSpeed;
    nextNoteIndex = lowerBound(allNotes, currentTime);
  }
  updateProgress();
  // 拖拽时也更新可视化
  const fallDur = 2.0 / fallSpeedMultiplier;
  const leftIdx = lowerBound(allNotes, currentTime - fallDur);
  const rightIdx = lowerBound(allNotes, currentTime + fallDur);
  drawScene(allNotes, leftIdx, rightIdx, currentTime);
}
function endSeek(){
  isSeeking = false;
  document.removeEventListener('mousemove', doSeek);
  document.removeEventListener('mouseup', endSeek);
  document.removeEventListener('touchmove', doSeek);
  document.removeEventListener('touchend', endSeek);
}

function setSpeed(speed){
  playSpeed = Math.max(0.1, Math.min(3, parseFloat(speed) || 1));
  const sl = document.getElementById('speedSlider');
  if(sl) sl.value = playSpeed;
  const v = document.getElementById('speedVal');
  if(v) v.textContent = playSpeed.toFixed(1) + 'x';
  if(isPlaying){
    playStartTime = audioCtx.currentTime - currentTime / playSpeed;
  }
}
function onSpeedChange(){
  const sl = document.getElementById('speedSlider');
  if(sl) setSpeed(sl.value);
}

let fallSpeedMultiplier = 1.0;
function onFallSpeedChange(){
  fallSpeedMultiplier = parseFloat(document.getElementById('fallSpeedSlider').value);
  document.getElementById('fallSpeedVal').textContent = fallSpeedMultiplier.toFixed(1) + 'x';
}

// 二分查找：第一个 time >= target 的索引
function lowerBound(arr, target){
  let lo = 0, hi = arr.length;
  while(lo < hi){
    const mid = (lo + hi) >> 1;
    if(arr[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function playLoop(ts){
  if(!isPlaying) return;
  // 帧率上限：不足最小间隔则本帧只重排 rAF、不推进逻辑与绘制
  const _cap = _effectiveFpsCap();
  if(_cap > 0){
    const _t = (typeof ts === 'number') ? ts : performance.now();
    if(_lastLoopTs && (_t - _lastLoopTs) < (1000 / _cap) - 0.5){
      rafId = requestAnimationFrame(playLoop);
      return;
    }
    _lastLoopTs = _t;
  }
  const _frameT0 = performance.now();
  const now = audioCtx.currentTime;

  // 帧间隔跳变检测：主线程被阻塞（GC/长任务）会导致rAF延迟，
  // 随后一帧内堆积触发大量音符，瞬间灌爆音频线程
  if(AudioDebugMonitor.lastFrameAudioTime){
    const jump = now - AudioDebugMonitor.lastFrameAudioTime;
    if(jump > 0.1) AudioDebugMonitor.severeDrops++; // 严重丢帧（帧间隔 >100ms）
    if(jump > 0.08){
      console.warn('[AudioDebug] 帧间隔跳变 ' + (jump * 1000).toFixed(0) +
        'ms 本帧将追赶音符');
    }
    // 遮挡/最小化等未触发 visibilitychange 的长时间停摆：把时间基准回拨冻结，
    // 从停摆处续播，避免用音频时钟一次性跳播、丢掉中间谱面
    if(jump > 1.0){
      playStartTime = now - currentTime / playSpeed;
      SoundfontLoader.stopAll();
      console.log('[AudioDebug][INFO] 检测到长时间停摆 ' + (jump * 1000).toFixed(0) +
        'ms，已冻结播放头避免跳播');
    }
  }
  AudioDebugMonitor.lastFrameAudioTime = now;

  currentTime = (now - playStartTime) * playSpeed;

  // 触发到时间的音符（不做同音合并，每个音符事件都触发）
  // 追赶洪峰抑制：若一帧待触发音符过多（音频时钟曾停摆导致积压），
  // 只触发上限内的音符并快进跳过剩余积压，避免瞬间创建海量节点灌爆音频线程
  const MAX_TRIGGER_PER_FRAME = 256;
  let _trigCount = 0;
  let _skipped = 0;
  while(nextNoteIndex < allNotes.length && allNotes[nextNoteIndex].time <= currentTime){
    if(_trigCount >= MAX_TRIGGER_PER_FRAME){
      while(nextNoteIndex < allNotes.length && allNotes[nextNoteIndex].time <= currentTime){
        nextNoteIndex++; _skipped++;
      }
      break;
    }
    const note = allNotes[nextNoteIndex];
    _trigCount++;
    // 演奏模式：音符只下落不自动发声，需用户点击琴键
    if(playMode === 'appreciate') SoundfontLoader.playNote(note.midi, note.velocity, note.duration / playSpeed);
    nextNoteIndex++;
  }
  if(_skipped > 0){
    AudioDebugMonitor.skippedNotes += _skipped;
  }
  AudioDebugMonitor.frame(performance.now() - _frameT0, _trigCount);

  // 计算可见音符范围：二分查找定位区间，不slice（避免大数组分配）
  const fallDuration = 2.0 / fallSpeedMultiplier;
  const leftIdx = lowerBound(allNotes, currentTime - fallDuration);
  const rightIdx = lowerBound(allNotes, currentTime + fallDuration);

  // 进度与统计每100ms更新一次，不每帧写DOM
  if(!lastStatUpdate || now - lastStatUpdate > 0.1){
    lastStatUpdate = now;
    updateProgress();
    const played = nextNoteIndex;
    const total = allNotes.length;
    document.getElementById('statPlayed').textContent = '已播：' + played + '/' + total;
    document.getElementById('statPercent').textContent = (total > 0 ? (played / total * 100).toFixed(2) : '0.00') + '%';
  }
  const _drawT0 = performance.now();
  drawScene(allNotes, leftIdx, rightIdx, currentTime);
  AudioDebugMonitor.drawFrame(performance.now() - _drawT0);

  if(currentTime >= totalDuration){
    _songEnded = true; // 播完：作废待自动切换的默认音色
    if(loopMode === 'one'){
      currentTime = 0;
      nextNoteIndex = 0;
      playStartTime = audioCtx.currentTime;
    } else if(loopMode === 'none'){
      // 不循环：播完立即暂停
      stopPlay();
      return;
    } else {
      // 列表循环：自动播下一首，播完列表回到第一首
      const sel = document.getElementById('songSel');
      const nextIdx = sel.selectedIndex + 1;
      const targetIdx = nextIdx < sel.options.length ? nextIdx : 0;
      sel.selectedIndex = targetIdx;
      onSongChange(sel.value);
      return;
    }
  }
  rafId = requestAnimationFrame(playLoop);
}

function updateProgress(){
  const pct = totalDuration ? (currentTime / totalDuration) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('curTime').textContent = formatTime(currentTime);
}

/* ============================================================
 * 5. Canvas 可视化：88键钢琴 + 下落音符
 * ========================================================== */
const canvas = document.getElementById('visualCanvas');
const ctx = canvas.getContext('2d');
let C = { w: 800, h: 500 };
let cachedLayout = null;
let keyByMidi = null;       // midi -> key，O(1)查找
let staticCanvas = null;    // 离屏canvas：预渲染静态元素
// 每帧复用的矩形桶：buckets[黑白][力度] -> [x,y,w,h, ...]，避免每帧新建 Path2D
const _drawBuckets = [0, 1].map(() => [0, 1, 2, 3, 4].map(() => []));

// 配色：色相区分黑白键，明度区分力度（各 5 级，轻→重）
const PALETTES = {
  A: { // 纯紫，无力度变化
    white: ['#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6'],
    black: ['#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6', '#8b5cf6']
  },
  B: { // 青蓝 × 琥珀红
    white: ['#22d3ee', '#38bdf8', '#3b82f6', '#6366f1', '#8b5cf6'],
    black: ['#fde68a', '#fbbf24', '#fb923c', '#f97316', '#ef4444']
  },
  C: { // 青绿 × 品红
    white: ['#5eead4', '#2dd4bf', '#22d3ee', '#38bdf8', '#3b82f6'],
    black: ['#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d']
  }
};
// ===== 主题色（按钮/按键遮罩/开关/滑块）=====
const PALETTE_THEME = { A: '#8b5cf6', B: '#c20c0c', C: '#fb7299' }; // A紫 B网抑红 C哔哩哔哩浅粉
let _themeAccent = '#c20c0c';
let _themeAccentRgba = 'rgba(194,12,12,0.7)';
let _themeBeforeEdit = null;
function _hexToRgb(hex){
  let h = String(hex).replace('#', '');
  if(h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0; // 忽略 8 位 hex 的 alpha
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
// 取 6 位/8 位 hex 的 alpha（无则 1）
function _hexAlpha(hex){
  const h = String(hex).replace('#', '');
  return h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
}
// HSLA -> hex（alpha=1 时输出 6 位）
function _hslaToHex(h, s, l, a){
  const hex = hslToHex(h, s, l);
  const al = Math.round((a == null ? 1 : a) * 255);
  return al >= 255 ? hex : hex + al.toString(16).padStart(2, '0');
}
// 应用主题色：写入 --accent 及半透明变体，并更新按键遮罩色
function applyTheme(color){
  const c = color || '#c20c0c';
  _themeAccent = c;
  const root = document.documentElement;
  root.style.setProperty('--accent', c);
  const rgb = _hexToRgb(c);
  const a = _hexAlpha(c);
  root.style.setProperty('--accent-a18', 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + +(0.18 * a).toFixed(3) + ')');
  root.style.setProperty('--accent-a28', 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + +(0.28 * a).toFixed(3) + ')');
  _themeAccentRgba = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + +(0.7 * a).toFixed(3) + ')';
}

// ===== 自定义配色（四端颜色插值出 5 级）=====
const paletteEditColors = { wl: '#5eead4', wh: '#3b82f6', bl: '#f9a8d4', bh: '#be185d', theme: '#c20c0c' };
const PALETTE_TARGET_LABELS = { wl: '白键最轻', wh: '白键最重', bl: '黑键最轻', bh: '黑键最重', theme: '主题色' };
// 常用品牌色预置：点按即把取色板滑块定位到该色并实时应用
const PALETTE_PRESETS = [
  { name: '哔哩粉', color: '#fb7299' },
  { name: '网抑红', color: '#c20c0c' },
  { name: '小书红', color: '#ff2442' },
  { name: 'Q音绿', color: '#31c27c' },
  { name: '酷安绿', color: '#11aa66' },
  { name: '钉钉蓝', color: '#0089ff' },
  { name: '美团黄', color: '#ffc300' },
];
let paletteEditTarget = 'theme';
let _colorPicking = false;
let _colorBoardBound = false;
let _paletteModalBound = false;
let _editHSL = { h: 0, s: 1, l: 0.5, a: 1 };
let _hslDragging = null;

function buildCustomPalette(wl, wh, bl, bh){
  const lerp = (a, b, t) => {
    const pa = _hexToRgb(a), pb = _hexToRgb(b);
    const aa = _hexAlpha(a), ab = _hexAlpha(b);
    const c = pa.map((v, i) => Math.round(v + (pb[i]-v)*t));
    const al = aa + (ab - aa) * t;
    const hex = '#' + c.map(v => v.toString(16).padStart(2,'0')).join('');
    return al >= 0.999 ? hex : hex + Math.round(al * 255).toString(16).padStart(2,'0');
  };
  const ramp = (lo, hi) => [0,1,2,3,4].map(i => lerp(lo, hi, i/4));
  return { white: ramp(wl, wh), black: ramp(bl, bh) };
}
// HSL -> RGB/HEX（用于全彩取色板）
function hslToRgb(h, s, l){
  h = (((h % 360) + 360) % 360) / 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
function hslToHex(h, s, l){
  const c = hslToRgb(h, s, l);
  return '#' + c.map(v => v.toString(16).padStart(2,'0')).join('');
}
function loadCustomPalette(){
  try{
    const s = localStorage.getItem('paletteCustom');
    if(!s) return false;
    const o = JSON.parse(s);
    if(!o.wl || !o.wh || !o.bl || !o.bh) return false;
    paletteEditColors.wl = o.wl; paletteEditColors.wh = o.wh;
    paletteEditColors.bl = o.bl; paletteEditColors.bh = o.bh;
    if(o.theme) paletteEditColors.theme = o.theme;
    PALETTES.custom = buildCustomPalette(o.wl, o.wh, o.bl, o.bh);
    return true;
  }catch(e){ return false; }
}
let currentPalette = 'B';

/* 配色面板：默认收起；播放中 2s 未操作自动收起 */
let paletteAutoCollapseTimer = null;
function _paletteRow(){ return document.getElementById('paletteRow'); }
function updatePaletteToggleIcon(){
  const icon = document.getElementById('paletteToggleIcon');
  const row = _paletteRow();
  if(!icon || !row) return;
  const collapsed = !row.classList.contains('open');
  icon.style.transform = collapsed ? 'rotate(180deg)' : '';
  const btn = document.getElementById('paletteToggleBtn');
  if(btn) btn.title = collapsed ? '展开配色面板' : '收起配色面板';
  syncDropToggleIcons();
}
function setPaletteRowCollapsed(collapsed){
  const row = _paletteRow();
  if(!row) return;
  row.classList.toggle('open', !collapsed);
  if(collapsed) closePaletteEditor();
  updatePaletteToggleIcon();
}
function cancelPaletteAutoCollapse(){
  if(paletteAutoCollapseTimer){ clearTimeout(paletteAutoCollapseTimer); paletteAutoCollapseTimer = null; }
}
// 仅在播放中且配色面板展开时，2s 无操作后自动收起
function schedulePaletteAutoCollapse(){
  cancelPaletteAutoCollapse();
  const row = _paletteRow();
  if(_paletteEditorOpen()) return; // 选色面板打开时不启用 2s 无操作自动收起
  if(!isPlaying || !row || !row.classList.contains('open')) return;
  paletteAutoCollapseTimer = setTimeout(() => {
    paletteAutoCollapseTimer = null;
    setPaletteRowCollapsed(true);
  }, 2000);
}
function togglePaletteRow(){
  const row = _paletteRow();
  if(!row) return;
  cancelPaletteAutoCollapse();
  closeAllDropPanels(row);
  row.classList.toggle('open');
  updatePaletteToggleIcon();
  if(row.classList.contains('open')) schedulePaletteAutoCollapse();
}
// 操作配色面板（点按）时重置自动收起计时
const _paletteRowEl = _paletteRow();
if(_paletteRowEl) _paletteRowEl.addEventListener('pointerdown', () => { if(isPlaying) schedulePaletteAutoCollapse(); });

function setPalette(name){
  if(!PALETTES[name]) return;
  schedulePaletteAutoCollapse(); // 切换配色视为操作，重置自动收起计时
  currentPalette = name;
  try{ localStorage.setItem('paletteV2', name); }catch(e){}
  document.querySelectorAll('.palette-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.palette === name);
  });
  const editBtn = document.getElementById('paletteEditBtn');
  if(editBtn) editBtn.classList.toggle('active', name === 'custom');
  applyTheme(name === 'custom' ? (paletteEditColors.theme || '#c20c0c') : PALETTE_THEME[name]);
  updatePaletteSwatch();
  if(typeof allNotes !== 'undefined'){
    const fallDur = 2.0 / fallSpeedMultiplier;
    const leftIdx = lowerBound(allNotes, currentTime - fallDur);
    const rightIdx = lowerBound(allNotes, currentTime + fallDur);
    drawScene(allNotes, leftIdx, rightIdx, currentTime);
  }
}
// 叠加在力度图上的小标签（白键/黑键/力度）
function _swatchLabel(text, pos){
  return '<span style="position:absolute;' + pos +
    'font-size:9px;line-height:1;color:#fff;' +
    'text-shadow:0 0 3px #000,0 0 3px #000;pointer-events:none;white-space:nowrap;">' + text + '</span>';
}
// 两个横向直角梯形渐变块：短底=长底一半，左轻右重；上白键、下黑键；标签叠加在图上
function updatePaletteSwatch(){
  const host = document.getElementById('paletteSwatch');
  if(!host) return;
  const pal = PALETTES[currentPalette] || PALETTES.C;
  const W = 300, H = 44, gap = 4;
  const bh = (H - gap) / 2; // 每块高度（长底）
  const stops = (colors) => colors.map((c, i) =>
    '<stop offset="' + (i / (colors.length - 1) * 100).toFixed(1) + '%" stop-color="' + c + '"/>').join('');
  // 直角梯形：右竖直边为长底(bh)，左竖直边为短底(bh/2)，下底水平
  const trap = (yTop, fillId) =>
    '<polygon points="0,' + (yTop + bh/2) + ' ' + W + ',' + yTop + ' ' + W + ',' + (yTop + bh) +
    ' 0,' + (yTop + bh) + '" fill="url(#' + fillId + ')"/>';
  host.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      '<defs>' +
        '<linearGradient id="pgW" x1="0" y1="0" x2="1" y2="0">' + stops(pal.white) + '</linearGradient>' +
        '<linearGradient id="pgB" x1="0" y1="0" x2="1" y2="0">' + stops(pal.black) + '</linearGradient>' +
      '</defs>' +
      trap(0, 'pgW') +
      trap(bh + gap, 'pgB') +
    '</svg>' +
    _swatchLabel('白键', 'left:10px;top:' + (bh * 0.75) + 'px;transform:translateY(-50%);') +
    _swatchLabel('黑键', 'left:10px;top:' + (bh + gap + bh * 0.75) + 'px;transform:translateY(-50%);') +
    _swatchLabel('力度', 'left:50%;top:50%;transform:translate(-50%,-50%);font-size:11px;');
}

// ===== 全彩取色板 =====
function drawColorBoard(){
  const cv = document.getElementById('colorBoard');
  if(!cv) return;
  const c2 = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  const img = c2.createImageData(w, h);
  for(let y = 0; y < h; y++){
    const l = 1 - y / (h - 1);
    for(let x = 0; x < w; x++){
      const rgb = hslToRgb(x / (w - 1) * 360, _editHSL.s, l);
      const i = (y * w + x) * 4;
      img.data[i] = rgb[0]; img.data[i+1] = rgb[1]; img.data[i+2] = rgb[2]; img.data[i+3] = 255;
    }
  }
  c2.putImageData(img, 0, 0);
}
function _bindColorBoard(){
  if(_colorBoardBound) return;
  const cv = document.getElementById('colorBoard');
  if(!cv) return;
  _colorBoardBound = true;
  cv.addEventListener('pointerdown', (e) => {
    _colorPicking = true;
    try{ cv.setPointerCapture(e.pointerId); }catch(_){}
    _pickColorAt(e);
    e.preventDefault();
  });
  cv.addEventListener('pointermove', (e) => { if(_colorPicking) _pickColorAt(e); });
  cv.addEventListener('pointerup', () => { _colorPicking = false; });
  cv.addEventListener('pointercancel', () => { _colorPicking = false; });
}
function _pickColorAt(e){
  const cv = document.getElementById('colorBoard');
  const rect = cv.getBoundingClientRect();
  const p = e.touches ? e.touches[0] : e;
  let x = (p.clientX - rect.left) / rect.width * cv.width;
  let y = (p.clientY - rect.top) / rect.height * cv.height;
  x = Math.max(0, Math.min(cv.width - 1, x));
  y = Math.max(0, Math.min(cv.height - 1, y));
  _editHSL.h = x / (cv.width - 1) * 360;
  _editHSL.l = 1 - y / (cv.height - 1);
  _commitEditHSL('hl');
}
// 由当前目标色反推 HSL，同步到 2D 板与三个滑块
function _syncEditHSL(){
  const c = paletteEditColors[paletteEditTarget] || '#c20c0c';
  const hsl = _hexToHsl(c);
  _editHSL.h = hsl[0]; _editHSL.s = hsl[1]; _editHSL.l = hsl[2];
  _editHSL.a = _hexAlpha(c);
}
// 提交 HSL 改动：写回 hex、实时应用、同步四个滑块
function _commitEditHSL(changed){
  paletteEditColors[paletteEditTarget] = _hslaToHex(_editHSL.h, _editHSL.s, _editHSL.l, _editHSL.a);
  _applyCustomLive();
  updatePalettePickUI();
  _positionBoardMarker();
  if(changed === 's') drawColorBoard(); // 2D 板按当前饱和度重新渲染
}
// 实时应用自定义配色（主题色 + 黑白键色阶）并持久化
function _applyCustomLive(){
  const c = paletteEditColors;
  PALETTES.custom = buildCustomPalette(c.wl, c.wh, c.bl, c.bh);
  try{ localStorage.setItem('paletteCustom', JSON.stringify(c)); }catch(e){}
  setPalette('custom');
}
// 常用色预置：设置当前目标色 + 实时应用 + 定位滑块
function _applyPresetColor(color){
  if(!color) return;
  paletteEditColors[paletteEditTarget] = color;
  _syncEditHSL();
  _applyCustomLive();
  updatePalettePickUI();
  _positionBoardMarker();
  drawColorBoard();
}
// HEX -> [h(0-360), s, l]
function _hexToHsl(hex){
  const rgb = _hexToRgb(hex).map(v => v / 255);
  const r = rgb[0], g = rgb[1], b = rgb[2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, sat = 0;
  if(d){
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if(max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if(max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, sat, l];
}
// 2D 取色板圆点滑块定位（x=色相，y=明度）
function _positionBoardMarker(){
  const marker = document.getElementById('colorBoardMarker');
  if(!marker) return;
  marker.style.left = (_editHSL.h / 360 * 100) + '%';
  marker.style.top = ((1 - _editHSL.l) * 100) + '%';
  marker.style.background = paletteEditColors[paletteEditTarget];
  marker.style.opacity = _editHSL.a;
}
// 黑白键力度图：直角梯形（左底边=右底边一半，左轻右重），两端方形色块可点选目标
function renderPaletteEndpoints(){
  const host = document.getElementById('paletteEndpoints');
  if(!host) return;
  const c = paletteEditColors;
  const p = buildCustomPalette(c.wl, c.wh, c.bl, c.bh);
  const stops = cols => cols.map((col, i) =>
    '<stop offset="' + (i / (cols.length - 1) * 100).toFixed(1) + '%" stop-color="' + col + '"/>').join('');
  // 直角梯形力度条（左底边=右底边一半），标签覆盖在左侧与中间（与配色面板一致）
  const bar = (gradId, label) =>
    '<div class="pe-bar">' +
      '<svg viewBox="0 0 300 20" preserveAspectRatio="none">' +
        '<polygon points="0,10 300,0 300,20 0,20" fill="url(#' + gradId + ')"/>' +
      '</svg>' +
      _swatchLabel(label, 'left:6px;top:50%;transform:translateY(-50%);') +
    '</div>';
  // 端点色块：与右上角主题色按钮同形式（圆角框 + 内部色块）
  const box = (t, col) =>
    '<button type="button" class="pe-box' + (paletteEditTarget === t ? ' sel' : '') + '" data-target="' + t +
    '" title="' + PALETTE_TARGET_LABELS[t] + '"><span class="sw" style="background:' + col + '"></span></button>';
  host.innerHTML =
    '<svg width="0" height="0" style="position:absolute"><defs>' +
      '<linearGradient id="peW" x1="0" y1="0" x2="1" y2="0">' + stops(p.white) + '</linearGradient>' +
      '<linearGradient id="peB" x1="0" y1="0" x2="1" y2="0">' + stops(p.black) + '</linearGradient>' +
    '</defs></svg>' +
    '<div class="pe-row">' + box('wl', c.wl) + bar('peW', '白键') + box('wh', c.wh) + '</div>' +
    '<div class="pe-row">' + box('bl', c.bl) + bar('peB', '黑键') + box('bh', c.bh) + '</div>' +
    _swatchLabel('力度', 'left:50%;top:50%;transform:translate(-50%,-50%);');
}
function renderPalettePresets(){
  const host = document.getElementById('palettePresets');
  if(!host) return;
  host.innerHTML = PALETTE_PRESETS.map(p =>
    '<button type="button" class="pp-item" data-color="' + p.color + '" title="' + p.name + '">' +
    '<span class="pp-swatch" style="background:' + p.color + '"></span>' +
    '<span class="pp-name">' + p.name + '</span></button>').join('');
}
// 三个 HSL 滑块（色相/明度/饱和度）与 2D 板滑块同步
function _updateSliderUI(){
  const h = _editHSL.h, s = _editHSL.s, l = _editHSL.l, a = _editHSL.a;
  const set = (id, frac) => { const el = document.getElementById(id); if(el) el.style.left = (frac * 100) + '%'; };
  set('hslHandleH', h / 360);
  set('hslHandleS', s);
  set('hslHandleL', l);
  set('hslHandleA', a);
  const elH = document.querySelector('.hsl-slider[data-hsl="h"]');
  const elS = document.querySelector('.hsl-slider[data-hsl="s"]');
  const elL = document.querySelector('.hsl-slider[data-hsl="l"]');
  const elA = document.querySelector('.hsl-slider[data-hsl="a"]');
  if(elH){
    const st = [0, 60, 120, 180, 240, 300, 360].map(d =>
      'hsl(' + d + ',100%,50%) ' + (d / 360 * 100) + '%').join(',');
    elH.style.background = 'linear-gradient(to right,' + st + ')';
  }
  if(elS) elS.style.background = 'linear-gradient(to right, hsl(' + h + ',0%,' + (l * 100) + '%), hsl(' + h + ',100%,' + (l * 100) + '%))';
  if(elL) elL.style.background = 'linear-gradient(to right, #000, hsl(' + h + ',' + (s * 100) + '%,50%), #fff)';
  if(elA){
    const rgb = _hexToRgb(hslToHex(h, s, l));
    elA.style.background = 'linear-gradient(to right, rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0), rgb(' +
      rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')), repeating-conic-gradient(#3a3a44 0% 25%, #26262e 0% 50%) 0 0 / 8px 8px';
  }
}
function _bindHSLSliders(){
  document.querySelectorAll('.hsl-slider').forEach(el => {
    const key = el.getAttribute('data-hsl');
    el.addEventListener('pointerdown', e => {
      _hslDragging = key;
      try{ el.setPointerCapture(e.pointerId); }catch(_){}
      _pickHSLAt(key, e, el);
      e.preventDefault();
    });
    el.addEventListener('pointermove', e => { if(_hslDragging === key) _pickHSLAt(key, e, el); });
    el.addEventListener('pointerup', () => { _hslDragging = null; });
    el.addEventListener('pointercancel', () => { _hslDragging = null; });
  });
}
function _pickHSLAt(key, e, el){
  const rect = el.getBoundingClientRect();
  const p = e.touches ? e.touches[0] : e;
  let t = (p.clientX - rect.left) / rect.width;
  t = Math.max(0, Math.min(1, t));
  if(key === 'h') _editHSL.h = t * 360;
  else if(key === 's') _editHSL.s = t;
  else if(key === 'l') _editHSL.l = t;
  else if(key === 'a') _editHSL.a = t;
  _commitEditHSL(key);
}
function _renderPaletteThemeBtn(){
  const sw = document.getElementById('paletteThemeSwatch');
  const btn = document.getElementById('paletteThemeBtn');
  if(sw) sw.style.background = paletteEditColors.theme;
  if(btn) btn.classList.toggle('active', paletteEditTarget === 'theme');
}
function selectPaletteTarget(k){
  if(!PALETTE_TARGET_LABELS[k]) return;
  paletteEditTarget = k;
  _syncEditHSL();
  updatePalettePickUI();
  _positionBoardMarker();
  drawColorBoard();
}
function updatePalettePickUI(){
  const label = document.getElementById('palettePickLabel');
  const prev = document.getElementById('palettePickPreview');
  if(label) label.textContent = PALETTE_TARGET_LABELS[paletteEditTarget];
  if(prev) prev.style.background = paletteEditColors[paletteEditTarget];
  renderPaletteEndpoints();
  _renderPaletteThemeBtn();
  _updateSliderUI();
}
function _paletteEditorEl(){ return document.getElementById('paletteEditor'); }
function _paletteEditorOpen(){ const pe = _paletteEditorEl(); return !!(pe && pe.classList.contains('open')); }
function _bindPaletteModal(){
  if(_paletteModalBound) return;
  _paletteModalBound = true;
  const eps = document.getElementById('paletteEndpoints');
  const presets = document.getElementById('palettePresets');
  if(eps) eps.addEventListener('click', e => {
    const t = e.target.closest ? e.target.closest('[data-target]') : null;
    if(t) selectPaletteTarget(t.getAttribute('data-target'));
  });
  if(presets) presets.addEventListener('click', e => {
    const b = e.target.closest ? e.target.closest('[data-color]') : null;
    if(b) _applyPresetColor(b.getAttribute('data-color'));
  });
  _bindHSLSliders();
}
function openPaletteEditor(){
  const pe = _paletteEditorEl();
  if(!pe) return;
  cancelPaletteAutoCollapse(); // 选色面板打开时不自动收起
  if(PALETTES.custom){
    paletteEditColors.wl = PALETTES.custom.white[0];
    paletteEditColors.wh = PALETTES.custom.white[4];
    paletteEditColors.bl = PALETTES.custom.black[0];
    paletteEditColors.bh = PALETTES.custom.black[4];
  }
  paletteEditColors.theme = (currentPalette === 'custom' && paletteEditColors.theme) ? paletteEditColors.theme : (_themeAccent || '#c20c0c');
  paletteEditTarget = 'theme';
  _bindColorBoard();
  _bindPaletteModal();
  _syncEditHSL();
  drawColorBoard();
  renderPaletteEndpoints();
  renderPalettePresets();
  _renderPaletteThemeBtn();
  updatePalettePickUI();
  _positionBoardMarker();
  pe.classList.add('open');
  syncDropToggleIcons();
}
function closePaletteEditor(){
  const pe = _paletteEditorEl();
  if(pe) pe.classList.remove('open');
  syncDropToggleIcons();
}
function togglePaletteEditor(){
  if(_paletteEditorOpen()) closePaletteEditor();
  else openPaletteEditor();
}
function savePaletteCustom(){ _applyCustomLive(); } // 兼容旧调用：实时应用
// 恢复上次选择与自定义配色
(function(){
  try{
    loadCustomPalette();
    const saved = localStorage.getItem('paletteV2');
    if(saved && PALETTES[saved]) currentPalette = saved;
  }catch(e){}
})();

// 全屏绘制区
const FS_ICON_MAX = '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M9 15L2 22M2 16.1429V22H7.85714"/><path d="M15 9L22 2M22 7.85714V2H16.1429"/></g>';
const FS_ICON_MIN = '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M2 22L9 15M9 20.8571V15H3.14286"/><path d="M22 2L15 9M15 3.14286V9H20.8571"/></g>';
function toggleFullscreen(){
  const el = document.querySelector('.visual-panel');
  if(!el) return;
  cancelPaletteAutoCollapse(); // 播放开始后 3s 内点过全屏 -> 不自动收起配色栏
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if(!fsEl){
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if(req){ const p = req.call(el); if(p && p.catch) p.catch(() => {}); }
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if(exit){ const p = exit.call(document); if(p && p.catch) p.catch(() => {}); }
  }
}
function _syncFsIcon(){
  const icon = document.getElementById('fsIcon');
  if(!icon) return;
  const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
  icon.innerHTML = on ? FS_ICON_MIN : FS_ICON_MAX;
  const btn = document.getElementById('fsBtn');
  if(btn) btn.title = on ? '退出全屏' : '全屏绘制区';
}
document.addEventListener('fullscreenchange', _syncFsIcon);
document.addEventListener('webkitfullscreenchange', _syncFsIcon);

/* ============================================================
 * 全屏悬浮控件：设置(左上) / 退出(右上)
 * 2s 无操作淡出；点击悬浮按钮立即暂停播放
 * ========================================================== */
let _fsIdleTimer = null;
function _isFullscreenNow(){ return !!(document.fullscreenElement || document.webkitFullscreenElement); }
// 仅全屏时：点击悬浮按钮立即暂停
function _fsPauseIfPlaying(){ if(_isFullscreenNow() && isPlaying){ try{ pausePlay(); }catch(e){} } }
// 2s 未点击悬浮按钮 → 淡到 10%
function _fsShowControls(){
  const ov = document.getElementById('fsOverlay');
  if(!ov) return;
  ov.classList.remove('faded');
  if(_fsIdleTimer) clearTimeout(_fsIdleTimer);
  _fsIdleTimer = setTimeout(() => { ov.classList.add('faded'); }, 2000);
}
function _fsHideControls(){
  if(_fsIdleTimer){ clearTimeout(_fsIdleTimer); _fsIdleTimer = null; }
}
// 进入/退出全屏：设置面板随全屏元素移动（让左上角设置按钮能展开它）
const _panelEl = document.getElementById('controlPanel');
const _panelHome = _panelEl ? { parent: _panelEl.parentElement, next: _panelEl.nextSibling } : null;
// 全屏时把整个进度面板（统计+时间+状态+进度条）挂到渲染区顶部中央
const _progressEl = document.getElementById('progressPanel');
const _progressHome = _progressEl ? { parent: _progressEl.parentElement, next: _progressEl.nextSibling } : null;
function _syncFsLayout(){
  const vp = document.querySelector('.visual-panel');
  if(!vp) return;
  if(_isFullscreenNow()){
    if(_panelEl){ vp.appendChild(_panelEl); _panelEl.classList.add('in-fs'); }
    if(_progressEl){ vp.appendChild(_progressEl); _progressEl.classList.add('in-fs'); _progressEl.classList.remove('hidden'); }
    _fsShowControls();
  } else {
    _fsHideControls();
    const fo = document.getElementById('fsOverlay'); if(fo) fo.classList.remove('faded');
    closeAllDropPanels();
    if(_panelEl){
      _panelEl.classList.remove('in-fs');
      if(_panelHome) _panelHome.parent.insertBefore(_panelEl, _panelHome.next);
    }
    if(_progressEl){
      _progressEl.classList.remove('in-fs'); _progressEl.classList.remove('hidden');
      if(_progressHome) _progressHome.parent.insertBefore(_progressEl, _progressHome.next);
    }
  }
}
// 全屏时单击渲染区：收起/重新显示悬浮进度面板
function toggleProgressOverlay(){
  if(!_isFullscreenNow()) return;
  const p = document.getElementById('progressPanel');
  if(p) p.classList.toggle('hidden');
}
document.addEventListener('fullscreenchange', _syncFsLayout);
document.addEventListener('webkitfullscreenchange', _syncFsLayout);
// 只有点击悬浮按钮才重置淡出；点琴键 / 音符区不算
function _fsBindButton(id, action){
  const el = document.getElementById(id);
  if(!el) return;
  el.addEventListener('pointerdown', () => { _fsShowControls(); }, true);
  el.addEventListener('click', (e) => {
    _fsPauseIfPlaying();
    _fsShowControls();
    if(action) action(e);
  });
}
_fsBindButton('fsExitBtn', () => toggleFullscreen());
_fsBindButton('fsSettingsBtn', () => toggleMenu());
_fsShowControls();

function resizeCanvas(){
  // 横竖屏切换时套用对应方向的默认钢琴高度（用户手动改过则用其值）
  _syncPianoHeightForOrientation();
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(r.width * devicePixelRatio));
  canvas.height = Math.max(320, Math.floor(r.height * devicePixelRatio));
  C.w = canvas.width; C.h = canvas.height;
  // 重新计算布局和映射（按当前偏移百分比重算水平偏移）
  _viewOffsetFromPct();
  cachedLayout = getKeyLayout();
  keyByMidi = new Array(109).fill(null);
  cachedLayout.keys.forEach(k => { keyByMidi[k.midi] = k; });
  // 预渲染静态元素到离屏canvas
  renderStatic();
  const fallDur = 2.0 / fallSpeedMultiplier;
  const leftIdx = lowerBound(allNotes, currentTime - fallDur);
  const rightIdx = lowerBound(allNotes, currentTime + fallDur);
  drawScene(allNotes, leftIdx, rightIdx, currentTime);
}
// rAF 合并：移动端地址栏收放会连续触发 resize，避免重复重排重绘
let _resizePending = false;
function scheduleResizeCanvas(){
  if(_resizePending) return;
  _resizePending = true;
  requestAnimationFrame(() => { _resizePending = false; resizeCanvas(); });
}
window.addEventListener('resize', scheduleResizeCanvas);
// 全屏切换、屏幕方向变化、移动端地址栏显示/隐藏时重新计算布局，确保钢琴键盘始终可见
document.addEventListener('fullscreenchange', () => {
  [50, 150, 300, 500].forEach(t => setTimeout(scheduleResizeCanvas, t));
});
window.addEventListener('orientationchange', () => {
  [100, 250, 500].forEach(t => setTimeout(scheduleResizeCanvas, t));
});
// 软键盘弹出时 visualViewport 变矮：不改渲染区高度，直接让键盘遮挡
function _onVisualViewportResize(){
  const vv = window.visualViewport;
  if(vv && vv.height < window.innerHeight - 120) return;
  scheduleResizeCanvas();
}
if(window.visualViewport) window.visualViewport.addEventListener('resize', _onVisualViewportResize);

// 预渲染静态元素（背景、轨道线、琴键、音名）
function renderStatic(){
  if(!staticCanvas) staticCanvas = document.createElement('canvas');
  staticCanvas.width = C.w; staticCanvas.height = C.h;
  const sctx = staticCanvas.getContext('2d');
  const layout = cachedLayout;
  const keyAreaH = C.h * (pianoHeightPct / 100);
  const keyTop = C.h - keyAreaH;
  const noteNames = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  // 背景
  sctx.fillStyle = '#0a0a10';
  sctx.fillRect(0, 0, C.w, C.h);
  // 轨道线
  sctx.strokeStyle = 'rgba(255,255,255,0.03)';
  sctx.lineWidth = 1;
  layout.keys.forEach(k => {
    if(!k.isBlack){
      sctx.beginPath();
      sctx.moveTo(k.x, 0);
      sctx.lineTo(k.x, keyTop);
      sctx.stroke();
    }
  });
  // 白键
  layout.keys.forEach(k => {
    if(k.isBlack) return;
    sctx.fillStyle = '#f0f0f0';
    sctx.fillRect(k.x, keyTop, k.w - 1, keyAreaH);
    sctx.strokeStyle = '#ccc';
    sctx.strokeRect(k.x, keyTop, k.w - 1, keyAreaH);
  });
  // 黑键
  layout.keys.forEach(k => {
    if(!k.isBlack) return;
    sctx.fillStyle = '#1a1a1a';
    sctx.fillRect(k.x, keyTop, k.w, keyAreaH * 0.62);
  });
  // 音名：字母大、数字下标小，同一水平线
  const whiteW = layout.whiteW;
  const fontSize = Math.max(5 * devicePixelRatio, Math.min(8 * devicePixelRatio, whiteW * 0.55));
  const smallFont = fontSize * 0.7;
  sctx.fillStyle = 'rgba(0,0,0,0.45)';
  sctx.textAlign = 'left';
  layout.keys.forEach(k => {
    if(k.isBlack) return;
    const name = noteNames[k.midi % 12];
    const oct = Math.floor(k.midi / 12) - 1;
    const baseY = C.h - 3 * devicePixelRatio;
    // 字母
    sctx.font = `${fontSize}px sans-serif`;
    const letterW = fontSize * 0.55;
    const startX = k.x + k.w / 2 - letterW * 0.8;
    sctx.fillText(name, startX, baseY);
    // 数字（下标，更小更靠下）
    sctx.font = `${smallFont}px sans-serif`;
    sctx.fillText(String(oct), startX + letterW * 0.9, baseY + smallFont * 0.3);
  });
}

// 88键布局
const BLACK_KEYS = [1,3,6,8,10];
const BLACK_KEY_TABLE = new Uint8Array(12);
BLACK_KEYS.forEach(k => { BLACK_KEY_TABLE[k] = 1; });
function isBlackKey(midi){ return BLACK_KEY_TABLE[midi % 12] === 1; }
function getKeyLayout(){
  const keys = [];
  let whiteIdx = 0;
  for(let midi = 21; midi <= 108; midi++){
    if(!isBlackKey(midi)){
      keys.push({midi, x: whiteIdx, isBlack: false});
      whiteIdx++;
    }
  }
  const totalWhite = whiteIdx;
  const totalW = C.w * pianoWidthScale;   // 钢琴总宽随缩放变化
  const whiteW = totalW / totalWhite;
  const blackW = whiteW * 0.6;
  const result = [];
  whiteIdx = 0;
  for(let midi = 21; midi <= 108; midi++){
    if(!isBlackKey(midi)){
      result.push({midi, x: viewOffsetX + whiteIdx * whiteW, w: whiteW, isBlack: false});
      whiteIdx++;
    } else {
      result.push({midi, x: viewOffsetX + whiteIdx * whiteW - blackW / 2, w: blackW, isBlack: true});
    }
  }
  return {keys: result, whiteW, blackW, totalWhite, totalW};
}
// 限制水平偏移，保证钢琴不超出两侧留白（缩放 >= 1 时总宽 >= 画布宽）
function _clampViewOffset(){
  const totalW = C.w * pianoWidthScale;
  const minOff = Math.min(0, C.w - totalW);
  if(viewOffsetX > 0) viewOffsetX = 0;
  else if(viewOffsetX < minOff) viewOffsetX = minOff;
}
// 由「水平偏移」滑块百分比换算 viewOffsetX（0% 最左，100% 最右）
function _viewOffsetFromPct(){
  const os = document.getElementById('pianoOffsetSlider');
  const pct = Math.max(0, Math.min(100, parseFloat(os && os.value) || 0));
  const totalW = C.w * pianoWidthScale;
  const maxOff = Math.min(0, C.w - totalW); // <= 0
  viewOffsetX = maxOff * (pct / 100);
}
// 宽度缩放 / 水平偏移滑块 → 应用（缩放变化后按当前偏移百分比重算）
function _applyPianoViewFromSliders(){
  const ws = document.getElementById('pianoWidthSlider');
  pianoWidthScale = Math.max(PIANO_MIN_SCALE, Math.min(PIANO_MAX_SCALE, parseFloat(ws && ws.value) || 1));
  const wv = document.getElementById('pianoWidthVal');
  if(wv) wv.textContent = pianoWidthScale.toFixed(1) + '×';
  _viewOffsetFromPct();
  const ov = document.getElementById('pianoOffsetVal');
  const os = document.getElementById('pianoOffsetSlider');
  if(ov && os) ov.textContent = (Math.round((parseFloat(os.value) || 0) * 10) / 10) + '%';
  _applyPianoZoom();
}
function onPianoWidthChange(){ _applyPianoViewFromSliders(); }
function onPianoOffsetChange(){ _applyPianoViewFromSliders(); }
// 标准键盘版型：键数 + 音域（科学音高记号 / MIDI 编号）
// 88 A0–C8 | 76 E1–G7 | 61 C2–C7 | 49 C2–C6 | 37 C3–C6 | 25 C3–C5
// 默认缩放 = 52 / 该音域白键数（使该音域白键恰好铺满画布宽）
// 默认偏移 = 把音域第一个键对齐到渲染区最左侧
const KEYBOARD_PRESETS = [
  { keys: 25, lo: 48, hi: 72,  label: '25键' }, // C3–C5
  { keys: 37, lo: 48, hi: 84,  label: '37键' }, // C3–C6
  { keys: 49, lo: 36, hi: 84,  label: '49键' }, // C2–C6
  { keys: 61, lo: 36, hi: 96,  label: '61键' }, // C2–C7
  { keys: 73, lo: 28, hi: 100, label: '73键' }, // E1–E7（标准 73 键音域）
  { keys: 76, lo: 28, hi: 103, label: '76键' }, // E1–G7
  { keys: 88, lo: 21, hi: 108, label: '88键' }, // A0–C8 全尺寸
];
function _whiteCountInRange(lo, hi){
  let n = 0;
  for(let m = lo; m <= hi; m++) if(!isBlackKey(m)) n++;
  return n;
}
function _whiteIndexBefore(midi){
  let n = 0;
  for(let m = 21; m < midi; m++) if(!isBlackKey(m)) n++;
  return n;
}
// 版型默认缩放 / 偏移百分比（均与画布宽度无关）
function _presetLayout(p){
  const whiteCount = _whiteCountInRange(p.lo, p.hi);
  let scale = 52 / whiteCount;
  scale = Math.max(PIANO_MIN_SCALE, Math.min(PIANO_MAX_SCALE, scale));
  const wi = _whiteIndexBefore(p.lo);
  const offsetPct = (scale > 1) ? (wi * scale / (52 * (scale - 1)) * 100) : 0;
  return { scale: scale, offsetPct: Math.max(0, Math.min(100, offsetPct)) };
}
function _setKeyboardPresetIndex(idx){
  idx = Math.max(0, Math.min(KEYBOARD_PRESETS.length - 1, parseInt(idx, 10) || 0));
  const p = KEYBOARD_PRESETS[idx];
  const lay = _presetLayout(p);
  // 直接用精确缩放，避免 range step 取整导致音域首键与左边界错位
  pianoWidthScale = lay.scale;
  const ws = document.getElementById('pianoWidthSlider');
  if(ws) ws.value = lay.scale;         // 仅供显示/后续手动微调
  const os = document.getElementById('pianoOffsetSlider');
  if(os) os.value = lay.offsetPct;
  const wv = document.getElementById('pianoWidthVal');
  if(wv) wv.textContent = lay.scale.toFixed(1) + '×';
  const ov = document.getElementById('pianoOffsetVal');
  if(ov) ov.textContent = (Math.round(lay.offsetPct * 10) / 10) + '%';
  const ks = document.getElementById('keyboardPresetSlider');
  if(ks) ks.value = idx;
  const kv = document.getElementById('keyboardPresetVal');
  if(kv) kv.textContent = p.label;
  _viewOffsetFromPct();                // 用精确 pianoWidthScale 重算 viewOffsetX
  _applyPianoZoom();
  return p;
}
function setKeyboardPreset(keys){
  const idx = KEYBOARD_PRESETS.findIndex(p => p.keys === keys);
  _setKeyboardPresetIndex(idx < 0 ? 0 : idx);
}
function onKeyboardPresetChange(){
  const ks = document.getElementById('keyboardPresetSlider');
  _setKeyboardPresetIndex(ks ? ks.value : 0);
}
// 缩放 / 偏移变化后重算布局、静态层与当前帧
function _applyPianoZoom(){
  _clampViewOffset();
  cachedLayout = getKeyLayout();
  keyByMidi = new Array(109).fill(null);
  cachedLayout.keys.forEach(k => { keyByMidi[k.midi] = k; });
  renderStatic();
  const fallDur = 2.0 / fallSpeedMultiplier;
  const leftIdx = lowerBound(allNotes, currentTime - fallDur);
  const rightIdx = lowerBound(allNotes, currentTime + fallDur);
  drawScene(allNotes, leftIdx, rightIdx, currentTime);
}

function drawScene(notes, startIdx, endIdx, curTime){
  curTime = curTime || 0;
  // 直接贴预渲染的静态层
  ctx.drawImage(staticCanvas, 0, 0);
  const keyAreaH = C.h * (pianoHeightPct / 100);
  const keyTop = C.h - keyAreaH;
  const fallDuration = 2.0 / fallSpeedMultiplier;
  const invFallDur = 1 / fallDuration;
  const minH = 6 * devicePixelRatio;
  const radius = 3 * devicePixelRatio;
  // 复用Set，不每帧新建
  activeKeySet.clear();

  // 颜色双维度：色相区分黑白键，明度区分力度（各 5 级，轻→重）
  const _pal = PALETTES[currentPalette] || PALETTES.C;
  const palettes = [_pal.white, _pal.black];
  // 复用矩形桶，避免每帧新建 Path2D 造成 GC 压力
  const buckets = _drawBuckets;
  for(let p = 0; p < 2; p++){
    for(let c = 0; c < 5; c++) buckets[p][c].length = 0;
  }
  let hasAny = false;

  // ===== 渲染 LOD：默认完整绘制；仅当 PerfArbiter 判定需要降级时才抽样 =====
  // 抽样基于"绝对音符索引取模"，保证同一音符在滚动中始终被画/不画，避免逐帧闪烁
  const visibleCount = endIdx - startIdx;
  const DRAW_BUDGET = 4000;
  let stride = 1;
  if(PerfArbiter.degraded && visibleCount > DRAW_BUDGET * 1.3){
    // 量化到 2 的幂 + 1.3x 进入阈值，避免 stride 在边界反复跳变
    stride = 1 << Math.ceil(Math.log2(visibleCount / DRAW_BUDGET));
  }
  const useRound = stride === 1;
  let i = startIdx;
  if(stride > 1) i = startIdx + ((stride - (startIdx % stride)) % stride);

  for(; i < endIdx; i += stride){
    const n = notes[i];
    const key = keyByMidi[n.midi];
    if(!key) continue;
    // 水平不可见（缩放/偏移后落在画布外）：跳过渲染以省性能；播放仍按原时间轴进行
    if(key.x + key.w < 0 || key.x > C.w) continue;
    const timeUntilStart = n.time - curTime;
    const noteH = n.duration * invFallDur * keyTop;
    const h = noteH < minH ? minH : noteH;
    const bottomY = keyTop - timeUntilStart * invFallDur * keyTop;
    const y = bottomY - h;
    // 整个音符沉入琴键后才消失
    if(y > keyTop || bottomY <= 0) continue;
    const pi = isBlackKey(n.midi) ? 1 : 0;
    const ci = Math.min(4, Math.floor(n.velocity * 5));
    buckets[pi][ci].push(key.x + 1, y, key.w - 2, h);
    hasAny = true;
  }

  // 裁剪到琴键以上区域，音符沉入琴键时不遮盖
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, C.w, keyTop);
  ctx.clip();
  if(hasAny){
    for(let p = 0; p < 2; p++){
      for(let c = 0; c < 5; c++){
        const arr = buckets[p][c];
        if(!arr.length) continue;
        ctx.beginPath();
        for(let j = 0; j < arr.length; j += 4){
          if(useRound) ctx.roundRect(arr[j], arr[j + 1], arr[j + 2], arr[j + 3], radius);
          else ctx.rect(arr[j], arr[j + 1], arr[j + 2], arr[j + 3]);
        }
        ctx.fillStyle = palettes[p][c];
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // 高亮当前正在发声的键：直接读 voice 注册表（O(88)），与绘制抽样无关
  for(let m = 0; m < SoundfontLoader.activeSources.length; m++){
    if(SoundfontLoader.activeSources[m]) activeKeySet.add(m);
  }
  for(const k in SoundfontLoader.activeSynth){
    activeKeySet.add(parseInt(k, 10));
  }

  // 按键高亮
  if(activeKeySet.size > 0){
    ctx.fillStyle = _themeAccentRgba;
    activeKeySet.forEach(midi => {
      const key = keyByMidi[midi];
      if(!key) return;
      if(key.isBlack){
        ctx.fillRect(key.x, keyTop, key.w, keyAreaH * 0.62);
      } else {
        ctx.fillRect(key.x, keyTop, key.w - 1, keyAreaH);
      }
    });
  }
}

/* ============================================================
 * 8. 钢琴键盘交互：点击 / 触摸琴键发声（欣赏模式与演奏模式均可用）
 * ========================================================== */
const _keyPointers = new Map(); // pointerId -> midi（用于多指）
function _canvasPointToKey(e){
  const rect = canvas.getBoundingClientRect();
  if(!rect.width || !rect.height || !cachedLayout || !cachedLayout.keys) return null;
  const px = (e.clientX - rect.left) / rect.width * C.w;
  const py = (e.clientY - rect.top) / rect.height * C.h;
  const keyAreaH = C.h * (pianoHeightPct / 100);
  const keyTop = C.h - keyAreaH;
  if(py < keyTop) return null; // 仅键盘区可点击
  // 黑键绘制在上层，优先命中
  let hit = null;
  for(const k of cachedLayout.keys){ if(k.isBlack && px >= k.x && px < k.x + k.w){ hit = k; break; } }
  if(!hit){ for(const k of cachedLayout.keys){ if(!k.isBlack && px >= k.x && px < k.x + k.w){ hit = k; break; } } }
  return hit ? hit.midi : null;
}
// 暂停状态下的静态重绘：用户敲键 / 松键时刷新按键高亮（播放中由 playLoop 负责）
let _staticRedrawPending = false;
function requestStaticRedraw(){
  if(typeof isPlaying !== 'undefined' && isPlaying) return;
  if(_staticRedrawPending) return;
  _staticRedrawPending = true;
  requestAnimationFrame(() => {
    _staticRedrawPending = false;
    if(isPlaying) return;
    const fallDur = 2.0 / fallSpeedMultiplier;
    const leftIdx = lowerBound(allNotes, currentTime - fallDur);
    const rightIdx = lowerBound(allNotes, currentTime + fallDur);
    drawScene(allNotes, leftIdx, rightIdx, currentTime);
  });
}
function _userPlayKey(midi){
  if(midi == null) return;
  initAudio();
  if(audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  SoundfontLoader.playNote(midi, 0.9, 0.7); // 用户敲击：固定力度与时长
  requestStaticRedraw(); // 暂停时也要立即显示按下紫色高亮
}
let _canvasTapTimer = null;
canvas.addEventListener('pointerdown', (e) => {
  const midi = _canvasPointToKey(e);
  if(midi == null){
    // 非钢琴键的渲染区：单击收起/显示进度面板；双击（含双触）播放/暂停
    if(_canvasTapTimer){
      clearTimeout(_canvasTapTimer); _canvasTapTimer = null;
      togglePlay();
    } else {
      _canvasTapTimer = setTimeout(() => { _canvasTapTimer = null; toggleProgressOverlay(); }, 300);
    }
    e.preventDefault();
    return;
  }
  _keyPointers.set(e.pointerId, midi);
  try{ canvas.setPointerCapture(e.pointerId); }catch(_){}
  _userPlayKey(midi);
  e.preventDefault();
});
// 抬起手指：立即停止该键的发声并清除高亮（同一键仍被其它手指按住则不停）
function _endCanvasPointer(e){
  const midi = _keyPointers.get(e.pointerId);
  _keyPointers.delete(e.pointerId);
  if(midi == null) return;
  for(const m of _keyPointers.values()){ if(m === midi) return; }
  try{ SoundfontLoader.stopNote(midi); }catch(_){}
  requestStaticRedraw(); // 清除高亮
}
canvas.addEventListener('pointerup', _endCanvasPointer);
canvas.addEventListener('pointercancel', _endCanvasPointer);

// 初始化
resizeCanvas();
setPalette(currentPalette); // 同步按钮选中态并按恢复的配色重绘
updatePaletteToggleIcon();  // 配色栏默认展开，同步收起/展开按钮图标
applyPanelAppearance();     // 统一菜单/调试/选谱/管理面板的透明度与模糊（含动态创建的 .csel-pop）
_loadFpsCap();              // 恢复帧率上限设置
_updateSynthPathInfo();     // 调试面板：合成钢琴当前路径（AudioWorklet / 预渲染缓冲区）
