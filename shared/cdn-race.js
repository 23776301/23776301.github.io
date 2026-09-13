/* ============================================================
 * 公共 CDN 多镜像竞速组件（midi_player 与 music_visualization 共用）
 * ------------------------------------------------------------
 * - CDN_BASES：同一份镜像列表，两个页面同时受益
 * - buildUrls(dir, relPath)：为某仓库子目录下的资源生成 [各镜像..., 同源兜底]
 * - raceDownload / fetchFirstByte / fetchResource：完整下载竞速 / 首字节竞速
 * - makeLiveLogger：竞速日志「进行中实时覆盖、完成后固化保留」的公共实现
 *
 * 依赖：浏览器环境（fetch / AbortController / Blob）。无外部依赖。
 * 用法：先于页面 app.js 加载，使用全局 CdnRace。
 * ========================================================== */
(function(global){
  'use strict';

  const REPO_GH = 'teecatt/teecatt.github.io';
  const REPO_REF = 'master';
  const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO_GH + '/' + REPO_REF + '/';

  // prefix 同时用于拼接与来源识别；资源 URL = prefix + encode(子目录/相对路径)
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

  function encPath(p){
    return String(p).split('/').map(encodeURIComponent).join('/');
  }

  // 子目录内相对路径 -> [各镜像..., 本站同源 Pages 兜底]
  function buildUrls(dir, relPath){
    const clean = String(relPath).replace(/^\.\//, '');
    const dirClean = dir ? (String(dir).replace(/\/+$/, '') + '/') : '';
    const enc = encPath(dirClean + clean);
    const urls = CDN_BASES.map(b => b.prefix + enc);
    urls.push(clean); // 同源（相对当前页面目录）
    return urls;
  }

  // 从 URL 推断可读来源名（用于日志/状态区）
  function sourceLabel(url){
    const u = String(url);
    if(u.indexOf('://') < 0) return 'Pages';
    for(const b of CDN_BASES){ if(u.indexOf(b.prefix) === 0) return b.name; }
    try{ return new URL(u).hostname; }catch(e){ return '备用源'; }
  }

  // 字节数格式化：3.6MB / 520KB / 800B
  function fmtSize(n){
    n = Number(n) || 0;
    if(n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    if(n >= 1024) return (n / 1024).toFixed(0) + 'KB';
    return n + 'B';
  }

  // Promise.any 兼容封装：返回最先成功的结果；全部失败时抛出含 errors 数组的对象
  function promiseAny(ps){
    if(typeof Promise.any === 'function') return Promise.any(ps);
    return new Promise((resolve, reject) => {
      let pending = ps.length; const errs = [];
      if(!pending) return reject(new Error('无可用源'));
      ps.forEach((p, i) => Promise.resolve(p).then(resolve, e => { errs[i] = e; if(--pending === 0) reject({ errors: errs }); }));
    });
  }

  // 并发择优：同时请求所有候选源，最先成功返回响应的胜出，其余 abort（首字节竞速模式用）
  async function raceFetch(urls){
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
      winner = await promiseAny(attempts);
    }catch(agg){
      const errs = (agg && agg.errors) || [];
      const first = errs.find(e => e);
      throw (first instanceof Error) ? first : new Error('全部源下载失败');
    }
    controllers.forEach((c, i) => { if(c && i !== winner.i){ try{ c.abort(); }catch(e){} } });
    return { resp: winner.resp, url: winner.url, index: winner.i, list: list };
  }

  // 流式读取响应为 Blob 并回报百分比（首字节竞速模式用）
  async function readBlobWithProgress(resp, onProgress){
    const total = (resp.headers && resp.headers.get) ? parseInt(resp.headers.get('content-length') || '0', 10) : 0;
    if(!resp.body || !total || !resp.body.getReader){
      const blob = new Blob([await resp.arrayBuffer()]);
      if(onProgress) onProgress(100);
      return blob;
    }
    const reader = resp.body.getReader();
    const chunks = []; let received = 0;
    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      chunks.push(value); received += value.length;
      if(onProgress) onProgress(received / total * 100);
    }
    const blob = new Blob(chunks);
    if(onProgress) onProgress(100);
    return blob;
  }

  // 单源：完整下载为 Blob（流式回报 (received, total)；中止/失败时丢弃已收分片）
  async function downloadBlob(url, onProgress, signal){
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
        const { done, value } = await reader.read();
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

  // 完整下载竞速：所有镜像同时完整下载，最先完成者胜出；其余立即 abort 并丢弃不完整分片。
  // 进行中每 0.5s 覆盖一行进度（onLive）；完成后由 onFinal 固化为最终性能行（保留，不被刷掉）。
  // opts: { label, onProgress(0..100), onLive(text), onFinal(text) }
  async function raceDownload(list, opts){
    opts = opts || {};
    const onProgress = opts.onProgress, onLive = opts.onLive, onFinal = opts.onFinal;
    const tag = opts.label || '文件';
    if(!list.length) throw new Error('无可用源');
    const hasAbort = (typeof AbortController !== 'undefined');
    const controllers = list.map(() => hasAbort ? new AbortController() : null);
    const states = list.map(url => ({ src: sourceLabel(url), received: 0, total: 0, failed: false }));
    const t0 = performance.now();
    let lastLog = 0, bestPct = 0, done = false;
    const report = () => {
      if(done || !onLive) return;
      const now = performance.now();
      if(now - lastLog < 500) return; // 每 0.5s 一次
      lastLog = now;
      let lead = null;
      for(const s of states){ if(!s.failed && (!lead || s.received > lead.received)) lead = s; }
      if(!lead || lead.received <= 0) return;
      const elapsed = Math.max((now - t0) / 1000, 0.001);
      const speed = lead.received / elapsed / 1024;
      const pctTxt = lead.total > 0 ? (lead.received / lead.total * 100).toFixed(0) + '%' : '?';
      onLive('竞速[' + tag + '] 领先: [' + lead.src + '] ' + fmtSize(lead.received) + '/' +
        (lead.total > 0 ? fmtSize(lead.total) : '?') + ' ~ ' + pctTxt + ' 平均' + speed.toFixed(0) + 'KB/s');
    };
    const attempts = list.map((url, i) => downloadBlob(
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
      winner = await promiseAny(attempts);
    }catch(agg){
      done = true;
      if(onFinal) onFinal('竞速[' + tag + '] 全部镜像失败');
      const errs = (agg && agg.errors) || [];
      const first = errs.find(e => e);
      throw (first instanceof Error) ? first : new Error('全部源下载失败');
    }
    done = true;
    controllers.forEach((c, i) => { if(c && i !== winner.i){ try{ c.abort(); }catch(e){} } });
    if(onProgress) onProgress(100);
    const secs = (performance.now() - t0) / 1000;
    const avg = winner.blob.size / Math.max(secs, 0.001) / 1024;
    if(onFinal) onFinal('竞速[' + tag + '] 完成 <- [' + sourceLabel(winner.url) + '] ' +
      fmtSize(winner.blob.size) + ' 用时' + secs.toFixed(2) + 's 平均' + avg.toFixed(0) + 'KB/s');
    try{ winner.blob._netSize = states[winner.i].total || winner.blob.size; }catch(e){}
    return { blob: winner.blob, url: winner.url, index: winner.i };
  }

  // 首字节竞速（开关关闭时）：胜出源流式读取，若读取中途失败则按顺序回退其余候选
  // opts: { label, onProgress(0..100), onLive(text), onFinal(text), quiet, onInfo(text) }
  async function fetchFirstByte(list, opts){
    opts = opts || {};
    const tag = opts.label || '文件';
    const onProgress = opts.onProgress, onLive = opts.onLive, onFinal = opts.onFinal;
    const winner = await raceFetch(list);
    const order = [winner.index, ...list.map((_, i) => i).filter(i => i !== winner.index)];
    let lastErr;
    const t0 = performance.now();
    for(const idx of order){
      try{
        let resp;
        if(idx === winner.index){ resp = winner.resp; }
        else { resp = await fetch(list[idx]); if(!resp.ok) throw new Error('HTTP ' + resp.status); }
        const blob = await readBlobWithProgress(resp, onProgress);
        try{
          const net = parseInt((resp.headers && resp.headers.get) ? (resp.headers.get('content-length') || '0') : '0', 10);
          blob._netSize = net > 0 ? net : blob.size;
        }catch(e){ blob._netSize = blob.size; }
        const secs = (performance.now() - t0) / 1000;
        if(onFinal) onFinal('竞速[' + tag + '] 完成 <- [' + sourceLabel(list[idx]) + '] ' +
          fmtSize(blob.size) + ' 用时' + secs.toFixed(2) + 's');
        return blob;
      }catch(e){
        lastErr = e; if(onProgress) onProgress(0);
        if(!opts.quiet && opts.onInfo) opts.onInfo(tag + '从' + sourceLabel(list[idx]) + '下载失败');
      }
    }
    if(onFinal) onFinal('竞速[' + tag + '] 全部镜像失败');
    throw lastErr || new Error('下载失败');
  }

  // 下载入口：raceFull 为真走「完整下载竞速」，否则「首字节竞速」
  async function fetchResource(urls, opts){
    opts = opts || {};
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if(opts.raceFull) return raceDownload(list, opts);
    return fetchFirstByte(list, opts);
  }

  // ===== 竞速日志「进行中覆盖、完成后固化」的公共实现 =====
  // getContainer(): 返回承载日志行的元素；live 覆盖同一行，final 固化该行并另起新行。
  // opts: { maxLines, enabled(), color(text), className, scrollParent() }
  function makeLiveLogger(getContainer, opts){
    opts = opts || {};
    const maxLines = opts.maxLines || 300;
    const enabled = opts.enabled || function(){ return true; };
    const color = opts.color || null;
    const className = opts.className || '';
    const getScroll = opts.scrollParent || getContainer;
    let liveEl = null;
    function stamp(t){ return '[' + new Date().toLocaleTimeString() + '] ' + t; }
    function newEl(c){
      const el = document.createElement('div');
      if(className) el.className = className;
      el.style.wordBreak = 'break-all';
      c.appendChild(el);
      while(c.childElementCount > maxLines) c.removeChild(c.firstChild);
      return el;
    }
    function applyColor(el, text){
      if(!color) return;
      const col = color(text);
      if(col) el.style.color = col;
    }
    function live(text){
      if(!enabled()) return;
      const c = getContainer(); if(!c) return;
      const line = stamp(text);
      if(liveEl && liveEl.parentNode === c){
        liveEl.textContent = line;
      } else {
        const sp = getScroll();
        const atBottom = sp ? (sp.scrollHeight - sp.scrollTop - sp.clientHeight < 40) : true;
        liveEl = newEl(c);
        liveEl.textContent = line;
        if(atBottom && sp) sp.scrollTop = sp.scrollHeight;
      }
      applyColor(liveEl, text);
    }
    function final(text){
      if(enabled()){
        const c = getContainer();
        if(c){
          const line = stamp(text);
          if(liveEl && liveEl.parentNode === c){
            liveEl.textContent = line;
            applyColor(liveEl, text);
          } else {
            const el = newEl(c);
            el.textContent = line;
            applyColor(el, text);
          }
        }
      }
      liveEl = null; // 固化：后续竞速另起一行
    }
    return { live: live, final: final };
  }

  global.CdnRace = {
    REPO_GH: REPO_GH,
    REPO_REF: REPO_REF,
    CDN_BASES: CDN_BASES,
    buildUrls: buildUrls,
    sourceLabel: sourceLabel,
    fmtSize: fmtSize,
    promiseAny: promiseAny,
    raceFetch: raceFetch,
    readBlobWithProgress: readBlobWithProgress,
    downloadBlob: downloadBlob,
    raceDownload: raceDownload,
    fetchFirstByte: fetchFirstByte,
    fetchResource: fetchResource,
    makeLiveLogger: makeLiveLogger,
  };
})(typeof window !== 'undefined' ? window : this);
