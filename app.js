/* 可可掃描 — 主程式 */
'use strict';
const $ = (s) => document.querySelector(s);
const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
const MODES = [
  { id: 'color', name: '彩色' },
  { id: 'gray', name: '灰階' },
  { id: 'bw', name: '黑白' },
  { id: 'original', name: '原圖' },
];
const MAX_PIXELS = 16000000; // iOS canvas 上限約 16.7M 像素

/* ---------- 設定 ---------- */
const DEFAULTS = { mode: 'bw', pdfSize: 'a4', autoShutter: true, confirmCrop: true, v: 2 };
const settings = (() => {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('cocoscan-settings') || '{}'); } catch (_) {}
  if (s.v !== 2) { s.mode = 'bw'; s.v = 2; } // 1.1 起預設黑白
  return Object.assign({}, DEFAULTS, s);
})();
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
async function detectOn(src) {
  await whenReady();
  const d = smallFrame(src, 900);
  const r = await wcall('detect', { buffer: d.data.buffer, width: d.width, height: d.height }, [d.data.buffer]);
  return r;
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
  if (!page) return;
  await whenReady();
  const d = await decodeFull(page.original);
  const r = await wcall('process', {
    buffer: d.data.buffer, width: d.width, height: d.height,
    corners: page.corners, rotation: page.rotation || 0, mode: page.mode,
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
  if (latest.mode !== page.mode || latest.rotation !== page.rotation || JSON.stringify(latest.corners) !== JSON.stringify(page.corners)) return;
  latest.processed = processed; latest.thumb = thumb; latest.ver = (latest.ver || 0) + 1; latest.outW = r.width; latest.outH = r.height;
  await DB.put('pages', latest);
}
async function waitQueue() { await queue; }

async function createDoc() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const doc = {
    id: uid(), created: Date.now(), updated: Date.now(), pageIds: [],
    title: `掃描 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`,
  };
  await DB.put('docs', doc);
  return doc;
}
async function addPage(docId, blob, corners) {
  const page = { id: uid(), docId, original: blob, corners, rotation: 0, mode: settings.mode, created: Date.now() };
  await DB.put('pages', page);
  const doc = await DB.get('docs', docId);
  doc.pageIds.push(page.id); doc.updated = Date.now();
  await DB.put('docs', doc);
  enqueue(page.id);
  return page;
}

/* ---------- 畫面切換 ---------- */
let current = 'home';
const state = { docId: null, pageIndex: 0 };
function show(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
  current = name;
}
function go(name, push = true) {
  if (push) history.pushState({ s: name, doc: state.docId, i: state.pageIndex }, '');
  show(name);
}
history.replaceState({ s: 'home' }, '');
window.addEventListener('popstate', (e) => {
  const s = (e.state && e.state.s) || 'home';
  if (current === 'live') stopLive();
  if (current === 'crop' && cropCtx && cropCtx.onCancel) { const f = cropCtx.onCancel; cropCtx = null; f(true); }
  closeSheet();
  if (s === 'home') { renderHome(); show('home'); }
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
    for (const d of docs) {
      for (const pid of d.pageIds) {
        const p = await DB.get('pages', pid);
        if (!p) continue;
        const copy = Object.assign({}, p, { id: uid(), docId: merged.id, created: Date.now() });
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
async function burstAdd(blob, corners) {
  if (!burst.docId) burst.docId = (await createDoc()).id;
  const page = await addPage(burst.docId, blob, corners);
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
      onConfirm: async (c) => { await burstAdd(blob, c); toBurst(); },
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
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
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
    if ('ImageCapture' in window) { try { live.ic = new ImageCapture(live.track); } catch (_) {} }
    const updRes = () => {
      $('#resChip').textContent = live.ic ? `預覽 ${v.videoWidth}×${v.videoHeight}・拍攝用全解析度` : `${v.videoWidth}×${v.videoHeight}`;
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
  Object.assign(live, { cand: [], acc: [], lockQ: null, outliers: 0, miss: 0, anchorQ: null, stableSince: 0, progress: 0, best: null, prevQs: null, lastQs: null });
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
  const target = live.armed && !live.capturing ? live.lockQ : null;
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
    ctx.fillStyle = `rgba(143,179,138,${0.12 + 0.3 * pr})`;
    ctx.fill();
    ctx.lineWidth = 3 + pr; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#A8D4A1';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(drawOverlay);
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
      try { blob = await live.ic.takePhoto(); fromPhoto = !!blob; } catch (e) { console.warn('takePhoto', e); }
    }
    if (!blob) {
      src = full || grabFull(v); // 畫面在這一刻已經固定
      flash();
      setHint('已拍好，請換下一頁', true);
      live.armed = false; live.capturedQuad = quad; live.capturedSig = sig; live.capturedQs = live.lastQs; // 立刻隱藏框
      blob = await toBlob(src, 'image/jpeg', 0.97);
    } else { flash(); setHint('已拍好，請換下一頁', true); live.armed = false; live.capturedQuad = quad; live.capturedSig = sig; live.capturedQs = live.lastQs; }
    let corners = quad ? quad.map((p) => p.slice()) : FULL.map((p) => p.slice());
    // 用較高解析度重新精算四個角（只在結果相近時採用，避免抓錯）
    try {
      let r = null, sameAspect = true;
      if (fromPhoto) {
        const { img, url } = await loadImg(blob);
        sameAspect = Math.abs(img.naturalWidth / img.naturalHeight - v.videoWidth / v.videoHeight) < 0.02;
        r = await detectOn(img);
        URL.revokeObjectURL(url);
      } else if (src) r = await detectOn(src);
      if (r && (!quad || !sameAspect || maxDisp(r.corners, quad) < 0.06)) corners = r.corners;
      else if (!r && !sameAspect) corners = FULL.map((p) => p.slice());
    } catch (_) {}
    if (!live.docId) live.docId = (await createDoc()).id;
    const page = await addPage(live.docId, blob, corners);
    live.count++;
    const th = $('#liveThumb');
    th.style.visibility = 'visible';
    th.querySelector('span').textContent = live.count;
    th.querySelector('img').src = blobUrl('live:last', blob, page.id);
    live.lastCapT = Date.now(); live.miss = 0; live.best = null;
    if (!quad) { live.armed = true; resetLock(); }
  } catch (e) {
    console.error(e); toast('拍攝失敗：' + e.message);
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

/* ---------- 裁切 ---------- */
let cropCtx = null;
async function openCrop(opts) {
  if (cropCtx && cropCtx.url) URL.revokeObjectURL(cropCtx.url);
  const { img, url } = await loadImg(opts.blob);
  cropCtx = Object.assign({ url, nat: [img.naturalWidth, img.naturalHeight], corners: opts.corners.map((p) => p.slice()) }, opts);
  const ci = $('#cropImg'); ci.src = url;
  $('#cropRetake').style.display = opts.retake ? '' : 'none';
  $('#cropNext').style.display = opts.burst ? '' : 'none';
  go('crop');
  requestAnimationFrame(layoutCrop);
}
function layoutCrop() {
  if (!cropCtx) return;
  const st = $('#cropStage').getBoundingClientRect();
  const [nw, nh] = cropCtx.nat;
  const pad = 26;
  const s = Math.min((st.width - pad * 2) / nw, (st.height - pad * 2) / nh);
  const w = nw * s, h = nh * s, x = (st.width - w) / 2, y = (st.height - h) / 2;
  cropCtx.rect = { x, y, w, h };
  const ci = $('#cropImg');
  Object.assign(ci.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  const svg = $('#cropSvg');
  Object.assign(svg.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  drawCrop();
}
function drawCrop() {
  const { w, h } = cropCtx.rect;
  const P = cropCtx.corners.map((p) => [p[0] * w, p[1] * h]);
  const poly = P.map((p) => p.join(',')).join(' ');
  let html = `<defs><mask id="m"><rect x="-40" y="-40" width="${w + 80}" height="${h + 80}" fill="#fff"/><polygon points="${poly}" fill="#000"/></mask></defs>`;
  html += `<rect x="0" y="0" width="${w}" height="${h}" fill="rgba(28,19,14,.55)" mask="url(#m)"/>`;
  html += `<polygon points="${poly}" fill="none" stroke="#F2C48D" stroke-width="2.5" stroke-linejoin="round"/>`;
  P.forEach((p) => { html += `<circle cx="${p[0]}" cy="${p[1]}" r="13" fill="rgba(242,196,141,.25)" stroke="#fff" stroke-width="2.5"/><circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#fff"/>`; });
  $('#cropSvg').innerHTML = html;
}
(() => {
  const stage = $('#cropStage');
  let drag = -1, off = [0, 0];
  const local = (e) => { const b = stage.getBoundingClientRect(); return [e.clientX - b.left - cropCtx.rect.x, e.clientY - b.top - cropCtx.rect.y]; };
  stage.addEventListener('pointerdown', (e) => {
    if (!cropCtx) return;
    const [lx, ly] = local(e);
    const { w, h } = cropCtx.rect;
    let best = -1, bd = 46;
    cropCtx.corners.forEach((p, i) => { const d = Math.hypot(p[0] * w - lx, p[1] * h - ly); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    drag = best; off = [cropCtx.corners[best][0] * w - lx, cropCtx.corners[best][1] * h - ly];
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    loupe(e);
  });
  stage.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [lx, ly] = local(e);
    const { w, h } = cropCtx.rect;
    cropCtx.corners[drag] = [Math.min(1, Math.max(0, (lx + off[0]) / w)), Math.min(1, Math.max(0, (ly + off[1]) / h))];
    drawCrop(); loupe(e);
  });
  const end = () => { drag = -1; $('#loupe').style.display = 'none'; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  function loupe() {
    const L = $('#loupe');
    const p = cropCtx.corners[drag];
    const [nw, nh] = cropCtx.nat;
    const ctx = L.getContext('2d');
    const zoom = 3;
    const k = nw / cropCtx.rect.w; // 原圖像素 / 畫面像素
    const srcSize = (132 / zoom) * k;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 264, 264);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage($('#cropImg'), p[0] * nw - srcSize / 2, p[1] * nh - srcSize / 2, srcSize, srcSize, 0, 0, 264, 264);
    ctx.strokeStyle = '#F2C48D'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(132, 108); ctx.lineTo(132, 156); ctx.moveTo(108, 132); ctx.lineTo(156, 132); ctx.stroke();
    const leftSide = p[0] < 0.5;
    L.style.display = 'block';
    L.style.left = leftSide ? '' : '12px';
    L.style.right = leftSide ? '12px' : '';
  }
})();
window.addEventListener('resize', () => { if (current === 'crop') layoutCrop(); if (current === 'page') fitView(); });
$('#cropFull').onclick = () => { cropCtx.corners = FULL.map((p) => p.slice()); drawCrop(); };
$('#cropAuto').onclick = async () => {
  busy('偵測中…');
  try {
    const r = await detectOn($('#cropImg'));
    if (r) { cropCtx.corners = r.corners; drawCrop(); } else toast('找不到文件邊框，請手動調整');
  } finally { unbusy(); }
};
$('#cropOk').onclick = async () => {
  const c = cropCtx; if (!c) return;
  const q = c.corners;
  const area = Math.abs([0, 1, 2, 3].reduce((a, i) => { const j = (i + 1) % 4; return a + q[i][0] * q[j][1] - q[j][0] * q[i][1]; }, 0)) / 2;
  if (area < 0.01) { toast('範圍太小了'); return; }
  cropCtx = null;
  URL.revokeObjectURL(c.url);
  await c.onConfirm(q);
};
$('#cropCancel').onclick = () => history.back();
$('#cropNext').onclick = () => { if (!cropCtx) return; openCamera(); $('#cropOk').onclick(); };
$('#cropRetake').onclick = () => { const c = cropCtx; cropCtx = null; if (c && c.onRetake) c.onRetake(); history.back(); };

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
  el.innerHTML = `<img src="${blobUrl('t:' + p.id, src, verOf(p, 'thumb'))}" alt=""><span class="no">${i + 1}</span>${wait ? '<span class="wait"><span class="spin sm"></span></span>' : ''}`;
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
async function renameDoc() {
  const doc = await DB.get('docs', state.docId);
  const t = prompt('文件名稱', doc.title);
  if (t && t.trim()) { doc.title = t.trim(); delete doc.exportName; doc.updated = Date.now(); await DB.put('docs', doc); $('#docTitle').textContent = doc.title; }
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
$('#docMode').onclick = () => openSheet(`<h3>套用到全部頁面</h3>${MODES.map((m) => `<button class="srow" data-m="${m.id}"><span>${m.name}<span class="sub">${modeDesc(m.id)}</span></span></button>`).join('')}`, (s) => {
  s.querySelectorAll('.srow').forEach((b) => b.onclick = async () => {
    closeSheet();
    const { pages } = await getDocPages(state.docId);
    for (const p of pages) { if (p.mode !== b.dataset.m) { p.mode = b.dataset.m; await DB.put('pages', p); enqueue(p.id); } }
    renderDoc();
  });
});
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
  $('#viewBusy').style.display = processing.has(p.id) || !p.processed ? 'block' : 'none';
  $('#modeChips').innerHTML = MODES.map((m) => `<button class="chip ${p.mode === m.id ? 'on' : ''}" data-m="${m.id}">${m.name}</button>`).join('');
  $('#modeChips').querySelectorAll('.chip').forEach((b) => b.onclick = () => updatePage({ mode: b.dataset.m }));
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
function applyZoom(gesturing) {
  const b = zoom.base; if (!b) return;
  const img = $('#viewImg');
  if (!gesturing && zoom.s <= 1.001) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
  // 實際尺寸最多放到「原圖 1 像素 = 螢幕 1 像素」，再大就只是放大像素，交給 transform
  const capS = Math.max(1, img.naturalWidth / (b.w * (window.devicePixelRatio || 1)));
  if (!gesturing || !zoom.cs) zoom.cs = Math.min(zoom.s, capS);
  const cs = zoom.cs;
  img.style.width = b.w * cs + 'px'; img.style.height = b.h * cs + 'px';
  const k = zoom.s / cs;
  img.style.transform = `translate(${b.x + zoom.x}px,${b.y + zoom.y}px)` + (Math.abs(k - 1) > 1e-4 ? ` scale(${k})` : '');
}
(() => {
  const stage = $('#viewStage');
  const pts = new Map();
  let g = null, lastTap = 0, swipeStart = null;
  const pos = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.navarrow')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, pos(e));
    if (pts.size === 1) {
      const now = Date.now();
      const p = pos(e);
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
    if (!pts.has(e.pointerId) || !g) return;
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
    if (swipeStart && p && pts.size === 0) {
      const dx = pos(e)[0] - swipeStart[0], dy = pos(e)[1] - swipeStart[1];
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }
    swipeStart = null;
    if (pts.size === 0) { g = null; applyZoom(false); }
    else if (pts.size === 1) { const q = [...pts.values()][0]; g = { type: 'pan', start: q, x0: zoom.x, y0: zoom.y }; }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
})();
function step(d) { state.pageIndex += d; zoom.s = 1; renderPage(); history.replaceState({ s: 'page', doc: state.docId, i: state.pageIndex }, ''); }
$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);
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
    blob: p.original, corners: p.corners,
    onConfirm: async (c) => { history.back(); await updatePage({ corners: c }); },
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
  obj(3, `<< /Title ${utf16hex(title)} /Producer (CocoaScan) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`);
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
function deliverSheet(files, label) {
  const canShare = navigator.canShare && navigator.canShare({ files });
  const totalMB = files.reduce((a, f) => a + f.size, 0) / 1048576;
  openSheet(`<h3>${label}已完成</h3>
    <div class="note" style="margin-top:0">${files.length} 個檔案・共 ${totalMB.toFixed(1)} MB</div>
    ${canShare ? `<button class="bigbtn" id="dShare">分享／儲存到檔案或相簿</button>` : ''}
    <button class="bigbtn ${canShare ? 'alt' : ''}" id="dDown">下載</button>`, (s) => {
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
    <div class="note">所有掃描只存在這支手機的瀏覽器裡，不會上傳。<br>即時掃描：Android 會以相機全解析度拍攝；iPhone 受限於網頁相機串流解析度。要最清楚的畫質請用「高畫質拍照」。</div>
    <div class="note" id="storeInfo"></div>`, (s) => {
    s.querySelectorAll('#setMode button').forEach((b) => b.onclick = () => {
      settings.mode = b.dataset.k; saveSettings();
      s.querySelectorAll('#setMode button').forEach((x) => x.classList.toggle('on', x === b));
    });
    s.querySelectorAll('.tg').forEach((b) => b.onclick = () => { settings[b.dataset.k] = !settings[b.dataset.k]; saveSettings(); b.classList.toggle('on', settings[b.dataset.k]); });
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => {
      s.querySelector('#storeInfo').textContent = `已使用空間 ${(e.usage / 1048576).toFixed(0)} MB`;
    });
  });
};

/* ---------- 啟動 ---------- */
renderHome();
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
