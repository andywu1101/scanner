/* 小伍敵樂譜掃描 — 主程式（內部資料名稱 cocoscan 維持不變，避免舊資料遺失） */
'use strict';
const $ = (s) => document.querySelector(s);
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MODES = [
  { id: 'bw', name: '黑白' },
  { id: 'gray', name: '灰階' },
  { id: 'color', name: '彩色' },
  { id: 'original', name: '原圖' },
];
// 各模式的調整拉桿（數值與 worker.js 的 ADJ_DEFAULTS 對應）
const S_EXP = { k: 'exposure', name: '曝光', min: -100, max: 100, def: 0, lo: '暗', hi: '亮' };
const S_CON = { k: 'contrast', name: '對比', min: -100, max: 100, def: 0, lo: '低', hi: '高' };
const S_SAT = { k: 'saturation', name: '飽和度', min: -100, max: 100, def: 0, lo: '淡', hi: '豔' };
const S_TMP = { k: 'temp', name: '色溫', min: -100, max: 100, def: 0, lo: '冷', hi: '暖' };
const ADJ = {
  bw: [S_EXP, S_CON, { k: 'density', name: '濃淡', min: -100, max: 100, def: 0, lo: '淡', hi: '濃' },
    { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 82, lo: '柔', hi: '銳' }, { k: 'despeckle', name: '去雜點', min: 0, max: 100, def: 35, lo: '少', hi: '多' }, // 1.15 起 82／35（原 35／20）
    { k: 'smooth', name: '邊緣平滑', min: 0, max: 100, def: 50, lo: '關', hi: '強' }],
  gray: [S_EXP, S_CON, { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 50, lo: '柔', hi: '銳' }],
  color: [S_EXP, S_CON, { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 50, lo: '柔', hi: '銳' }, S_SAT, S_TMP],
  original: [S_EXP, S_CON, { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 0, lo: '柔', hi: '銳' }, S_SAT, S_TMP],
};
const MAX_PIXELS = 16000000; // iOS canvas 上限約 16.7M 像素
const MAX_PHOTO = 15000000;  // Android 即時掃描拍照上限 1500 萬畫素（1.10）
const HAS_IC = 'ImageCapture' in window; // Android Chrome 有、iPhone 沒有

/* ---------- 設定 ---------- */
const DEFAULTS = { mode: 'bw', pdfSize: 'a4', autoShutter: true, confirmCrop: true, upscale: 'auto', v: 2 };
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('cocoscan-settings') || '{}'); } catch (_) {}
  if (s.v !== 2) { s.mode = 'bw'; s.v = 2; } // 1.1 起預設黑白
  return Object.assign({}, DEFAULTS, s);
})();
/* 調整數值分三層（1.11）：
   1. App 預設值（ADJ 的 def）
   2. 文件的統一設定 doc.adj[mode]（新文件從 settings.adj 複製；settings.adj＝設定裡的「預設調整數值」，1.15 起只在設定裡改）
   3. 單頁設定 page.adj[mode]（有值＝這一頁單獨調整過，只影響這一頁）
   docAdjCache 是所有文件 doc.adj 的記憶體副本，讓 procKey 可以同步算出每一頁實際用的數值 */
if (!settings.adj) settings.adj = {};
const docAdjCache = new Map();
function fillAdj(mode, cur) {
  const o = {};
  for (const d of ADJ[mode] || []) o[d.k] = cur && cur[d.k] !== undefined ? cur[d.k] : d.def;
  return o;
}
function docAdjOf(docId, mode) { const a = docAdjCache.get(docId); return fillAdj(mode, a ? a[mode] : settings.adj[mode]); }
function pageAdjOf(p, mode = p.mode) { return p.adj && p.adj[mode] ? fillAdj(mode, p.adj[mode]) : docAdjOf(p.docId, mode); }
const pageCustom = (p) => !!(p && p.adj && p.adj[p.mode]);
const cloneAdj = (a) => JSON.parse(JSON.stringify(a || {}));
// 使用者的預設調整數值（設定 → 預設調整數值）；新文件以完整數值複製一份，之後出廠值再改也不會影響已有文件
const userDefOf = (mode) => fillAdj(mode, settings.adj[mode]);
const userDefAll = () => Object.fromEntries(MODES.map((m) => [m.id, userDefOf(m.id)]));
// 處理結果的「身分」：模式、旋轉、四角、這一頁實際用的調整數值，任何一項變了就要重算
function procKey(p) { return JSON.stringify([p.mode, p.rotation || 0, p.corners, p.curve || null, pageAdjOf(p), settings.upscale]); }
function isStale(p) { return !p.processed || p.pkey !== procKey(p); }
function saveSettings() { try { localStorage.setItem('cocoscan-settings', JSON.stringify(settings)); } catch (_) {} }

/* ---------- IndexedDB ---------- */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('cocoscan', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('docs', { keyPath: 'id' });
        const p = d.createObjectStore('pages', { keyPath: 'id' });
        p.createIndex('docId', 'docId');
      };
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const q = fn(s);
      if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  // iPhone Safari 存進 IndexedDB 的 Blob 日後可能讀不出來，所以一律存成 ArrayBuffer
  async get(store, id) { return unpackRec(await this.tx(store, 'readonly', (s) => s.get(id))); },
  async put(store, v) { const r = await packRec(v); return this.tx(store, 'readwrite', (s) => s.put(r)); },
  del(store, id) { return this.tx(store, 'readwrite', (s) => s.delete(id)); },
  async all(store) { return (await this.tx(store, 'readonly', (s) => s.getAll())).map(unpackRec); },
};
const BLOB_FIELDS = ['original', 'processed', 'thumb'];
async function packRec(v) {
  const o = Object.assign({}, v);
  for (const f of BLOB_FIELDS) if (o[f] instanceof Blob) o[f] = { __ab: await o[f].arrayBuffer(), type: o[f].type || 'image/jpeg' };
  return o;
}
function unpackRec(v) {
  if (!v) return v;
  for (const f of BLOB_FIELDS) if (v[f] && v[f].__ab) v[f] = new Blob([v[f].__ab], { type: v[f].type });
  return v;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- Worker ---------- */
const worker = new Worker('worker.js');
let workerReady = false, wSeq = 0;
const wPending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') { workerReady = true; document.dispatchEvent(new Event('cvready')); return; }
  const p = wPending.get(m.id);
  if (!p) return;
  wPending.delete(m.id);
  m.ok ? p.res(m.result) : p.rej(new Error(m.error));
};
function wcall(type, payload, transfer) {
  return new Promise((res, rej) => {
    const id = ++wSeq;
    wPending.set(id, { res, rej });
    worker.postMessage(Object.assign({ id, type }, payload), transfer || []);
  });
}
function whenReady() {
  return workerReady ? Promise.resolve() : new Promise((r) => document.addEventListener('cvready', r, { once: true }));
}

/* ---------- 影像工具 ---------- */
function loadImg(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法讀取圖片')); };
    img.src = url;
  });
}
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toBlob(canvas, type, q) { return new Promise((r) => canvas.toBlob(r, type, q)); }
function sourceSize(src) {
  return src.videoWidth ? [src.videoWidth, src.videoHeight] : [src.naturalWidth || src.width, src.naturalHeight || src.height];
}
function smallFrame(src, maxSide) {
  const [w, h] = sourceSize(src);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  const c = canvasOf(cw, ch);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}
async function decodeFull(blob) {
  const { img, url } = await loadImg(blob);
  let w = img.naturalWidth, h = img.naturalHeight;
  if (w * h > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (w * h)); w = Math.floor(w * s); h = Math.floor(h * s); }
  const c = canvasOf(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  c.width = c.height = 0;
  URL.revokeObjectURL(url);
  return data;
}
// 自動偵測紙張四角；任何錯誤都只當作「沒偵測到」，不影響照片匯入
async function detectOn(src) {
  try {
    await whenReady();
    const d = smallFrame(src, 900);
    return await wcall('detect', { buffer: d.data.buffer, width: d.width, height: d.height }, [d.data.buffer]);
  } catch (e) { console.warn('detect failed', e); return null; }
}
async function detectBlob(blob) {
  const { img, url } = await loadImg(blob);
  try { const r = await detectOn(img); return r ? r.corners : FULL.map((p) => p.slice()); }
  finally { URL.revokeObjectURL(url); }
}

/* ---------- 物件網址快取 ---------- */
const urlCache = new Map();
function blobUrl(key, blob, ver) {
  const old = urlCache.get(key);
  if (old && old.ver === ver) return old.url;
  if (old) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, { ver, url });
  return url;
}
const verOf = (p, field) => (p[field] ? field + (p.ver || 0) : 'o');
function dropUrls(prefix) {
  for (const [k, v] of urlCache) if (k.startsWith(prefix)) { URL.revokeObjectURL(v.url); urlCache.delete(k); }
}

/* ---------- 頁面處理 ---------- */
let queue = Promise.resolve();
const procCount = new Map();
const processing = { has: (id) => (procCount.get(id) || 0) > 0 };
let queueGate = null;
function pauseQueue() { if (!queueGate) { let r; queueGate = new Promise((x) => { r = x; }); queueGate.release = r; } }
function resumeQueue() { if (queueGate) { const g = queueGate; queueGate = null; g.release(); } }
function enqueue(pageId) {
  procCount.set(pageId, (procCount.get(pageId) || 0) + 1);
  queue = queue.then(() => queueGate).then(() => processPageNow(pageId)).catch((e) => { console.error(e); toast('處理失敗：' + e.message); })
    .finally(() => { procCount.set(pageId, procCount.get(pageId) - 1); onPageUpdated(pageId); });
  return queue;
}
async function processPageNow(pageId) {
  const page = await DB.get('pages', pageId);
  if (!page || !isStale(page)) return;
  const key = procKey(page);
  await whenReady();
  const d = await decodeFull(page.original);
  const r = await wcall('process', {
    buffer: d.data.buffer, width: d.width, height: d.height,
    corners: page.corners, curve: page.curve || null, upscale: settings.upscale,
    rotation: page.rotation || 0, mode: page.mode, params: pageAdjOf(page),
  }, [d.data.buffer]);
  const c = canvasOf(r.width, r.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
  const processed = page.mode === 'bw' ? await toBlob(c, 'image/png') : await toBlob(c, 'image/jpeg', 0.95);
  const ts = Math.min(1, 420 / Math.max(r.width, r.height));
  const t = canvasOf(Math.round(r.width * ts), Math.round(r.height * ts));
  const tctx = t.getContext('2d'); tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(c, 0, 0, t.width, t.height);
  const thumb = await toBlob(t, 'image/jpeg', 0.85);
  c.width = c.height = 0;
  // 期間可能被修改或刪除，重新讀取
  const latest = await DB.get('pages', pageId);
  if (!latest) return;
  if (procKey(latest) !== key) return;
  latest.pkey = key;
  latest.processed = processed; latest.thumb = thumb; latest.ver = (latest.ver || 0) + 1; latest.outW = r.width; latest.outH = r.height;
  await DB.put('pages', latest);
}
async function waitQueue() { await queue; }
// 舊頁面不主動重算，打開或匯出時才依目前的數值更新
function ensureFresh(pages) {
  for (const p of pages) if (p && isStale(p) && !processing.has(p.id)) enqueue(p.id);
}

async function createDoc() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const doc = {
    id: uid(), created: Date.now(), updated: Date.now(), pageIds: [], adj: userDefAll(),
    title: `掃描 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`,
  };
  await DB.put('docs', doc);
  docAdjCache.set(doc.id, doc.adj);
  return doc;
}
// 啟動時載入每份文件的統一設定；1.10 以前的文件沒有 doc.adj，以當時的數值（settings.adj）為起點，看起來不會變
async function loadDocAdj() {
  const fix115 = !settings.adjFix115;
  for (const d of await DB.all('docs')) {
    let dirty = false;
    if (!d.adj) { d.adj = cloneAdj(settings.adj); dirty = true; }
    // 1.15 黑白出廠值改成 82／35：已有的文件把沒設定過的這兩項固定成舊值 35／20，看起來不變、也不用重算
    if (fix115) {
      const b = d.adj.bw = d.adj.bw || {};
      if (b.sharp === undefined) { b.sharp = 35; dirty = true; }
      if (b.despeckle === undefined) { b.despeckle = 20; dirty = true; }
    }
    if (dirty) await DB.put('docs', d);
    docAdjCache.set(d.id, d.adj);
  }
  if (fix115) {
    // 單頁設定一般存完整數值；萬一有缺，也固定成舊值
    for (const p of await DB.all('pages')) {
      const b = p.adj && p.adj.bw;
      if (b && (b.sharp === undefined || b.despeckle === undefined)) {
        if (b.sharp === undefined) b.sharp = 35;
        if (b.despeckle === undefined) b.despeckle = 20;
        await DB.put('pages', p);
      }
    }
    settings.adj = {}; // 預設調整數值改回新的出廠值（作者選擇）
    settings.adjFix115 = true; saveSettings();
  }
}
async function addPage(docId, blob, corners, curve) {
  const page = { id: uid(), docId, original: blob, corners, curve: curve || null, rotation: 0, mode: settings.mode, created: Date.now() };
  await DB.put('pages', page);
  const doc = await DB.get('docs', docId);
  doc.pageIds.push(page.id); doc.updated = Date.now();
  await DB.put('docs', doc);
  enqueue(page.id);
  return page;
}

/* ---------- 畫面切換 ---------- */
let current = 'cover';
const state = { docId: null, pageIndex: 0 };
function show(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
  if (name === 'home' && typeof needA2Bar === 'function' && needA2Bar()) $('#a2Bar').classList.add('on'); // 加入主畫面提示：每次回到首頁都再出現
  current = name;
  // 狀態列顏色跟著畫面：相機類畫面深色，其他米白
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', ['live', 'crop', 'burst'].includes(name) ? '#1C130E' : name === 'cover' ? '#F6EFE6' : '#FFFCF8');
}
function go(name, push = true) {
  if (push) history.pushState({ s: name, doc: state.docId, i: state.pageIndex }, '');
  show(name);
}
history.replaceState({ s: 'cover' }, '');
window.addEventListener('popstate', (e) => {
  const s = (e.state && e.state.s) || 'home';
  if (adj.open) closeAdjust();
  if (current === 'live') stopLive();
  if (current === 'crop') pipClose();
  if (current === 'crop' && cropCtx && cropCtx.onCancel) { const f = cropCtx.onCancel; cropCtx = null; f(true); }
  closeSheet();
  if (s === 'cover') { show('cover'); }
  else if (s === 'home') { renderHome(); show('home'); }
  else if (s === 'doc') { state.docId = e.state.doc; renderDoc(); show('doc'); }
  else if (s === 'library') { renderLibrary(); show('library'); }
  else if (s === 'burst') { renderBurst(); show('burst'); }
  else if (s === 'page') { state.docId = e.state.doc; state.pageIndex = e.state.i; renderPage(); show('page'); }
  else { renderHome(); show('home'); }
});

/* ---------- 提示 ---------- */
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
function busy(msg) { $('#busyMsg').textContent = msg || '處理中…'; $('#busy').classList.add('show'); }
function unbusy() { $('#busy').classList.remove('show'); }
function openSheet(html, bind) {
  $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  $('#sheetWrap').classList.add('show');
  if (bind) bind($('#sheet'));
}
function closeSheet() { $('#sheetWrap').classList.remove('show'); }
$('#sheetWrap').addEventListener('click', (e) => { if (e.target.id === 'sheetWrap') closeSheet(); });

const ICON = {
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M7 12h10"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="M21 15l-5-5L5 21"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

/* ---------- 首頁 ---------- */
function fmtDate(t) {
  const d = new Date(t); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function deleteDocs(ids) {
  for (const id of ids) {
    const doc = await DB.get('docs', id);
    if (!doc) continue;
    for (const pid of doc.pageIds) { await DB.del('pages', pid); dropUrls('t:' + pid); dropUrls('v:' + pid); dropUrls('home:' + pid); dropUrls('lib:' + pid); dropUrls('strip:' + pid); }
    await DB.del('docs', id);
  }
}
const EMPTY_HTML = `<div class="empty"><svg viewBox="0 0 96 96" fill="none"><rect x="22" y="12" width="52" height="68" rx="6" fill="#EFE4D7"/><path d="M32 34h32M32 44h32M32 54h22" stroke="#C9935F" stroke-width="4" stroke-linecap="round"/><path d="M10 26V14a4 4 0 0 1 4-4h12M70 10h12a4 4 0 0 1 4 4v12M86 70v12a4 4 0 0 1-4 4H70M26 86H14a4 4 0 0 1-4-4V70" stroke="#6B4632" stroke-width="4" stroke-linecap="round"/></svg><b>還沒有掃描文件</b><div>按下方「即時掃描」對準文件自動拍攝，<br>或用「高畫質拍照」取得最清晰的原圖。</div></div>`;
let homeTimer = null;
function renderHomeSoon() { clearTimeout(homeTimer); homeTimer = setTimeout(renderHome, 250); }
async function renderHome() {
  const docs = (await DB.all('docs')).sort((a, b) => b.updated - a.updated);
  const body = $('#homeBody');
  if (!docs.length) { body.innerHTML = EMPTY_HTML; return; }
  const doc = docs[0];
  const pages = (await Promise.all(doc.pageIds.map((id) => DB.get('pages', id)))).filter(Boolean);
  // 正在改名時不要重畫，避免打斷輸入
  const active = document.activeElement;
  if (active && active.id === 'recentName' && body.dataset.doc === doc.id) { updateHomeStrip(pages); return; }
  body.dataset.doc = doc.id;
  body.innerHTML = `
    <div class="sec">最近掃描</div>
    <div class="recent">
      <label class="rname">${ICON.edit}<input id="recentName" type="text" enterkeyhint="done" autocomplete="off" aria-label="文件名稱"></label>
      <div class="rmeta">${pages.length} 頁・${fmtDate(doc.updated)}</div>
      <div class="strip" id="homeStrip"></div>
      <div class="rbtns">
        <button class="bigbtn alt" id="recentOpen">開啟文件</button>
        <button class="bigbtn" id="recentPdf">匯出 PDF</button>
      </div>
    </div>
    <button class="allbtn" id="allDocs"><span>${ICON.folder}全部文件</span><span class="cnt">${docs.length} 份 ›</span></button>`;
  const inp = $('#recentName');
  inp.value = doc.title;
  nameField(inp);
  const save = async () => {
    const v = inp.value.trim();
    const d = await DB.get('docs', doc.id);
    if (!d || !v || v === d.title) { if (!v) inp.value = d ? d.title : ''; return; }
    d.title = v; delete d.exportName; await DB.put('docs', d);
    toast('已重新命名');
  };
  inp.addEventListener('change', save);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  updateHomeStrip(pages);
  $('#recentOpen').onclick = () => openDoc(doc.id);
  $('#recentPdf').onclick = () => { state.docId = doc.id; openPdfSheet(); };
  $('#allDocs').onclick = () => { renderLibrary(); go('library'); };
}
function updateHomeStrip(pages) {
  const strip = $('#homeStrip');
  if (!strip) return;
  ensureFresh(pages);
  const docId = $('#homeBody').dataset.doc;
  strip.innerHTML = '';
  pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'sth';
    const src = p.thumb || p.original;
    b.innerHTML = `<img src="${blobUrl('strip:' + p.id, src, verOf(p, 'thumb'))}" alt=""><span>${i + 1}</span>${!p.thumb || processing.has(p.id) ? '<i class="spin sm"></i>' : ''}`;
    b.onclick = async () => {
      state.docId = docId; await renderDoc();
      history.pushState({ s: 'doc', doc: docId }, '');
      state.pageIndex = i; renderPage(); go('page');
    };
    strip.appendChild(b);
  });
}

/* ---------- 全部文件（多選、合併、刪除） ---------- */
const lib = { selecting: false, order: [] };
async function renderLibrary() {
  const docs = (await DB.all('docs')).sort((a, b) => b.updated - a.updated);
  const list = $('#libList');
  lib.order = lib.order.filter((id) => docs.some((d) => d.id === id));
  $('#libSelect').textContent = lib.selecting ? '取消' : '選取';
  $('#libTitle').textContent = lib.selecting ? `已選 ${lib.order.length} 份` : '全部文件';
  $('#libDock').style.display = lib.selecting ? '' : 'none';
  $('#libAll').querySelector('span').textContent = lib.order.length === docs.length && docs.length ? '取消全選' : '全選';
  $('#libMerge').disabled = lib.order.length < 2;
  $('#libDel').disabled = lib.order.length < 1;
  if (!docs.length) { list.style.display = 'block'; list.innerHTML = EMPTY_HTML; $('#libSelect').style.visibility = 'hidden'; return; }
  $('#libSelect').style.visibility = '';
  list.style.display = '';
  const pages = new Map((await DB.all('pages')).map((p) => [p.id, p]));
  list.innerHTML = '';
  list.classList.toggle('selecting', lib.selecting);
  for (const doc of docs) {
    const first = pages.get(doc.pageIds[0]);
    const b = document.createElement('button');
    const n = lib.order.indexOf(doc.id);
    b.className = 'doc' + (n >= 0 ? ' sel' : '');
    const th = first && (first.thumb || first.original);
    b.innerHTML = `<div class="th">${th ? `<img src="${blobUrl('lib:' + first.id, th, verOf(first, 'thumb'))}" alt="">` : ''}<span class="n">${doc.pageIds.length} 頁</span><span class="ck">${n >= 0 ? n + 1 : ''}</span></div><div class="meta"><div class="t"></div><div class="d">${fmtDate(doc.updated)}</div></div>`;
    b.querySelector('.t').textContent = doc.title;
    b.onclick = () => {
      if (!lib.selecting) { openDoc(doc.id); return; }
      const i = lib.order.indexOf(doc.id);
      if (i >= 0) lib.order.splice(i, 1); else lib.order.push(doc.id);
      renderLibrary();
    };
    list.appendChild(b);
  }
}
$('#libBack').onclick = () => history.back();
$('#libSelect').onclick = () => { lib.selecting = !lib.selecting; lib.order = []; renderLibrary(); };
$('#libAll').onclick = async () => {
  const docs = (await DB.all('docs')).sort((a, b) => b.updated - a.updated);
  lib.order = lib.order.length === docs.length ? [] : docs.map((d) => d.id);
  renderLibrary();
};
$('#libDel').onclick = async () => {
  const n = lib.order.length; if (!n) return;
  if (!confirm(`確定要刪除這 ${n} 份文件？刪除後無法復原。`)) return;
  busy('刪除中…');
  await deleteDocs(lib.order);
  unbusy();
  lib.selecting = false; lib.order = [];
  renderLibrary(); toast(`已刪除 ${n} 份文件`);
};
$('#libMerge').onclick = async () => {
  if (lib.order.length < 2) return;
  busy('合併中…');
  try {
    const docs = (await Promise.all(lib.order.map((id) => DB.get('docs', id)))).filter(Boolean);
    const merged = await createDoc();
    merged.title = docs[0].title + '（合併）';
    merged.adj = cloneAdj(docs[0].adj || settings.adj); docAdjCache.set(merged.id, merged.adj);
    for (const d of docs) {
      for (const pid of d.pageIds) {
        const p = await DB.get('pages', pid);
        if (!p) continue;
        const copy = Object.assign({}, p, { id: uid(), docId: merged.id, created: Date.now(), adj: cloneAdj(p.adj) });
        // 合併後統一設定改成第一份的；原本跟著自己文件設定的頁面，數值不同時記成單頁設定，維持原樣
        if (!copy.adj[p.mode]) {
          const was = pageAdjOf(p), now = docAdjOf(merged.id, p.mode);
          if (JSON.stringify(was) !== JSON.stringify(now)) copy.adj[p.mode] = was;
        }
        await DB.put('pages', copy);
        merged.pageIds.push(copy.id);
      }
    }
    merged.updated = Date.now();
    await DB.put('docs', merged);
    unbusy();
    lib.selecting = false; lib.order = [];
    renderLibrary();
    toast(`已合併為「${merged.title}」，原檔保留`);
  } catch (e) { unbusy(); toast('合併失敗：' + e.message); }
};

/* ---------- 來源選擇 ---------- */
let cameraTarget = null; // docId 或 null（新文件）
function openCamera() { const i = $('#fileCamera'); i.value = ''; i.click(); }
function startSource(src, docId) {
  if (src === 'live') return startLive(docId);
  cameraTarget = docId;
  if (src === 'camera') { startBurst(docId); openCamera(); }
  else { $('#fileGallery').value = ''; $('#fileGallery').click(); }
}
document.querySelectorAll('#home .act').forEach((b) => b.onclick = () => startSource(b.dataset.src, null));

// iPhone：相機／相簿傳回的 File 是暫存檔，稍後可能失效，立刻讀進記憶體
async function stableBlob(file) {
  return new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
}

/* ---------- 高畫質連拍 ---------- */
const burst = { docId: null, fromDoc: false, onStack: false, count: 0, lastPageId: null };
function startBurst(docId) {
  Object.assign(burst, { docId, fromDoc: !!docId, onStack: false, count: 0, lastPageId: null });
}
async function burstAdd(blob, corners, curve) {
  if (!burst.docId) burst.docId = (await createDoc()).id;
  const page = await addPage(burst.docId, blob, corners, curve);
  burst.count++; burst.lastPageId = page.id;
  return page;
}
function toBurst() {
  renderBurst();
  if (current === 'burst') return;
  if (current === 'crop' && burst.onStack) { history.back(); return; }
  if (current === 'crop') history.replaceState({ s: 'burst' }, ''); else history.pushState({ s: 'burst' }, '');
  burst.onStack = true;
  show('burst');
}
async function renderBurst() {
  $('#burstCount').textContent = burst.count ? `已拍 ${burst.count} 張` : '尚未拍攝';
  $('#burstConfirm').classList.toggle('on', settings.confirmCrop);
  $('#burstRetake').disabled = !burst.lastPageId;
  const img = $('#burstImg');
  if (burst.lastPageId) {
    const p = await DB.get('pages', burst.lastPageId);
    if (p) { img.src = blobUrl('burst', p.original, p.id); img.style.visibility = 'visible'; }
  } else img.style.visibility = 'hidden';
}
$('#burstNext').onclick = () => openCamera();
$('#burstConfirm').onclick = () => { settings.confirmCrop = !settings.confirmCrop; saveSettings(); renderBurst(); };
$('#burstRetake').onclick = async () => {
  openCamera();
  if (!burst.lastPageId) return;
  const doc = await DB.get('docs', burst.docId);
  doc.pageIds = doc.pageIds.filter((id) => id !== burst.lastPageId);
  await DB.put('docs', doc);
  await DB.del('pages', burst.lastPageId);
  burst.count--; burst.lastPageId = doc.pageIds.length && burst.count ? doc.pageIds[doc.pageIds.length - 1] : null;
  renderBurst();
};
async function finishBurst() {
  const id = burst.docId;
  if (!id || !burst.count) { history.back(); return; }
  if (burst.fromDoc) { history.back(); setTimeout(renderDoc, 60); return; }
  state.docId = id;
  history.replaceState({ s: 'doc', doc: id }, '');
  await renderDoc(); show('doc');
}
$('#burstDone').onclick = finishBurst;

$('#fileCamera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  busy('偵測文件邊框…');
  let blob, corners;
  try { blob = await stableBlob(file); corners = await detectBlob(blob); }
  catch (err) { unbusy(); toast(err.message); return; }
  unbusy();
  if (settings.confirmCrop) {
    openCrop({
      blob, corners, retake: true, burst: true,
      onConfirm: async (c, cv) => { await burstAdd(blob, c, cv); toBurst(); },
      onRetake: () => openCamera(),
    });
  } else {
    await burstAdd(blob, corners);
    toBurst();
    toast(`已加入第 ${burst.count} 張`);
  }
});

$('#fileGallery').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  let docId = cameraTarget;
  if (!docId) docId = (await createDoc()).id;
  for (let i = 0; i < files.length; i++) {
    busy(`匯入中 ${i + 1} / ${files.length}`);
    try {
      const blob = await stableBlob(files[i]);
      const c = await detectBlob(blob);
      await addPage(docId, blob, c);
    } catch (err) { toast(err.message); }
  }
  unbusy();
  openDoc(docId, current !== 'doc');
});

/* ---------- 即時掃描 ---------- */
const live = { running: false };
const STABLE_MS = 500;   // 鎖定後大致不動多久就拍
const STABLE_TOL = 0.03;  // 容許的手抖（畫面比例）
const EDGE_MARGIN = 0.01; // 紙張四角至少離畫面邊緣 1%（1.4～1.15 是 3%，作者覺得要拿太遠，1.16 放寬）
async function startLive(docId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('此瀏覽器不支援即時相機，請改用「高畫質拍照」'); return;
  }
  Object.assign(live, {
    running: true, docId, fromDoc: !!docId, count: 0, stream: null, track: null, ic: null, lastQuad: null, shown: null,
    hist: [], miss: 0, armed: true, capturedQuad: null, capturedSig: null, capturing: false, detecting: false, lastCapT: 0, progress: 0,
  });
  pauseQueue(); // 掃描期間暫停高解析度處理，讓抓邊保持流暢
  resetLock();
  $('#liveThumb').style.visibility = 'hidden';
  $('#autoBtn').classList.toggle('on', settings.autoShutter);
  $('#autoBtn').textContent = settings.autoShutter ? '自動拍攝' : '手動拍攝';
  setRing(0);
  go('live');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // Android（有 ImageCapture）另外用 takePhoto 拍照，預覽只用來找紙，要 1920×1440 就夠，弱手機偵測才跟得上（1.10）
      // iPhone 沒有 ImageCapture，存下來的就是預覽那一格，所以維持最高解析度
      video: HAS_IC
        ? { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
    if (!live.running) { stream.getTracks().forEach((t) => t.stop()); return; }
    live.stream = stream;
    live.track = stream.getVideoTracks()[0];
    const v = $('#video');
    v.srcObject = stream;
    await v.play().catch(() => {});
    try {
      const caps = live.track.getCapabilities ? live.track.getCapabilities() : {};
      $('#torchBtn').style.display = caps.torch ? '' : 'none';
      if (caps.focusMode && caps.focusMode.includes('continuous')) live.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    } catch (_) {}
    live.photoSettings = null;
    if (HAS_IC) {
      try {
        live.ic = new ImageCapture(live.track);
        // 拍照尺寸：請相機用不超過 1500 萬畫素的大小拍（手機不支援時會選最接近的，拍完再縮）
        live.ic.getPhotoCapabilities().then((pc) => {
          const W = pc.imageWidth, H = pc.imageHeight;
          if (!W || !H || !W.max || !H.max || W.max * H.max <= MAX_PHOTO) return;
          const s = Math.sqrt(MAX_PHOTO / (W.max * H.max));
          live.photoSettings = { imageWidth: Math.floor(W.max * s), imageHeight: Math.floor(H.max * s) };
        }).catch(() => {});
      } catch (_) {}
    }
    const updRes = () => {
      $('#resChip').textContent = live.ic ? `預覽 ${v.videoWidth}×${v.videoHeight}・拍照最高 1500 萬畫素` : `${v.videoWidth}×${v.videoHeight}`;
    };
    v.onloadedmetadata = updRes; updRes();
    setHint(workerReady ? '將文件放進畫面中' : '影像引擎載入中…');
    whenReady().then(() => { if (live.running) setHint('將文件放進畫面中'); });
    liveLoop();
    requestAnimationFrame(drawOverlay);
  } catch (err) {
    console.error(err);
    stopLive();
    history.back();
    toast(err.name === 'NotAllowedError' ? '未取得相機權限' : '無法開啟相機：' + err.message);
  }
}
function stopLive() {
  live.running = false;
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.stream = null;
  $('#video').srcObject = null;
  shotFx('');
  resumeQueue();
}
function setHint(t, good) { const h = $('#hint'); if (h.textContent !== t) h.textContent = t; h.classList.toggle('on', !!good); }
function setRing(p) { $('#ring').setAttribute('stroke-dashoffset', String(226.2 * (1 - p))); }
const maxDisp = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));

// 畫面內容指紋（判斷是否換頁）
const sigCanvas = canvasOf(24, 32);
function frameSig(v) {
  const ctx = sigCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, 24, 32);
  const d = ctx.getImageData(0, 0, 24, 32).data;
  const g = new Uint8Array(24 * 32);
  for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] + d[i * 4 + 1] * 2 + d[i * 4 + 2]) >> 2;
  return g;
}
function sigDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

// ---- 偵測結果的穩定化：先「鎖定」紙張才顯示框，框用中位數平滑 ----
function medianQuad(list) {
  const med = (arr) => { const a = arr.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  return [0, 1, 2, 3].map((i) => [med(list.map((q) => q[i][0])), med(list.map((q) => q[i][1]))]);
}
function resetLock() {
  Object.assign(live, { cand: [], acc: [], lockQ: null, outliers: 0, miss: 0, anchorQ: null, stableSince: 0, progress: 0, best: null, prevQs: null, lastQs: null, edge: false });
  live.lastQuad = null;
}
// 清晰度（梯度能量），用來從穩定期間挑最清楚的一格
function sharpness(d) {
  const { width: w, height: h, data } = d;
  let s = 0, n = 0;
  const x0 = w >> 3, x1 = w - x0, y0 = h >> 3, y1 = h - y0;
  for (let y = y0; y < y1; y += 2) {
    let i = (y * w + x0) * 4;
    for (let x = x0; x < x1; x += 2, i += 8) {
      const g = data[i + 1], gx = data[i + 9], gy = data[i + 1 + w * 4];
      const dx = gx - g, dy = gy - g;
      s += dx * dx + dy * dy; n++;
    }
  }
  return s / n;
}
// 紙張「內部內容」指紋：依偵測到的四角取樣，所以手抖時不變；有手經過或換頁時才會變
function grayThumb(d) {
  const step = Math.max(1, Math.floor(d.width / 160));
  const w = Math.floor(d.width / step), h = Math.floor(d.height / step);
  const g = new Float32Array(w * h), src = d.data, W = d.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y * step) * W + x * step) * 4;
    g[y * w + x] = src[i] * 0.3 + src[i + 1] * 0.59 + src[i + 2] * 0.11;
  }
  // 模糊兩次，去掉五線譜這類細線造成的鋸齒
  boxBlur(g, w, h, 3); boxBlur(g, w, h, 3);
  return { w, h, g };
}
function boxBlur(g, w, h, r) {
  const t = new Float32Array(g.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += g[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      t[y * w + x] = acc / n;
      acc += g[y * w + Math.min(w - 1, x + r + 1)] - g[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      g[y * w + x] = acc / n;
      acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
    }
  }
}
function quadSig(gt, q) {
  const N = 12, M = 16, out = new Float32Array(N * M);
  let sum = 0;
  for (let j = 0; j < M; j++) for (let i = 0; i < N; i++) {
    const u = 0.1 + 0.8 * (i + 0.5) / N, v = 0.1 + 0.8 * (j + 0.5) / M;
    const x = ((1 - v) * ((1 - u) * q[0][0] + u * q[1][0]) + v * ((1 - u) * q[3][0] + u * q[2][0])) * (gt.w - 1);
    const y = ((1 - v) * ((1 - u) * q[0][1] + u * q[1][1]) + v * ((1 - u) * q[3][1] + u * q[2][1])) * (gt.h - 1);
    const x0 = Math.max(0, Math.min(gt.w - 2, Math.floor(x))), y0 = Math.max(0, Math.min(gt.h - 2, Math.floor(y)));
    const fx = x - x0, fy = y - y0, g = gt.g, w = gt.w;
    const val = g[y0 * w + x0] * (1 - fx) * (1 - fy) + g[y0 * w + x0 + 1] * fx * (1 - fy) + g[(y0 + 1) * w + x0] * (1 - fx) * fy + g[(y0 + 1) * w + x0 + 1] * fx * fy;
    out[j * N + i] = val; sum += val;
  }
  const mean = sum / out.length;
  let v2 = 0; for (const x of out) v2 += (x - mean) ** 2;
  const sd = Math.sqrt(v2 / out.length) + 6; // +6 避免空白頁被雜訊放大
  for (let k = 0; k < out.length; k++) out[k] = (out[k] - mean) / sd;
  return out;
}
function qsDiff(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
const MOTION_TOL = 0.35;  // 倒數期間紙內容的變化上限（超過代表有手或東西在動）
const CHANGE_TOL = 0.45;  // 與上一張相比超過此值，代表換頁了

// 兩張全解析度暫存畫布輪流使用：一張存目前最清楚的，一張給新的一格
const fullCanvases = [document.createElement('canvas'), document.createElement('canvas')];
function grabInto(c, v) {
  if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
  c.getContext('2d').drawImage(v, 0, 0);
  return c;
}
function grabFull(v) { return grabInto(fullCanvases[0], v); }

async function liveLoop() {
  if (!live.running) return;
  const v = $('#video');
  if (workerReady && !live.detecting && !live.capturing && v.videoWidth) {
    live.detecting = true;
    try {
      // 進入穩定倒數後，每一格都先存全解析度畫面（與偵測用的是同一瞬間）
      const pre = settings.autoShutter && live.armed && live.lockQ && live.progress > 0 && !live.ic;
      let full = null;
      if (pre) {
        const spare = live.best && live.best.canvas === fullCanvases[0] ? fullCanvases[1] : fullCanvases[0];
        full = grabInto(spare, v);
      }
      const sig = frameSig(v);
      const d = smallFrame(v, 480);
      const sharp = sharpness(d);
      const gt = grayThumb(d);
      const r = await wcall('detect', { buffer: d.data.buffer, width: d.width, height: d.height, fast: true }, [d.data.buffer]);
      onDetect(r, sig, full, sharp, gt);
    } catch (e) { console.warn(e); }
    live.detecting = false;
  }
  if (live.running) setTimeout(liveLoop, 20);
}

function onDetect(r, sig, full, sharp, gt) {
  if (!live.running || live.capturing) return;
  const now = performance.now();
  const ok = r && r.area > 0.1;
  const qs = ok ? quadSig(gt, r.corners) : null;
  live.dbg = { motion: live.prevQs && qs ? qsDiff(qs, live.prevQs) : null, change: live.capturedQs && qs ? qsDiff(qs, live.capturedQs) : null };

  // 拍完後：等換頁／移開才重新開始，期間不顯示框
  if (!live.armed) {
    const moved = ok && live.capturedQuad && maxDisp(r.corners, live.capturedQuad) > 0.08;
    const changed = qs && live.capturedQs && qsDiff(qs, live.capturedQs) > CHANGE_TOL;
    if (!ok) live.miss++; else live.miss = 0;
    if (moved || changed || live.miss >= 3) { live.rearm = moved ? 'moved' : changed ? 'changed' : 'miss'; live.armed = true; resetLock(); }
    else { setHint('已拍好，請換下一頁', true); return; }
  }

  if (!ok) {
    live.miss++;
    live.cand = [];
    if (live.miss >= 4 && live.lockQ) resetLock();
    if (!live.lockQ) { setRing(0); setHint(live.count ? '放入下一頁' : '將文件放進畫面中'); }
    return;
  }
  live.miss = 0;
  const q = r.corners;

  if (!live.lockQ) {
    // 尚未鎖定：需要連續 3 格位置一致，才確定是文件
    if (live.cand.length && maxDisp(q, live.cand[live.cand.length - 1]) > 0.05) live.cand = [];
    live.cand.push(q);
    if (live.cand.length < 3) { setHint('尋找文件中…'); return; }
    live.lockQ = medianQuad(live.cand);
    live.acc = live.cand.slice();
    live.cand = [];
    live.anchorQ = live.lockQ; live.stableSince = now; live.best = null;
  } else {
    // 已鎖定：離群值忽略，連續 3 次離群才放棄鎖定（例如紙被拿走）
    if (maxDisp(q, live.lockQ) > 0.12) {
      if (++live.outliers >= 3) resetLock();
      return;
    }
    live.outliers = 0;
    live.acc.push(q);
    if (live.acc.length > 5) live.acc.shift();
    live.lockQ = medianQuad(live.acc);
  }
  live.lastQuad = live.lockQ;

  // 紙內容在動（手經過、正在翻頁）→ 重新倒數
  const motion = live.prevQs ? qsDiff(qs, live.prevQs) : 0; // qs 是依這一格實際四角取樣
  live.prevQs = qs;
  if (motion > MOTION_TOL) { live.anchorQ = live.lockQ; live.stableSince = now; live.best = null; live.lastQs = null; }
  live.lastQs = live.prevQs;

  // 穩定判斷：容許自然手抖（約 3%），超過就重新倒數
  if (maxDisp(live.lockQ, live.anchorQ) > STABLE_TOL) { live.anchorQ = live.lockQ; live.stableSince = now; live.best = null; }
  const progress = Math.min(1, (now - live.stableSince) / STABLE_MS);
  live.progress = progress;

  // 紙張太靠近畫面邊緣：照片四周會沒有空間可以重新裁切，先不拍
  live.edge = live.lockQ.some(([x, y]) => x < EDGE_MARGIN || x > 1 - EDGE_MARGIN || y < EDGE_MARGIN || y > 1 - EDGE_MARGIN);
  if (live.edge) {
    live.stableSince = now; live.progress = 0; live.best = null;
    setRing(0); setHint('請稍微拉遠一點'); return;
  }

  // 記錄倒數期間最清楚的一格
  if (full && (!live.best || sharp > live.best.sharp)) live.best = { canvas: full, sharp, quad: q.map((p) => p.slice()) };

  if (!settings.autoShutter) { setRing(0); setHint('按下快門拍攝', true); return; }
  setRing(progress);
  setHint('對準了，保持住…', true);
  if (progress >= 1 && Date.now() - live.lastCapT > 800) {
    const b = live.best;
    capture(sig, b ? b.canvas : null, b ? b.quad : live.lockQ);
  }
}
function videoRect() {
  const st = $('#live .stage').getBoundingClientRect();
  const v = $('#video');
  const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
  const s = Math.min(st.width / vw, st.height / vh);
  return { x: (st.width - vw * s) / 2, y: (st.height - vh * s) / 2, w: vw * s, h: vh * s, cw: st.width, ch: st.height };
}
function drawOverlay() {
  if (!live.running) return;
  const cv = $('#overlay');
  const dpr = window.devicePixelRatio || 1;
  const R = videoRect();
  if (cv.width !== Math.round(R.cw * dpr)) { cv.width = Math.round(R.cw * dpr); cv.height = Math.round(R.ch * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, R.cw, R.ch);
  const target = live.armed && (!live.capturing || live.holdBox) ? live.lockQ : null;
  if (target) {
    if (!live.shown) { live.shown = target.map((p) => p.slice()); live.fade = 0; }
    else live.shown = live.shown.map((p, i) => [p[0] + (target[i][0] - p[0]) * 0.5, p[1] + (target[i][1] - p[1]) * 0.5]);
    live.fade = Math.min(1, (live.fade || 0) + 0.2);
  } else { live.shown = null; live.fade = 0; }
  if (live.shown) {
    const pts = live.shown.map((p) => [R.x + p[0] * R.w, R.y + p[1] * R.h]);
    const pr = settings.autoShutter ? live.progress : 1;
    ctx.globalAlpha = live.fade;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    // 綠色隨倒數逐漸變濃
    ctx.fillStyle = live.edge ? 'rgba(242,196,141,.18)' : `rgba(143,179,138,${0.12 + 0.3 * pr})`;
    ctx.fill();
    ctx.lineWidth = 3 + pr; ctx.lineJoin = 'round';
    ctx.strokeStyle = live.edge ? '#F2C48D' : '#A8D4A1';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(drawOverlay);
}
/* 拍攝提示（v1.9）：'busy' 拍攝中（定格畫面＋轉圈，只有 Android 全解析度拍照會用到）、
   'ok' 拍好了（大勾勾，在影像確定取得的那一刻顯示，之後手就可以移開）、'' 全部收起 */
let okT;
function shotFx(state) {
  const fz = $('#freeze'), busyEl = $('#shotBusy'), ok = $('#shotOk');
  if (state === 'busy') {
    // 把當下畫面定格，讓使用者知道還在拍
    const v = $('#video'), R = videoRect(), dpr = window.devicePixelRatio || 1;
    fz.width = Math.round(R.cw * dpr); fz.height = Math.round(R.ch * dpr);
    const c = fz.getContext('2d');
    try { c.drawImage(v, R.x * dpr, R.y * dpr, R.w * dpr, R.h * dpr); } catch (_) {}
    fz.style.display = 'block'; busyEl.classList.add('show');
    return;
  }
  fz.style.display = 'none'; busyEl.classList.remove('show');
  clearTimeout(okT);
  ok.classList.remove('show');
  if (state === 'ok') {
    void ok.offsetWidth; ok.classList.add('show');
    okT = setTimeout(() => ok.classList.remove('show'), 800);
  }
}
function flash() {
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  if (navigator.vibrate) navigator.vibrate(30);
}
async function capture(sig, full, quadAt) {
  if (live.capturing || !live.running) return;
  live.capturing = true;
  const quad = quadAt || live.lockQ;
  const v = $('#video');
  if (!sig) sig = frameSig(v);
  setRing(0);
  try {
    let blob = null, fromPhoto = false, src = null;
    if (live.ic && !full) {
      // Android：全解析度拍照需要一點時間，拍好才閃光
      setHint('拍攝中，請勿移動…', true);
      live.holdBox = true; shotFx('busy');
      try { blob = await live.ic.takePhoto(live.photoSettings || undefined); fromPhoto = !!blob; }
      catch (e) {
        console.warn('takePhoto', e);
        if (live.photoSettings) { try { blob = await live.ic.takePhoto(); fromPhoto = !!blob; } catch (_) {} }
      }
      live.holdBox = false; shotFx('');
    }
    if (!blob) {
      src = full || grabFull(v); // 畫面在這一刻已經固定
      flash(); shotFx('ok'); // 這一格已經固定下來，手可以移開了
      setHint('已拍好，請換下一頁', true);
      live.armed = false; live.capturedQuad = quad; live.capturedSig = sig; live.capturedQs = live.lastQs; // 立刻隱藏框
      blob = await toBlob(src, 'image/jpeg', 0.97);
    } else { flash(); shotFx('ok'); setHint('已拍好，請換下一頁', true); live.armed = false; live.capturedQuad = quad; live.capturedSig = sig; live.capturedQs = live.lastQs; }
    let corners = quad ? quad.map((p) => p.slice()) : FULL.map((p) => p.slice());
    // 用較高解析度重新精算四個角（只在結果相近時採用，避免抓錯）
    try {
      let r = null, sameAspect = true;
      if (fromPhoto) {
        const { img, url } = await loadImg(blob);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        sameAspect = Math.abs(iw / ih - v.videoWidth / v.videoHeight) < 0.02;
        let srcImg = img;
        if (iw * ih > MAX_PHOTO * 1.05) {
          // 相機給的照片太大（例如 4800 萬畫素），先縮到 1500 萬再存，後面的處理才不會拖慢
          const sc = Math.sqrt(MAX_PHOTO / (iw * ih));
          const c = canvasOf(Math.floor(iw * sc), Math.floor(ih * sc));
          const cx = c.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, c.width, c.height);
          const nb = await toBlob(c, 'image/jpeg', 0.95);
          if (nb) { blob = nb; srcImg = c; }
        }
        r = await detectOn(srcImg);
        if (srcImg !== img) srcImg.width = srcImg.height = 0;
        URL.revokeObjectURL(url);
      } else if (src) r = await detectOn(src);
      // Android 照片：即時框在弱手機上可能偏掉，以照片上完整偵測的結果為準（只排除差太多的誤判）
      const okR = r && (fromPhoto ? r.area > 0.15 && (!quad || !sameAspect || maxDisp(r.corners, quad) < 0.25)
                                  : (!quad || !sameAspect || maxDisp(r.corners, quad) < 0.06));
      if (okR) corners = r.corners;
      else if (!r && !sameAspect) corners = FULL.map((p) => p.slice());
    } catch (_) {}
    if (!live.docId) live.docId = (await createDoc()).id;
    const page = await addPage(live.docId, blob, corners);
    live.count++;
    { const tb = $('#liveThumb'); tb.classList.remove('bump'); void tb.offsetWidth; tb.classList.add('bump'); }
    const th = $('#liveThumb');
    th.style.visibility = 'visible';
    th.querySelector('span').textContent = live.count;
    th.querySelector('img').src = blobUrl('live:last', blob, page.id);
    live.lastCapT = Date.now(); live.miss = 0; live.best = null;
    if (!quad) { live.armed = true; resetLock(); }
  } catch (e) {
    console.error(e); shotFx(''); toast('拍攝失敗：' + e.message);
    live.armed = true; resetLock();
  }
  live.capturing = false;
}
$('#shutter').onclick = () => { if (live.running) capture(); };
$('#liveClose').onclick = () => finishLive();
$('#liveDone').onclick = () => finishLive();
$('#liveThumb').onclick = () => finishLive();
$('#autoBtn').onclick = () => {
  settings.autoShutter = !settings.autoShutter; saveSettings();
  $('#autoBtn').classList.toggle('on', settings.autoShutter);
  $('#autoBtn').textContent = settings.autoShutter ? '自動拍攝' : '手動拍攝';
  resetLock(); setRing(0);
};
let torchOn = false;
$('#torchBtn').onclick = async () => {
  torchOn = !torchOn;
  try { await live.track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('#torchBtn').classList.toggle('on', torchOn); }
  catch (_) { toast('無法開啟閃光燈'); }
};
function finishLive() {
  const docId = live.docId, count = live.count;
  stopLive();
  if (live.fromDoc) { history.back(); return; }
  if (count && docId) {
    state.docId = docId;
    history.replaceState({ s: 'doc', doc: docId }, '');
    renderDoc(); show('doc');
  } else history.back();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && current === 'live') finishLive();
});

/* ---------- 裁切（直線：四角＋拖邊平移；曲線：每條邊 5 個點，抓哪裡拉哪裡，可把彎曲的書頁拉平） ---------- */
let cropCtx = null;
// 曲線工具（與 worker.js 相同）
function crPt(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
}
// 通過 a、內部點 ctrl[]、b 的平滑曲線（Catmull-Rom）；每段取 n 點
function edgePath(a, ctrl, b, n) {
  const pts = [a, ...ctrl, b], m = pts.length;
  const P = [[2 * a[0] - pts[1][0], 2 * a[1] - pts[1][1]], ...pts, [2 * b[0] - pts[m - 2][0], 2 * b[1] - pts[m - 2][1]]];
  const out = [];
  for (let s = 1; s < m; s++) for (let i = 0; i < n; i++) out.push(crPt(P[s - 1], P[s], P[s + 1], P[s + 2], i / n));
  out.push(b.slice());
  return out;
}
const CURVE_N = 5; // 每條邊的內部點數
const bump = (u, u0) => (u <= u0 ? 0.5 - 0.5 * Math.cos((Math.PI * u) / u0) : 0.5 - 0.5 * Math.cos((Math.PI * (1 - u)) / (1 - u0)));
const sameCorners = (a, b) => !!a && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-6 && Math.abs(p[1] - b[i][1]) < 1e-6);
// 曲線上位置 u（0~1）對 a、各內部點、b 的權重（曲線對這些點是線性的）
function edgeWeights(u, m) {
  const segs = m + 1, s = Math.min(segs - 1e-9, Math.max(0, u * segs)), seg = Math.floor(s), t = s - seg;
  const n = m + 2, w = new Array(n).fill(0);
  // 端點外插的虛擬點：P[-1] = 2a - p1，P[n] = 2b - p(n-2)
  const add = (idx, c) => {
    if (idx === -1) { w[0] += 2 * c; w[1] -= c; } else if (idx === n) { w[n - 1] += 2 * c; w[n - 2] -= c; } else w[idx] += c;
  };
  const t2 = t * t, t3 = t2 * t;
  add(seg - 1, 0.5 * (-t + 2 * t2 - t3));
  add(seg, 0.5 * (2 - 5 * t2 + 3 * t3));
  add(seg + 1, 0.5 * (t + 4 * t2 - 3 * t3));
  add(seg + 2, 0.5 * (-t2 + t3));
  return w;
}
function edgePoint(a, ctrl, b, u) {
  const pts = [a, ...ctrl, b], w = edgeWeights(u, ctrl.length);
  return [0, 1].map((k) => pts.reduce((acc, p, i) => acc + w[i] * p[k], 0));
}
// 把任何點數的曲線換成 CURVE_N 個內部點（舊資料或自動偵測的結果）
function normCurve(C, curve) {
  return curve.map((ctrl, i) => {
    if (ctrl.length === CURVE_N) return ctrl.map((p) => p.slice());
    const a = C[i], b = C[(i + 1) % 4];
    return Array.from({ length: CURVE_N }, (_, k) => edgePoint(a, ctrl, b, (k + 1) / (CURVE_N + 1)));
  });
}
function straightCurve(C) {
  return [0, 1, 2, 3].map((i) => { const a = C[i], b = C[(i + 1) % 4]; return Array.from({ length: CURVE_N }, (_, k) => { const t = (k + 1) / (CURVE_N + 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }); });
}
// 外框折線（0~1 座標）；曲線模式依彎曲點畫平滑曲線
function cropOutline(C, curve) {
  if (!curve) return C.map((p) => p.slice());
  const pts = [];
  for (let i = 0; i < 4; i++) { const seg = edgePath(C[i], curve[i], C[(i + 1) % 4], 6); seg.pop(); pts.push(...seg); }
  return pts;
}
async function detectCurveOn(img, corners) {
  try {
    await whenReady();
    const d = smallFrame(img, 1000);
    const r = await wcall('detectCurve', { buffer: d.data.buffer, width: d.width, height: d.height, corners }, [d.data.buffer]);
    return r && r.bulge > 0.003 ? r.curve : null;
  } catch (e) { console.warn('detectCurve', e); return null; }
}

async function openCrop(opts) {
  if (cropCtx && cropCtx.url) URL.revokeObjectURL(cropCtx.url);
  const { img, url } = await loadImg(opts.blob);
  const curve = opts.curve ? normCurve(opts.corners, opts.curve) : null;
  // 放大鏡的取圖來源：把整張照片畫進畫布（整張繪製時各瀏覽器都會正確套用照片方向），
  // 之後只從這張畫布取局部，避免 iPhone Safari 取局部時沒套用方向而錯位
  const ls = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const lc = canvasOf(Math.round(img.naturalWidth * ls), Math.round(img.naturalHeight * ls));
  const lctx = lc.getContext('2d'); lctx.imageSmoothingQuality = 'high';
  lctx.drawImage(img, 0, 0, lc.width, lc.height);
  cropCtx = Object.assign({}, opts, { url, nat: [img.naturalWidth, img.naturalHeight], loupeSrc: lc, corners: opts.corners.map((p) => p.slice()), curve, curveMode: !!curve, drag: null, pipKey: 'crop:' + Date.now() });
  pipInit(cropCtx);
  const ci = $('#cropImg'); ci.src = url;
  $('#cropRetake').style.display = opts.retake ? '' : 'none';
  $('#cropNext').style.display = opts.burst ? '' : 'none';
  updateCurveBtn();
  go('crop');
  requestAnimationFrame(layoutCrop);
}
function updateCurveBtn() {
  const b = $('#cropCurve');
  b.classList.toggle('on', !!(cropCtx && cropCtx.curveMode));
  b.querySelector('span').textContent = cropCtx && cropCtx.curveMode ? '曲線' : '直線';
}
function layoutCrop() {
  if (!cropCtx) return;
  const st = $('#cropStage').getBoundingClientRect();
  const [nw, nh] = cropCtx.nat;
  const pad = 26;
  const s = Math.min((st.width - pad * 2) / nw, (st.height - pad * 2) / nh);
  const w = nw * s, h = nh * s, x = (st.width - w) / 2;
  const y = (st.height - h) / 2; // 置中（1.13 曾下移 40 點，1.14 預覽改到對角後改回置中）
  cropCtx.rect = { x, y, w, h };
  const ci = $('#cropImg');
  Object.assign(ci.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  for (const id of ['#cropSvg', '#cropHandles']) {
    const svg = $(id);
    Object.assign(svg.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  pipPlace(false);
  drawCrop();
}
function drawCrop() {
  const { w, h } = cropCtx.rect;
  const C = cropCtx.corners, curve = cropCtx.curveMode ? cropCtx.curve : null;
  const P = C.map((p) => [p[0] * w, p[1] * h]);
  const poly = cropOutline(C, curve).map((p) => (p[0] * w).toFixed(1) + ',' + (p[1] * h).toFixed(1)).join(' ');
  const g = cropCtx.drag;
  let html = `<defs><mask id="m"><rect x="-40" y="-40" width="${w + 80}" height="${h + 80}" fill="#fff"/><polygon points="${poly}" fill="#000"/></mask></defs>`;
  html += `<rect x="0" y="0" width="${w}" height="${h}" fill="rgba(28,19,14,.55)" mask="url(#m)"/>`;
  html += `<polygon points="${poly}" fill="none" stroke="#F2C48D" stroke-width="2.5" stroke-linejoin="round"/>`;
  $('#cropSvg').innerHTML = html;
  // 控制點另外畫在最上層（1.12）：預覽小視窗蓋到時也看得到、拖得到
  html = '';
  if (curve) {
    // 正在拉的那一點
    if (g && g.type === 'rope') {
      const p = ropePoint(g);
      html += `<circle cx="${p[0] * w}" cy="${p[1] * h}" r="15" fill="rgba(242,196,141,.35)" stroke="#fff" stroke-width="2.5"/><circle cx="${p[0] * w}" cy="${p[1] * h}" r="3.5" fill="#fff"/>`;
    }
  } else {
    // 四條邊的中點把手（拖動只移動那一條邊）
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      const on = g && g.type === 'edge' && g.i === i;
      html += `<rect x="${mx - 15}" y="${my - 4.5}" width="30" height="9" rx="4.5" transform="rotate(${ang} ${mx} ${my})" fill="${on ? '#F2C48D' : '#fff'}" stroke="rgba(28,19,14,.35)" stroke-width="1"/>`;
    }
  }
  P.forEach((p, i) => {
    const on = g && g.type === 'corner' && g.i === i;
    html += `<circle cx="${p[0]}" cy="${p[1]}" r="13" fill="${on ? 'rgba(242,196,141,.55)' : 'rgba(242,196,141,.25)'}" stroke="#fff" stroke-width="2.5"/><circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#fff"/>`;
  });
  $('#cropHandles').innerHTML = html;
  pipRequest(false);
}
(() => {
  const stage = $('#cropStage');
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const local = (e) => { const b = stage.getBoundingClientRect(); return [e.clientX - b.left - cropCtx.rect.x, e.clientY - b.top - cropCtx.rect.y]; };
  stage.addEventListener('pointerdown', (e) => {
    if (!cropCtx || cropCtx.drag) return;
    if (e.target.closest('#pipFull')) { pipFullClose(); return; }
    const [lx, ly] = local(e);
    const { w, h } = cropCtx.rect;
    const P = cropCtx.corners.map((p) => [p[0] * w, p[1] * h]);
    const curveOn = cropCtx.curveMode && cropCtx.curve;
    // 優先順序：角 → 彎曲點（曲線模式）→ 邊的中點把手（直線模式）
    let best = null, bd = 40;
    P.forEach((p, i) => { const d = Math.hypot(p[0] - lx, p[1] - ly); if (d < bd) { bd = d; best = { type: 'corner', i }; } });
    // 1.13：預覽只是暫時出現，所有控制點（含曲線沿邊拉）都優先；離邊遠的地方點預覽才是放大
    if (!best && curveOn) {
      // 找手指最靠近哪一條邊的哪個位置（只取邊的中段，太靠近角時彎不動）
      bd = 30;
      for (let i = 0; i < 4; i++) {
        const a = cropCtx.corners[i], b = cropCtx.corners[(i + 1) % 4], k = cropCtx.curve[i];
        for (let n = 0; n <= 90; n++) {
          const u = 0.05 + (0.9 * n) / 90;
          const p = edgePoint(a, k, b, u);
          const d = Math.hypot(p[0] * w - lx, p[1] * h - ly);
          if (d < bd) { bd = d; best = { type: 'rope', i, s: u }; }
        }
      }
    }
    if (!best && !curveOn) {
      bd = 34;
      for (let i = 0; i < 4; i++) {
        const a = P[i], b = P[(i + 1) % 4];
        const d = Math.hypot((a[0] + b[0]) / 2 - lx, (a[1] + b[1]) / 2 - ly);
        if (d < bd) { bd = d; best = { type: 'edge', i }; }
      }
    }
    if (!best) {
      // 沒按到控制點：按在小視窗上就是移動或點開小視窗
      if (e.target.closest('#pip') && $('#pip').classList.contains('vis')) { e.preventDefault(); pipFullOpen(); }
      return;
    }
    best.start = [lx, ly];
    pipShow(lx + cropCtx.rect.x, ly + cropCtx.rect.y);
    best.c0 = cropCtx.corners.map((p) => p.slice());
    best.k0 = cropCtx.curve ? cropCtx.curve.map((e) => e.map((p) => p.slice())) : null;
    cropCtx.drag = best;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    drawCrop(); loupe(lx, ly);
  });
  stage.addEventListener('pointermove', (e) => {
    const g = cropCtx && cropCtx.drag;
    if (!g) return;
    const [lx, ly] = local(e);
    const { w, h } = cropCtx.rect;
    const dx = lx - g.start[0], dy = ly - g.start[1];
    if (g.type === 'corner') {
      const c = g.c0[g.i];
      const n = [clamp(c[0] + dx / w), clamp(c[1] + dy / h)];
      cropCtx.corners[g.i] = n;
      // 曲線模式：相鄰兩條邊的彎曲點跟著按比例移動，保持原本的彎度
      if (g.k0 && cropCtx.curveMode) {
        const ddx = n[0] - c[0], ddy = n[1] - c[1];
        const prev = (g.i + 3) % 4;
        const mv = (ei, j, f) => { const p = g.k0[ei][j]; cropCtx.curve[ei][j] = [clamp(p[0] + ddx * f), clamp(p[1] + ddy * f)]; };
        for (let j = 0; j < CURVE_N; j++) { const u = (j + 1) / (CURVE_N + 1); mv(g.i, j, 1 - u); mv(prev, j, u); }
      }
    } else if (g.type === 'rope') {
      // 讓曲線上被抓住的那一點跟著手指移動：用最小變動量調整這條邊的兩個內部控制點，兩端的角不動
      // 像拉繩子：位移從手指那點往兩端平順遞減（兩端的角為 0），再換算成讓手指那點剛好跟著走
      const k0 = g.k0[g.i], m = k0.length;
      const phi = k0.map((_, j) => bump((j + 1) / (m + 1), g.s));
      const wts = edgeWeights(g.s, m);
      const gain = Math.max(0.3, phi.reduce((acc, f, j) => acc + f * wts[j + 1], 0));
      const D = [dx / w / gain, dy / h / gain];
      cropCtx.curve[g.i] = k0.map((p, j) => [clamp(p[0] + D[0] * phi[j]), clamp(p[1] + D[1] * phi[j])]);
    } else {
      // 邊：沿著與這條邊垂直的方向平移，兩端的角一起移動
      const i = g.i, j = (i + 1) % 4;
      const a = [g.c0[i][0] * w, g.c0[i][1] * h], b = [g.c0[j][0] * w, g.c0[j][1] * h];
      const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
      const nx = -ey / len, ny = ex / len;
      const dn = dx * nx + dy * ny;
      cropCtx.corners[i] = [clamp(g.c0[i][0] + (dn * nx) / w), clamp(g.c0[i][1] + (dn * ny) / h)];
      cropCtx.corners[j] = [clamp(g.c0[j][0] + (dn * nx) / w), clamp(g.c0[j][1] + (dn * ny) / h)];
    }
    drawCrop(); loupe(lx, ly);
    pipAvoid(lx + cropCtx.rect.x, ly + cropCtx.rect.y);
  });
  const end = (e) => {
    if (!cropCtx) return;
    const was = !!cropCtx.drag;
    cropCtx.drag = null; $('#loupe').style.display = 'none'; drawCrop();
    if (was) { pipRequest(true); pipHideSoon(); }
  };
  window.ropePoint = (g) => { const C = cropCtx.corners, k = cropCtx.curve[g.i]; return edgePoint(C[g.i], k, C[(g.i + 1) % 4], g.s); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  // 放大鏡：顯示正在拖的點附近，直接畫出裁切邊、框外變暗；跟著手指，顯示在手指上方
  function loupe(fx, fy) {
    const g = cropCtx.drag;
    const L = $('#loupe');
    const ctx = L.getContext('2d');
    const { w, h, x: rx, y: ry } = cropCtx.rect;
    const C = cropCtx.corners;
    let fxN, fyN;
    if (g.type === 'corner') [fxN, fyN] = C[g.i];
    else if (g.type === 'rope') [fxN, fyN] = ropePoint(g);
    else { const a = C[g.i], b = C[(g.i + 1) % 4]; fxN = (a[0] + b[0]) / 2; fyN = (a[1] + b[1]) / 2; }
    const R = 264, half = R / 2;
    const src = cropCtx.loupeSrc, SW = src.width, SH = src.height;
    const scale = 2.6 * 2 * (w / SW);       // 暫存圖像素 → 放大鏡畫布像素
    const cx = fxN * SW, cy = fyN * SH;
    ctx.save();
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, R, R);
    ctx.imageSmoothingQuality = 'high';
    // 自己裁掉超出圖片範圍的部分，不依賴瀏覽器對「超出範圍取圖」的處理
    const sw = R / scale;
    const sx0 = Math.max(0, cx - sw / 2), sy0 = Math.max(0, cy - sw / 2);
    const sx1 = Math.min(SW, cx + sw / 2), sy1 = Math.min(SH, cy + sw / 2);
    if (sx1 > sx0 && sy1 > sy0) {
      ctx.drawImage(src, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - cx) * scale + half, (sy0 - cy) * scale + half, (sx1 - sx0) * scale, (sy1 - sy0) * scale);
    }
    const toL = (p) => [(p[0] * SW - cx) * scale + half, (p[1] * SH - cy) * scale + half];
    const Q = cropOutline(C, cropCtx.curveMode ? cropCtx.curve : null).map(toL);
    const path = () => { ctx.moveTo(Q[0][0], Q[0][1]); for (let k = 1; k < Q.length; k++) ctx.lineTo(Q[k][0], Q[k][1]); ctx.closePath(); };
    ctx.beginPath(); ctx.rect(-10, -10, R + 20, R + 20); path();
    ctx.fillStyle = 'rgba(28,19,14,.5)'; ctx.fill('evenodd');
    ctx.beginPath(); path();
    ctx.strokeStyle = '#F2C48D'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
    const st = $('#cropStage').getBoundingClientRect();
    const sx = rx + fx, sy = ry + fy, size = 132, gap = 95;
    let top = sy - gap - size / 2;
    if (top < 6) top = sy + gap - size / 2;
    const left = Math.min(st.width - size - 6, Math.max(6, sx - size / 2));
    Object.assign(L.style, { display: 'block', left: left + 'px', top: top + 'px', right: '' });
  }
})();
window.addEventListener('resize', () => { if (current === 'crop') layoutCrop(); if (current === 'page') { if (adj.open) { fitAdj(); scheduleRegion(); } else fitView(); } });
$('#cropFull').onclick = () => {
  cropCtx.corners = FULL.map((p) => p.slice());
  if (cropCtx.curveMode) cropCtx.curve = straightCurve(cropCtx.corners);
  drawCrop();
};
$('#cropAuto').onclick = async () => {
  const c = cropCtx; if (!c) return;
  busy('偵測中…');
  try {
    const r = await detectOn($('#cropImg'));
    if (!r) { toast('找不到文件邊框，請手動調整'); return; }
    c.corners = r.corners;
    if (c.curveMode) {
      const cv = await detectCurveOn($('#cropImg'), c.corners);
      c.curve = cv ? normCurve(c.corners, cv) : straightCurve(c.corners);
      toast(cv ? '已依紙張邊緣擺好曲線，可再拉邊微調' : '沒有偵測到明顯彎曲，可以按住邊拉彎');
    }
    if (cropCtx === c) drawCrop();
  } finally { unbusy(); }
};
// 直線／曲線切換：第一次切到曲線時自動偵測彎曲
$('#cropCurve').onclick = async () => {
  const c = cropCtx; if (!c) return;
  if (c.curveMode) {
    c.savedCurve = c.curve; c.savedCorners = c.corners.map((p) => p.slice()); c.curve = null; c.curveMode = false;
  } else {
    // 從目前框好的範圍開始：之前彎過就沿用，否則四條邊先維持直線，由使用者拉彎
    c.curveMode = true;
    if (!c.curve) c.curve = c.savedCurve && sameCorners(c.savedCorners, c.corners) ? c.savedCurve : straightCurve(c.corners);
    toast('按住任何一條邊拉動，就能把邊拉彎');
  }
  if (cropCtx === c) { updateCurveBtn(); drawCrop(); }
};
$('#cropOk').onclick = async () => {
  const c = cropCtx; if (!c) return;
  const q = c.corners;
  const area = Math.abs([0, 1, 2, 3].reduce((a, i) => { const j = (i + 1) % 4; return a + q[i][0] * q[j][1] - q[j][0] * q[i][1]; }, 0)) / 2;
  if (area < 0.01) { toast('範圍太小了'); return; }
  cropCtx = null;
  URL.revokeObjectURL(c.url);
  pipClose();
  await c.onConfirm(q, c.curveMode && c.curve ? c.curve : null);
};
$('#cropCancel').onclick = () => history.back();
$('#cropNext').onclick = () => { if (!cropCtx) return; openCamera(); $('#cropOk').onclick(); };
$('#cropRetake').onclick = () => { const c = cropCtx; cropCtx = null; pipClose(); if (c && c.onRetake) c.onRetake(); history.back(); };
$('#cropPrev').onclick = () => pipFullOpen();

/* ---------- 裁切即時成品預覽（1.13 方案 B，1.14 改對角） ----------
   - 平常不顯示；拖控制點時才出現（約半個畫面寬），即時更新；放開後停 1 秒再淡出
   - 只做拉平轉正（不做黑白等增強）：拖動時長邊 700 像素，放開後 1400 像素
   - 位置：開始拖的那一刻，看手指在畫面中心的哪一個象限，就出現在相反的角落；拖的途中手指移到它附近才左右對調，
     兩邊都擋到時變透明；放大鏡永遠在它上面
   - 出現時輕點可放大全螢幕；工具列「成品」隨時看全螢幕大圖，點一下回到框選 */
const pip = { busy: false, want: null, avoid: false, hideT: null, hq: null, v: 't', h: 'l' };
async function pipInit(c) {
  pip.busy = false; pip.want = null; pip.hq = null; pip.avoid = false; clearTimeout(pip.hideT);
  $('#pipFull').classList.remove('show');
  $('#pip').classList.remove('show', 'vis');
  const cv = $('#pipCv'); cv.width = 1; cv.height = 1;
  try {
    await whenReady();
    if (cropCtx !== c) return;
    const d = smallFrame(c.loupeSrc, 1600);
    await wcall('cropSrc', { key: c.pipKey, buffer: d.data.buffer, width: d.width, height: d.height }, [d.data.buffer]);
    if (cropCtx !== c) return;
    c.pipReady = true;
    pipRequest(true);
  } catch (e) { console.warn('pip', e); }
}
function pipClose() {
  $('#pipFull').classList.remove('show');
  $('#pip').classList.remove('show', 'vis');
  clearTimeout(pip.hideT);
  wcall('cropRelease', {}).catch(() => {});
}
// 開始拖控制點時出現在對角（fx、fy：手指在裁切區裡的位置）；還沒消失時直接滑到新的對角
function pipShow(fx, fy) {
  clearTimeout(pip.hideT);
  const el = $('#pip'), st = $('#cropStage').getBoundingClientRect();
  pip.v = fy < st.height / 2 ? 'b' : 't';
  pip.h = fx < st.width / 2 ? 'r' : 'l';
  pip.avoid = false;
  el.style.opacity = '';
  if (!el.classList.contains('show')) { el.classList.add('show'); el.style.transition = 'none'; pipPlace(false); void el.offsetWidth; el.style.transition = ''; }
  else pipPlace(false);
  requestAnimationFrame(() => el.classList.add('vis'));
}
// 放開後停 1 秒再淡出
function pipHideSoon() {
  clearTimeout(pip.hideT);
  pip.hideT = setTimeout(() => {
    const el = $('#pip'); el.classList.remove('vis');
    pip.hideT = setTimeout(() => { el.classList.remove('show'); pip.avoid = false; }, 250);
  }, 1000);
}
// 要求更新預覽；忙碌時只記住最新一次，做完再接著做
function pipRequest(hq) {
  const c = cropCtx;
  if (!c || !c.pipReady) return;
  pip.want = { c, hq, corners: c.corners.map((p) => p.slice()), curve: c.curveMode && c.curve ? c.curve.map((e) => e.map((p) => p.slice())) : null };
  if (!pip.busy) pipRun();
}
async function pipRun() {
  const job = pip.want; pip.want = null;
  if (!job || job.c !== cropCtx) return;
  pip.busy = true;
  try {
    const r = await wcall('cropWarp', { key: job.c.pipKey, corners: job.corners, curve: job.curve, maxSide: job.hq ? 1400 : 700 });
    if (job.c === cropCtx) {
      const cv = $('#pipCv');
      if (cv.width !== r.width || cv.height !== r.height) { cv.width = r.width; cv.height = r.height; }
      cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
      pip.hq = job.hq ? r : null;
      if ($('#pipFull').classList.contains('show')) drawFull();
      pipPlace(pip.avoid);
    }
  } catch (e) { console.warn('cropWarp', e); }
  pip.busy = false;
  if (pip.want) pipRun();
}
// 位置（以裁切區為準，單位 px）：pip.v／pip.h 決定的角落，讓開時左右對調
function pipHome() {
  const st = $('#cropStage').getBoundingClientRect(), el = $('#pip'), m = 10;
  const w = el.offsetWidth || st.width * 0.5, h = el.offsetHeight || w * 1.3;
  return { st, x: pip.h === 'r' ? st.width - w - m : m, y: pip.v === 'b' ? Math.max(m, st.height - h - m) : m, w, h };
}
function pipPlace(avoid) {
  const el = $('#pip');
  if (!el.classList.contains('show')) return;
  const { st, x, y, w } = pipHome();
  el.style.left = (avoid ? st.width - w - x : x) + 'px'; el.style.top = y + 'px';
}
function pipAvoid(fx, fy) {
  const el = $('#pip');
  if (!el.classList.contains('show')) return;
  const home = pipHome(), pad = 36;
  const inBox = (bx) => fx > bx - pad && fx < bx + home.w + pad && fy > home.y - pad && fy < home.y + home.h + pad;
  const other = home.st.width - home.w - home.x;
  if (!pip.avoid && inBox(home.x)) pip.avoid = true;
  pipPlace(pip.avoid);
  el.style.opacity = inBox(pip.avoid ? other : home.x) ? '0.15' : ''; // 兩邊都擋到（紙張很小）時變透明
}
function drawFull() {
  const src = $('#pipCv'), fc = $('#pipFullCv');
  fc.width = src.width; fc.height = src.height;
  fc.getContext('2d').drawImage(src, 0, 0);
}
function pipFullOpen() {
  clearTimeout(pip.hideT); $('#pip').classList.remove('show', 'vis');
  drawFull(); $('#pipFull').classList.add('show');
  if (!pip.hq) pipRequest(true);
}
function pipFullClose() { $('#pipFull').classList.remove('show'); }

/* ---------- 文件頁 ---------- */
async function openDoc(id, push = true) {
  state.docId = id;
  await renderDoc();
  if (current === 'crop' || current === 'live') { history.replaceState({ s: 'doc', doc: id }, ''); show('doc'); }
  else if (current === 'doc') show('doc');
  else go('doc', push);
}
async function getDocPages(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc) return { doc: null, pages: [] };
  const pages = await Promise.all(doc.pageIds.map((pid) => DB.get('pages', pid)));
  return { doc, pages: pages.filter(Boolean) };
}
const docSel = { on: false, ids: new Set(), docId: null };
function updateDocSelUI(total) {
  $('#docSelect').textContent = docSel.on ? '取消' : '選取';
  $('#docDock').style.display = docSel.on ? 'none' : '';
  $('#docSelDock').style.display = docSel.on ? '' : 'none';
  $('#docSelCount').textContent = `已選 ${docSel.ids.size} 頁`;
  $('#docSelAll').querySelector('span').textContent = docSel.ids.size === total && total ? '取消全選' : '全選';
  $('#docSelDel').disabled = !docSel.ids.size;
  $('#pageGrid').classList.toggle('selecting', docSel.on);
  $('#docHint').textContent = docSel.on ? '點選要刪除的頁面' : '長按頁面可拖曳調整順序';
  document.querySelectorAll('#pageGrid .pg:not(.add)').forEach((el) => el.classList.toggle('sel', docSel.ids.has(el.dataset.id)));
}
async function renderDoc() {
  const { doc, pages } = await getDocPages(state.docId);
  if (!doc) return;
  ensureFresh(pages);
  if (docSel.docId !== doc.id) { docSel.on = false; docSel.ids.clear(); docSel.docId = doc.id; }
  $('#docTitle').textContent = doc.title;
  const g = $('#pageGrid'); g.innerHTML = '';
  pages.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pg'; b.dataset.id = p.id;
    fillPageThumb(b, p, i);
    b.onclick = () => {
      if (docSel.on) {
        if (docSel.ids.has(p.id)) docSel.ids.delete(p.id); else docSel.ids.add(p.id);
        updateDocSelUI(pages.length); return;
      }
      if (Date.now() - lastDragEnd < 300) return;
      state.pageIndex = [...g.querySelectorAll('.pg:not(.add)')].indexOf(b);
      renderPage(); go('page');
    };
    g.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'pg add';
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新增頁面';
  add.onclick = addSheet;
  g.appendChild(add);
  setupSort(g);
  if (sorter) sorter.option('disabled', docSel.on);
  add.style.display = docSel.on ? 'none' : '';
  updateDocSelUI(pages.length);
}
$('#docSelect').onclick = () => { docSel.on = !docSel.on; docSel.ids.clear(); renderDoc(); };
$('#docSelAll').onclick = async () => {
  const doc = await DB.get('docs', state.docId);
  if (docSel.ids.size === doc.pageIds.length) docSel.ids.clear(); else doc.pageIds.forEach((id) => docSel.ids.add(id));
  updateDocSelUI(doc.pageIds.length);
};
$('#docSelDel').onclick = async () => {
  const n = docSel.ids.size; if (!n) return;
  const doc = await DB.get('docs', state.docId);
  const all = n === doc.pageIds.length;
  if (!confirm(all ? `要刪除全部 ${n} 頁嗎？整份文件也會一起刪除。` : `確定要刪除選取的 ${n} 頁？`)) return;
  if (all) { await deleteDocs([doc.id]); docSel.on = false; history.back(); return; }
  for (const id of docSel.ids) { await DB.del('pages', id); dropUrls('t:' + id); dropUrls('v:' + id); dropUrls('home:' + id); dropUrls('lib:' + id); dropUrls('strip:' + id); }
  doc.pageIds = doc.pageIds.filter((id) => !docSel.ids.has(id));
  doc.updated = Date.now();
  await DB.put('docs', doc);
  docSel.on = false; docSel.ids.clear();
  renderDoc(); toast(`已刪除 ${n} 頁`);
};
// 長按拖曳排序
let sorter = null, lastDragEnd = 0;
function setupSort(g) {
  if (sorter) { sorter.destroy(); sorter = null; }
  if (typeof Sortable === 'undefined') return;
  sorter = Sortable.create(g, {
    draggable: '.pg:not(.add)',
    filter: '.add',
    animation: 160,
    delay: 220, delayOnTouchOnly: true, touchStartThreshold: 6,
    ghostClass: 'pg-ghost', chosenClass: 'pg-chosen', dragClass: 'pg-drag',
    forceFallback: true, fallbackTolerance: 4,
    scroll: true, scrollSensitivity: 80, scrollSpeed: 12, bubbleScroll: true,
    onMove: (evt) => !evt.related.classList.contains('add'),
    onChoose: () => { if (navigator.vibrate) navigator.vibrate(15); },
    onEnd: async () => {
      lastDragEnd = Date.now();
      const ids = [...g.querySelectorAll('.pg:not(.add)')].map((el) => el.dataset.id);
      g.querySelectorAll('.pg:not(.add) .no').forEach((el, i) => { el.textContent = i + 1; });
      const doc = await DB.get('docs', state.docId);
      if (doc.pageIds.join() === ids.join()) return;
      doc.pageIds = ids; doc.updated = Date.now();
      await DB.put('docs', doc);
    },
  });
}
function fillPageThumb(el, p, i) {
  const src = p.thumb || p.original;
  const wait = !p.thumb || processing.has(p.id);
  el.innerHTML = `<img src="${blobUrl('t:' + p.id, src, verOf(p, 'thumb'))}" alt=""><span class="no">${i + 1}</span>${pageCustom(p) ? `<span class="custom" title="這一頁單獨調整過">${ICON.sliders}</span>` : ''}${wait ? '<span class="wait"><span class="spin sm"></span></span>' : ''}`;
}
async function onPageUpdated(pageId) {
  if (current === 'doc') {
    const el = document.querySelector(`.pg[data-id="${pageId}"]`);
    if (el) { const p = await DB.get('pages', pageId); const idx = [...el.parentNode.children].indexOf(el); if (p) fillPageThumb(el, p, idx); }
  }
  if (current === 'page' && viewPage && viewPage.id === pageId) renderPage(true);
  if (current === 'home') renderHomeSoon();
}
function addSheet() {
  openSheet(`<h3>新增頁面</h3>
    <button class="srow" data-s="live">${ICON.live}<span>即時掃描<span class="sub">對準文件自動拍攝，可連續多頁</span></span></button>
    <button class="srow" data-s="camera">${ICON.camera}<span>高畫質拍照<span class="sub">使用手機相機全解析度，畫質最清楚</span></span></button>
    <button class="srow" data-s="gallery">${ICON.gallery}<span>從相簿匯入<span class="sub">可一次選取多張</span></span></button>`, (s) => {
    s.querySelectorAll('.srow').forEach((b) => b.onclick = () => { closeSheet(); startSource(b.dataset.s, state.docId); });
  });
}
$('#docAdd').onclick = addSheet;
$('#docBack').onclick = () => history.back();
$('#docTitle').onclick = renameDoc;
// 改名（1.12 起不用瀏覽器內建對話框，改成底部輸入畫面，才能全選、有清除鈕）
function renameDoc() {
  const title = $('#docTitle').textContent;
  openSheet(`<h3>文件名稱</h3><div class="fname"><input id="rnIn" type="text" enterkeyhint="done" autocomplete="off" aria-label="文件名稱"></div><button class="bigbtn" id="rnOk" style="width:100%">確定</button>`, (s) => {
    const i = s.querySelector('#rnIn');
    i.value = title; nameField(i);
    const ok = async () => {
      const t = i.value.trim();
      closeSheet();
      if (!t || t === title) return;
      const doc = await DB.get('docs', state.docId);
      if (!doc) return;
      doc.title = t; delete doc.exportName; doc.updated = Date.now(); await DB.put('docs', doc);
      $('#docTitle').textContent = doc.title; toast('已重新命名');
    };
    s.querySelector('#rnOk').onclick = ok;
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    i.focus(); // 在點擊的同一個動作裡聚焦，iPhone 才會跳出鍵盤
  });
}
$('#docMore').onclick = () => openSheet(`<h3>文件</h3>
  <button class="srow" data-a="rename">${ICON.edit}<span>重新命名</span></button>
  <button class="srow danger" data-a="del">${ICON.trash}<span>刪除整份文件</span></button>`, (s) => {
  s.querySelector('[data-a=rename]').onclick = () => { closeSheet(); renameDoc(); };
  s.querySelector('[data-a=del]').onclick = async () => {
    closeSheet();
    if (!confirm('確定要刪除這份文件與所有頁面？')) return;
    await deleteDocs([state.docId]);
    history.back();
  };
});
$('#docMode').onclick = () => openSheet(`<h3>統一調整</h3><div class="note" style="margin:-6px 4px 10px">選一個模式套用到全部頁面，接著可以調整這份文件統一的數值</div>${MODES.map((m) => `<button class="srow" data-m="${m.id}"><span>${m.name}<span class="sub">${modeDesc(m.id)}</span></span></button>`).join('')}`, (s) => {
  s.querySelectorAll('.srow').forEach((b) => b.onclick = async () => {
    closeSheet();
    openDocAdjust(b.dataset.m);
  });
});
// 統一調整：全部頁面改成這個模式，再進入調整畫面（預覽第一頁，可左右切換預覽的頁面）
async function openDocAdjust(mode) {
  const { pages } = await getDocPages(state.docId);
  if (!pages.length) return;
  for (const p of pages) { if (p.mode !== mode) { p.mode = mode; await DB.put('pages', p); } } // 先不重算，按完成後一起處理
  state.pageIndex = 0;
  viewPage = pages[0];
  history.pushState({ s: 'page', doc: state.docId, i: 0, adj: 1, scope: 'doc' }, '');
  show('page');
  setAdjNav(pages.length);
  openAdjust('doc');
}
function setAdjNav(n) {
  $('#pageTitle').textContent = `統一調整・預覽第 ${state.pageIndex + 1} / ${n} 頁`;
  $('#prevBtn').style.visibility = state.pageIndex > 0 ? 'visible' : 'hidden';
  $('#nextBtn').style.visibility = state.pageIndex < n - 1 ? 'visible' : 'hidden';
}
function modeDesc(id) {
  return { color: '提亮紙張、去除陰影，保留色彩', gray: '去陰影後轉灰階，柔和清楚', bw: '純黑白，最適合樂譜、講義、文字', original: '只裁切校正，不做色彩處理' }[id];
}

/* ---------- 單頁檢視 ---------- */
let viewPage = null;
const zoom = { s: 1, x: 0, y: 0, base: null };
async function renderPage(keepZoom) {
  const { pages } = await getDocPages(state.docId);
  if (!pages.length) { history.back(); return; }
  state.pageIndex = Math.max(0, Math.min(state.pageIndex, pages.length - 1));
  const p = pages[state.pageIndex];
  viewPage = p;
  $('#pageTitle').textContent = `第 ${state.pageIndex + 1} / ${pages.length} 頁`;
  $('#prevBtn').style.visibility = state.pageIndex > 0 ? 'visible' : 'hidden';
  $('#nextBtn').style.visibility = state.pageIndex < pages.length - 1 ? 'visible' : 'hidden';
  const img = $('#viewImg');
  const src = p.processed || p.original;
  const url = blobUrl('v:' + p.id, src, verOf(p, 'processed'));
  if (img.getAttribute('src') !== url) {
    img.onload = () => {
      const nat = img.naturalWidth + 'x' + img.naturalHeight;
      if (!keepZoom || nat !== zoom.nat) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
      zoom.nat = nat; fitView();
    };
    img.src = url;
  }
  ensureFresh([p]);
  $('#viewBusy').style.display = processing.has(p.id) || isStale(p) ? 'block' : 'none';
  $('#modeChips').innerHTML = MODES.map((m) => `<button class="chip ${p.mode === m.id ? 'on' : ''}" data-m="${m.id}">${m.name}</button>`).join('') +
    `<button class="chip adj" id="adjBtn">${ICON.sliders}調整</button>`;
  $('#modeChips').querySelectorAll('.chip[data-m]').forEach((b) => b.onclick = () => updatePage({ mode: b.dataset.m }));
  $('#adjBtn').onclick = openAdjust;
}
function fitView() {
  const img = $('#viewImg');
  if (!img.naturalWidth) return;
  const st = $('#viewStage').getBoundingClientRect();
  const pad = 14;
  const s = Math.min((st.width - pad * 2) / img.naturalWidth, (st.height - pad * 2) / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  zoom.base = { x: (st.width - w) / 2, y: (st.height - h) / 2, w, h };
  applyZoom();
}
// 手勢進行中用 transform 縮放（流暢）；手勢結束後把圖片「實際尺寸」設成放大後的大小，
// 瀏覽器才會用原圖細節重新繪製，放大後不會糊（iPhone 只用 transform 會把小圖拉大）
function zoomTarget() {
  return adj.open ? { el: $('#adjWrap'), natW: adj.fullW || 1 } : { el: $('#viewImg'), natW: $('#viewImg').naturalWidth };
}
function applyZoom(gesturing) {
  const b = zoom.base; if (!b) return;
  const { el: img, natW } = zoomTarget();
  if (!gesturing && zoom.s <= 1.001) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
  // 實際尺寸最多放到「原圖 1 像素 = 螢幕 1 像素」，再大就只是放大像素，交給 transform
  const capS = Math.max(1, natW / (b.w * (window.devicePixelRatio || 1)));
  if (!gesturing || !zoom.cs) zoom.cs = Math.min(zoom.s, capS);
  const cs = zoom.cs;
  img.style.width = b.w * cs + 'px'; img.style.height = b.h * cs + 'px';
  const k = zoom.s / cs;
  img.style.transform = `translate(${b.x + zoom.x}px,${b.y + zoom.y}px)` + (Math.abs(k - 1) > 1e-4 ? ` scale(${k})` : '');
}
(() => {
  const stage = $('#viewStage');
  const pts = new Map();
  let g = null, lastTap = 0, swipeStart = null, holdT = null, holdStart = null;
  const pos = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.navarrow')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, pos(e));
    clearTimeout(holdT);
    if (pts.size === 1) {
      const now = Date.now();
      const p = pos(e);
      if (adj.open) { holdStart = p; holdT = setTimeout(startCompare, 320); }
      if (now - lastTap < 300) { // 雙擊縮放
        const b = zoom.base;
        if (zoom.s > 1) { zoom.s = 1; } else {
          const ns = 3;
          zoom.x = (p[0] - b.x) - ((p[0] - b.x - zoom.x) / zoom.s) * ns;
          zoom.y = (p[1] - b.y) - ((p[1] - b.y - zoom.y) / zoom.s) * ns;
          zoom.s = ns;
        }
        applyZoom(); lastTap = 0; return;
      }
      lastTap = now;
      g = { type: 'pan', start: p, x0: zoom.x, y0: zoom.y };
      swipeStart = zoom.s === 1 ? p : null;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      g = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s0: zoom.s, x0: zoom.x, y0: zoom.y };
      swipeStart = null;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    if (holdStart) { const q = pos(e); if (Math.hypot(q[0] - holdStart[0], q[1] - holdStart[1]) > 8) { clearTimeout(holdT); holdStart = null; } }
    if (!g) return;
    pts.set(e.pointerId, pos(e));
    const B = zoom.base;
    if (g.type === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ns = Math.min(10, Math.max(1, g.s0 * d / g.d0));
      const ix = (g.m0[0] - B.x - g.x0) / g.s0, iy = (g.m0[1] - B.y - g.y0) / g.s0;
      zoom.s = ns; zoom.x = m[0] - B.x - ix * ns; zoom.y = m[1] - B.y - iy * ns;
      applyZoom(true);
    } else if (g.type === 'pan' && zoom.s > 1) {
      const p = pos(e);
      zoom.x = g.x0 + p[0] - g.start[0]; zoom.y = g.y0 + p[1] - g.start[1];
      applyZoom(true);
    }
  });
  const up = (e) => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (swipeStart && p && pts.size === 0 && !adj.open) {
      const dx = pos(e)[0] - swipeStart[0], dy = pos(e)[1] - swipeStart[1];
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }
    swipeStart = null;
    clearTimeout(holdT); holdStart = null;
    if (adj.comparing) endCompare();
    if (pts.size === 0) { g = null; applyZoom(false); if (adj.open) scheduleRegion(); }
    else if (pts.size === 1) { const q = [...pts.values()][0]; g = { type: 'pan', start: q, x0: zoom.x, y0: zoom.y }; }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
})();
function step(d) { state.pageIndex += d; zoom.s = 1; renderPage(); history.replaceState({ s: 'page', doc: state.docId, i: state.pageIndex }, ''); }
$('#prevBtn').onclick = () => (adj.open && adj.scope === 'doc' ? adjSwitch(-1) : step(-1));
$('#nextBtn').onclick = () => (adj.open && adj.scope === 'doc' ? adjSwitch(1) : step(1));
$('#pageBack').onclick = () => history.back();
async function updatePage(patch) {
  const p = await DB.get('pages', viewPage.id);
  Object.assign(p, patch);
  await DB.put('pages', p);
  viewPage = p;
  enqueue(p.id);
  renderPage(true);
}
$('#pgRotL').onclick = () => updatePage({ rotation: ((viewPage.rotation || 0) + 270) % 360 });
$('#pgRotR').onclick = () => updatePage({ rotation: ((viewPage.rotation || 0) + 90) % 360 });
$('#pgCrop').onclick = () => {
  const p = viewPage;
  openCrop({
    blob: p.original, corners: p.corners, curve: p.curve || null,
    onConfirm: async (c, cv) => { history.back(); await updatePage({ corners: c, curve: cv }); },
  });
};
async function movePage(d) {
  const doc = await DB.get('docs', state.docId);
  const i = state.pageIndex, j = i + d;
  if (j < 0 || j >= doc.pageIds.length) return;
  [doc.pageIds[i], doc.pageIds[j]] = [doc.pageIds[j], doc.pageIds[i]];
  doc.updated = Date.now();
  await DB.put('docs', doc);
  state.pageIndex = j;
  history.replaceState({ s: 'page', doc: state.docId, i: j }, '');
  renderPage(true);
  toast(`已移到第 ${j + 1} 頁`);
}
$('#pgMoveL').onclick = () => movePage(-1);
$('#pgMoveR').onclick = () => movePage(1);
$('#pageDel').onclick = async () => {
  if (!confirm('刪除這一頁？')) return;
  const doc = await DB.get('docs', state.docId);
  doc.pageIds = doc.pageIds.filter((id) => id !== viewPage.id);
  doc.updated = Date.now();
  await DB.del('pages', viewPage.id);
  dropUrls('t:' + viewPage.id); dropUrls('v:' + viewPage.id); dropUrls('home:' + viewPage.id);
  if (!doc.pageIds.length) {
    await DB.del('docs', doc.id);
    history.go(-2);
    return;
  }
  await DB.put('docs', doc);
  renderPage();
};


/* ---------- 細部調整（1.11 起分「單頁」與「統一調整」兩種） ----------
   一次一條拉桿；預覽可放大，放開後以全解析度重算看得到的區域；按住預覽看對照數值
   scope 'page'：只改這一頁（page.adj），對照／重設＝這份文件的統一設定
   scope 'doc' ：改整份文件（doc.adj），對照／重設＝App 預設值；可左右切換預覽的頁面 */
const adj = { open: false, ready: false, busy: false, pending: false, key: null, mode: null, snap: null, active: null, regionSeq: 0, comparing: false, scope: 'page', vals: null, ref: null };
const defaultsOf = (mode) => Object.fromEntries(ADJ[mode].map((d) => [d.k, d.def]));
const rotSwap = (r) => r === 90 || r === 270;
async function openAdjust(scope) {
  if (scope !== 'doc') scope = 'page'; // 由按鈕直接呼叫時會傳進事件物件
  const p = viewPage;
  if (!p || adj.open) return;
  const vals = scope === 'doc' ? docAdjOf(p.docId, p.mode) : pageAdjOf(p);
  const ref = scope === 'doc' ? userDefOf(p.mode) : docAdjOf(p.docId, p.mode); // 統一調整對照／重設＝預設調整數值
  Object.assign(adj, {
    open: true, ready: false, busy: false, pending: false, mode: p.mode, scope, vals, ref,
    snap: JSON.stringify(vals), comparing: false, defImg: null,
    active: adj.mode === p.mode && adj.active ? adj.active : ADJ[p.mode][0].k,
  });
  $('#page').classList.add('adjusting');
  $('#page').classList.toggle('adj-doc', scope === 'doc');
  $('#cmpTag').textContent = scope === 'doc' ? '預設' : '統一設定';
  $('#adjReset').textContent = scope === 'doc' ? '全部重設' : '回到統一設定';
  ['#adjMain', '#adjCmp', '#adjCmpDetail'].forEach((s) => { $(s).style.display = 'none'; });
  $('#cmpTag').style.display = 'none';
  buildPanel();
  if (scope === 'page') history.pushState({ s: 'page', doc: state.docId, i: state.pageIndex, adj: 1 }, '');
  await adjPrepare(p);
}
// 把一頁原圖準備成預覽用的校正圖（切換預覽頁面時也會用到）
async function adjPrepare(p) {
  hideDetail(); endCompare();
  adj.ready = false; adj.defImg = null; adj.key = p.id + ':' + Date.now(); adj.rotation = p.rotation || 0;
  zoom.s = 1; zoom.x = 0; zoom.y = 0; zoom.cs = null;
  $('#viewBusy').style.display = 'block';
  const key = adj.key;
  try {
    await whenReady();
    const st = $('#viewStage').getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const maxSide = Math.min(1800, Math.ceil(Math.max(st.width, st.height) * dpr));
    const d = await decodeFull(p.original);
    if (!adj.open || key !== adj.key) return;
    const info = await wcall('prepare', { key, buffer: d.data.buffer, width: d.width, height: d.height, corners: p.corners, curve: p.curve || null, upscale: settings.upscale, maxSide }, [d.data.buffer]);
    if (!adj.open || key !== adj.key) return;
    const sw = rotSwap(adj.rotation);
    adj.pw = sw ? info.height : info.width; adj.ph = sw ? info.width : info.height;
    adj.fullW = sw ? info.fullH : info.fullW; adj.fullH = sw ? info.fullW : info.fullH;
    adj.ready = true;
    fitAdj();
    await renderAdj();
  } catch (e) { console.error(e); toast('預覽失敗：' + e.message); }
  if (key === adj.key) $('#viewBusy').style.display = 'none';
}
// 統一調整時切換預覽的頁面
async function adjSwitch(d) {
  const { pages } = await getDocPages(state.docId);
  const j = state.pageIndex + d;
  if (j < 0 || j >= pages.length) return;
  state.pageIndex = j; viewPage = pages[j];
  history.replaceState({ s: 'page', doc: state.docId, i: j, adj: 1, scope: 'doc' }, '');
  setAdjNav(pages.length);
  $('#adjMain').style.display = 'none';
  adjPrepare(pages[j]);
}
function fitAdj() {
  if (!adj.pw) return;
  const st = $('#viewStage').getBoundingClientRect();
  const pad = 10;
  const s = Math.min((st.width - pad * 2) / adj.pw, (st.height - pad * 2) / adj.ph);
  const w = adj.pw * s, h = adj.ph * s;
  zoom.base = { x: (st.width - w) / 2, y: (st.height - h) / 2, w, h };
  applyZoom();
}
function buildPanel() {
  const mode = adj.mode, name = MODES.find((m) => m.id === mode).name;
  $('#adjTitle').textContent = adj.scope === 'doc' ? `統一調整・${name}` : `這一頁・${name}`;
  $('#adjNote').textContent = adj.scope === 'doc'
    ? '套用到這份文件的所有頁面・左右箭頭切換預覽頁・按住圖片看預設值'
    : '只套用到這一頁・按住圖片看統一設定・雙指放大檢查';
  $('#adjTabs').innerHTML = ADJ[mode].map((d) => `<button class="atab ${d.k === adj.active ? 'on' : ''} ${adj.vals[d.k] !== adj.ref[d.k] ? 'chg' : ''}" data-k="${d.k}">${d.name}</button>`).join('');
  $('#adjTabs').querySelectorAll('.atab').forEach((b) => {
    let lastTap = 0;
    b.onclick = () => {
      const now = Date.now();
      if (b.dataset.k === adj.active && now - lastTap < 350) { setAdjValue(b.dataset.k, adj.ref[b.dataset.k], true); }
      lastTap = now;
      adj.active = b.dataset.k;
      $('#adjTabs').querySelectorAll('.atab').forEach((x) => x.classList.toggle('on', x === b));
      showSlider();
    };
  });
  showSlider();
}
function showSlider() {
  const d = ADJ[adj.mode].find((x) => x.k === adj.active);
  const inp = $('#adjRange');
  inp.min = d.min; inp.max = d.max; inp.step = 1;
  inp.style.setProperty('--def', ((adj.ref[d.k] - d.min) / (d.max - d.min)) * 100 + '%');
  inp.value = adj.vals[d.k];
  $('#adjLo').textContent = d.lo || ''; $('#adjHi').textContent = d.hi || '';
  showVal();
}
function showVal() {
  const d = ADJ[adj.mode].find((x) => x.k === adj.active);
  const v = +$('#adjRange').value;
  const out = $('#adjVal');
  out.textContent = d.name + ' ' + (d.min < 0 && v > 0 ? '+' + v : String(v));
  out.classList.toggle('chg', v !== adj.ref[d.k]);
  const tab = $(`#adjTabs .atab[data-k="${d.k}"]`);
  if (tab) tab.classList.toggle('chg', v !== adj.ref[d.k]);
}
function setAdjValue(k, v, commit) {
  adj.vals[k] = v;
  if (k === adj.active) $('#adjRange').value = v;
  showVal(); hideDetail(); renderAdj();
  if (commit) scheduleRegion();
}
$('#adjRange').addEventListener('input', () => setAdjValue(adj.active, +$('#adjRange').value, false));
$('#adjRange').addEventListener('change', () => scheduleRegion());

function drawTo(canvas, r) {
  if (canvas.width !== r.width || canvas.height !== r.height) { canvas.width = r.width; canvas.height = r.height; }
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
}
async function renderAdj() {
  if (!adj.open || !adj.ready) return;
  if (adj.busy) { adj.pending = true; return; }
  adj.busy = true;
  try {
    const key = adj.key;
    const r = await wcall('render', { key, mode: adj.mode, params: adj.vals, rotation: adj.rotation });
    if (adj.open && key === adj.key) { drawTo($('#adjMain'), r); $('#adjMain').style.display = 'block'; }
  } catch (e) { console.warn(e); }
  adj.busy = false;
  if (adj.pending) { adj.pending = false; renderAdj(); }
}
// 放大時，看得到的區域改用全解析度計算
let regionTimer = null;
function scheduleRegion() { clearTimeout(regionTimer); regionTimer = setTimeout(doRegion, 140); }
function hideDetail() { adj.regionSeq++; adj.detailRect = null; $('#adjDetail').style.display = 'none'; }
function visibleRect() {
  const st = $('#viewStage').getBoundingClientRect(), b = zoom.base, s = zoom.s;
  const left = b.x + zoom.x, top = b.y + zoom.y, W = b.w * s, H = b.h * s;
  const x0 = Math.max(0, -left / W), x1 = Math.min(1, (st.width - left) / W);
  const y0 = Math.max(0, -top / H), y1 = Math.min(1, (st.height - top) / H);
  if (x1 - x0 < 0.003 || y1 - y0 < 0.003) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function placeIn(canvas, rect) {
  Object.assign(canvas.style, { left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.w * 100 + '%', height: rect.h * 100 + '%', display: 'block' });
}
async function doRegion() {
  if (!adj.open || !adj.ready || zoom.s <= 1.15) { if (zoom.s <= 1.15) hideDetail(); return; }
  const rect = visibleRect();
  if (!rect) return;
  const seq = ++adj.regionSeq, pk = JSON.stringify(adj.vals);
  try {
    const r = await wcall('region', { key: adj.key, mode: adj.mode, params: adj.vals, rotation: adj.rotation, rect });
    if (!adj.open || seq !== adj.regionSeq || pk !== JSON.stringify(adj.vals)) return;
    const c = $('#adjDetail');
    drawTo(c, r); placeIn(c, r.rect);
    adj.detailRect = r.rect;
  } catch (e) { console.warn(e); }
}
// 按住看對照數值（單頁＝統一設定；統一調整＝App 預設值）
async function startCompare() {
  if (!adj.ready || adj.comparing) return;
  adj.comparing = true;
  if (navigator.vibrate) navigator.vibrate(10);
  $('#cmpTag').style.display = 'block';
  const defs = adj.ref;
  try {
    if (!adj.defImg) {
      const r = await wcall('render', { key: adj.key, mode: adj.mode, params: defs, rotation: adj.rotation });
      adj.defImg = r;
      drawTo($('#adjCmp'), r);
    }
    if (!adj.comparing) return;
    $('#adjCmp').style.display = 'block';
    if (adj.detailRect) {
      const r = await wcall('region', { key: adj.key, mode: adj.mode, params: defs, rotation: adj.rotation, rect: adj.detailRect });
      if (!adj.comparing) return;
      const c = $('#adjCmpDetail'); drawTo(c, r); placeIn(c, r.rect);
    }
  } catch (e) { console.warn(e); }
}
function endCompare() {
  if (!adj.comparing) return;
  adj.comparing = false;
  ['#adjCmp', '#adjCmpDetail', '#cmpTag'].forEach((s) => { $(s).style.display = 'none'; });
}
function closeAdjust() {
  if (!adj.open) return;
  endCompare();
  adj.open = false; adj.ready = false;
  clearTimeout(regionTimer); hideDetail();
  $('#page').classList.remove('adjusting', 'adj-doc');
  wcall('release', {}).catch(() => {});
  zoom.s = 1; zoom.x = 0; zoom.y = 0; zoom.cs = null;
  const changed = JSON.stringify(adj.vals) !== adj.snap;
  const mode = adj.mode, vals = Object.assign({}, adj.vals), name = MODES.find((m) => m.id === mode).name;
  if (adj.scope === 'doc') {
    // 統一調整：存到文件，也記成新文件的起始數值；單獨調過的頁面詢問要不要一起覆蓋
    applyDocAdjust(state.docId, mode, vals, changed);
    return; // popstate 會回到文件頁
  }
  if (changed && viewPage) {
    const p = viewPage;
    const same = JSON.stringify(vals) === JSON.stringify(docAdjOf(p.docId, mode));
    DB.get('pages', p.id).then(async (pg) => {
      if (!pg) return;
      pg.adj = pg.adj || {};
      if (same) delete pg.adj[mode]; else pg.adj[mode] = vals; // 和統一設定一樣就不算單獨調整
      await DB.put('pages', pg);
      viewPage = pg;
      enqueue(pg.id);
      if (current === 'page') renderPage();
    });
    toast(same ? '這一頁已回到統一設定' : '已更新這一頁的設定');
  }
  renderPage();
  fitView();
}
async function applyDocAdjust(docId, mode, vals, changed) {
  const doc = await DB.get('docs', docId);
  if (!doc) return;
  const { pages } = await getDocPages(docId);
  let overwrite = false;
  if (changed) {
    doc.adj = doc.adj || {};
    doc.adj[mode] = vals;
    docAdjCache.set(doc.id, doc.adj);
    await DB.put('docs', doc);
    const custom = pages.filter((p) => p.adj && p.adj[mode] && JSON.stringify(fillAdj(mode, p.adj[mode])) !== JSON.stringify(vals));
    if (custom.length) overwrite = confirm(`有 ${custom.length} 頁單獨調整過。\n要一起套用新的統一設定嗎？\n\n確定：全部套用\n取消：保留那幾頁自己的設定`);
    for (const p of pages) {
      if (p.adj && p.adj[mode] && (overwrite || JSON.stringify(fillAdj(mode, p.adj[mode])) === JSON.stringify(vals))) { delete p.adj[mode]; await DB.put('pages', p); }
    }
  }
  const { pages: fresh } = await getDocPages(docId);
  ensureFresh(fresh);
  if (current === 'doc') renderDoc();
  toast(changed ? `已套用到全部頁面（${MODES.find((m) => m.id === mode).name}）` : `全部頁面已改成「${MODES.find((m) => m.id === mode).name}」`);
}
$('#adjDone').onclick = () => history.back();
$('#adjReset').onclick = () => {
  adj.vals = Object.assign({}, adj.ref);
  buildPanel(); hideDetail(); renderAdj(); scheduleRegion();
};

/* ---------- PDF 產生（自製，JPEG 原檔直嵌、黑白頁 1-bit 無損） ---------- */
const enc = new TextEncoder();
async function deflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function utf16hex(str) {
  let h = 'FEFF';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c > 0xffff) { const v = c - 0x10000; h += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0'); }
    else h += c.toString(16).padStart(4, '0');
  }
  return '<' + h.toUpperCase() + '>';
}
async function pageImageForPdf(p) {
  const canDeflate = typeof CompressionStream !== 'undefined';
  if (p.mode === 'bw' && canDeflate) {
    const d = await decodeFull(p.processed);
    const { width: w, height: h, data } = d;
    // 有邊緣平滑（邊緣帶灰階）時用 4 階灰（2-bit）無損嵌入，否則用純黑白（1-bit）
    let hasGray = false;
    for (let i = 0; i < data.length; i += 4) { const v = data[i]; if (v > 24 && v < 231) { hasGray = true; break; } }
    if (hasGray) {
      const rb = Math.ceil(w / 4), out = new Uint8Array(rb * h);
      for (let y = 0; y < h; y++) {
        let o = y * rb, src = y * w * 4;
        for (let x = 0; x < w; x += 4) {
          let byte = 0;
          for (let b = 0; b < 4; b++) {
            const xx = x + b;
            const q = xx < w ? Math.round(data[src + xx * 4] / 85) : 3;
            byte = (byte << 2) | q;
          }
          out[o++] = byte;
        }
      }
      return { w, h, bytes: await deflate(out), dict: `/ColorSpace /DeviceGray /BitsPerComponent 2 /Filter /FlateDecode` };
    }
    const rowBytes = Math.ceil(w / 8);
    const bits = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      let o = y * rowBytes, src = y * w * 4;
      for (let x = 0; x < w; x += 8) {
        let byte = 0;
        for (let b = 0; b < 8; b++) {
          const xx = x + b;
          const white = xx < w ? data[src + xx * 4] > 127 : 1;
          byte = (byte << 1) | (white ? 1 : 0);
        }
        bits[o++] = byte;
      }
    }
    return { w, h, bytes: await deflate(bits), dict: `/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode` };
  }
  let blob = p.processed;
  if (blob.type !== 'image/jpeg') {
    const { img, url } = await loadImg(blob);
    const c = canvasOf(img.naturalWidth, img.naturalHeight);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0);
    blob = await toBlob(c, 'image/jpeg', 0.95);
    URL.revokeObjectURL(url); c.width = c.height = 0;
  }
  return { w: p.outW, h: p.outH, bytes: new Uint8Array(await blob.arrayBuffer()), dict: `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode` };
}
async function buildPdf(title, pages, sizeMode, onProgress) {
  const parts = []; const offsets = []; let pos = 0;
  const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); pos += u.byteLength; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); if (typeof body === 'string') push(body); else body(); push(`\nendobj\n`); };
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const n = pages.length;
  const pageObj = (i) => 4 + i * 3;
  obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Title ${utf16hex(title)} /Producer (WuDi Score Scan) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`);
  for (let i = 0; i < n; i++) {
    onProgress && onProgress(i + 1, n);
    const im = await pageImageForPdf(pages[i]);
    let PW, PH;
    const land = im.w > im.h;
    if (sizeMode === 'a4') { PW = 595.28; PH = 841.89; }
    else if (sizeMode === 'letter') { PW = 612; PH = 792; }
    else { PW = im.w * 72 / 300; PH = im.h * 72 / 300; }
    if (sizeMode !== 'fit' && land) [PW, PH] = [PH, PW];
    const s = Math.min(PW / im.w, PH / im.h);
    const dw = im.w * s, dh = im.h * s, dx = (PW - dw) / 2, dy = (PH - dh) / 2;
    const content = `q ${dw.toFixed(3)} 0 0 ${dh.toFixed(3)} ${dx.toFixed(3)} ${dy.toFixed(3)} cm /Im0 Do Q`;
    const po = pageObj(i);
    obj(po, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW.toFixed(2)} ${PH.toFixed(2)}] /Resources << /XObject << /Im0 ${po + 2} 0 R >> >> /Contents ${po + 1} 0 R >>`);
    obj(po + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(po + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} ${im.dict} /Length ${im.bytes.byteLength} >>\nstream\n`);
      push(im.bytes);
      push(`\nendstream`);
    });
  }
  const total = 4 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '-').trim() || '掃描'; }

/* ---------- 匯出 ---------- */
// iPhone／iPad（iPadOS 會自稱 Mac，用觸控點數判斷）
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function deliverSheet(files, label) {
  // 1.13：iPhone 的 PDF 用「開啟檔案」那條路（系統 PDF 預覽右上角的分享選單才有 LINE），只留一顆按鈕
  const iosPdf = IS_IOS && files.length === 1 && /\.pdf$/i.test(files[0].name);
  const canShare = !iosPdf && navigator.canShare && navigator.canShare({ files });
  const totalMB = files.reduce((a, f) => a + f.size, 0) / 1048576;
  openSheet(`<h3>${label}已完成</h3>
    <div class="note" style="margin-top:0">${files.length} 個檔案・共 ${totalMB.toFixed(1)} MB</div>
    ${canShare ? `<button class="bigbtn" id="dShare">分享／儲存到檔案或相簿</button>` : ''}
    <button class="bigbtn ${canShare ? 'alt' : ''}" id="dDown">${iosPdf ? '分享／儲存到檔案' : '下載'}</button>`, (s) => {
    const sh = s.querySelector('#dShare');
    if (sh) sh.onclick = async () => {
      try { await navigator.share({ files }); closeSheet(); }
      catch (e) { if (e.name !== 'AbortError') toast('分享失敗：' + e.message); }
    };
    s.querySelector('#dDown').onclick = () => {
      files.forEach((f, i) => setTimeout(() => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      }, i * 350));
      closeSheet();
    };
  });
}
$('#docPdf').onclick = () => openPdfSheet();
function openPdfSheet() {
  const sizes = [['a4', 'A4'], ['letter', 'Letter'], ['fit', '依原圖尺寸']];
  openSheet(`<h3>匯出 PDF</h3><div class="lbl">檔案名稱</div>
    <div class="fname"><input id="fname" type="text" enterkeyhint="done" autocomplete="off"><span>.pdf</span></div>
    <div class="lbl">頁面尺寸</div>
    <div class="seg" id="pdfSeg">${sizes.map(([k, n]) => `<button data-k="${k}" class="${settings.pdfSize === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <button class="bigbtn" id="pdfGo">產生 PDF</button>
    <div class="note">彩色、灰階、原圖頁以全解析度 JPEG 原檔嵌入（不再壓縮）；黑白頁以 1-bit 無損嵌入，字跡與五線譜邊緣最銳利。</div>`, (s) => {
    s.querySelectorAll('#pdfSeg button').forEach((b) => b.onclick = () => {
      settings.pdfSize = b.dataset.k; saveSettings();
      s.querySelectorAll('#pdfSeg button').forEach((x) => x.classList.toggle('on', x === b));
    });
    fillName(s);
    s.querySelector('#pdfGo').onclick = async () => {
      const name = readName(s);
      closeSheet(); busy('等待頁面處理…');
      try {
        ensureFresh((await getDocPages(state.docId)).pages);
        await waitQueue();
        const { doc, pages } = await getDocPages(state.docId);
        const ready = pages.filter((p) => p.processed);
        const pdf = await buildPdf(doc.title, ready, settings.pdfSize, (i, n) => busy(`產生 PDF ${i} / ${n}`));
        unbusy();
        deliverSheet([new File([pdf], name + '.pdf', { type: 'application/pdf' })], 'PDF ');
      } catch (e) { unbusy(); console.error(e); toast('產生失敗：' + e.message); }
    };
  });
};
$('#docImg').onclick = () => openSheet(`<h3>匯出圖片</h3><div class="lbl">檔案名稱</div>
  <div class="fname"><input id="fname" type="text" enterkeyhint="done" autocomplete="off"><span>_01、_02…</span></div>
  <button class="bigbtn" id="imgGo">產生圖片</button>
  <div class="note">黑白頁存成 PNG（無損），其他模式存成高品質 JPEG，都是全解析度。</div>`, (s) => {
  fillName(s);
  s.querySelector('#imgGo').onclick = async () => {
    const name = readName(s);
    closeSheet(); busy('等待頁面處理…');
    try {
      ensureFresh((await getDocPages(state.docId)).pages);
      await waitQueue();
      const { pages } = await getDocPages(state.docId);
      const ready = pages.filter((p) => p.processed);
      const files = ready.map((p, i) => {
        const ext = p.processed.type === 'image/png' ? 'png' : 'jpg';
        const suffix = ready.length > 1 ? '_' + String(i + 1).padStart(2, '0') : '';
        return new File([p.processed], `${name}${suffix}.${ext}`, { type: p.processed.type });
      });
      unbusy();
      deliverSheet(files, '圖片');
    } catch (e) { unbusy(); toast('匯出失敗：' + e.message); }
  };
});
async function fillName(s) {
  const doc = await DB.get('docs', state.docId);
  const i = s.querySelector('#fname');
  i.value = doc.exportName || doc.title;
  nameField(i);
}
/* 名稱輸入框（1.12）：第一次點進去全選（直接打字就整段換掉，再點一下才是一般游標）；右邊 ⓧ 一鍵清空
   iPhone Safari 點擊放開時會把選取取消，所以 focus 後短時間內攔掉 mouseup，並延遲再選一次 */
function nameField(inp) {
  if (!inp || inp.dataset.nf) { if (inp && inp._sync) inp._sync(); return; }
  inp.dataset.nf = '1';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'nclr'; btn.setAttribute('aria-label', '清除');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".35"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';
  inp.after(btn);
  const sync = () => btn.classList.toggle('on', !!inp.value);
  inp._sync = sync;
  inp.addEventListener('input', sync); sync();
  let fresh = false, freshT = 0;
  const selAll = () => { try { inp.setSelectionRange(0, inp.value.length); } catch (_) { inp.select(); } };
  inp.addEventListener('focus', () => {
    fresh = true; selAll(); setTimeout(selAll, 0); setTimeout(selAll, 80);
    clearTimeout(freshT); freshT = setTimeout(() => { fresh = false; }, 450);
  });
  inp.addEventListener('mouseup', (e) => { if (fresh) e.preventDefault(); });
  // 按清除鈕是程式改值，瀏覽器不會發 change；離開時自己補發，讓存檔的程式照常運作
  let atFocus = inp.value, viaClear = false;
  inp.addEventListener('focus', () => { atFocus = inp.value; viaClear = false; });
  inp.addEventListener('blur', () => { fresh = false; if (viaClear && inp.value !== atFocus) inp.dispatchEvent(new Event('change')); viaClear = false; });
  btn.addEventListener('pointerdown', (e) => e.preventDefault()); // 保持輸入框的焦點
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    inp.focus(); // 先聚焦再清空（沒聚焦時按清除鈕也能正確存檔）
    inp.value = ''; sync(); fresh = false; viaClear = true;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function readName(s) {
  const v = safeName(s.querySelector('#fname').value);
  DB.get('docs', state.docId).then((doc) => { if (doc && doc.exportName !== v) { doc.exportName = v; DB.put('docs', doc); } });
  return v;
}

/* ---------- 設定 ---------- */
$('#btnSettings').onclick = () => {
  openSheet(`<h3>設定</h3>
    <div class="lbl">新頁面預設模式</div>
    <div class="seg" id="setMode">${MODES.map((m) => `<button data-k="${m.id}" class="${settings.mode === m.id ? 'on' : ''}">${m.name}</button>`).join('')}</div>
    <div class="switch"><span>即時掃描自動拍攝<small>文件穩定約 1 秒後自動按快門</small></span><button class="tg ${settings.autoShutter ? 'on' : ''}" data-k="autoShutter"></button></div>
    <div class="switch"><span>拍照後先確認裁切<small>高畫質拍照後進入四角微調畫面</small></span><button class="tg ${settings.confirmCrop ? 'on' : ''}" data-k="confirmCrop"></button></div>
    <div class="lbl" style="margin-top:12px">小圖平滑放大<small style="display:block;font-size:12px;margin-top:2px">讓解析度低的圖片（例如別人傳來的照片）轉黑白時邊緣更平順</small></div>
    <div class="seg" id="setUp">${[['auto', '自動'], ['always', '一律'], ['off', '關閉']].map(([k, n]) => `<button data-k="${k}" class="${settings.upscale === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <button class="srow" id="setDefAdj" style="margin-top:6px"><span>預設調整數值 ›<span class="sub">新文件一開始用的曝光、濃淡、銳利度等數值</span></span></button>
    <div class="note">所有掃描只存在這支手機的瀏覽器裡，不會上傳。<br>即時掃描：Android 會另外拍一張照片（最高 1500 萬畫素）；iPhone 受限於網頁相機串流解析度。要最清楚的畫質請用「高畫質拍照」。</div>
    <div class="note" id="storeInfo"></div>
    <div class="note" style="font-size:11px;opacity:.7">${viewportInfo()}・v1.17</div>`, (s) => {
    s.querySelector('#setDefAdj').onclick = () => openDefAdj('bw');
    s.querySelectorAll('#setMode button').forEach((b) => b.onclick = () => {
      settings.mode = b.dataset.k; saveSettings();
      s.querySelectorAll('#setMode button').forEach((x) => x.classList.toggle('on', x === b));
    });
    s.querySelectorAll('#setUp button').forEach((b) => b.onclick = () => {
      settings.upscale = b.dataset.k; saveSettings();
      s.querySelectorAll('#setUp button').forEach((x) => x.classList.toggle('on', x === b));
      // 目前打開的文件立即更新，其他文件打開時才更新
      if (state.docId && (current === 'doc' || current === 'page')) getDocPages(state.docId).then(({ pages }) => ensureFresh(pages));
    });
    s.querySelectorAll('.tg').forEach((b) => b.onclick = () => { settings[b.dataset.k] = !settings[b.dataset.k]; saveSettings(); b.classList.toggle('on', settings[b.dataset.k]); });
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => {
      s.querySelector('#storeInfo').textContent = `已使用空間 ${(e.usage / 1048576).toFixed(0)} MB`;
    });
  });
};

/* ---------- 封面、小額贊助、作者主頁（v1.8） ----------
   封面不進瀏覽紀錄：開始掃描／回封面都用 replaceState，返回鍵行為和以前一樣 */
function goCover() { history.replaceState({ s: 'cover' }, ''); show('cover'); }
$('#cvStart').onclick = () => {
  history.replaceState({ s: 'home' }, ''); renderHome(); show('home');
  // 第一次使用自動打開教學
  let seen = false;
  try { seen = localStorage.getItem('cocoscan-help-seen') === '1'; localStorage.setItem('cocoscan-help-seen', '1'); } catch (_) {}
  if (!seen) openHelp();
};
$('#btnHelp').onclick = () => openHelp();
$('#homeCover').onclick = () => goCover();
$('#homeDonate').onclick = () => openDonate();
function openHelp() {
  const first = A2.standalone ? '<div class="a2-ok">✓ 已加入主畫面</div>'
    : '<div class="a2-first"><h4>第一步：加入主畫面</h4><ul><li>先加入主畫面再開始掃描，用起來就像一般 App。</li><li>在瀏覽器裡掃描的資料，不會出現在主畫面的 App 裡。</li></ul><button id="helpA2">📲 教我怎麼加入</button></div>';
  openSheet(`<div class="help"><h3>使用教學</h3>${first}
    <h4>三種拍法</h4><ul>
      <li><b>即時掃描</b>：對準樂譜就會自動拍，適合一次拍很多頁。</li>
      <li><b>高畫質拍照</b>：用手機相機拍，畫質最清楚，iPhone 特別建議用這個。</li>
      <li><b>相簿匯入</b>：別人傳來的樂譜圖片也能整理成 PDF。</li></ul>
    <h4>即時掃描小技巧</h4><ul>
      <li>紙張四周要留一點空間，太貼邊不會拍。</li>
      <li>綠框出現後拿穩，看到中間的「✓ 已拍好」才算完成。</li>
      <li>換下一頁時，讓紙張離開畫面或翻頁，就會自動拍下一張。</li></ul>
    <h4>裁切</h4><ul>
      <li>拖四個角或拖邊來調整範圍，放大鏡能幫你對準。</li>
      <li>書頁彎曲時切到「曲線」，抓住框線哪裡彎就往哪裡拉，存檔時會自動拉平。</li></ul>
    <h4>模式與調整</h4><ul>
      <li>黑白最適合樂譜，灰階、彩色適合有照片或顏色的講義。</li>
      <li>「調整」可以改曝光、濃淡、去雜點等。按住畫面，可以和預設值比較。</li>
      <li>文件頁的「統一調整」可以一次調整全部頁面；在單頁裡調整只會影響那一頁。</li></ul>
    <h4>管理文件</h4><ul>
      <li>長按頁面可以拖曳排序，也可以選取多頁刪除。</li>
      <li>在「全部文件」裡可以合併或刪除文件。</li></ul>
    <h4>匯出</h4><ul>
      <li>匯出 PDF 或圖片，檔名可以自己改。</li></ul>
    <div class="warn"><h4>⚠ 重要提醒</h4><ul>
      <li>掃描只存在這支手機裡，不會上傳。</li>
      <li>刪除主畫面上的 App，或清除瀏覽器資料，掃描就會全部消失。重要的樂譜請記得匯出 PDF 備份。</li></ul></div>
    <button class="close-help" id="helpClose">我知道了</button></div>`, (sh) => {
    sh.querySelector('#helpClose').onclick = closeSheet; sh.scrollTop = 0;
    const a = sh.querySelector('#helpA2'); if (a) a.onclick = () => { closeSheet(); tryInstall(); };
  });
}
$('#cvDonate').onclick = () => openDonate();
$('#cvAuthor').onclick = () => openModal('authorModal');

/* 贊助者名單：要新增名字，複製下面的範例改名字即可（名單是空的時候顯示「目前尚未有人贊助」）
   例：{ name: '王小明' }, */
const SPONSORS = [
];
function openModal(id) { $('#' + id).classList.add('open'); }
function closeModal(id) { $('#' + id).classList.remove('open'); }
function donatePanel(which) {
  $('#donateIntro').style.display = which ? 'none' : '';
  ['', 'Jko', 'Bank', 'Sponsors'].forEach((k) => { $('#donate' + (k || '_')).style.display = which === k ? 'flex' : 'none'; });
  if (which === 'Sponsors') {
    $('#sponsorList').innerHTML = !SPONSORS.length ? '<div class="sponsor-empty">目前尚未有人贊助，成為第一位贊助者 💛</div>' : SPONSORS.map((x) => `<span>${String(x.name).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</span>`).join('');
  }
  $('#donateModal').scrollTop = 0;
}
function openDonate() { donatePanel(''); openModal('donateModal'); }
document.querySelectorAll('.dmodal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) { closeModal(m.id); return; }
    const pb = e.target.closest('[data-panel]'); if (pb) { donatePanel(pb.dataset.panel); return; }
    const cb = e.target.closest('[data-copy]'); if (cb) { copyText(cb, cb.dataset.copy); }
  });
});
$('#donateToAuthor').onclick = () => { closeModal('donateModal'); openModal('authorModal'); };
function copyText(btn, text) {
  const done = () => { const t = btn.textContent; btn.textContent = '已複製'; setTimeout(() => { btn.textContent = t; }, 1400); };
  const fallback = () => {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (_) {}
    done();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}

/* ---------- 預設調整數值（1.15） ----------
   四個模式各一組拉桿；存在 settings.adj（只記和出廠值不同的項目）。
   新文件從這組數值開始，統一調整的「按住對照」與「全部重設」也以它為準；已經存在的文件不受影響 */
function openDefAdj(mode) {
  const vals = userDefOf(mode);
  openSheet(`<h3>預設調整數值</h3>
    <div class="seg" id="defMode">${MODES.map((m) => `<button data-m="${m.id}" class="${m.id === mode ? 'on' : ''}">${m.name}</button>`).join('')}</div>
    ${ADJ[mode].map((d) => `<div class="defrow"><div class="dh"><span>${d.name}</span><b data-v="${d.k}">${vals[d.k] > 0 && d.min < 0 ? '+' : ''}${vals[d.k]}</b></div>
      <input type="range" class="defrange" data-k="${d.k}" min="${d.min}" max="${d.max}" step="1" value="${vals[d.k]}" style="--def:${((d.def - d.min) / (d.max - d.min)) * 100}%">
      <div class="dl"><span>${d.lo || ''}</span><span>出廠 ${d.def}</span><span>${d.hi || ''}</span></div></div>`).join('')}
    <button class="bigbtn alt" id="defReset" style="width:100%;margin-top:6px">恢復「${MODES.find((m) => m.id === mode).name}」的出廠值</button>
    <div class="note">新文件會從這組數值開始；文件裡的「統一調整」按住對照、全部重設也以這組為準。已經存在的文件不受影響。</div>
    <button class="bigbtn" id="defBack" style="width:100%;margin-top:12px">完成</button>`, (s) => {
    s.querySelectorAll('#defMode button').forEach((b) => b.onclick = () => openDefAdj(b.dataset.m));
    s.querySelectorAll('.defrange').forEach((inp) => inp.addEventListener('input', () => {
      const d = ADJ[mode].find((x) => x.k === inp.dataset.k), v = +inp.value;
      s.querySelector(`[data-v="${d.k}"]`).textContent = (v > 0 && d.min < 0 ? '+' : '') + v;
      const cur = settings.adj[mode] = settings.adj[mode] || {};
      if (v === d.def) delete cur[d.k]; else cur[d.k] = v;
      saveSettings();
    }));
    s.querySelector('#defReset').onclick = () => { delete settings.adj[mode]; saveSettings(); openDefAdj(mode); };
    s.querySelector('#defBack').onclick = closeSheet;
  });
}

/* ---------- 加入主畫面（1.17，做法比照音樂聽力練習 App） ----------
   iPhone 沒有程式可以安裝，只能開說明視窗教使用者按；Android／Chromium 有 beforeinstallprompt 可一鍵安裝。
   iPhone 上 Safari 和主畫面 App 的資料是分開的，所以提醒「先加入主畫面再開始掃描」。
   從主畫面打開（standalone）時，封面按鈕、首頁提示條都不顯示；電腦則顯示 QR Code 請他用手機開 */
function a2hsEnv() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  const isAndroid = /Android/.test(ua);
  const inApp = /\bLine\/|Instagram|FBAN|FBAV|FB_IAB|MicroMessenger|Twitter/i.test(ua);
  const iosOther = isIOS && /CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return { isIOS, isAndroid, desktop: !isIOS && !isAndroid, standalone: navigator.standalone === true || matchMedia('(display-mode: standalone)').matches, needBrowser: inApp || iosOther };
}
const A2 = a2hsEnv();
function showA2HS() {
  const env = a2hsEnv();
  $('#a2StepsIOS').style.display = env.isAndroid ? 'none' : '';
  $('#a2StepsAndroid').style.display = env.isAndroid ? '' : 'none';
  document.querySelectorAll('.a2Br').forEach((e) => { e.textContent = env.isAndroid ? 'Chrome' : 'Safari'; });
  $('#a2InApp').style.display = env.needBrowser ? 'block' : 'none';
  openModal('a2hsModal');
}
// 按「加入主畫面」：Android 有安裝事件就直接跳系統視窗，沒有（已裝過、瀏覽器不支援）就開說明
function tryInstall() {
  const e = window.__a2hsPrompt;
  if (!e) { showA2HS(); return; }
  window.__a2hsPrompt = null;
  try { e.prompt(); } catch (_) { showA2HS(); }
}
$('#a2Copy').onclick = () => {
  const b = $('#a2Copy'), url = location.origin + location.pathname;
  const done = () => { b.textContent = '✓ 已複製，請貼到瀏覽器的網址列'; setTimeout(() => { b.textContent = '📋 複製網址'; }, 2600); };
  const fail = () => { b.textContent = url; };
  try { navigator.clipboard.writeText(url).then(done, fail); } catch (_) { fail(); }
};
$('#cvA2hs').onclick = () => tryInstall();
$('#a2BarHow').onclick = () => tryInstall();
$('#a2BarX').onclick = () => $('#a2Bar').classList.remove('on'); // 只是暫時收起，回到首頁會再出現
const needA2Bar = () => !A2.standalone && !A2.desktop;
(function setupCoverA2() {
  if (A2.standalone) return;
  if (!A2.desktop) { $('#cvA2hs').classList.add('on'); return; }
  // 電腦：請他用手機開（QR Code 由 App 自己產生，函式庫只在電腦上載入）
  $('#cvDesk').classList.add('on');
  $('.cv-msg').style.display = 'none';
  const st = $('#cvStart'); st.textContent = '仍要在電腦上開啟 →'; st.classList.add('desk');
  const sc = document.createElement('script');
  sc.src = 'lib/qrcode.js';
  sc.onload = () => {
    try { const q = qrcode(0, 'M'); q.addData('https://andywu1101.github.io/scanner/'); q.make(); $('#cvQr').src = q.createDataURL(6, 2); } catch (e) { console.warn('qr', e); }
  };
  document.head.appendChild(sc);
})();

/* ---------- 畫面資訊（除錯用，顯示在設定最下方） ----------
   iOS 26 主畫面 App 底部空白的修正在 index.html 的 CSS（html min-height） */
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
function viewportInfo() {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
  document.body.appendChild(d);
  const cs = getComputedStyle(d), t = cs.paddingTop, b = cs.paddingBottom;
  d.remove();
  return `畫面 ${innerWidth}×${innerHeight}・螢幕 ${screen.width}×${screen.height}・上 ${t}・下 ${b}・網頁高 ${document.documentElement.getBoundingClientRect().height}・${isStandalone() ? '主畫面' : '瀏覽器'}`;
}

/* ---------- 啟動 ---------- */
show('cover');
loadDocAdj().catch((e) => console.error(e)).then(() => renderHome());
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
