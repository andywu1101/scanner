/* 伍線譜樂譜掃描 — 主程式（內部資料名稱 cocoscan 維持不變，避免舊資料遺失） */
'use strict';
const APP_VER = '5.3.1'; // 完整版號，每次打包都要改（說明見「版本、更新日誌」那段）
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
    { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 55, lo: '柔', hi: '銳' }, { k: 'despeckle', name: '去雜點', min: 0, max: 100, def: 35, lo: '少', hi: '多' }, // 1.30 起 55／35（1.15～1.29 為 82／35，更早 35／20）
    { k: 'smooth', name: '邊緣平滑', min: 0, max: 100, def: 65, lo: '關', hi: '強' }], // 1.30 起 65（原 50）
  gray: [S_EXP, S_CON, { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 50, lo: '柔', hi: '銳' }],
  color: [S_EXP, S_CON, { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 50, lo: '柔', hi: '銳' }, S_SAT, S_TMP],
  original: [S_EXP, S_CON, { k: 'sharp', name: '銳利度', min: 0, max: 100, def: 0, lo: '柔', hi: '銳' }, S_SAT, S_TMP],
};
const MAX_PIXELS = 16000000; // iOS canvas 上限約 16.7M 像素
// 1.33：即時掃描存檔畫質依手機分檔（見 camTier）；1.10～1.32 是固定 1500 萬
const HAS_IC = 'ImageCapture' in window; // Android Chrome 有；新版 iPhone Safari 也開始有（1.21 起 iPhone 不用，見 startLive）

/* ---------- 設定 ---------- */
// 3.1：新使用者預設「稍後裁切」（立即裁切改成每張都進框選，連拍會變慢）；已經存過設定的老使用者維持原本的值。sound＝拍攝音效
const DEFAULTS = { mode: 'bw', pdfSize: 'a4', autoShutter: true, cropLater: false, autoAI: false, confirmCrop: true, upscale: 'auto', landscape: true, sound: true, countdown: true, v: 2 }; // 5.1.3：倒數拍攝預設開（手動關過的人維持關）；5.3.1：預設改回立即裁切（只影響新用戶，存過設定的人維持原本）
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
function procKey(p) { return JSON.stringify([p.mode, p.rotation || 0, p.corners, p.curve || null, pageAdjOf(p), settings.upscale, p.ai ? p.aiSide || 1 : 0]); }
// 1.29：沒有照片資料的壞頁面（弱手機轉檔失敗留下的）不處理，避免每個畫面一直跳錯誤
const isBroken = (p) => !(p && (p.lite ? p.liteOrig > 0 : p.original instanceof Blob && p.original.size > 0));
function isStale(p) { if (isBroken(p)) return false; return !(p.lite ? p.liteProc : p.processed) || p.pkey !== procKey(p); }
/* 5.2：輕量版頁面（作者：修正大量讀檔有可能閃退的問題）。資料庫一頁是一整筆，只能整筆讀出；文件畫面、主畫面最近掃描、匯出前的清單
   以前把每一頁整筆（原圖＋處理後大圖＋精修圖）同時讀進來而且一直留著（30 頁約 180 MB 以上），單頁檢視每滑一頁還整份重讀一次。
   改成：清單只留縮圖和設定（lite），大圖要用時（單頁檢視、裁切、調整、匯出、分享、AI）才讀那一頁，用完就放掉。
   lite 頁不能存回資料庫（packRec 會擋，免得把原圖蓋掉）；要改頁面一律重新整筆讀出來再存 */
const LITE_DROP = ['original', 'processed', 'plain', 'srBuf', 'sr'];
function liteOf(p) {
  if (!p) return p;
  const o = Object.assign({}, p);
  o.lite = true;
  o.liteOrig = p.original instanceof Blob ? p.original.size : 0;
  o.liteProc = p.processed instanceof Blob ? p.processed.size : 0;
  o.liteSr = p.srBuf instanceof ArrayBuffer ? p.srBuf.byteLength : 0;
  for (const k of LITE_DROP) delete o[k];
  if (!o.thumb && p.original instanceof Blob) o.original = p.original; // 還沒處理好、沒有縮圖：先用原圖當縮圖（處理完就換掉）
  return o;
}
const hasProc = (p) => !!(p && (p.lite ? p.liteProc : p.processed));
// 依順序讀一串頁面，同時最多讀 3 頁（一次全部讀會同時佔用全部頁面的記憶體）；full＝要完整資料
async function pagesOf(ids, full) {
  const out = new Array(ids.length); let k = 0;
  const work = async () => { while (k < ids.length) { const i = k++; const p = await DB.get('pages', ids[i]); out[i] = full ? p : liteOf(p); } };
  await Promise.all([work(), work(), work()]);
  return out.filter(Boolean);
}
function saveSettings() { try { localStorage.setItem('cocoscan-settings', JSON.stringify(settings)); } catch (_) {} }

/* ---------- IndexedDB ---------- */
const DB = {
  _db: null, _p: null, cleaned: 0, rebuilt: false,
  // 4.2.4：第一次開啟時先整理資料庫（dbMaint），其他地方都等整理完才讀寫，不會和拍照同時進行
  open() {
    if (this._db) return Promise.resolve(this._db);
    if (this._p) return this._p;
    this._p = (async () => {
      let d = await this._raw();
      try { d = await dbMaint(d); } catch (e) { console.warn('整理資料庫', e); }
      this._db = d; return d;
    })();
    this._p.catch(() => { this._p = null; });
    return this._p;
  },
  _raw() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('cocoscan', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('docs', { keyPath: 'id' });
        const p = d.createObjectStore('pages', { keyPath: 'id' });
        p.createIndex('docId', 'docId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  // 只取編號（不讀照片，幾乎不占記憶體）
  async keys(store) { return (await this.tx(store, 'readonly', (s) => s.getAllKeys())) || []; },
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
  if (v && v.lite) throw new Error('輕量版頁面不能存回資料庫'); // 5.2：防呆，避免把原圖蓋掉
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
/* 4.2.4 資料庫整理（打開 App 時做一次，在任何讀寫之前）：
   1. 孤兒頁面：頁面存進資料庫、還沒登記到文件就閃退，刪文件時刪不到，一直占空間。
      只刪「所屬文件已經不存在」的（用 docId 索引只看編號，不讀照片）；文件還在、只是沒登記進去的先不動（可能是意外遺失的頁），設定裡顯示數量
   2. 一份文件、一頁都沒有時，整個資料庫刪掉重建：Safari 刪資料後檔案不一定縮小，重建才會把空間還回來 */
function idbReq(q) { return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function dbMaint(d) {
  const t = d.transaction(['docs', 'pages'], 'readonly');
  const qDocs = idbReq(t.objectStore('docs').getAll()); // 兩個讀取同時送出，不在中間 await（舊版 Safari 會提早結束交易）
  const qPairs = new Promise((res, rej) => { // [頁面編號, 所屬文件]
    const out = [], q = t.objectStore('pages').index('docId').openKeyCursor();
    q.onsuccess = () => { const c = q.result; if (!c) { res(out); return; } out.push([c.primaryKey, c.key]); c.continue(); };
    q.onerror = () => rej(q.error);
  });
  const [docs, pairs] = await Promise.all([qDocs, qPairs]);
  const docIds = new Set(docs.map((x) => x.id));
  // 5.3：散頁（所屬文件還在、但文件的頁面清單裡沒有它）找回來，依拍攝時間放回去
  //   頁面編號開頭 8 碼是建立時間（uid），不用讀頁面資料；放在「建立時間比它早的最後一頁」後面（沒有就放最前面）
  //   所有刪除流程都是先刪頁面資料再改清單，所以刪掉的頁不會被找回來
  const tOf = (id) => parseInt(String(id).slice(0, 8), 36) || 0;
  const fixed = [];
  for (const doc of docs) {
    const listed = new Set(doc.pageIds);
    const loose = pairs.filter(([pid, did]) => did === doc.id && !listed.has(pid)).map(([pid]) => pid).sort((a, b) => tOf(a) - tOf(b));
    if (!loose.length) continue;
    const ids = doc.pageIds.slice();
    for (const pid of loose) {
      let at = 0;
      for (let i = 0; i < ids.length; i++) if (tOf(ids[i]) <= tOf(pid)) at = i + 1;
      ids.splice(at, 0, pid);
    }
    fixed.push(Object.assign({}, doc, { pageIds: ids }));
    DB.found = (DB.found || 0) + loose.length;
  }
  if (fixed.length) {
    const w = d.transaction('docs', 'readwrite'), st = w.objectStore('docs');
    for (const doc of fixed) st.put(doc);
    await new Promise((res, rej) => { w.oncomplete = res; w.onerror = () => rej(w.error); w.onabort = () => rej(w.error); });
  }
  const dead = pairs.filter(([, did]) => !docIds.has(did)).map(([pid]) => pid);
  if (dead.length) {
    const w = d.transaction('pages', 'readwrite'), st = w.objectStore('pages');
    for (const pid of dead) st.delete(pid);
    await new Promise((res, rej) => { w.oncomplete = res; w.onerror = () => rej(w.error); w.onabort = () => rej(w.error); });
    DB.cleaned = dead.length;
  }
  if (docs.length || pairs.length > dead.length) return d;
  // 完全沒有資料：刪掉重建
  d.close();
  await new Promise((res) => { const q = indexedDB.deleteDatabase('cocoscan'); q.onsuccess = q.onerror = q.onblocked = () => res(); setTimeout(res, 3000); });
  DB.rebuilt = true;
  return DB._raw();
}
// 設定畫面用：文件數、頁面數、沒登記到文件的頁數（只看編號）
async function storeCounts() {
  const docs = await DB.all('docs'), keys = await DB.keys('pages');
  const ref = new Set(); for (const x of docs) for (const id of x.pageIds) ref.add(id);
  return { docs: docs.length, pages: keys.length, loose: keys.filter((k) => !ref.has(k)).length };
}

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
    if (!(blob instanceof Blob) || !blob.size) { rej(new Error('這一頁沒有照片資料（拍攝失敗），請刪除後重拍')); return; }
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法讀取圖片')); };
    img.src = url;
  });
}
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toBlob(canvas, type, q) { return new Promise((r) => { try { canvas.toBlob(r, type, q); } catch (_) { r(null); } }); }
// 1.29：即時掃描存照片。Y31 等弱手機偶爾 toBlob 交回空的結果：先重試，再改用 dataURL，最後縮小 0.7 倍再試
async function canvasBlob(c) {
  if (!c || !c.width || !c.height) return null;
  let b = await toBlob(c, 'image/jpeg', 0.97);
  if (b && b.size) return b;
  blobStrain = true; // 1.33：第一次就失敗＝記憶體吃緊，之後自動降檔
  b = await toBlob(c, 'image/jpeg', 0.9);
  if (b && b.size) return b;
  try { const r = await fetch(c.toDataURL('image/jpeg', 0.9)); b = await r.blob(); if (b && b.size > 1000) return b; } catch (_) {}
  try {
    const s = canvasOf(Math.round(c.width * 0.7), Math.round(c.height * 0.7));
    s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    b = await toBlob(s, 'image/jpeg', 0.92); s.width = s.height = 0;
    if (b && b.size) return b;
  } catch (_) {}
  return null;
}
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
// 1.29：拍攝失敗的頁面沒有照片，縮圖改顯示提示圖
const BROKEN_IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="210" height="297" viewBox="0 0 210 297"><rect width="210" height="297" fill="#F3E3DE"/><text x="105" y="140" text-anchor="middle" font-family="sans-serif" font-size="26" font-weight="700" fill="#B4533F">拍攝失敗</text><text x="105" y="178" text-anchor="middle" font-family="sans-serif" font-size="19" fill="#B4533F">請刪除後重拍</text></svg>');
function blobUrl(key, blob, ver) {
  if (!(blob instanceof Blob)) return BROKEN_IMG;
  const old = urlCache.get(key);
  if (old && old.ver === ver) return old.url;
  if (old) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, { ver, url });
  return url;
}
const verOf = (p, field) => (p[field] || (p.lite && field === 'processed' && p.liteProc) ? field + (p.ver || 0) : 'o');
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
// 4.2.1：一次 AI 框選多頁時（按「完成」後、文件頁「AI 框選」）先暫停頁面處理，框完再處理。
// iPhone 一邊框選、一邊把整張照片解開拉正，記憶體疊加會閃退（作者實測 5 頁必閃退；等處理完再框就不會）。和拍攝用的 queueGate 分開
let batchGate = null, procNow = null;
async function holdQueue() {
  if (!batchGate) { let r; batchGate = new Promise((x) => { r = x; }); batchGate.release = r; }
  if (procNow) await procNow.catch(() => {}); // 正在處理的那一頁先做完
}
function releaseQueue() { if (batchGate) { const g = batchGate; batchGate = null; g.release(); } }
function enqueue(pageId) {
  procCount.set(pageId, (procCount.get(pageId) || 0) + 1);
  queue = queue.then(() => queueGate).then(() => batchGate).then(() => (procNow = processPageNow(pageId))).catch((e) => { console.error(e); toast('處理失敗：' + e.message); })
    .finally(() => { procCount.set(pageId, procCount.get(pageId) - 1); onPageUpdated(pageId); });
  return queue;
}
// 從一張圖（原照片或精修圖）拉正並套用這頁的模式、數值、轉向 → { processed, w, h, canvas }
async function procImage(page, src, corners, curve, upscale) {
  const d = await decodeFull(src);
  const r = await wcall('process', {
    buffer: d.data.buffer, width: d.width, height: d.height,
    corners, curve: curve || null, upscale,
    rotation: page.rotation || 0, mode: page.mode, params: pageAdjOf(page),
  }, [d.data.buffer]);
  const c = canvasOf(r.width, r.height);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
  const processed = page.mode === 'bw' ? await toBlob(c, 'image/png') : await toBlob(c, 'image/jpeg', 0.95);
  return { processed, w: r.width, h: r.height, c };
}
const plainKeyOf = (p) => procKey(Object.assign({}, p, { ai: false })); // 這頁「沒精修」時的成品身分
async function processPageNow(pageId) {
  const page = await DB.get('pages', pageId);
  if (!page || isBroken(page) || !isStale(page)) return;
  const key = procKey(page);
  await whenReady();
  // 4.1：AI 精修的頁先確定有精修圖（拉正＋精修，和模式、調整數值無關，只看框），再從精修圖套用模式
  let sr = page.ai ? await srEnsurePage(page) : null;
  if (page.ai && !sr) return; // 精修被取消（使用者關掉）：等下一次處理
  let res;
  if (sr) {
    try { res = await procImage(page, sr.blob, sr.corners, sr.curve, 'off'); }
    catch (e) {
      // 4.1.2：精修圖讀不出來（iPhone 曾在關掉再打開時出現「無法讀取圖片」）：丟掉精修圖、重新精修一次，不跳錯誤
      console.warn('精修圖讀取失敗，重新精修', e);
      const lp = await DB.get('pages', pageId); if (lp) { srDrop(lp); await DB.put('pages', lp); }
      srDrop(page);
      sr = await srEnsurePage(page);
      if (!sr) return;
      res = await procImage(page, sr.blob, sr.corners, sr.curve, 'off');
    }
  } else res = await procImage(page, page.original, page.corners, page.curve, settings.upscale);
  const { processed, c } = res;
  const ts = Math.min(1, 420 / Math.max(res.w, res.h));
  const t = canvasOf(Math.round(res.w * ts), Math.round(res.h * ts));
  const tctx = t.getContext('2d'); tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(c, 0, 0, t.width, t.height);
  const thumb = await toBlob(t, 'image/jpeg', 0.85);
  c.width = c.height = 0;
  // 4.1.2：精修的頁另外留一份「精修前」的成品，單頁畫面按住可以比較
  let plain = null; const pk = plainKeyOf(page);
  if (sr && page.plainKey !== pk) { try { const q = await procImage(page, page.original, page.corners, page.curve, settings.upscale); q.c.width = q.c.height = 0; plain = q.processed; } catch (e) { console.warn('精修前成品', e); } }
  // 期間可能被修改或刪除，重新讀取
  const latest = await DB.get('pages', pageId);
  if (!latest) return;
  if (procKey(latest) !== key) return;
  latest.pkey = key;
  latest.processed = processed; latest.thumb = thumb; latest.ver = (latest.ver || 0) + 1; latest.outW = res.w; latest.outH = res.h;
  if (plain) { latest.plain = plain; latest.plainKey = pk; }
  await DB.put('pages', latest);
}
async function waitQueue() { await queue; }
// 舊頁面不主動重算，打開或匯出時才依目前的數值更新
function ensureFresh(pages) {
  for (const p of pages) {
    // 1.29：拍攝失敗的頁沒辦法裁切，拿掉 ✂ 標記（只能刪除重拍）
    if (p && isBroken(p) && p.needCrop) { delete p.needCrop; DB.get('pages', p.id).then((q) => { if (q) { delete q.needCrop; return DB.put('pages', q); } }).catch(() => {}); } // 5.2：重新整筆讀出再存
    if (p && isStale(p) && !processing.has(p.id)) enqueue(p.id);
  }
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
  // 1.30 黑白出廠值改成銳利度 55、邊緣平滑 65（原 82／50，iPhone 即時掃描會有鋸齒）：已有的文件與單頁把沒設定過的這兩項固定成舊值，看起來不變
  const fix130 = !settings.adjFix130;
  for (const d of await DB.all('docs')) {
    let dirty = false;
    if (!d.adj) { d.adj = cloneAdj(settings.adj); dirty = true; }
    if (fix130) {
      const b = d.adj.bw = d.adj.bw || {};
      if (b.sharp === undefined && !fix115) { b.sharp = 82; dirty = true; } // 1.15 以前的文件下面會固定成 35
      if (b.smooth === undefined) { b.smooth = 50; dirty = true; }
    }
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
    // 單頁設定一般存完整數值；萬一有缺，也固定成舊值（5.2.1：一頁一頁讀，不再一次讀全部頁面）
    for (const id of await DB.keys('pages')) {
      const p = await DB.get('pages', id); if (!p) continue;
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
  if (fix130) {
    for (const id of await DB.keys('pages')) { // 5.2.1：一頁一頁讀
      const p = await DB.get('pages', id); if (!p) continue;
      const b = p.adj && p.adj.bw;
      if (b && (b.sharp === undefined || b.smooth === undefined)) {
        if (b.sharp === undefined) b.sharp = 82;
        if (b.smooth === undefined) b.smooth = 50;
        await DB.put('pages', p);
      }
    }
    settings.adjFix130 = true; saveSettings();
  }
}
/* 5.3：散頁（作者回報：設定裡算得到、文件裡看不到、刪文件也刪不掉的頁）。原因：存一頁是「存頁面 → 讀文件 → 頁面清單加一頁 → 存回文件」，
   兩頁幾乎同時存（連拍、匯入多張）時兩邊讀到同一份舊清單，後存的蓋掉先存的。所有「讀文件 → 改頁面清單 → 存回」都排進 docEdit 這條隊伍，
   一個做完才做下一個（新增、刪除、重拍、排序）。已經變成散頁的，打開 App 時 dbMaint 找回來（見上面） */
let docQ = Promise.resolve();
function docEdit(fn) { const job = docQ.then(fn); docQ = job.catch(() => {}); return job; }
async function addPage(docId, blob, corners, curve, needCrop, rotation) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error('照片沒有存成功，請再拍一次');
  const page = { id: uid(), docId, original: blob, corners, curve: curve || null, rotation: rotation || 0, mode: settings.mode, created: Date.now() };
  if (needCrop) page.needCrop = true; // 1.19：即時掃描時要自己裁切、還沒裁的頁
  await DB.put('pages', page);
  await docEdit(async () => {
    const doc = await DB.get('docs', docId);
    doc.pageIds.push(page.id); doc.updated = Date.now();
    await DB.put('docs', doc);
  });
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
  if (name !== 'doc' && name !== 'home') { const ub = document.getElementById('undoBar'); if (ub) ub.classList.remove('show'); } // 還原列只在文件頁、首頁顯示
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
  if (capRes.resolve && !capRes.flying) { $('#capRes').classList.remove('on'); capRes.resolve('back'); } // 3.1 成品畫面按返回鍵＝當作確定（頁面已經存好）
  if (current === 'crop' && cropCtx && cropCtx.onCancel) { const f = cropCtx.onCancel; cropFree(cropCtx); cropCtx = null; f(true); } // 4.2.3：返回鍵離開也放掉大圖
  closeSheet();
  if (s === 'cover') { show('cover'); }
  else if (s === 'home') { renderHome(); show('home'); }
  else if (s === 'doc') { state.docId = e.state.doc; renderDoc(); show('doc'); }
  else if (s === 'library') { renderLibrary(); show('library'); }
  else if (s === 'burst') { show('burst'); renderBurst(); }
  else if (s === 'live' && live.running) { show('live'); liveResume(); }
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
let sheetOpenAt = 0;
function openSheet(html, bind) {
  sheetOpenAt = Date.now();
  $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  $('#sheetWrap').classList.add('show');
  if (bind) bind($('#sheet'));
}
let sheetOnClose = null;
function closeSheet() { $('#sheetWrap').classList.remove('show'); const f = sheetOnClose; sheetOnClose = null; if (f) f(); }
// 1.31：App 內的確認視窗（iPhone 跳出系統 confirm 時會中斷相機）。回傳 true＝按了確定
function askSheet(title, msg, okText, cancelText) {
  return new Promise((res) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; res(v); };
    openSheet(`<h3>${title}</h3><div class="note" style="margin:2px 4px 14px;font-size:14.5px;line-height:1.6">${msg}</div>
      <button class="bigbtn" id="askOk" style="width:100%">${okText || '確定'}</button>
      <button class="bigbtn alt" id="askNo" style="width:100%;margin-top:8px">${cancelText || '取消'}</button>`, (s) => {
      s.querySelector('#askOk').onclick = () => { sheetOnClose = null; closeSheet(); fin(true); };
      s.querySelector('#askNo').onclick = () => { sheetOnClose = null; closeSheet(); fin(false); };
    });
    sheetOnClose = () => fin(false);
  });
}
// 3.1.3：剛打開 0.4 秒內點到背景不關（新增頁面那一格在手指放開時就打開選單，接著的點擊會落在背景上）
$('#sheetWrap').addEventListener('click', (e) => { if (e.target.id === 'sheetWrap' && Date.now() - sheetOpenAt > 400) closeSheet(); });

const ICON = {
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
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
  const pages = await pagesOf(doc.pageIds); // 5.2：輕量版
  // 正在改名時不要重畫，避免打斷輸入
  const active = document.activeElement;
  if (active && active.id === 'recentName' && body.dataset.doc === doc.id) { updateHomeStrip(pages); return; }
  body.dataset.doc = doc.id;
  body.innerHTML = `
    <div class="sec">最近掃描</div>
    <div class="recent">
      <label class="rname">${ICON.edit}<input id="recentName" type="text" enterkeyhint="done" autocomplete="off" aria-label="文件名稱"></label>
      <div class="rmeta">${pages.length} 頁・${fmtDate(doc.updated)}${pages.some((p) => p.needCrop) ? `・<span class="w">✂ ${pages.filter((p) => p.needCrop).length} 頁待裁切</span>` : ''}</div>
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
  // 5.1.9：點卡片空白處也開啟文件（名稱、縮圖、按鈕維持原本功能）
  body.querySelector('.recent').onclick = (e) => { if (!e.target.closest('input, label, button')) openDoc(doc.id); };
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
    b.innerHTML = `<div class="card" style="${cardStyle(p)}"><img src="${blobUrl('strip:' + p.id, src, verOf(p, 'thumb'))}" alt=""><span>${i + 1}</span>${p.needCrop ? '<i class="cut">✂</i>' : ''}${!isBroken(p) && (!p.thumb || processing.has(p.id)) ? '<i class="spin sm"></i>' : ''}</div>`;
    b.onclick = async () => {
      state.docId = docId; await renderDoc();
      history.pushState({ s: 'doc', doc: docId }, '');
      state.pageIndex = i; renderPage(); go('page');
      if (p.needCrop) openPageCropSoon(p.id);
    };
    strip.appendChild(b);
  });
}

/* ---------- 全部文件（多選、合併、刪除） ---------- */
const lib = { selecting: false, order: [] };
/* 4.2.4：原本每次重畫（打開、點選、全選）都 DB.all('pages') 一次把所有頁（含原圖、成品，存成 ArrayBuffer、讀出來整份在記憶體）
   讀進來，作者全選幾十頁就閃退。改成打開時一頁一頁讀，只留第一頁縮圖和待裁切頁數（libLoad）；點選、全選只用留下的資料重畫（libPaint） */
async function renderLibrary() { await libLoad(); libPaint(); }
async function libLoad() {
  lib.docs = (await DB.all('docs')).sort((a, b) => b.updated - a.updated);
  lib.info = new Map();
  for (const doc of lib.docs) {
    let first = null, need = 0;
    for (const pid of doc.pageIds) {
      const p = await DB.get('pages', pid); if (!p) continue;
      if (!first) first = { id: p.id, th: p.thumb || p.original, ver: verOf(p, 'thumb') };
      if (p.needCrop) need++;
    }
    lib.info.set(doc.id, { first, need });
  }
}
function libPaint() {
  const docs = lib.docs || [];
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
  list.innerHTML = '';
  list.classList.toggle('selecting', lib.selecting);
  for (const doc of docs) {
    const inf = lib.info.get(doc.id) || {}, first = inf.first;
    const b = document.createElement('button');
    const n = lib.order.indexOf(doc.id);
    b.className = 'doc' + (n >= 0 ? ' sel' : '');
    const th = first && first.th;
    b.innerHTML = `<div class="th">${th ? `<img src="${blobUrl('lib:' + first.id, th, first.ver)}" alt="">` : ''}<span class="n">${doc.pageIds.length} 頁</span>${inf.need ? `<span class="w">✂ ${inf.need} 頁待裁切</span>` : ''}<span class="ck">${n >= 0 ? n + 1 : ''}</span></div><div class="meta"><div class="t"></div><div class="d">${fmtDate(doc.updated)}</div></div>`;
    b.querySelector('.t').textContent = doc.title;
    b.onclick = () => {
      if (!lib.selecting) { openDoc(doc.id); return; }
      const i = lib.order.indexOf(doc.id);
      if (i >= 0) lib.order.splice(i, 1); else lib.order.push(doc.id);
      libPaint();
    };
    list.appendChild(b);
  }
}
$('#libBack').onclick = () => history.back();
$('#libSelect').onclick = () => { lib.selecting = !lib.selecting; lib.order = []; libPaint(); };
$('#libAll').onclick = () => {
  const docs = lib.docs || [];
  lib.order = lib.order.length === docs.length ? [] : docs.map((d) => d.id);
  libPaint();
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
function openCamera() { sfxPrime(); const i = $('#fileCamera'); i.value = ''; i.click(); } // 3.1.6：點擊當下啟動聲音（連拍畫面的掃描音效）
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
const burst = { docId: null, fromDoc: false, onStack: false, count: 0, lastPageId: null, fresh: false, shownKey: null, tok: 0, sw: null, ar: 0 };
function startBurst(docId) {
  Object.assign(burst, { docId, fromDoc: !!docId, onStack: false, count: 0, lastPageId: null });
}
async function burstAdd(blob, corners, curve, rotation) {
  if (!burst.docId) burst.docId = (await createDoc()).id;
  const page = await addPage(burst.docId, blob, corners, curve, false, rotation || 0);
  burst.count++; burst.lastPageId = page.id; burst.fresh = true;
  return page;
}
function toBurst() {
  if (current === 'burst') { renderBurst(); return; }
  if (current === 'crop' && burst.onStack) { history.back(); return; } // popstate 會 show＋renderBurst
  if (current === 'crop') history.replaceState({ s: 'burst' }, ''); else history.pushState({ s: 'burst' }, '');
  burst.onStack = true;
  show('burst'); // 3.1.6：先顯示再畫成品（要量得到畫面大小）
  renderBurst();
}
async function renderBurst() {
  $('#burstCount').textContent = burst.count ? `已拍 ${burst.count} 張` : '尚未拍攝';
  $('#burstConfirm').classList.toggle('on', settings.confirmCrop);
  $('#burstRetake').disabled = $('#burstEdit').disabled = !burst.lastPageId;
  if (!burst.lastPageId) { burst.tok++; if (burst.sw) { burst.sw.stop(); burst.sw = null; } burst.shownKey = null; $('#burstPw').style.visibility = 'hidden'; $('#burstSpin').classList.remove('on'); return; }
  const p = await DB.get('pages', burst.lastPageId);
  if (!p) return;
  const key = p.id + procKey(p);
  if (key === burst.shownKey) { burstLayout(); return; } // 同一張、沒改過（例如框選畫面按取消回來）：不重播
  burst.shownKey = key;
  const anim = burst.fresh && animOn(); burst.fresh = false;
  burstShow(p, anim);
}
// 3.1.6：連拍畫面顯示「成品」（框選拉正＋目前模式），不再顯示原始照片。
// 有動畫時沿用即時掃描成品畫面（#capRes）的做法：先畫原色拉正的底圖，金色掃描光往下刷出成品，加掃描音效
function burstLayout() {
  const ar = burst.ar; if (!ar) return;
  const r = $('#burstStage').getBoundingClientRect(), m = 18;
  const w = Math.max(1, Math.min(r.width - 2 * m, (r.height - 2 * m) * ar)), h = w / ar;
  Object.assign($('#burstPw').style, { left: (r.width - w) / 2 + 'px', top: (r.height - h) / 2 + 'px', width: w + 'px', height: h + 'px' });
}
async function burstShow(p, anim) {
  const pw = $('#burstPw'), base = pw.querySelector('.cr-base'), outC = pw.querySelector('.cr-out');
  const clip = pw.querySelector('.cr-clip'), band = pw.querySelector('.cr-band'), spin = $('#burstSpin');
  const tok = ++burst.tok; if (burst.sw) { burst.sw.stop(); burst.sw = null; }
  const alive = () => tok === burst.tok;
  pw.style.visibility = 'hidden'; bandInit(band); clip.style.opacity = ''; clip.style.transition = ''; spin.classList.add('on');
  pauseQueue(); // 先讓成品出來，背景的整頁處理稍後再跑
  try {
    await whenReady();
    const { img, url } = await loadImg(p.original);
    const f0 = anim ? smallFrame(img, 900) : null, f1 = smallFrame(img, 2000); URL.revokeObjectURL(url);
    const job = (f, mode, params) => wcall('process', { buffer: f.data.buffer, width: f.width, height: f.height, corners: p.corners, curve: p.curve || null, upscale: 'off', rotation: p.rotation || 0, mode, params }, [f.data.buffer]);
    if (anim) {
      const r0 = await job(f0, 'original', fillAdj('original'));
      if (!alive()) return;
      drawTo(base, r0); burst.ar = r0.width / r0.height; burstLayout();
      clip.style.clipPath = 'inset(0 0 100% 0)'; pw.style.visibility = 'visible'; spin.classList.remove('on');
      burst.sw = sweepRun('res', 1200, (q, f) => { bandAtPct(band, q, f); if (f) clip.style.clipPath = `inset(0 0 ${(1 - q) * 100}% 0)`; }, band);
    }
    const r = await job(f1, p.mode, pageAdjOf(p));
    if (!alive()) return;
    drawTo(outC, r); spin.classList.remove('on');
    if (!anim) {
      base.width = base.height = 1; burst.ar = r.width / r.height; burstLayout();
      clip.style.clipPath = 'none'; band.style.display = 'none'; pw.style.visibility = 'visible'; return;
    }
    // 4.0：已掃過的部分淡入成品，剩下的跟著掃描光刷出來，到底「叮」
    const sw = burst.sw;
    clip.style.clipPath = `inset(0 0 ${(1 - sw.p) * 100}% 0)`; clip.style.opacity = 0; clip.style.transition = 'opacity .2s';
    requestAnimationFrame(() => { clip.style.opacity = 1; });
    await sw.done();
    if (!alive()) return;
    burst.sw = null; band.style.display = 'none'; clip.style.clipPath = 'none'; clip.style.transition = '';
  } catch (e) {
    console.warn('burst result', e);
    if (alive()) { if (burst.sw) { burst.sw.stop(); burst.sw = null; } spin.classList.remove('on'); clip.style.clipPath = 'none'; clip.style.opacity = ''; band.style.display = 'none'; pw.style.visibility = 'visible'; }
  } finally { if (alive()) resumeQueue(); }
}
$('#burstNext').onclick = () => openCamera();
// 3.1.6：繼續編輯上一張：回到框選畫面，確定後重新顯示成品（含動畫）
$('#burstEdit').onclick = async () => {
  if (!burst.lastPageId) return;
  const p = await DB.get('pages', burst.lastPageId); if (!p) return;
  openCrop({
    blob: p.original, corners: p.corners, curve: p.curve || null, rotation: p.rotation || 0,
    onConfirm: async (c, cv, edited, rot) => {
      sfxPrime();
      const q = await DB.get('pages', p.id);
      if (q) { q.corners = c; q.curve = cv; q.rotation = rot; if (edited) q.cropUser = true; await DB.put('pages', q); enqueue(q.id); burst.fresh = true; }
      toBurst();
    },
  });
};
$('#burstConfirm').onclick = () => { settings.confirmCrop = !settings.confirmCrop; saveSettings(); renderBurst(); };
$('#burstRetake').onclick = async () => {
  openCamera();
  if (!burst.lastPageId) return;
  // 5.3：排隊；先刪頁面再改清單（反過來的話中途關掉，留下的頁會被當散頁找回來）
  const doc = await docEdit(async () => {
    await DB.del('pages', burst.lastPageId);
    const d = await DB.get('docs', burst.docId);
    d.pageIds = d.pageIds.filter((id) => id !== burst.lastPageId);
    await DB.put('docs', d);
    return d;
  });
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

// 4.1.6：3.1.7 的自動轉正（看線條方向，躺著就順時針轉 90 度）拿掉：作者實測仍有誤轉，框選畫面已有「向右轉」
// 3.0.1：高畫質拍照、相簿匯入也跟著「自動 AI 框選」開關（開著而且 AI 已下載才用）。
// 回傳 { corners, curve }；AI 判斷不適合或失敗回傳 { fail, msg }（呼叫的地方保留一般偵測的框）
async function aiAutoOn() { return !!settings.autoAI && (await aiCached()); }
async function aiCorners(blob) {
  try {
    const { img, url } = await loadImg(blob);
    let r = null;
    try { r = await aiFrame(img); } finally { URL.revokeObjectURL(url); }
    if (!r || !r.corners) return { fail: 'reject', msg: r && r.reject };
    return { corners: r.corners, curve: r.curve ? normCurve(r.corners, r.curve) : null, teed: teedNote(r) };
  } catch (e) { console.warn('auto AI', e); return { fail: 'error', msg: e && e.message ? e.message : String(e) }; }
}
$('#fileCamera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  busy('偵測文件邊框…');
  let blob, corners, curve = null;
  try { blob = await stableBlob(file); corners = await detectBlob(blob); }
  catch (err) { unbusy(); toast(err.message); return; }
  if (await aiAutoOn()) {
    busy('AI 框選中…');
    const r = await aiCorners(blob);
    if (r.corners) { corners = r.corners; curve = r.curve; if (r.teed && teedMarkOn()) toast(r.teed); }
    else toast(r.fail === 'reject' ? 'AI 判斷不適合，保留原框' : 'AI 框選失敗：' + (r.msg || '未知原因'));
  }
  unbusy();
  if (settings.confirmCrop) {
    openCrop({
      blob, corners, curve, retake: true, burst: true,
      onConfirm: async (c, cv, edited, rot) => { sfxPrime(); const pg = await burstAdd(blob, c, cv, rot); if (edited) { pg.cropUser = true; await DB.put('pages', pg); } toBurst(); },
      onRetake: () => openCamera(),
    });
  } else {
    await burstAdd(blob, corners, curve);
    toBurst();
    toast(`已加入第 ${burst.count} 張`);
  }
});

$('#fileGallery').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  let docId = cameraTarget;
  if (!docId) docId = (await createDoc()).id;
  const useAI = await aiAutoOn();
  let rejected = 0, aiErr = null, tdone = 0;
  // 4.2.2：開著自動 AI 框選時，和 4.2.1 的批次框選一樣先暫停頁面處理、全部框完再處理（相簿照片解析度高，一邊框一邊處理容易閃退）
  if (useAI) { busy(`AI 框選中 1 / ${files.length}`); await holdQueue(); aiBatchMark(true); }
  try {
  for (let i = 0; i < files.length; i++) {
    busy(`${useAI ? 'AI 框選中' : '匯入中'} ${i + 1} / ${files.length}`);
    try {
      const blob = await stableBlob(files[i]);
      let c = await detectBlob(blob), cv = null;
      if (useAI) {
        const r = await aiCorners(blob);
        if (r.corners) { c = r.corners; cv = r.curve; if (r.teed) tdone++; } else if (r.fail === 'reject') rejected++; else aiErr = aiErr || r.msg || '未知原因';
      }
      await addPage(docId, blob, c, cv);
    } catch (err) { toast(err.message); }
  }
  } finally { if (useAI) { aiBatchMark(false); releaseQueue(); aiReleaseSoon(); } }
  unbusy();
  openDoc(docId, current !== 'doc');
  if (aiErr) toast('AI 框選失敗：' + aiErr);
  else if (rejected) toast((files.length === 1 ? 'AI 判斷不適合，保留原框' : `${rejected} 張 AI 判斷不適合，保留原框`) + teedCount(tdone));
  else if (teedCount(tdone)) toast(`AI 框選完成${teedCount(tdone)}`); // 5.0
});

/* ---------- 即時掃描 ---------- */
const live = { running: false };
const STABLE_MS = 1000;  // 鎖定後大致不動多久就拍（5.1.3：作者覺得 0.5 秒太突然、聚焦圓環來不及顯示，iPhone、Android 都改 1 秒）
const STABLE_TOL = 0.05;  // 容許的手抖（畫面比例；1.21 從 3% 放寬，作者覺得拿穩了還是拍不下去）
const EDGE_MARGIN = 0.01; // 紙張四角至少離畫面邊緣 1%（1.4～1.15 是 3%，作者覺得要拿太遠，1.16 放寬）
async function startLive(docId) {
  sfxPrime(); // 3.1：在點擊的當下啟動聲音（iPhone 規定）
  if (landOn()) motionStart(); else if (motion.on) motionStop(); // 1.37：只有 Android 用感應器（設定可關）
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('此瀏覽器不支援即時相機，請改用「高畫質拍照」'); return;
  }
  Object.assign(live, {
    running: true, docId, fromDoc: !!docId, count: 0, stream: null, track: null, ic: null, lastQuad: null, shown: null,
    hist: [], miss: 0, armed: true, capturedQuad: null, capturedSig: null, capturing: false, detecting: false, lastCapT: 0, progress: 0, paused: false,
    aiLater: [], lastRes: null, lastPageId: null, deferring: false, deferDone: null, finishing: false, camOff: false,
    seenT: performance.now(), idleT0: performance.now(), tipOn: false, // 4.1.7
    teedOK: false, teedBusy: false, teedNext: 0, teedErr: 0, capSrc: null, tT0: null, tCapped: false, tCapSig: null, // 4.3
    cd: null, cdT0: null, cdBlock: null, cdPrev: null, cdNext: 0, cdBase: 0, // 5.1；5.1.4 cdBase
  });
  aiHas([TEED_FILE]).then((ok) => {
    if (!live.running) return;
    live.teedOK = ok;
    // 5.3：先暖機 TEED（載入模型＋跑一次小圖），第一次真的要用時（確認碰邊的框）才不會等太久
    if (ok && !live.teedWarm) { const b = new Uint8ClampedArray(64 * 48 * 4).fill(128).buffer; aiCall({ type: 'teed', buffer: b, width: 64, height: 48 }, [b]).then(() => { live.teedWarm = true; }).catch(() => {}); }
  }); // 4.3：有 TEED 才有即時後援
  aiErrShown = false; aiTag(aiPend ? 'AI ' + aiPend : '', !!aiPend);
  pauseQueue(); // 掃描期間暫停高解析度處理，讓抓邊保持流暢
  resetLock();
  $('#liveThumb').style.visibility = 'hidden';
  updateLiveBtns();
  torchOn = false; $('#torchBtn').classList.remove('on');
  setRing(0);
  go('live');
  applyUiRot();
  try {
    // 1.21：iPhone 不另外拍照（ImageCapture 的 takePhoto 要等約 1 秒，作者覺得太慢、常想先拿走），
    // 改回直接存畫面那一格（瞬間完成），所以預覽解析度要求最高；Android 維持另外拍照
    const useIC = HAS_IC && !IS_IOS;
    // 1.34：iPhone 還沒設定「相機永遠允許」時，開相機會跳詢問；查權限（查不到就看開相機花多久）決定要不要顯示短提示
    // 1.34.1：Safari 回報的權限不一定準（iOS 曾有不管實際狀態都回報 prompt 的紀錄），所以還要「開相機真的花了時間」＝真的跳了詢問：
    //   查得到且是 prompt → 開相機超過 0.5 秒才顯示；查不到 → 超過 1 秒才顯示（避免舊手機開相機本來就慢而誤判）
    const aiAsk = await aiDefaultCheck(); // 2.1：自動 AI 框選預設開啟（第一次進拍攝畫面詢問下載）
    let camPerm = null;
    if (IS_IOS) { try { camPerm = (await navigator.permissions.query({ name: 'camera' })).state; } catch (_) {} }
    const camT0 = performance.now();
    const stream = await navigator.mediaDevices.getUserMedia(camConstraints(useIC));
    const camDt = performance.now() - camT0;
    // 2.1：同一次要詢問 AI 下載時不顯示相機提示（一次只出現一個要讀的東西，下次進來才輪到它）
    if (!aiAsk && IS_IOS && ((camPerm === 'prompt' && camDt > 500) || (camPerm === null && camDt > 1000))) showCamTip();
    if (!live.running) { stream.getTracks().forEach((t) => t.stop()); return; }
    live.stream = stream;
    live.track = stream.getVideoTracks()[0];
    const v = $('#video');
    v.srcObject = stream;
    await v.play().catch(() => {});
    if (IS_IOS) fixVideoSoon(400); // 3.1.1：從文件頁重新開啟時相機畫面可能被畫小
    try {
      const caps = live.track.getCapabilities ? live.track.getCapabilities() : {};
      $('#torchBtn').style.display = caps.torch ? '' : 'none';
      if (caps.focusMode && caps.focusMode.includes('continuous')) live.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    } catch (_) {}
    live.photoSettings = null;
    if (useIC) {
      try {
        live.ic = new ImageCapture(live.track);
        setPhotoSettings();
      } catch (_) {}
    }
    // 1.33：左下角只顯示存檔的畫質（作者：寫預覽解析度會讓人誤會）
    v.onloadedmetadata = updResChip; updResChip();
    if (!settings.autoShutter) manualHint(); else setHint(workerReady ? '將文件放進畫面中' : '影像引擎載入中…');
    whenReady().then(() => { if (live.running && settings.autoShutter) setHint('將文件放進畫面中'); });
    liveLoop();
    requestAnimationFrame(drawOverlay);
    if (aiAsk) { live.paused = true; setTimeout(aiAsk === 'up' ? aiUpAskNow : aiAskNow, 1000); } // 相機畫面出來、系統權限詢問結束後再等 1 秒；問完之前先不自動拍
  } catch (err) {
    console.error(err);
    stopLive();
    history.back();
    toast(err.name === 'NotAllowedError' ? '未取得相機權限' : '無法開啟相機：' + err.message);
  }
}
// Android（有 ImageCapture）另外用 takePhoto 拍照，預覽只用來找紙，要 1920×1440 就夠，弱手機偵測才跟得上（1.10）
// iPhone（1.21 起不用 ImageCapture）存下來的就是預覽那一格，所以要求最高解析度
// 1.33 即時掃描畫質分檔：settings.camQ＝'auto'｜'high'｜'low'；settings.camAutoLow＝曾經記憶體不足、自動降成省記憶體
// 自動：iPhone 高檔（網頁相機串流上限約 1200 萬）；Android 依 navigator.deviceMemory（只有 Chrome 有，最多報 8）≥8 高、≥4 中、<4 省，讀不到當中
function camTier() {
  const q = settings.camQ || 'auto';
  if (q === 'high') return 'high';
  if (q === 'low') return 'low';
  if (settings.camAutoLow) return 'low';
  if (IS_IOS) return 'high';
  const dm = navigator.deviceMemory;
  if (!dm) return 'mid';
  return dm >= 8 ? 'high' : dm >= 4 ? 'mid' : 'low';
}
const tierMP = (t) => (t === 'high' ? (IS_IOS ? 12 : 16) : t === 'mid' ? 12 : 8); // 萬畫素 ÷ 100
const photoCap = () => tierMP(camTier()) * 1e6;
const TIER_NAME = { high: '高', mid: '中', low: '省記憶體' };
const mpText = (w, h) => Math.round((w * h) / 1e5) * 10; // 例：3024×4032 → 1220（萬畫素）
function updResChip() {
  const v = $('#video'), el = $('#resChip');
  if (live.lastRes) { el.textContent = `已拍 ${live.lastRes[0]}×${live.lastRes[1]}（${mpText(...live.lastRes)} 萬畫素）`; return; }
  const cap = photoCap();
  if (live.ic) el.textContent = `畫質最高 ${cap / 1e4} 萬畫素`;
  else if (v.videoWidth) el.textContent = `畫質約 ${Math.min(mpText(v.videoWidth, v.videoHeight), cap / 1e4)} 萬畫素`;
  else el.textContent = '';
}
// 存照片時記憶體吃緊（canvasBlob 第一次就失敗）：自動降成省記憶體並記住（只在「自動」時）
let blobStrain = false;
function noteStrain() {
  if (!blobStrain) return;
  blobStrain = false;
  if ((settings.camQ || 'auto') !== 'auto' || settings.camAutoLow || camTier() === 'low') return;
  settings.camAutoLow = true; saveSettings();
  toast('這支手機記憶體較少，已改用省記憶體畫質');
  if (live.ic) live.photoSettings = null, setPhotoSettings();
  updResChip();
}
function setPhotoSettings() {
  if (!live.ic) return;
  // 拍照尺寸：請相機用不超過上限的大小拍（手機不支援時會選最接近的，拍完再縮）
  live.ic.getPhotoCapabilities().then((pc) => {
    const W = pc.imageWidth, H = pc.imageHeight, cap = photoCap();
    if (!W || !H || !W.max || !H.max || W.max * H.max <= cap) { live.photoSettings = null; return; }
    const s = Math.sqrt(cap / (W.max * H.max));
    live.photoSettings = { imageWidth: Math.floor(W.max * s), imageHeight: Math.floor(H.max * s) };
  }).catch(() => {});
}
function camConstraints(useIC) {
  return {
    audio: false,
    video: useIC
      ? { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
  };
}
// 1.31：重新開一次相機（iPhone 下載 AI 資料後相機畫面會凍結）；已拍的頁與文件保留，失敗就結束掃描
async function restartCamera() {
  if (!live.running) return;
  try {
    if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
    const useIC = HAS_IC && !IS_IOS;
    const stream = await navigator.mediaDevices.getUserMedia(camConstraints(useIC));
    if (!live.running) { stream.getTracks().forEach((t) => t.stop()); return; }
    live.stream = stream; live.track = stream.getVideoTracks()[0];
    if (useIC) { try { live.ic = new ImageCapture(live.track); setPhotoSettings(); } catch (_) {} }
    const v = $('#video');
    v.style.display = 'none'; void v.offsetHeight; v.style.display = '';
    v.srcObject = null; v.srcObject = stream;
    await v.play().catch(() => {});
    reapplyTorch();
    live.armed = true; resetLock();
  } catch (e) {
    console.warn('restartCamera', e);
    toast('相機無法重新開啟，已結束掃描'); finishLive();
  }
}
/* 3.1.5：立即裁切等 AI、框選、看成品時暫停相機（作者：舊手機 AI 框選要等很久，相機一直開著）。
   不是關掉：相機軌道停止送畫面（track.enabled＝false）、播放器暫停、偵測與綠框重畫停止，權限與連線保留，
   回來不會重新詢問權限、幾乎不用等。回到拍攝畫面（liveResume）時恢復，並換一個新的影片元素（3.1.2，避免畫面縮小） */
function camPause() {
  if (!live.running || live.camOff) return;
  live.camOff = true;
  try { if (live.track) live.track.enabled = false; } catch (_) {}
  try { $('#video').pause(); } catch (_) {}
}
function camResume() {
  if (!live.camOff) return;
  live.camOff = false;
  try { if (live.track) live.track.enabled = true; } catch (_) {}
}
function stopLive() {
  live.running = false; live.camOff = false; live.tipOn = false; tipSync();
  if (live.teedOK) aiReleaseSoon(); // 4.3：即時 TEED 用過，離開後釋放 AI 引擎
  clearTimeout(camTipT); $('#camTip').classList.remove('show');
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.stream = null;
  $('#video').srcObject = null;
  shotFx('');
  resumeQueue();
}
function setHint(t, good) { const h = $('#hint'); if (h.textContent !== t) h.textContent = t; h.classList.toggle('on', !!good); h.style.visibility = ''; }
function hideHint() { $('#hint').style.visibility = 'hidden'; }
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
  Object.assign(live, { sus: false, susT0: 0, tChk: null, tChkN: 0, edgeT0: 0, cand: [], tCand: [], lockSrc: null, acc: [], lockQ: null, outliers: 0, miss: 0, anchorQ: null, stableSince: 0, progress: 0, best: null, prevQs: null, lastQs: null, edge: false, motionHits: 0, moveHits: 0 });
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
const MOTION_TOL = 0.5;   // 倒數期間紙內容的變化上限（超過代表有手或東西在動；1.21 從 0.35 放寬）
const CHANGE_TOL = 0.45;  // 與上一張相比超過此值，代表換頁了

// 兩張全解析度暫存畫布輪流使用：一張存目前最清楚的，一張給新的一格
const fullCanvases = [document.createElement('canvas'), document.createElement('canvas')];
function grabInto(c, v) {
  if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
  c.getContext('2d').drawImage(v, 0, 0);
  return c;
}
function grabFull(v) { return grabInto(fullCanvases[0], v); }
// 4.2.3：進框選畫面時放掉（每張約 50 MB，原本整個拍攝過程都留著）；下一張倒數時 grabInto 會自動重建
function freeFullCanvases() { live.best = null; for (const c of fullCanvases) c.width = c.height = 0; }

/* ---------- 4.3 即時掃描的 TEED 後援 ----------
   白色／淺色背景時原本的偵測鎖不到框：鎖不到 2 秒後，相機畫面縮成長邊 640 交給 TEED（ai-worker，CPU），
   worker.js 的 teedRegionQuad 找出「中間沒被線切斷的最大區塊」當框，交給同一套鎖定、倒數、拍照流程（onDetect 的 src 'teed'）。
   - 跑完一次休息至少和這次一樣久（iPhone 17 約每 0.4 秒、Y31 約每 1.6 秒一次），原本的偵測照常一起找，誰先鎖到聽誰的
   - TEED 鎖到後，這一頁由 TEED 負責到拍完、換頁為止（teedOwns：原本的偵測不參與、也不跑）
   - 連續跑 20 秒沒結果就先停（控制發熱），畫面明顯改變（frameSig 差 > 18）才再開始；只有下載過 AI 資料（有 TEED）的手機才有 */
const TEED_AFTER = 1000, TEED_CAP = 20000; // 5.1.4：2 → 1 秒，讓 TEED 在倒數（2 秒）開始前有機會先試
function teedOwns() { return !!live.teedOK && (live.armed ? live.lockSrc === 'teed' : live.capSrc === 'teed'); }
/* 5.3：原本的偵測鎖到的框碰到畫面邊緣（任一角離邊 2% 內）＝可疑，先不拍，請 TEED 確認一次（作者：布面、桌紋等有紋路的背景，
   紙的一條邊被紋路連到畫面外；周報實拍：原本的偵測底邊在 0.99，TEED／AI 都在 0.86）。
   TEED 找到形狀合理、完整在畫面內的框 → 改用它（這一頁交給 TEED，金框）；TEED 也碰邊或找不到（試 2 次）→ 照原本的框走（書本旁邊那頁超出畫面維持原樣）。
   作者 84 張實拍樣張（大半是書）模擬：58 張沒碰邊不受影響；碰邊的 22 張裡 15 張改用 TEED 全部變準（含 7 張書），7 張 TEED 找不到維持原樣，沒有變差的。
   最多等 2.5 秒（SUS_WAIT）；沒有 TEED、TEED 停了（20 秒上限）就直接照原本的走 */
const SUS_EDGE = 0.02, SUS_WAIT = 2500;
const edgeTouch = (q) => !!q && q.some(([x, y]) => x < SUS_EDGE || x > 1 - SUS_EDGE || y < SUS_EDGE || y > 1 - SUS_EDGE);
function susPending(now) {
  if (!(live.lockQ && live.lockSrc === 'det' && live.sus && !live.tChk)) return false;
  if (!live.teedOK || live.tCapped || now - live.susT0 > (live.teedWarm ? SUS_WAIT : SUS_WAIT + 3500)) { live.tChk = 'keep'; return false; } // TEED 還在暖機最多多等 3.5 秒
  return true;
}
function teedWanted(now) {
  if (!live.teedOK || !live.running || !settings.autoShutter || live.paused || live.capturing || live.cd) return false;
  if (live.armed) return live.lockQ ? live.lockSrc === 'teed' || susPending(now) : now - Math.max(live.idleT0 || now, live.seenT || 0) > TEED_AFTER;
  return live.capSrc === 'teed';
}
function teedRearm() { live.capSrc = null; live.tT0 = null; live.tCapped = false; live.tCand = []; }
function teedTick(v) {
  if (!live.teedOK || live.teedBusy) return;
  const now = performance.now();
  if (live.tCapped) { // 停下來了：畫面明顯改變才重新開始
    if (now < (live.teedNext || 0)) return;
    live.teedNext = now + 500;
    if (live.tCapSig && sigDiff(frameSig(v), live.tCapSig) > 18) { live.tCapped = false; live.tT0 = null; }
    return;
  }
  if (!teedWanted(now)) { if (!teedOwns()) live.tT0 = null; return; }
  if (live.tT0 == null) live.tT0 = now;
  if (now - live.tT0 > TEED_CAP) { live.tCapped = true; live.tCapSig = frameSig(v); live.tCand = []; if (live.armed && live.lockSrc === 'teed') { resetLock(); setRing(0); } return; }
  if (now < (live.teedNext || 0)) return;
  live.teedBusy = true;
  teedLiveRun(v).then(() => { live.teedErr = 0; live.teedWarm = true; }).catch((e) => { console.warn('TEED 即時', e); if (++live.teedErr >= 3) live.teedOK = false; })
    .finally(() => { const dt = performance.now() - now; live.teedBusy = false; live.teedNext = performance.now() + Math.min(1200, Math.max(250, dt)); }); // 休息和這次一樣久（最少 0.25、最多 1.2 秒；第一次含載入引擎，比較慢）
}
async function teedLiveRun(v) {
  const pre = live.armed && live.lockQ && live.lockSrc === 'teed' && live.progress > 0 && !live.ic;
  let full = null;
  if (pre) { const spare = live.best && live.best.canvas === fullCanvases[0] ? fullCanvases[1] : fullCanvases[0]; full = grabInto(spare, v); }
  const sig = frameSig(v);
  const [w, h] = sourceSize(v), s = 640 / Math.max(w, h);
  const W = Math.max(8, Math.floor((w * s) / 8) * 8), H = Math.max(8, Math.floor((h * s) / 8) * 8);
  const c = canvasOf(W, H), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(v, 0, 0, W, H);
  const d = x.getImageData(0, 0, W, H);
  const sharp = sharpness(d), gt = grayThumb(d);
  const buf = await aiCall({ type: 'teed', buffer: d.data.buffer, width: W, height: H }, [d.data.buffer]);
  if (!teedWanted(performance.now())) return;
  const r = await wcall('teedQuad', { buffer: buf, width: W, height: H }, [buf]);
  if (!teedWanted(performance.now())) return; // 這段時間原本的偵測鎖到了、拍下了、或離開了
  onDetect(r, sig, full, sharp, gt, 'teed');
}
/* ---------- 5.1 倒數拍攝（5.1.1：開始倒數後就暫停框選，一般晃動不影響，只有大幅移動才停；設定 countdown，預設關；拍攝畫面 AI 按鈕右邊的碼錶按鈕，手動拍攝時隱藏） ----------
   自動拍攝時框選鎖不到 2 秒、而且畫面拿穩（5.1.5 起要連續 1 秒）→ 中央圓環倒數（5.1.5 起 3、2、1，原本 5 秒；每秒嗶一聲）→ 拍下整個畫面
   （和自己按快門一樣：開著自動 AI 框選就交給 AI 框，否則標 ✂ 待裁切）。點相機畫面取消；拍下或取消後，畫面明顯改變（差 > 18，翻頁、換紙）才會再倒數，同一頁不會重拍。
   倒數中原本的偵測或 TEED 鎖到合理的框 → 停止倒數，走正常流程。開著倒數時不顯示 4 秒「直接按快門」提示 */
const CD_STILL = 10, CD_STILL_LOOSE = 20, CD_LOOSE_AFTER = 3000, CD_STUCK = 3000, CD_WAIT = '拿穩後開始倒數', CD_LEAVE = 25, CD_LEAVE_N = 3, CD_EDGE = 3000, CD_AFTER = 2000, CD_LEN = 3000, CD_MOVE = 10, CD_CHANGE = 18, CD_HINT = '倒數拍攝中，點畫面可取消';
const cdOn = () => !!(settings.countdown && settings.autoShutter);
function cdStop() { live.cdT0 = null; live.cd = null; live.cdAnchor = null; live.cdOut = 0; live.cdWait = false; }
// 5.1.3：兩張小縮圖的差異，先各自扣掉平均亮度（相機自動曝光造成的整體變亮變暗不算）
function sigDiffN(a, b) {
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length;
  let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - ma - (b[i] - mb));
  return d / a.length;
}
function cdTick(v) {
  const now = performance.now();
  if (!cdOn() || !live.running || live.paused || live.capturing || !v.videoWidth) { cdStop(); return; }
  if (now < (live.cdNext || 0)) return;
  live.cdNext = now + 150;
  const sig = frameSig(v);
  if (live.cdBlock) { if (sigDiff(sig, live.cdBlock) > CD_CHANGE) live.cdBlock = null; else { cdStop(); live.cdPrev = sig; return; } }
  const diff = live.cdPrev ? sigDiff(sig, live.cdPrev) : 0;
  live.cdPrev = sig;
  if (live.cdT0 != null) {
    // 5.1.3：倒數已經開始就靠倒數拍完：跟「倒數開始那一刻的畫面」比（扣掉整體亮度，相機自動調亮暗不算），
    // 差 > 25 連續 3 次（約 0.45 秒）才停（紙被拿走、翻頁、鏡頭轉到別處），重新等 2 秒。
    // 作者影片：手持 5 秒內與起點最多差約 17；不同場景之間 23～39（5.1.1 是跟上一次比、差 > 18 一次就停，偶爾會被打斷）
    live.cdOut = live.cdAnchor && sigDiffN(sig, live.cdAnchor) > CD_LEAVE ? (live.cdOut || 0) + 1 : 0;
    if (!live.armed || live.cdOut >= CD_LEAVE_N) { cdStop(); live.idleT0 = now; return; }
  } else {
    // 5.1.5：要「連續 1 秒都拿穩」才開始倒數（作者：放好紙時倒數早就在跑了）：現在的畫面和最近 1 秒內每一次取樣比（扣亮度），都 ≤ 10；
    // 鎖不到超過 5 秒（5.2.2 改 3 秒）還沒開始就放寬到 20。作者影片：手持跟 1 秒前比，門檻 10 時 96% 的時間算穩定（含刻意移動、翻頁）
    live.cdHist = (live.cdHist || []).filter((h) => now - h.t <= 1400); live.cdHist.push({ t: now, sig }); // 鎖不到時拍攝迴圈約 0.2 秒一圈，留 1.4 秒內的取樣，最舊的要超過 0.9 秒
    const idle = now - Math.max(live.idleT0 || now, live.cdBase || 0);
    const tol = idle > CD_LOOSE_AFTER ? CD_STILL_LOOSE : CD_STILL;
    const still = live.cdHist[0].t <= now - 900 && live.cdHist.every((h) => sigDiffN(sig, h.sig) <= tol);
    // 5.1.2：框一直卡在「請稍微拉遠一點」超過 3 秒也可以倒數（拍下後交給 AI 框）
    const stuck = live.lockQ && live.edge && live.edgeT0 && now - live.edgeT0 > CD_EDGE;
    // 5.2.2：畫面上有框、但從這一頁開始找起 3 秒還拍不下來（作者：通常是錯的框，例如一角頂到邊緣，框忽隱忽現或一直抖，
    //   以前「有框」就永遠不倒數，只能一直舉著）也可以倒數；聚焦圓環已經轉超過三成（快拍下了）先讓它拍，但被「拉遠一點」擋住的不算
    const lockedLong = live.lockQ && now - (live.idleT0 || now) > CD_STUCK && (live.edge || (live.progress || 0) < 0.3)
      && !(live.lockSrc === 'teed' && now - (live.tLockT || 0) < CD_STUCK); // 5.3：TEED 剛鎖到（或剛換成 TEED 的框）給它 3 秒自己拍完（TEED 一秒只有 1～2 格）
    // 5.1.4：從「這一頁開始找」或「上一次真正鎖穩（聚焦過半）」算 2 秒；一閃而過的鎖定（原本的偵測或 TEED）不延後倒數
    const want = live.armed && (stuck || lockedLong || (!live.lockQ && now - Math.max(live.idleT0 || now, live.cdBase || 0) > CD_AFTER));
    live.cdWait = want && !still; // 等使用者拿穩：提示「拿穩後開始倒數」
    if (!want || !still) return;
    live.cdWait = false; live.cdHist = [];
    live.cdT0 = now; live.cdLastN = Math.ceil(CD_LEN / 1000) + 1; live.cdAnchor = sig; live.cdOut = 0;
    resetLock(); setRing(0); live.tCand = []; // 5.1.1：開始倒數就暫停框選，畫面上不顯示框
  }
  const el = now - live.cdT0, n = Math.ceil((CD_LEN - el) / 1000);
  live.cd = true;
  setHint(CD_HINT); // 5.1.5：倒數中不偵測，提示要在這裡設
  if (n >= 1 && n < live.cdLastN) { live.cdLastN = n; sfxPlay('tick'); }
  if (el >= CD_LEN) { cdStop(); capture(sig, null, null, true); }
}
async function liveLoop() {
  if (!live.running) return;
  const v = $('#video');
  // 手動模式不找框（1.19）；提示語只顯示 3 秒（1.20，作者覺得一直掛著礙眼）
  if (!settings.autoShutter && !live.paused && !live.capturing) { if (performance.now() < (live.manualHintUntil || 0)) setHint(MANUAL_HINT); else hideHint(); }
  if (workerReady && settings.autoShutter && !live.paused && !live.capturing && v.videoWidth && !live.cd) teedTick(v); // 4.3；5.1.1 倒數中不跑
  cdTick(v); // 5.1
  if (workerReady && settings.autoShutter && !live.paused && !live.detecting && !live.capturing && v.videoWidth && !teedOwns() && !live.cd) { // 5.1.1：倒數中不偵測
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
      const luma = meanLuma(d); // 要在 buffer 交給 worker 之前算
      const r = await wcall('detect', { buffer: d.data.buffer, width: d.width, height: d.height, fast: true }, [d.data.buffer]);
      onDetect(r, sig, full, sharp, gt);
      darkCheck(luma);
    } catch (e) { console.warn(e); }
    live.detecting = false;
  }
  // 4.1.7：連續 3 秒找不到紙就降到約每秒 5 次（白色背景時偵測一直全速跑，iPhone 會過熱）；一找到紙就恢復
  if (live.running) setTimeout(liveLoop, settings.autoShutter && performance.now() - (live.seenT || 0) > 3000 ? 200 : 20);
}

/* 5.0.2：即時掃描的框要「像一張紙」才算數（作者：白色背景時常出現貼著畫面邊框的怪框，還會鎖定，TEED 因此沒機會上場）
   - 兩條以上的邊貼著畫面邊框（兩端都在 1.5% 內）：真正的紙四周一定會露出背景，這是把畫面邊框當成紙邊
   - 四個角要在 70～110 度、相對兩邊長度差不到 1.5 倍、凸四邊形（作者 95 張樣張正確的紙是 79～99 度、最多 1.27 倍）
   作者 4 段影片 250 格：擋掉 88／128 個錯框，誤擋 0／120 個正確框；錄影裡的兩個怪框都擋得到 */
const QP_EDGE = 0.015, QP_AMIN = 70, QP_AMAX = 110, QP_OPP = 1.5;
function quadPlausible(q) {
  if (!q || q.length !== 4) return false;
  let hug = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    for (const k of [0, 1]) for (const e of [0, 1]) if (Math.abs(a[k] - e) < QP_EDGE && Math.abs(b[k] - e) < QP_EDGE) hug++;
  }
  if (hug >= 2) return false;
  // 5.1.2：一條邊從畫面的一角延伸到另一角（兩端都在角落 3% 內）＝把畫面邊框當成紙邊（作者截圖：上方被淺色布蓋住，框的上緣就是畫面上緣）
  const atCorner = (p) => Math.min(p[0], 1 - p[0]) < 0.03 && Math.min(p[1], 1 - p[1]) < 0.03;
  for (let i = 0; i < 4; i++) if (atCorner(q[i]) && atCorner(q[(i + 1) % 4])) return false;
  const v = $('#video'), ar = v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0.75; // 角度要用實際比例算
  const P = q.map((p) => [p[0] * ar, p[1]]);
  let sgn = 0;
  for (let i = 0; i < 4; i++) {
    const a = P[(i + 3) % 4], b = P[i], c = P[(i + 1) % 4];
    const x1 = a[0] - b[0], y1 = a[1] - b[1], x2 = c[0] - b[0], y2 = c[1] - b[1];
    const ang = (Math.acos(Math.max(-1, Math.min(1, (x1 * x2 + y1 * y2) / (Math.hypot(x1, y1) * Math.hypot(x2, y2) || 1)))) * 180) / Math.PI;
    if (ang < QP_AMIN || ang > QP_AMAX) return false;
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), s1 = Math.sign(cr);
    if (!s1 || (sgn && s1 !== sgn)) return false;
    sgn = s1;
  }
  const L = [0, 1, 2, 3].map((i) => Math.hypot(P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]));
  const rt = (x, y) => Math.max(x, y) / Math.max(1e-9, Math.min(x, y));
  return rt(L[0], L[2]) <= QP_OPP && rt(L[1], L[3]) <= QP_OPP;
}
function onDetect(r, sig, full, sharp, gt, src) {
  if (!live.running || live.capturing) return;
  src = src || 'det';
  if (live.cd) return; // 5.1.1：倒數中不框選（倒數開始前送出的偵測結果也丟掉）
  if (src === 'det' && teedOwns()) return; // 4.3：TEED 鎖定的頁、或 TEED 負責判斷換頁時，原本的偵測不參與
  const tq = src === 'teed'; // 4.3：TEED 一秒只有 1～2 格，累積的格數門檻較低
  const now = performance.now();
  const ok = r && r.area > 0.1 && quadPlausible(r.corners); // 5.0.2：不像一張紙的框當作沒找到
  const qs = ok ? quadSig(gt, r.corners) : null;
  // 4.2：自動拍攝時框選鎖不到 4 秒，提示可以直接按快門（快門鈕呼吸）；鎖到或拍下就收起，每一頁都會再提示
  //（4.1.7 原本是 10 秒後提示一次改成手動拍攝）
  if (live.armed && settings.autoShutter && !cdOn() && !live.tipOn && !live.lockQ && now - Math.max(live.idleT0 || now, live.seenT || 0) > TIP_MS) live.tipOn = true; // 5.1：開著倒數時不顯示
  tipSync();
  live.dbg = { motion: live.prevQs && qs ? qsDiff(qs, live.prevQs) : null, change: live.capturedQs && qs ? qsDiff(qs, live.capturedQs) : null };

  // 拍完後：等換頁／移開才重新開始，期間不顯示框
  if (!live.armed) {
    // 1.24：iPhone 改成瞬間拍好之後，同一頁會一直被重拍（偵測偶爾跳一格就被當成換頁）。
    //  - 拍完 2 秒內不判斷換頁（作者：翻頁本來就要 1～2 秒）
    //  - 換頁要「紙上內容變了」或「找不到紙」連續 3 格才算；紙只是被挪動、內容沒變不算
    const since = Date.now() - live.lastCapT;
    if (!live.capturedQs && qs) live.capturedQs = qs; // 拍的那一刻沒有內容指紋時，用拍完後第一格補上
    if (since < 2000) { live.chgHits = 0; live.miss = 0; setHint('已拍好，請換下一頁', true); return; }
    const changed = qs && live.capturedQs && qsDiff(qs, live.capturedQs) > CHANGE_TOL;
    live.chgHits = changed ? (live.chgHits || 0) + 1 : 0;
    if (!ok) live.miss++; else live.miss = 0;
    const hitN = tq ? 2 : 3;
    if (live.chgHits >= hitN || live.miss >= hitN) { live.rearm = live.chgHits >= hitN ? 'changed' : 'miss'; live.armed = true; live.chgHits = 0; resetLock(); live.idleT0 = now; teedRearm(); } // 4.2：換頁後重新計時提示
    else { setHint('已拍好，請換下一頁', true); return; }
  }

  // 5.3：TEED 來確認可疑的框（原本的偵測鎖到、碰到畫面邊緣）
  if (tq && live.lockQ && live.lockSrc === 'det') {
    if (!susPending(now)) return;
    if (ok && !edgeTouch(r.corners)) { // 改用 TEED 的框，這一頁交給 TEED
      const q = r.corners;
      Object.assign(live, { lockQ: q, acc: [q], cand: [], tCand: [], lockSrc: 'teed', tLockT: now, tT0: null, anchorQ: q, stableSince: now, best: null, outliers: 0, miss: 0, sus: false, tChk: 'teed', prevQs: null, lastQs: null });
      live.teedSwaps = (live.teedSwaps || 0) + 1;
    } else { if (++live.tChkN >= 2) live.tChk = 'keep'; return; }
  }
  if (!ok) {
    if (tq) { live.tCand = []; if (live.lockQ) { if (++live.miss >= 2) resetLock(); } }
    else { live.miss++; live.cand = []; if (live.miss >= 4 && live.lockQ) resetLock(); }
    if (!live.lockQ) { setRing(0); setHint(live.cd ? CD_HINT : live.cdWait ? CD_WAIT : live.tipOn ? waitTip() : live.count ? '放入下一頁' : '將文件放進畫面中'); }
    return;
  }
  live.miss = 0;
  const q = r.corners;

  if (!live.lockQ) {
    // 尚未鎖定：需要連續 3 格位置一致，才確定是文件
    // 4.3：原本的偵測和 TEED 各自累積（白色背景時原本的偵測一直跳，混在一起 TEED 永遠累積不起來），先鎖到的當這一頁的來源
    const C = tq ? 'tCand' : 'cand', need = tq ? 2 : 3;
    if (live[C].length && maxDisp(q, live[C][live[C].length - 1]) > 0.05) live[C] = [];
    live[C].push(q);
    if (live[C].length < need) { setHint(live.cd ? CD_HINT : live.cdWait ? CD_WAIT : live.tipOn ? waitTip() : '尋找文件中…'); return; }
    live.lockQ = medianQuad(live[C]);
    live.acc = live[C].slice();
    live.cand = []; live.tCand = []; live.lockSrc = src; live.tT0 = null; if (tq) live.tLockT = now; // 5.3
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
  if (live.lockSrc === 'det' && !live.sus && !live.tChk && edgeTouch(live.lockQ)) { live.sus = true; live.susT0 = now; live.tChkN = 0; } // 5.3
  live.seenT = now; // 4.1.7：「找到紙」＝框已鎖定（白色背景時偵測常回報亂跳的框，鎖不住，不算找到）

  // 紙內容在動（手經過、正在翻頁）→ 重新倒數
  const motion = live.prevQs ? qsDiff(qs, live.prevQs) : 0; // qs 是依這一格實際四角取樣
  live.prevQs = qs;
  // 1.21：單一格超過不算（多半是偵測誤差或一瞬間的手抖），連續兩格超過才重新倒數
  live.motionHits = motion > MOTION_TOL ? (live.motionHits || 0) + 1 : 0;
  if (live.motionHits >= 2) { live.anchorQ = live.lockQ; live.stableSince = now; live.best = null; live.lastQs = null; live.motionHits = 0; }
  live.lastQs = live.prevQs;

  // 穩定判斷：容許自然手抖（約 3%），超過就重新倒數
  live.moveHits = maxDisp(live.lockQ, live.anchorQ) > STABLE_TOL ? (live.moveHits || 0) + 1 : 0;
  if (live.moveHits >= 2) { live.anchorQ = live.lockQ; live.stableSince = now; live.best = null; live.moveHits = 0; }
  const progress = Math.min(1, (now - live.stableSince) / STABLE_MS);
  live.progress = progress;
  if (progress >= 0.5) live.cdBase = now; // 5.1.4：真正鎖穩才重新計時倒數

  // 紙張太靠近畫面邊緣：照片四周會沒有空間可以重新裁切，先不拍
  // 1.19：只有「一整條邊」貼著畫面的一側（例如書本攤開，旁邊那頁超出畫面）照樣可以拍；兩側以上或只有一個角碰到才擋
  live.edge = edgeBlocked(live.lockQ);
  if (live.edge) { if (!live.edgeT0) live.edgeT0 = now; } else live.edgeT0 = 0; // 5.1.2：卡在「拉遠一點」多久
  if (live.edge) {
    live.stableSince = now; live.progress = 0; live.best = null;
    setRing(0); setHint(live.cd ? CD_HINT : live.cdWait ? CD_WAIT : live.tipOn ? waitTip() : '請稍微拉遠一點'); return;
  }

  // 記錄倒數期間最清楚的一格
  if (full && (!live.best || sharp > live.best.sharp)) live.best = { canvas: full, sharp, quad: q.map((p) => p.slice()) };

  if (!settings.autoShutter) { setRing(0); setHint('按下快門拍攝', true); return; }
  if (progress <= 0) setRing(0); // 5.1.5：進度圈改由 drawOverlay 照時間畫
  if (live.tipOn && progress < 0.05) { setHint(waitTip()); } else { live.tipOn = false; setHint('對準了，保持住…', true); }
  if (progress >= 1 && Date.now() - live.lastCapT > 800 && !susPending(now)) { // 5.3：可疑的框等 TEED 確認完才拍
    const b = live.best;
    capture(sig, b ? b.canvas : null, b ? b.quad : live.lockQ);
  }
}
// 光線不足提示（1.23）：畫面平均亮度偏低持續約 1 秒，而且手機支援閃光燈、燈還沒開，就提示開燈
const DARK_LUMA = 70; // 0～255；實機覺得太常或太少跳出時調這個
function meanLuma(d) {
  const a = d.data; let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 64) { s += a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11; n++; }
  return n ? s / n : 255;
}
function darkCheck(luma) {
  const now = performance.now();
  const canTorch = $('#torchBtn').style.display !== 'none';
  if (luma < DARK_LUMA && canTorch && !torchOn) { if (!live.darkSince) live.darkSince = now; }
  else live.darkSince = 0;
  live.dark = !!live.darkSince && now - live.darkSince > 1000;
  if (live.dark && settings.autoShutter && live.armed && !live.capturing && !live.paused) setHint('光線不足，可點左上角 ⚡ 開燈');
}
// 閃光燈在同一次掃描中保持開著：Android 另外拍照、或從裁切畫面回來時，系統可能把燈關掉，重新打開
function reapplyTorch() {
  if (torchOn && live.track && live.track.readyState === 'live') live.track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
}
function edgeBlocked(Q) {
  const E = EDGE_MARGIN;
  const hit = Q.map(([x, y]) => [x < E, x > 1 - E, y < E, y > 1 - E]);
  const n = hit.filter((h) => h.some(Boolean)).length;
  if (!n) return false;
  if (n !== 2) return true;
  // 兩個角都碰到：要是同一側、相鄰的兩個角，而且各自只碰到那一側
  for (let s = 0; s < 4; s++) {
    const idx = hit.map((h, i) => (h[s] ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 2 && (idx[1] - idx[0] === 1 || (idx[0] === 0 && idx[1] === 3)) && idx.every((i) => hit[i].filter(Boolean).length === 1)) return false;
  }
  return true;
}
function videoRect() {
  const st = $('#live .stage').getBoundingClientRect();
  const v = $('#video');
  const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
  const s = Math.min(st.width / vw, st.height / vh);
  return { x: (st.width - vw * s) / 2, y: (st.height - vh * s) / 2, w: vw * s, h: vh * s, cw: st.width, ch: st.height };
}
function centerRing(ctx, c, p, num, color, alpha) {
  const r = num ? 40 : 30;
  ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.lineCap = 'round';
  ctx.lineWidth = num ? 7 : 6; ctx.strokeStyle = 'rgba(255,255,255,.38)';
  ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(c[0], c[1], r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.001, p)); ctx.stroke();
  if (num) {
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(c[0], c[1], r - 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '800 34px -apple-system,"PingFang TC","Noto Sans TC",sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(num), c[0], c[1] + 1);
  }
  ctx.restore();
}
function drawOverlay() {
  if (!live.running) return;
  if (live.camOff) { requestAnimationFrame(drawOverlay); return; } // 3.1.5 相機暫停時不重畫
  const cv = $('#overlay');
  const dpr = window.devicePixelRatio || 1;
  const R = videoRect();
  if (cv.width !== Math.round(R.cw * dpr) || cv.height !== Math.round(R.ch * dpr)) { cv.width = Math.round(R.cw * dpr); cv.height = Math.round(R.ch * dpr); } // 1.34：摺疊機展開／收合只改高度時也要重設
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, R.cw, R.ch);
  const target = settings.autoShutter && live.armed && (!live.capturing || live.holdBox) ? live.lockQ : null;
  if (target) {
    if (!live.shown) { live.shown = target.map((p) => p.slice()); live.fade = 0; }
    else live.shown = live.shown.map((p, i) => [p[0] + (target[i][0] - p[0]) * 0.5, p[1] + (target[i][1] - p[1]) * 0.5]);
    live.fade = Math.min(1, (live.fade || 0) + 0.2);
  } else { live.shown = null; live.fade = 0; }
  if (live.shown) {
    const pts = live.shown.map((p) => [R.x + p[0] * R.w, R.y + p[1] * R.h]);
    // 5.1.5：進度照時間算（每次重畫都算，約每秒 60 次），不再跟著偵測結果一格一格跳；不穩時 stableSince 會被重設，圓環就退回去
    const pr = settings.autoShutter ? (live.progress > 0 && live.stableSince ? Math.min(1, (performance.now() - live.stableSince) / STABLE_MS) : 0) : 1;
    if (settings.autoShutter && live.armed && live.lockQ && !live.edge) setRing(pr); // 快門鈕外圈也一起
    ctx.globalAlpha = live.fade;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    // 綠色隨倒數逐漸變濃
    const gold = settings.teedMark && live.lockSrc === 'teed' && !live.edge; // 5.0：TEED 協助標記開著時，TEED 找到的框用金色
    ctx.fillStyle = live.edge ? 'rgba(242,196,141,.18)' : gold ? `rgba(255,200,40,${0.12 + 0.3 * pr})` : `rgba(143,179,138,${0.12 + 0.3 * pr})`;
    ctx.fill();
    ctx.lineWidth = 3 + pr; ctx.lineJoin = 'round';
    ctx.strokeStyle = live.edge ? '#F2C48D' : gold ? '#FFC828' : '#A8D4A1';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 7); ctx.fill(); });
    ctx.globalAlpha = 1;
    // 5.1 聚焦：框的中央一個圓環跟著穩定進度填滿，填滿就拍（拍攝動畫關閉時不畫）
    if (settings.autoShutter && live.armed && !live.edge && pr > 0 && animOn()) centerRing(ctx, [pts.reduce((a, p) => a + p[0], 0) / 4, pts.reduce((a, p) => a + p[1], 0) / 4], pr, null, gold ? '#FFC828' : '#7ED67E', live.fade);
  }
  // 5.1 倒數拍攝：畫面中央的圓環，中間顯示 5～1
  if (live.cd && live.cdT0 != null && !live.capturing) {
    const el = performance.now() - live.cdT0;
    centerRing(ctx, [R.x + R.w / 2, R.y + R.h / 2], Math.min(1, el / CD_LEN), Math.max(1, Math.ceil((CD_LEN - el) / 1000)), '#7ED67E', 1);
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
async function capture(sig, full, quadAt, userPress) {
  if (live.capturing || !live.running || live.paused) return;
  live.capturing = true; live.tipOn = false; tipSync(); live.idleT0 = performance.now() + 1e9; // 4.1.7：拍下後提示消失；回到拍攝才重新計時
  const capRot = pageRotNow(); // 1.35：橫拿拍的頁自動轉正（按下快門那一刻的方向）
  // 1.19：哪些照片要交給使用者自己裁切
  //  - 手動拍攝模式：每一張（不找框，存整張）
  //  - 自動拍攝模式下自己按快門，而框還沒穩定（沒有鎖定，或被「請稍微拉遠一點」擋住）：用照片重新找一次框（C），找不到就整張
  const manualMode = !settings.autoShutter;
  const steady = !manualMode && !!live.lockQ && !live.edge;
  const needUser = !!userPress && !steady;
  const quad = needUser ? null : quadAt || live.lockQ;
  // 4.3：TEED 在找或已鎖定時拍下，換頁由 TEED 判斷（原本的偵測在白色背景會誤以為紙拿開，同一頁被重拍）
  live.capSrc = live.teedOK && (live.lockSrc === 'teed' || live.tT0 != null || live.tCapped) ? 'teed' : 'det';
  const capQsOk = live.capSrc === 'det' || live.lockSrc === 'teed'; // 不是 TEED 鎖定的框：內容指紋留給拍完後 TEED 的第一格補
  live.tT0 = null; live.tCapped = false;
  const v = $('#video');
  if (!sig) sig = frameSig(v);
  cdStop(); live.cdBlock = sig; // 5.1：畫面明顯改變才會再倒數
  setRing(0);
  // 3.1 拍攝動畫：拍下那一格先存一張小圖（Android 另外拍照要等，先用預覽畫面）；立即裁切＝每一張都進框選（自動拍攝也一樣）
  const fxOn = animOn(), now2crop = !settings.cropLater;
  const fxFrame = fxOn ? fxGrab(full || v) : null;
  let fx = null;
  const startFx = () => { if (fxFrame) fx = playCapFx(fxFrame, quad || FULL, now2crop ? (settings.autoAI ? 'ai' : 'crop') : false); };
  // 3.1.4：稍後裁切有動畫時，存照片（12 MP 轉 JPEG）、精算四角、存資料庫這些重活等紙飛進縮圖後才做。
  // 作者錄影：動畫在掃描光那段一頓一頓、飛進縮圖幾乎跳過——這些工作在主畫面執行，把動畫卡住。
  // 等待期間按「完成」或切到背景：先把動畫收掉，等這張存好再結束（finishLive）
  let defRes = null, defT0 = 0;
  const deferSave = async () => {
    if (!fx || now2crop) return;
    defT0 = live.lastCapT = Date.now(); // 換頁判斷的 2 秒從拍下那一刻算，不因為晚存而拖慢連拍
    live.deferring = true; live.deferDone = new Promise((r) => { defRes = r; });
    await fx.landed;
  };
  const endDefer = () => { if (defRes) { live.deferring = false; const r = defRes; defRes = null; r(); } };
  try {
    let blob = null, fromPhoto = false, src = null, thumbFrame = null;
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
      reapplyTorch();
    }
    if (!blob) {
      src = full || grabFull(v); // 畫面在這一刻已經固定
      flash(); sfxPlay('shutter'); if (fxOn) startFx(); else shotFx('ok'); // 這一格已經固定下來，手可以移開了
      setHint('已拍好，請換下一頁', true);
      live.armed = false; live.capturedQuad = quad; live.capturedSig = sig; live.capturedQs = capQsOk ? live.lastQs : null; // 立刻隱藏框
      await deferSave();
      // 1.33：iPhone 省記憶體檔：存檔前縮到上限以內
      const cap = photoCap();
      if (src.width * src.height > cap * 1.05) {
        const sc = Math.sqrt(cap / (src.width * src.height));
        const c2 = canvasOf(Math.floor(src.width * sc), Math.floor(src.height * sc));
        const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(src, 0, 0, c2.width, c2.height);
        src = c2;
      }
      thumbFrame = smallFrame(src, 640);
      blob = await canvasBlob(src);
      if (blob) live.lastRes = [src.width, src.height];
      noteStrain();
      if (!blob) { // 1.29：弱手機記憶體不足時轉檔會失敗，不要存成沒有照片的頁面
        toast('這張沒拍成功，請再拍一次'); shotFx(''); if (fx) fx.stop();
        live.armed = true; resetLock(); live.capturing = false; endDefer(); return;
      }
    } else { flash(); sfxPlay('shutter'); if (fxOn) startFx(); else shotFx('ok'); setHint('已拍好，請換下一頁', true); live.armed = false; live.capturedQuad = quad; live.capturedSig = sig; live.capturedQs = capQsOk ? live.lastQs : null; await deferSave(); }
    let corners = quad ? quad.map((p) => p.slice()) : FULL.map((p) => p.slice());
    // 用較高解析度重新精算四個角（只在結果相近時採用，避免抓錯）
    try {
      let r = null, sameAspect = true;
      if (fromPhoto) {
        const { img, url } = await loadImg(blob);
        const iw = img.naturalWidth, ih = img.naturalHeight;
        sameAspect = Math.abs(iw / ih - v.videoWidth / v.videoHeight) < 0.02;
        let srcImg = img;
        const cap = photoCap();
        if (iw * ih > cap * 1.05) {
          // 相機給的照片太大（例如 4800 萬畫素），先縮到上限再存，後面的處理才不會拖慢
          const sc = Math.sqrt(cap / (iw * ih));
          const c = canvasOf(Math.floor(iw * sc), Math.floor(ih * sc));
          const cx = c.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(img, 0, 0, c.width, c.height);
          const nb = await toBlob(c, 'image/jpeg', 0.95);
          if (nb) { blob = nb; srcImg = c; } else { blobStrain = true; noteStrain(); }
        }
        live.lastRes = [srcImg.width || srcImg.naturalWidth, srcImg.height || srcImg.naturalHeight];
        thumbFrame = smallFrame(srcImg, 640);
        if (!manualMode) r = await detectOn(srcImg);
        if (srcImg !== img) srcImg.width = srcImg.height = 0;
        URL.revokeObjectURL(url);
      } else if (src && !manualMode) r = await detectOn(src);
      // Android 照片：即時框在弱手機上可能偏掉，以照片上完整偵測的結果為準（只排除差太多的誤判）
      const okR = r && (fromPhoto ? r.area > 0.15 && (!quad || !sameAspect || maxDisp(r.corners, quad) < 0.25)
                                  : (!quad || !sameAspect || maxDisp(r.corners, quad) < 0.06));
      if (okR) corners = r.corners;
      else if (!r && !sameAspect) corners = FULL.map((p) => p.slice());
    } catch (_) {}
    if (!live.docId) live.docId = (await createDoc()).id;
    const page = await addPage(live.docId, blob, corners, null, needUser, capRot);
    live.count++;
    endDefer();
    const th = $('#liveThumb');
    // 3.1：有拍攝動畫（稍後裁切）時，等紙飛進縮圖才顯示張數、跳一下
    const showCount = (n) => { th.style.visibility = 'visible'; th.querySelector('span').textContent = n; bumpThumb(); };
    if (fx && !now2crop) { const n = live.count; fx.landed.then(() => { if (live.count >= n) showCount(live.count); }); } else showCount(live.count);
    // 1.33：左下角縮圖顯示框好、拉正後的範圍（先放原圖，拉正好了再換）
    live.lastPageId = page.id;
    if (!live.thumbUrl) th.querySelector('img').src = blobUrl('live:last', blob, page.id);
    if (thumbFrame) setLiveThumb(thumbFrame, corners, null, page.id, capRot); else refreshLiveThumb(page.id);
    updResChip();
    live.lastCapT = defT0 || Date.now(); live.miss = 0; live.best = null; live.idleT0 = performance.now(); // 4.1.7
    if (!quad) { live.armed = true; resetLock(); }
    if (now2crop) {
      // 3.1：立即裁切＝每拍一張就進框選（1.19～3.0 只有手動拍攝、或框沒穩就自己按快門的才進）
      // 1.29：自動 AI 框選開著時，先用 AI 框好再進裁切畫面（兩種手機都一樣）；3.1 有動畫時掃描光循環到 AI 框好
      live.paused = true;
      camPause(); // 3.1.5：拍下的照片已經存好，等 AI、框選、看成品時相機先暫停
      let curve = null;
      if (settings.autoAI && (await aiCached())) {
        if (!fx) busy('AI 框選中…');
        try {
          const r = await aiFixPage(page.id, blob, corners, true);
          if (r && r.corners) { corners = r.corners; curve = r.curve; if (r.teed && teedMarkOn()) setTimeout(() => toast(r.teed), 600); } else aiReport(r, live.count);
        } finally { if (!fx) unbusy(); aiReleaseNow(); } // 4.2.3：立即裁切每張都用 AI，原本引擎從頭到尾不釋放
      }
      if (fx) { fx.release(); await fx.ready; }
      live.capturing = false; openLiveCrop(page, blob, corners, curve);
      if (fx) { const f = fx; setTimeout(() => f.stop(), 80); } // 框選畫面出來後才收掉動畫，中間不會閃回拍攝畫面
      return;
    }
    // 1.29：不進裁切畫面的頁：iPhone 邊拍邊在背景跑 AI；Android 等按「完成」再一次跑（避免弱手機拍攝變卡）
    if (settings.autoAI) live.aiLater.push(page.id); // 4.1.7：iPhone 也改成按「完成」後一次處理（拍攝時不跑 AI，減少發熱）
  } catch (e) {
    console.error(e); shotFx(''); if (fx) fx.stop(); endDefer(); toast('拍攝失敗：' + e.message);
    live.armed = true; resetLock();
  }
  live.capturing = false;
}
$('#shutter').onclick = () => { sfxPrime(); if (live.running) capture(null, null, null, true); };

/* ---------- 1.35 橫拿拍攝 ----------
   用重力感應判斷手機是直拿還是橫拿（和內建相機一樣：版面不動，只把按鈕與文字轉 90 度，拍好的頁自動轉正）。
   devicemotion 的 accelerationIncludingGravity：Android 依規格，直拿時 y≈+9.8；iPhone 的正負號相反（y≈−9.8）。
   motion.up＝手機「上方」在裝置上的方向：0＝直拿、90＝橫拿且上緣朝左（逆時針轉）、-90＝上緣朝右、180＝倒拿；
   平放（重力幾乎垂直螢幕）或接近 45 度時沿用上一次，避免來回跳。iPhone 沒鎖旋轉時整個畫面會跟著轉，所以要扣掉螢幕本身的角度 */
const motion = { on: false, up: null, cand: null, candT: 0, cal: [0, 0] };
/* 1.37：只有 Android 用感應器（settings.landscape，預設開、記住狀態，設定畫面可關；不需要權限）。
   manifest 是 orientation:portrait，Android 加入主畫面後畫面不會轉，只能靠感應器。
   iPhone 不用感應器：iOS 忽略 manifest 的方向，沒鎖螢幕方向時系統會把整個畫面轉成橫的（下面的 screenAngle 與橫式版面），
   1.36 的 ↻ 按鈕與「動作與方向」詢問拿掉（作者：iPhone 使用者知道打開旋轉即可，盡量不要詢問）。有鎖方向的 iPhone 就不能橫拍 */
const hasMotion = () => typeof window.DeviceMotionEvent !== 'undefined';
const landOn = () => !IS_IOS && hasMotion() && settings.landscape !== false;
function motionStart() { if (motion.on) return; motion.on = true; window.addEventListener('devicemotion', onMotion); }
function motionStop() {
  if (motion.on) window.removeEventListener('devicemotion', onMotion);
  motion.on = false; motion.up = null; motion.cand = null;
  applyUiRot();
}
function screenAngle() {
  const o = typeof window.orientation === 'number' ? window.orientation : (screen.orientation && screen.orientation.angle) || 0;
  return ((o % 360) + 360) % 360;
}
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  const s = (IS_IOS ? -1 : 1) * (settings.motionFlip ? -1 : 1);
  const ux = g.x * s, uy = g.y * s;
  if (Math.hypot(ux, uy) < 4.5) return; // 平放
  let r;
  if (Math.abs(uy) >= Math.abs(ux) * 1.25) r = uy > 0 ? 0 : 180;
  else if (Math.abs(ux) >= Math.abs(uy) * 1.25) r = ux > 0 ? 90 : -90;
  else return; // 接近 45 度
  // 自動校正：螢幕是直的、手機明顯直立時，「上」應該是螢幕上緣；一開始大多數是反的，表示這支手機正負號和預期相反
  if (!settings.motionCal && screenAngle() === 0 && Math.abs(uy) > 7) {
    motion.cal[uy > 0 ? 0 : 1]++;
    if (motion.cal[0] + motion.cal[1] >= 40) {
      if (motion.cal[1] > motion.cal[0] * 3) { settings.motionFlip = !settings.motionFlip; motion.up = null; motion.cand = null; }
      settings.motionCal = true; saveSettings();
      return;
    }
  }
  const now = performance.now();
  if (r !== motion.cand) { motion.cand = r; motion.candT = now; }
  if (r !== motion.up && now - motion.candT > 300) { motion.up = r; applyUiRot(); }
}
// 相對目前畫面的旋轉（0／90／-90／180）
function uiRot() {
  if (motion.up == null) return 0;
  let r = (((motion.up - screenAngle()) % 360) + 540) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}
// 拍好的頁要轉幾度才會正（頁面的 rotation 是順時針）
const pageRotNow = () => (360 - uiRot()) % 360;
function applyUiRot() {
  const el = $('#live'); if (!el) return;
  const r = uiRot();
  el.classList.toggle('r90', r === 90); el.classList.toggle('rm90', r === -90); el.classList.toggle('r180', r === 180);
}
window.addEventListener('orientationchange', () => setTimeout(applyUiRot, 50));

// 1.33：即時掃描左下角縮圖＝框好、拉正後的小圖（原色，不做黑白）；作者：要馬上知道有沒有框好
async function setLiveThumb(frame, corners, curve, pageId, rotation) {
  try {
    await whenReady();
    const r = await wcall('process', { buffer: frame.data.buffer, width: frame.width, height: frame.height, corners, curve: curve || null, upscale: 'off', rotation: rotation || 0, mode: 'original', params: fillAdj('original') }, [frame.data.buffer]);
    if (pageId && live.lastPageId !== pageId) return;
    const c = canvasOf(r.width, r.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
    const b = await toBlob(c, 'image/jpeg', 0.85); c.width = c.height = 0;
    if (!b || (pageId && live.lastPageId !== pageId)) return;
    if (live.thumbUrl) URL.revokeObjectURL(live.thumbUrl);
    live.thumbUrl = URL.createObjectURL(b);
    $('#liveThumb img').src = live.thumbUrl;
  } catch (e) { console.warn('live thumb', e); }
}
// 從存好的原圖重算（背景 AI 框好、立即裁切確定、刪掉最後一張之後）
async function refreshLiveThumb(pageId) {
  try {
    const p = await DB.get('pages', pageId); if (!p || isBroken(p)) return;
    const { img, url } = await loadImg(p.original);
    const f = smallFrame(img, 640); URL.revokeObjectURL(url);
    await setLiveThumb(f, p.corners, p.curve, pageId, p.rotation || 0);
  } catch (e) { console.warn('live thumb', e); }
}

// 1.34：iPhone 相機權限說明（拍攝畫面短提示、設定、教學共用）。網頁 App 不能直接打開 iPhone 的設定頁，只能列步驟
const CAM_STEPS = '<ol style="margin:4px 0 8px;padding-left:22px;line-height:1.9"><li>打開 iPhone 的「設定」</li><li>點「App」→「Safari」</li><li>找到「相機」，改成「允許」</li></ol>';
const CAM_VIDEO = 'https://www.youtube.com/watch?v=q3Vb_R12qTI&t=76s';
function camPermHelp() {
  openSheet(`<h3>每次都要允許相機？</h3><div class="note" style="margin:0 4px 6px;font-size:14.5px;line-height:1.6">每次開即時掃描都要按「允許」使用相機的話，可以設定成永遠允許：</div>${CAM_STEPS}
    <div class="note" style="margin:0 4px 12px">（「動作與方向」也可以照樣改成「允許」。）</div>
    <button class="bigbtn" id="camHelpVideo" style="width:100%;background:#C4302B">▶ 看影片教學</button>
    <button class="bigbtn alt" id="camHelpOk" style="width:100%;margin-top:8px">知道了</button>`, (s) => {
    s.querySelector('#camHelpOk').onclick = () => closeSheet();
    // 2.2：影片從 1:16（相機設定那段）開始；Shorts 網址不能指定時間，所以用一般影片網址。
    // 在拍攝畫面點的話會跳到 YouTube，App 進背景時 visibilitychange 會結束即時掃描（已拍的頁照常存好），回來不會卡在凍結的相機畫面
    s.querySelector('#camHelpVideo').onclick = () => { closeSheet(); window.open(CAM_VIDEO, '_blank', 'noopener'); };
  });
}
let camTipT = 0;
function showCamTip() {
  const t = $('#camTip'); t.classList.add('show');
  clearTimeout(camTipT); camTipT = setTimeout(() => t.classList.remove('show'), 5000);
}
$('#camTipGo').onclick = () => { $('#camTip').classList.remove('show'); camPermHelp(); };
$('#camTipX').onclick = () => { clearTimeout(camTipT); $('#camTip').classList.remove('show'); };

/* 1.19 立即裁切：拍完直接進裁切畫面；相機不關，只暫停找框，回來就能接著拍 */
function openLiveCrop(page, blob, corners, curve, replace) {
  live.paused = true;
  freeFullCanvases(); // 4.2.3
  camPause(); // 3.1.5
  openCrop({
    blob, corners, curve: curve || null, rotation: page.rotation || 0, retake: true, liveCrop: true, replace,
    onConfirm: async (c, cv, edited, rot) => {
      const p = await DB.get('pages', page.id);
      if (!p) { history.back(); return; }
      p.corners = c; p.curve = cv; p.rotation = rot; delete p.needCrop;
      if (edited) p.cropUser = true;
      await DB.put('pages', p);
      // 3.1：先看成品（#capRes）；「繼續編輯」回到框選，「確定」才回到拍攝畫面（5.3.1 起自動確定，見 showCapResult）
      const act = await showCapResult(p.id);
      if (act === 'edit') { openLiveCrop(p, blob, c, cv, true); return; }
      if (act === 'ok') { capRes.flying = true; history.back(); try { await capResFly(); } finally { capRes.flying = false; } }
      if (live.lastPageId === p.id) refreshLiveThumb(p.id);
      enqueue(p.id);
    },
    onRetake: () => removeLivePage(page.id),
    onCancel: () => {}, // 左上「稍後裁切」或返回鍵：整張留著，保留待裁切標記
  });
}
async function removeLivePage(pageId) {
  live.count = Math.max(0, live.count - 1);
  live.armed = true; resetLock();
  const doc = await docEdit(async () => { // 5.3：排隊（可能和還在存的上一張同時）
    const d = await DB.get('docs', live.docId);
    await DB.del('pages', pageId);
    if (d) {
      d.pageIds = d.pageIds.filter((id) => id !== pageId);
      if (!d.pageIds.length && !live.fromDoc) { await DB.del('docs', d.id); live.docId = null; }
      else { d.updated = Date.now(); await DB.put('docs', d); }
    }
    return d;
  });
  const th = $('#liveThumb');
  if (!live.count) { th.style.visibility = 'hidden'; return; }
  th.querySelector('span').textContent = live.count;
  const last = doc && doc.pageIds.length ? await DB.get('pages', doc.pageIds[doc.pageIds.length - 1]) : null;
  if (last) { live.lastPageId = last.id; th.querySelector('img').src = blobUrl('live:last', last.original, last.id); refreshLiveThumb(last.id); }
}
function liveResume() {
  live.paused = false; live.idleT0 = live.seenT = performance.now(); live.tT0 = null; live.tCapped = false; // 4.1.7；4.3
  if (!live.track || live.track.readyState === 'ended') { finishLive(); return; } // 中途被切到背景，相機已經關了
  camResume(); // 3.1.5：相機恢復送畫面
  // 1.20：iPhone 從裁切畫面回來時，相機畫面會用錯誤的大小重畫（縮成約四分之三、四周變黑）。
  // 把串流重新接上一次、並讓影片元素重新排版，強制以正確大小重畫
  freshVideo(); // 3.1.2：換新的影片元素（舊的做法是重接串流）
  fixVideoSoon(); // 3.1.1：等畫面穩定再換一次（剛回來時，偶爾被還在收掉的畫面蓋過去）
  reapplyTorch();
  if (settings.autoShutter) setHint(live.armed ? '將文件放進畫面中' : '已拍好，請換下一頁', !live.armed);
  else hideHint();
}
const MANUAL_HINT = '手動拍攝：拍完後再自己調整範圍';
// 4.2：框選鎖不到時的提示（取代 4.1.7「10 秒後提示改成手動拍攝」）
const TIP_MS = 4000;
const waitTip = () => (settings.autoAI ? '找不到紙邊？直接按快門，拍完 AI 會幫你框' : '找不到紙邊？直接按快門，拍完可再調整框選');
function tipSync() { const b = $('#shutter'); if (b) b.classList.toggle('nudge', !!(live.running && live.tipOn && live.armed && settings.autoShutter)); }
function manualHint() { live.manualHintUntil = performance.now() + 3000; setHint(MANUAL_HINT); }
function updateLiveBtns() {
  $('#aiBtn').classList.toggle('on', !!settings.autoAI);
  $('#cdBtn').classList.toggle('on', !!settings.countdown); $('#cdBtn').style.display = settings.autoShutter ? '' : 'none'; // 5.1：手動拍攝時隱藏，開關狀態不變
  $('#autoBtn').classList.toggle('on', settings.autoShutter);
  $('#autoBtn').textContent = settings.autoShutter ? '自動拍攝' : '手動拍攝';
  $('#cropModeBtn').textContent = settings.cropLater ? '稍後裁切' : '立即裁切';
  $('#cropModeBtn').classList.toggle('later', !!settings.cropLater);
}
let liveTipT;
function liveTip(title, html) {
  const t = $('#liveTip');
  t.querySelector('b').textContent = title;
  t.querySelector('span').innerHTML = html;
  t.classList.add('show');
  clearTimeout(liveTipT);
  liveTipT = setTimeout(() => t.classList.remove('show'), 2200);
}
$('#cropModeBtn').onclick = () => {
  settings.cropLater = !settings.cropLater; settings.cropSet = true; saveSettings(); // 5.3.1：記下使用者自己切換過（以後改預設時可以分辨）
  updateLiveBtns();
  if (settings.cropLater) liveTip('稍後裁切', '拍完先存起來，可以連續拍<br>之後在文件裡點「✂」那頁裁切');
  else liveTip('立即裁切', '每拍一張就進入裁切畫面<br>完成後自動回到拍攝'); // 5.3.1：不用再按確定
};
$('#liveClose').onclick = () => finishLive();
$('#cdBtn').onclick = () => {
  sfxPrime();
  settings.countdown = !settings.countdown; saveSettings(); cdStop(); updateLiveBtns();
  liveTip('倒數拍攝', settings.countdown ? '偵測不到框選範圍時<br>拿穩後倒數 3 秒自動拍下（點畫面可取消）' : '已關閉倒數拍攝');
};
// 5.1：倒數中點相機畫面取消，這一頁不再倒數，畫面明顯改變後才重新開始
$('#live .stage').addEventListener('click', (e) => {
  if (!live.cd || e.target.closest('button,.pill,#liveTip,#camTip')) return;
  cdStop(); live.cdBlock = frameSig($('#video'));
  toast('已取消倒數，翻頁或換紙後會重新開始');
});
$('#liveDone').onclick = () => finishLive();
$('#liveThumb').onclick = () => finishLive();
$('#autoBtn').onclick = () => {
  settings.autoShutter = !settings.autoShutter; saveSettings();
  updateLiveBtns();
  live.armed = true; resetLock(); teedRearm(); setRing(0); live.tipOn = false; tipSync(); live.idleT0 = live.seenT = performance.now(); // 4.1.7；4.3
  if (settings.autoShutter) { setHint('將文件放進畫面中'); liveTip('自動拍攝', '對準文件，穩定後自動拍下'); }
  else { manualHint(); liveTip('手動拍攝', '不自動框選，拍完再自己調整範圍'); }
};
// 1.29 自動 AI 框選開關（記住上次的狀態）；第一次開啟要先下載 AI 資料
$('#aiBtn').onclick = async () => {
  if (!settings.autoAI) {
    live.paused = true;
    const had = await aiCached();
    const ok = await aiEnsure(true); // 1.31：用 App 內的確認視窗（系統 confirm 會讓 iPhone 相機凍結）
    if (!had && ok) await restartCamera(); // 下載幾十 MB 期間 iPhone 可能中斷相機：重新開一次
    live.paused = false;
    if (!live.running) return;
    if (!ok) return;
    settings.autoAI = true; settings.aiAsked = true; saveSettings(); updateLiveBtns();
    liveTip('自動 AI 框選', IS_IOS ? '拍完自動用 AI 重新框好' : '拍完自動用 AI 重新框好<br>按「完成」後一次處理');
  } else {
    settings.autoAI = false; settings.aiAsked = true; saveSettings(); updateLiveBtns();
    liveTip('自動 AI 框選', '已關閉');
  }
};
/* 2.1 自動 AI 框選預設開啟（作者：有些人不知道可以打開）。AI 資料要先下載（3.0 起約 32 MB），所以：
   第一次進拍攝畫面時（相機開好再等 1 秒）用 App 內視窗詢問；按「下載」→ 下載完自動開啟並重開相機（1.31 iPhone 凍結），
   按「暫時不要」→ 維持關閉、不再問（settings.aiAsked）。舊使用者也問一次（作者決定；以前特地關掉的人也會被問一次）。
   已開啟的不問；已下載過資料但沒開的直接開啟；弱 Android（裝置記憶體 < 4 GB 或曾經記憶體不足自動降檔）不問、維持關閉，自己按 AI 按鈕 */
const aiWeak = () => !IS_IOS && (settings.camAutoLow || (navigator.deviceMemory > 0 && navigator.deviceMemory < 4));
// 回傳 'ask'＝問要不要下載並開啟；'up'＝3.0 舊使用者問要不要升級引擎；false＝不問
async function aiDefaultCheck() {
  const st = await aiState();
  if (aiUpgradable(st) && !settings.aiUpAsked) return 'up';
  if (settings.aiAsked || settings.autoAI) return false;
  if (aiWeak()) return false;
  if (st.model && aiPickEngine(st)) { settings.autoAI = true; settings.aiAsked = true; saveSettings(); updateLiveBtns(); return false; }
  return 'ask';
}
// 3.0：已經用舊引擎的人，問一次要不要升級（同樣在相機開好 1 秒後、暫停自動拍攝；按「暫時不要」→ 設定裡有升級按鈕）
async function aiUpAskNow() {
  if (!live.running || current !== 'live' || settings.aiUpAsked) { live.paused = false; return; }
  settings.aiUpAsked = true; saveSettings();
  live.paused = true;
  const yes = await askSheet('AI 框選升級', `新版 AI 框選速度更快，需要再下載約 ${AI_UP_MB} MB（只需一次），建議在 Wi-Fi 下使用。`, '下載並升級', '暫時不要');
  let ok = false;
  if (yes && live.running) { ok = await aiUpgrade(); if (ok) await restartCamera(); }
  live.paused = false;
  if (ok && live.running) liveTip('AI 框選已升級', '速度更快了');
}
async function aiAskNow() {
  if (!live.running || current !== 'live' || settings.autoAI || settings.aiAsked) { live.paused = false; return; }
  settings.aiAsked = true; saveSettings();
  live.paused = true;
  const yes = await askSheet('自動 AI 框選', `拍完自動用 AI 精準框好紙張，省去調整的麻煩。<br>需要先下載約 ${AI_DL_MB} MB 的資料（只需一次，之後離線也能用），建議在 Wi-Fi 下使用。`, '下載並開啟', '暫時不要');
  let ok = false;
  if (yes && live.running) { ok = await aiEnsure(true, true); if (ok) await restartCamera(); }
  live.paused = false;
  if (!ok || !live.running) return;
  settings.autoAI = true; saveSettings(); updateLiveBtns();
  liveTip('自動 AI 框選', IS_IOS ? '拍完自動用 AI 重新框好' : '拍完自動用 AI 重新框好<br>按「完成」後一次處理');
}
// 用 AI 重新框一頁。c0＝拍下時的框：使用者已經自己改過範圍就不動。keepCrop＝要進裁切畫面，保留待裁切標記
// 回傳 { corners, curve }＝成功；{ fail: 'reject' | 'error' | 'skip', msg }＝沒有套用（1.31 起回報原因）
async function aiFixPage(pageId, blob, c0, keepCrop) {
  try {
    if (!(await aiCached())) return { fail: 'error', msg: '手機裡找不到 AI 資料，請關掉再打開自動 AI 框選重新下載' };
    const { img, url } = await loadImg(blob);
    let r = null;
    try { r = await aiFrame(img); } finally { URL.revokeObjectURL(url); }
    if (!r || !r.corners) return { fail: 'reject', msg: r && r.reject };
    const p = await DB.get('pages', pageId); if (!p) return { fail: 'skip' };
    if (c0 && JSON.stringify(p.corners) !== JSON.stringify(c0)) return { fail: 'skip' };
    pushHist(p, 'autoai');
    p.corners = r.corners; p.curve = r.curve ? normCurve(r.corners, r.curve) : null;
    if (!keepCrop) delete p.needCrop;
    await DB.put('pages', p);
    enqueue(p.id);
    if (current === 'doc' && state.docId === p.docId) onPageUpdated(p.id);
    if (live.running && live.lastPageId === p.id) refreshLiveThumb(p.id);
    return { corners: p.corners, curve: p.curve, teed: teedNote(r) };
  } catch (e) { console.warn('auto AI', e); return { fail: 'error', msg: e && e.message ? e.message : String(e) }; }
}
// 1.31：背景 AI 的狀態（左下角縮圖上方的「AI n」標籤）；不適合或失敗時提示
let aiLiveQ = Promise.resolve(), aiPend = 0, aiErrShown = false, aiTagT = 0;
function aiTag(text, busyNow) {
  const t = $('#liveAi'); if (!t) return;
  clearTimeout(aiTagT);
  if (!text) { t.classList.remove('show'); return; }
  t.innerHTML = (busyNow ? '<i class="spin sm"></i>' : '') + text;
  t.classList.add('show');
}
function aiReport(r, n) {
  if (!r || r.corners || r.fail === 'skip') return;
  if (r.fail === 'reject') toast(`第 ${n} 頁 AI 判斷不適合，保留原框`);
  else if (!aiErrShown) { aiErrShown = true; toast('AI 框選失敗：' + (r.msg || '未知原因')); }
}
function aiBg(pageId, blob, c0, n) {
  aiPend++; aiTag('AI ' + aiPend, true);
  aiLiveQ = aiLiveQ.then(async () => {
    const r = await aiFixPage(pageId, blob, c0, false);
    aiPend--;
    if (current === 'live') aiReport(r, n);
    if (aiPend > 0) aiTag('AI ' + aiPend, true);
    else { aiTag('AI ✓', false); aiTagT = setTimeout(() => aiTag(''), 1500); }
  });
}
// Android：按「完成」後把這次拍的頁一次用 AI 框好
async function aiRunLater(ids) {
  let done = 0, firstErr = null, tdone = 0;
  busy(`AI 框選中 1 / ${ids.length}`);
  await holdQueue(); aiBatchMark(true);
  try {
    for (let i = 0; i < ids.length; i++) {
      busy(`AI 框選中 ${i + 1} / ${ids.length}`);
      const p = await DB.get('pages', ids[i]); if (!p || isBroken(p)) continue;
      const r = await aiFixPage(p.id, p.original, p.corners, false);
      if (r && r.corners) { done++; if (r.teed) tdone++; }
      else if (r && r.fail === 'error' && !firstErr) firstErr = r.msg;
    }
  } finally { aiBatchMark(false); unbusy(); releaseQueue(); aiReleaseSoon(); }
  if (current === 'doc') renderDoc();
  toast(firstErr ? `AI 框選失敗：${firstErr}` : `AI 框選完成：${done} / ${ids.length} 頁${done < ids.length ? '（其餘判斷不適合，保留原框）' : ''}${teedCount(tdone)}`);
}
let torchOn = false;
$('#torchBtn').onclick = async () => {
  torchOn = !torchOn;
  try { await live.track.applyConstraints({ advanced: [{ torch: torchOn }] }); $('#torchBtn').classList.toggle('on', torchOn); }
  catch (_) { toast('無法開啟閃光燈'); }
};
function finishLive() {
  // 3.1.4：最後一張還在等動畫結束才存：收掉動畫、等它存好再結束
  if (live.deferring && live.deferDone) {
    if (capFx.cur) capFx.cur.stop();
    if (!live.finishing) { live.finishing = true; live.deferDone.then(() => { live.finishing = false; finishLive(); }); }
    return;
  }
  const docId = live.docId, count = live.count;
  const later = (live.aiLater || []).slice(); live.aiLater = [];
  stopLive();
  if (live.fromDoc) { history.back(); }
  else if (count && docId) {
    state.docId = docId;
    history.replaceState({ s: 'doc', doc: docId }, '');
    renderDoc(); show('doc');
  } else history.back();
  if (later.length) setTimeout(() => aiRunLater(later), 1000); // 4.2.1：等相機釋放（原 0.3 秒）
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && current === 'live') finishLive();
});

/* ---------- 3.1 拍攝動畫與音效 ----------
   即時掃描拍下時：白光一閃 → 框住的紙從斜的四邊形「攤平」成正面、周圍變暗 → 金色掃描光由上往下掃 0.8 秒
   （掃過的地方用濾鏡模擬成這個模式的樣子，只是預覽）→ 縮小飛進左下角縮圖。總長約 1.5 秒（拍完 2 秒內本來就不判斷換頁，不拖慢連拍）。
   立即裁切模式：攤平、掃描後停住，掃描光循環到 AI 框好，再進框選畫面；按確定後先看真正處理好的成品（#capRes）。
   設定「拍攝動畫」關掉（弱 Android 預設關）或系統開「減少動態效果」時，只有閃光與縮圖跳動；成品畫面改用轉圈。
   音效用 Web Audio 現場合成（不另外下載）：快門「咔、嚓」、掃描「刷—叮」；設定「拍攝音效」可關，
   iPhone 設成 ambient 跟著靜音開關，兩邊都跟著手機音量（網頁無法知道 Android 是否在靜音／震動模式） */
// 3.1.1：Android 記憶體回報小於 8 GB（Chrome 只回報 0.25～8，Y31 回報 4）預設關；作者 Y31 開動畫後 AI 框選變慢（主畫面重畫和 AI 搶運算）
const animWeak = () => !IS_IOS && (settings.camAutoLow || !(navigator.deviceMemory >= 8));
const animPref = () => (settings.capAnim !== undefined ? !!settings.capAnim : !animWeak()); // 設定開關顯示的值
const animOn = () => !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) && animPref();
const sfx = { ctx: null, buf: {} };
// 在使用者點擊的當下呼叫（iPhone 要在點擊裡才能啟動聲音）
function sfxPrime() {
  if (settings.sound === false) return;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'ambient'; // iPhone：靜音開關打開就不出聲
    if (!sfx.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; sfx.ctx = new AC(); }
    if (sfx.ctx.state === 'suspended') sfx.ctx.resume();
    const s = sfx.ctx.createBufferSource(); s.buffer = sfx.ctx.createBuffer(1, 1, 22050); s.connect(sfx.ctx.destination); s.start(0);
  } catch (_) {}
}
function sfxBuild(name) {
  const sr = sfx.ctx.sampleRate;
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1; };
  const out = (dur) => new Float32Array(Math.round(dur * sr));
  const add = (dst, src, t0) => { const i0 = Math.round(t0 * sr); for (let i = 0; i < src.length && i0 + i < dst.length; i++) dst[i0 + i] += src[i]; };
  const norm = (a, pk) => { let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); if (m) for (let i = 0; i < a.length; i++) a[i] *= pk / m; return a; };
  if (name === 'shutter') { // 「咔、嚓」兩聲短促的機械聲
    const click = (amp) => {
      const n = Math.round(0.04 * sr), a = new Float32Array(n); let hp = 0, px = 0;
      for (let i = 0; i < n; i++) { const t = i / sr, x = rnd(); hp = 0.9 * (hp + x - px); px = x; a[i] = amp * (hp * Math.exp(-t / 0.006) * 0.8 + Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t / 0.01) * 0.5); }
      return a;
    };
    const a = out(0.2); add(a, click(1), 0); add(a, click(0.7), 0.075);
    return norm(a, 0.9);
  }
  if (name === 'tick') { // 5.1 倒數拍攝每秒一聲短促的「嗶」
    const a = out(0.09); for (let i = 0; i < a.length; i++) { const t = i / sr; a[i] = Math.sin(2 * Math.PI * 1320 * t) * Math.min(1, t / 0.004) * Math.exp(-t / 0.03); }
    return norm(a, 0.7);
  }
  if (name === 'ding') { // 4.0：只留原本掃描音效最後的「叮」（刷的聲音拿掉）；用同一段合成再取 0.78 秒之後，音量與音色和 3.1 一樣
    const a = sfxBuild('scan'); return a.slice(Math.round(0.78 * sr));
  }
  // 掃描（3.1；4.0 起只用來取「叮」）：0.8 秒柔和的「刷—」（雜訊帶通由低往高掃）＋一點上滑的音色，0.78 秒時「叮」
  const D = 0.8, n = Math.round(D * sr), a = out(1.05);
  const sw = new Float32Array(n); let lp = 0, hp = 0, px = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, fc = 500 * Math.pow(6, t / D), x = rnd();
    lp += (1 - Math.exp(-2 * Math.PI * fc * 1.6 / sr)) * (x - lp);
    hp = Math.exp(-2 * Math.PI * fc * 0.6 / sr) * (hp + lp - px); px = lp; sw[i] = hp; m = Math.max(m, Math.abs(hp));
  }
  for (let i = 0; i < n; i++) { const t = i / sr, env = Math.pow(Math.sin(Math.PI * t / D), 1.5); sw[i] = sw[i] / m * env * 0.28 + Math.sin(2 * Math.PI * (700 + 900 * t / D) * t) * 0.06 * env; }
  add(a, sw, 0);
  const ch = new Float32Array(Math.round(0.25 * sr));
  for (let i = 0; i < ch.length; i++) { const t = i / sr; ch[i] = (Math.sin(2 * Math.PI * 1760 * t) + 0.5 * Math.sin(2 * Math.PI * 2637 * t)) * Math.exp(-t / 0.07) * 0.1; }
  add(a, ch, 0.78);
  return norm(a, 0.8);
}
const SFX_GAIN = { shutter: 0.4, scan: 0.45, ding: 0.45, tick: 0.3 }; // 提示音：比一般影片聲音小一點
function sfxPlay(name) {
  if (settings.sound === false || !sfx.ctx) return;
  try {
    if (sfx.ctx.state === 'suspended') sfx.ctx.resume();
    let b = sfx.buf[name];
    if (!b) { const d = sfxBuild(name); b = sfx.ctx.createBuffer(1, d.length, sfx.ctx.sampleRate); b.getChannelData(0).set(d); sfx.buf[name] = b; }
    const src = sfx.ctx.createBufferSource(), g = sfx.ctx.createGain();
    src.buffer = b; g.gain.value = SFX_GAIN[name] || 0.4;
    src.connect(g); g.connect(sfx.ctx.destination); src.start();
  } catch (_) {}
}
// 四點對四點的透視轉換（CSS matrix3d），讓斜的紙「攤平」
function homog(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) { const [x, y] = src[i], [u, v] = dst[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); }
  for (let i = 0; i < 8; i++) {
    let p = i; for (let j = i + 1; j < 8; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let j = i + 1; j < 8; j++) { const f = A[j][i] / A[i][i]; for (let k = i; k < 8; k++) A[j][k] -= f * A[i][k]; b[j] -= f * b[i]; }
  }
  const h = new Array(8);
  for (let i = 7; i >= 0; i--) { let t = b[i]; for (let k = i + 1; k < 8; k++) t -= A[i][k] * h[k]; h[i] = t / A[i][i]; }
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
}
const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2), easeIn3 = (t) => t * t * t, clamp01 = (t) => Math.max(0, Math.min(1, t));
// 掃描好的樣子（只是預覽，真正的成品另外處理）
const FX_FILTER = { bw: 'grayscale(1) contrast(1.9) brightness(1.18)', gray: 'grayscale(1) contrast(1.25) brightness(1.1)', color: 'contrast(1.15) brightness(1.1) saturate(1.1)', original: 'none' };
// 拍下那一格的小圖（動畫用，長邊 ≤ 1200）
function fxGrab(src) {
  const [w, h] = sourceSize(src); if (!w || !h) return null;
  const s = Math.min(1, 1200 / Math.max(w, h)), c = canvasOf(Math.round(w * s), Math.round(h * s));
  try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); } catch (_) { return null; }
  return c;
}
/* 4.0：等待時的掃描光只刷一遍，速度跟著處理時間走（不再循環）。
   App 拿不到真正的處理進度，所以用這支手機以往的實際時間當預估（ETA_KEY，各種等待分開記，指數平均）：
   到預估時間時約 82%，之後越來越慢、最多到 95%；處理完成時把剩下的刷完（至少 0.22 秒、整趟至少 0.8 秒），到底時「叮」。
   掃描光用 transform 平移（交給圖形處理器，主執行緒忙時比較不會頓），不再每格改 top／height。 */
const ETA_KEY = 'cocoscan-eta';
function etaGet(k, d) { try { const v = JSON.parse(localStorage.getItem(ETA_KEY) || '{}')[k]; return v > 0 ? v : d; } catch (_) { return d; } }
function etaPut(k, ms) {
  if (!(ms >= 0)) return;
  try { const o = JSON.parse(localStorage.getItem(ETA_KEY) || '{}'), old = o[k]; o[k] = Math.round(Math.min(20000, Math.max(150, old ? old * 0.6 + ms * 0.4 : ms))); localStorage.setItem(ETA_KEY, JSON.stringify(o)); } catch (_) {}
}
const etaP = (t, E) => 0.95 * (1 - Math.exp((-2 * t) / Math.max(800, E)));
const finishDur = (p0, el) => Math.max(220, (1 - p0) * 700, 800 - el);
const finishP = (p0, u) => p0 + (1 - p0) * (1 - Math.pow(1 - clamp01(u), 1.6));
// 成品畫面（#capRes、連拍 #burstPw）用：draw(p, finishing) 每格畫；done() 處理完成時呼叫，回傳刷到底的 Promise
// 4.0.1：超過 3 秒還沒完成，掃描光開始「呼吸」（.wait，CSS 動畫只動透明度，主執行緒忙時照樣會動），讓人知道手機還在跑
const WAIT_MS = 3000;
function sweepRun(key, def, draw, band) {
  const t0 = performance.now(), E = etaGet(key, def);
  let fin = null, p = 0, raf = 0, stopped = false, resolveEnd;
  const end = new Promise((r) => { resolveEnd = r; });
  const tick = (now) => {
    if (stopped) return;
    const e = Math.max(0, now - t0);
    p = fin ? finishP(fin.p0, (e - fin.e) / fin.dur) : etaP(e, E);
    if (band) band.classList.toggle('wait', !fin && e > WAIT_MS);
    draw(p, !!fin);
    if (fin && p >= 1) { stopped = true; if (band) band.classList.remove('wait'); sfxPlay('ding'); resolveEnd(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    get p() { return p; },
    done() { if (!fin && !stopped) { const e = performance.now() - t0; etaPut(key, e); fin = { e, p0: p, dur: finishDur(p, e) }; } return end; },
    stop() { stopped = true; cancelAnimationFrame(raf); if (band) band.classList.remove('wait'); resolveEnd(); },
  };
}
// 成品圖層上的掃描光：高 16%，用自身高度的百分比平移（16% × 6.25 = 100%）
function bandInit(band) { band.classList.remove('wait'); Object.assign(band.style, { display: 'none', left: '0', width: '100%', top: '-16%', height: '16%', transform: '', opacity: 1 }); }
// 4.0.1：只有「刷完」那段（fade）才淡出；等待時停在底部附近也保持全亮（4.0 會淡到幾乎看不見，慢手機像當機）
function bandAtPct(band, p, fade) { band.style.display = 'block'; band.style.transform = `translateY(${p * 625}%)`; band.style.opacity = fade && p > 0.85 ? 1 - (p - 0.85) / 0.15 : 1; }
const capFx = { cur: null };
// frame：拍下那一格；quad：0～1 四角（相對那一格）；stay：立即裁切（掃完停住、掃描光循環，release() 後 ready 才完成）
// 回傳 { landed（飛進縮圖）, ready（立即裁切可以進框選了）, release(), stop() }
function playCapFx(frame, quad, stay) {
  if (capFx.cur) capFx.cur.stop();
  const root = $('#capFx'), dim = root.querySelector('.cf-dim'), pw = root.querySelector('.cf-pw');
  const paper = root.querySelector('.cf-paper'), scan = root.querySelector('.cf-scan'), clip = root.querySelector('.cf-clip'), band = root.querySelector('.cf-band');
  const cw = frame.width, ch = frame.height;
  for (const c of [paper, scan]) { c.width = cw; c.height = ch; c.getContext('2d').drawImage(frame, 0, 0); }
  scan.style.filter = FX_FILTER[settings.mode] || 'none';
  const QP = quad.map((p) => [p[0] * cw, p[1] * ch]);
  const clipPoly = `polygon(${QP.map((p) => p[0] + 'px ' + p[1] + 'px').join(',')})`;
  paper.style.clipPath = scan.style.clipPath = clipPoly;
  // 那一格在畫面上的位置（影片是 contain 置中）
  const st = $('#live .stage').getBoundingClientRect(), R = videoRect();
  const QS = quad.map((p) => [st.left + R.x + p[0] * R.w, st.top + R.y + p[1] * R.h]);
  const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pwd = (len(QP[0], QP[1]) + len(QP[3], QP[2])) / 2 || 1, phd = (len(QP[0], QP[3]) + len(QP[1], QP[2])) / 2 || 1;
  const m = 24, fs = Math.min((st.width - 2 * m) / pwd, (st.height - 2 * m) / phd), rw = pwd * fs, rh = phd * fs;
  const rx = st.left + (st.width - rw) / 2, ry = st.top + (st.height - rh) / 2;
  const RT = [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]];
  const T = { f0: 0.08, f1: 0.4, s0: 0.4, s1: 1.2, y1: 1.5 };
  // stay：立即裁切時是等待種類（'ai'＝等 AI 框選、'crop'＝只等一般偵測），掃描光照這種等待以往的時間走
  const etaK = stay ? 'cap-' + stay : null, E = stay ? etaGet(etaK, stay === 'ai' ? 1500 : 300) : 0;
  let resolveLand, resolveReady, released = !stay, t0 = performance.now(), raf = 0, landedDone = false, dinged = false, fin = null, pCur = 0;
  const landed = new Promise((r) => { resolveLand = r; }), ready = new Promise((r) => { resolveReady = r; });
  pw.style.transform = ''; pw.style.opacity = 1; dim.style.opacity = 0; band.style.display = 'none'; clip.style.clipPath = 'inset(0 0 100% 0)';
  root.classList.add('on');
  const bh = rh * 0.16;
  Object.assign(band.style, { left: rx + 'px', width: rw + 'px', top: (ry - bh) + 'px', height: bh + 'px', transform: '' });
  band.classList.remove('wait');
  const placeBand = (p, fade) => { band.style.display = 'block'; band.style.transform = `translateY(${rh * p}px)`; band.style.opacity = fade && p > 0.85 ? 1 - (p - 0.85) / 0.15 : 1; };
  const h = {
    landed, ready, stop,
    release() { if (!released) { released = true; etaPut(etaK, Math.max(0, performance.now() - t0 - T.s0 * 1000)); } },
  };
  function stop() {
    cancelAnimationFrame(raf); clearTimeout(raf); root.classList.remove('on'); band.style.display = 'none'; band.classList.remove('wait');
    paper.width = paper.height = scan.width = scan.height = 1; // 3.1.1：釋放大張畫布（iPhone 圖層記憶體吃緊時相機畫面會被畫小）
    if (capFx.cur === h) capFx.cur = null;
    if (!landedDone) { landedDone = true; resolveLand(); }
    resolveReady();
  }
  function frameFn(now) {
    const t = (now - t0) / 1000;
    const k = easeIO(clamp01((t - T.f0) / (T.f1 - T.f0)));
    const D = QS.map((p, i) => [p[0] + (RT[i][0] - p[0]) * k, p[1] + (RT[i][1] - p[1]) * k]);
    paper.style.transform = scan.style.transform = homog(QP, D);
    dim.style.opacity = 0.82 * clamp01((t - T.f0) / (T.f1 - T.f0));
    // 掃描：稍後裁切固定 0.8 秒；立即裁切跟著等待時間走、只刷一遍（4.0，取代 3.1 的循環），刷到底「叮」
    const e = Math.max(0, (t - T.s0) * 1000);
    let p = 0;
    if (t >= T.s0) {
      if (!stay) p = easeIO(clamp01(e / 800));
      else {
        if (released && !fin) fin = { e, p0: pCur, dur: finishDur(pCur, e) };
        p = fin ? finishP(fin.p0, (e - fin.e) / fin.dur) : etaP(e, E);
      }
      pCur = p;
      if (stay) band.classList.toggle('wait', !fin && e > WAIT_MS); // 4.0.1：等太久時呼吸
    }
    clip.style.clipPath = `inset(0 0 ${Math.max(0, innerHeight - (ry + rh * p))}px 0)`;
    if (t >= T.s0 && p < 1) placeBand(p, !stay || !!fin);
    if (p >= 1) {
      if (!dinged) { dinged = true; band.classList.remove('wait'); sfxPlay('ding'); }
      if (stay) { band.style.display = 'none'; resolveReady(); return; } // 停在攤平的畫面，等進框選畫面後再 stop()
      band.style.display = 'none';
      const f = easeIn3(clamp01((t - T.s1) / (T.y1 - T.s1)));
      const tb = $('#liveThumb').getBoundingClientRect(), sc = 1 + (tb.width / rw - 1) * f;
      pw.style.transformOrigin = `${rx}px ${ry}px`;
      pw.style.transform = `translate(${(tb.left - rx) * f}px,${(tb.top - ry) * f}px) scale(${sc})`;
      dim.style.opacity = 0.82 * (1 - f);
      if (f >= 1) { stop(); return; }
    }
    raf = requestAnimationFrame(frameFn);
  }
  capFx.cur = h;
  raf = requestAnimationFrame(frameFn);
  return h;
}
// 縮圖跳一下
function bumpThumb() { const tb = $('#liveThumb'); tb.classList.remove('bump'); void tb.offsetWidth; tb.classList.add('bump'); }

/* 立即裁切按「確定」後的成品畫面：先放拉正的原圖（小張、很快），再用目前的模式與數值實際處理一張（長邊 2000），
   處理時金色掃描光循環，好了由上往下掃出來。「繼續編輯」回到框選；「確定」成品飛進縮圖、回到拍攝 */
const capRes = { resolve: null, flying: false };
function capResLayout(ar) {
  const el = $('#capRes'), st = el.querySelector('.cr-stage').getBoundingClientRect(), pw = el.querySelector('.cr-pw'), m = 16;
  const w = Math.min(st.width - 2 * m, (st.height - 2 * m) * ar), h = w / ar;
  Object.assign(pw.style, { left: (st.width - w) / 2 + 'px', top: (st.height - h) / 2 + 'px', width: w + 'px', height: h + 'px', transform: '', transition: '' });
}
/* 5.3.1：成品畫面不用再按「確定」（作者：編輯畫面下方已經有成品可看，掃描動畫本身就是確認）。
   拿掉「繼續編輯」「確定」；有動畫：掃描光刷完停 0.4 秒，飛進左下角縮圖；沒開動畫：成品出現停 1 秒直接收掉；點一下立刻回到拍攝 */
const CAPRES_HOLD = 400, CAPRES_HOLD_STILL = 1000;
function showCapResult(pageId) {
  const el = $('#capRes'), pw = el.querySelector('.cr-pw'), base = el.querySelector('.cr-base'), outC = el.querySelector('.cr-out');
  const clip = el.querySelector('.cr-clip'), band = el.querySelector('.cr-band'), spin = el.querySelector('.cr-spin');
  const anim = animOn();
  let sw = null, done = false;
  el.style.background = ''; el.querySelector('.cr-top').style.visibility = ''; el.querySelector('.cr-bar').style.display = 'none'; // 5.3.1：不用按鈕
  base.width = base.height = outC.width = outC.height = 1; pw.style.width = '0px';
  clip.style.clipPath = 'inset(0 0 100% 0)'; clip.style.opacity = ''; clip.style.transition = ''; bandInit(band); spin.classList.toggle('on', true);
  el.classList.add('on');
  const result = new Promise((res) => {
    capRes.resolve = (v) => { if (done) return; done = true; if (sw) sw.stop(); capRes.resolve = null; res(v); };
  });
  $('#crEdit').onclick = () => { el.classList.remove('on'); for (const c of el.querySelectorAll('canvas')) c.width = c.height = 1; capRes.resolve && capRes.resolve('edit'); }; // 4.2.3：放掉成品大圖
  $('#crOk').onclick = () => capRes.resolve && capRes.resolve('ok');
  el.onclick = () => capRes.resolve && capRes.resolve('ok'); // 5.3.1：點一下立刻回到拍攝
  const autoOk = (ms) => setTimeout(() => { if (!done && capRes.resolve) capRes.resolve('ok'); }, ms); // 只結束這一次的成品畫面
  (async () => {
    try {
      await whenReady();
      const p = await DB.get('pages', pageId); if (!p || done) return;
      const { img, url } = await loadImg(p.original);
      const f0 = smallFrame(img, 900), f1 = smallFrame(img, 2000); URL.revokeObjectURL(url);
      const job = (f, mode, params) => wcall('process', { buffer: f.data.buffer, width: f.width, height: f.height, corners: p.corners, curve: p.curve || null, upscale: 'off', rotation: p.rotation || 0, mode, params }, [f.data.buffer]);
      const r0 = await job(f0, 'original', fillAdj('original'));
      if (done) return;
      drawTo(base, r0); capResLayout(r0.width / r0.height);
      if (anim) { spin.classList.remove('on'); sw = sweepRun('res', 1200, (q, f) => { bandAtPct(band, q, f); if (f) clip.style.clipPath = `inset(0 0 ${(1 - q) * 100}% 0)`; }, band); }
      const r = await job(f1, p.mode, pageAdjOf(p));
      if (done) return;
      drawTo(outC, r); spin.classList.remove('on');
      if (!anim) { clip.style.clipPath = 'none'; band.style.display = 'none'; autoOk(CAPRES_HOLD_STILL); return; }
      // 4.0：已掃過的部分淡入成品，剩下的跟著掃描光刷出來
      clip.style.clipPath = `inset(0 0 ${(1 - sw.p) * 100}% 0)`; clip.style.opacity = 0; clip.style.transition = 'opacity .2s';
      requestAnimationFrame(() => { clip.style.opacity = 1; });
      await sw.done();
      if (done) return;
      band.style.display = 'none'; clip.style.clipPath = 'none'; clip.style.transition = '';
      autoOk(CAPRES_HOLD);
    } catch (e) { console.warn('capRes', e); if (sw) sw.stop(); spin.classList.remove('on'); clip.style.clipPath = 'none'; clip.style.opacity = ''; band.style.display = 'none'; autoOk(CAPRES_HOLD_STILL); }
  })();
  return result;
}
// 「確定」：回到拍攝畫面（底色變透明），成品縮小飛進縮圖
async function capResFly() {
  const el = $('#capRes'), pw = el.querySelector('.cr-pw');
  el.style.background = 'transparent'; el.querySelector('.cr-top').style.visibility = 'hidden'; el.querySelector('.cr-bar').style.visibility = 'hidden';
  el.querySelector('.cr-band').style.display = 'none'; el.querySelector('.cr-clip').style.clipPath = 'none';
  if (animOn()) {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // 等拍攝畫面排好版，縮圖位置才對
    const a = pw.getBoundingClientRect(), tb = $('#liveThumb').getBoundingClientRect();
    pw.style.transformOrigin = '0 0'; pw.style.transition = 'transform .3s cubic-bezier(.5,0,.9,.6)';
    pw.style.transform = `translate(${tb.left - a.left}px,${tb.top - a.top}px) scale(${tb.width / a.width})`;
    await new Promise((r) => setTimeout(r, 320));
  }
  el.classList.remove('on'); pw.style.transition = ''; pw.style.transform = '';
  for (const c of el.querySelectorAll('canvas')) c.width = c.height = 1; // 3.1.1：釋放大張畫布
  bumpThumb();
  fixVideoSoon(); // 3.1.1：動畫圖層收掉後再重接一次相機
}
/* 3.1.1：iPhone 從其他畫面回到拍攝時，相機畫面偶爾用錯的大小重畫（縮小、四周變黑，1.20 第一次遇到）。
   3.1 加了動畫圖層後更常發生，也發生在從文件頁重新開即時掃描時。把串流重新接上一次，強迫用正確大小重畫；
   等畫面穩定（兩個畫格＋短暫延遲）再做，太早做會被還在收掉的圖層蓋過去 */
let fixVT = 0;
function fixVideoSoon(ms) {
  clearTimeout(fixVT);
  fixVT = setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!live.running || current !== 'live' || !live.stream || live.track && live.track.readyState === 'ended') return;
    freshVideo();
  })), ms || 250);
}
/* 3.1.2：只重接串流不夠（作者：立即裁切＋自動 AI，編輯完回到相機還是縮小）。
   改成換一個全新的 <video>（同 id、同屬性），iPhone 舊的影片圖層整個丟掉，用正確大小重新建立。
   程式裡都是用 $('#video') 現找，換掉不影響其他地方 */
function freshVideo() {
  const old = $('#video'); if (!old || !live.stream) return;
  const v = old.cloneNode(false);
  v.muted = true; v.playsInline = true; v.autoplay = true;
  v.onloadedmetadata = updResChip;
  v.srcObject = live.stream;
  old.srcObject = null; old.replaceWith(v);
  v.play().catch(() => {});
}

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

// 3.1.7：框選畫面可以轉向（甲：照片跟著轉，所見即所得）。
// 頁面的四角、曲線一律存「原始照片」座標，旋轉另存 page.rotation（順時針）；框選畫面裡用「轉過的照片」座標操作，
// 打開時換算過去、按確定時換算回來。順時針 90 度：(x, y) → (1 - y, x)，角的順序跟著輪換（左上永遠是第一個）。
const rotPt = (p, r) => (r === 90 ? [1 - p[1], p[0]] : r === 180 ? [1 - p[0], 1 - p[1]] : r === 270 ? [p[1], 1 - p[0]] : [p[0], p[1]]);
function rotQuad(C, curve, r) {
  r = ((r % 360) + 360) % 360;
  const k = r / 90;
  const c2 = [0, 1, 2, 3].map((i) => rotPt(C[(i - k + 4) % 4], r));
  const cv2 = curve ? [0, 1, 2, 3].map((i) => curve[(i - k + 4) % 4].map((p) => rotPt(p, r))) : null;
  return { corners: c2, curve: cv2 };
}
function rotCanvas(src, r) {
  if (!r) return src;
  const c = r === 180 ? canvasOf(src.width, src.height) : canvasOf(src.height, src.width), x = c.getContext('2d');
  x.translate(c.width / 2, c.height / 2); x.rotate((r * Math.PI) / 180); x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
// 框選畫面顯示的照片：轉過的就把畫布存成圖（只給畫面、偵測、AI 用；存檔用的仍是原始照片）
async function setCropView(c) {
  if (c.viewUrl) { URL.revokeObjectURL(c.viewUrl); c.viewUrl = null; }
  let url = c.url;
  if (c.rot) { const b = await toBlob(c.loupeSrc, 'image/jpeg', 0.92); if (b) { c.viewUrl = URL.createObjectURL(b); url = c.viewUrl; } }
  const ci = $('#cropImg');
  await new Promise((res) => { ci.onload = ci.onerror = () => res(); ci.src = url; });
  ci.onload = ci.onerror = null;
}
function cropUrls(c) { if (c.url) URL.revokeObjectURL(c.url); if (c.viewUrl) URL.revokeObjectURL(c.viewUrl); }
// 4.2.3：離開框選畫面時連放大鏡用的大圖（約 2400 像素）一起放掉
function cropFree(c) { cropUrls(c); if (c.loupeSrc) c.loupeSrc.width = c.loupeSrc.height = 0; }
async function openCrop(opts) {
  if (cropCtx) cropFree(cropCtx);
  const { img, url } = await loadImg(opts.blob);
  const rot = ((opts.rotation || 0) % 360 + 360) % 360;
  const curve0 = opts.curve ? normCurve(opts.corners, opts.curve) : null;
  const v = rotQuad(opts.corners, curve0, rot);
  // 放大鏡的取圖來源：把整張照片畫進畫布（整張繪製時各瀏覽器都會正確套用照片方向），
  // 之後只從這張畫布取局部，避免 iPhone Safari 取局部時沒套用方向而錯位
  const ls = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const lc = canvasOf(Math.round(img.naturalWidth * ls), Math.round(img.naturalHeight * ls));
  const lctx = lc.getContext('2d'); lctx.imageSmoothingQuality = 'high';
  lctx.drawImage(img, 0, 0, lc.width, lc.height);
  const nat = rot === 90 || rot === 270 ? [img.naturalHeight, img.naturalWidth] : [img.naturalWidth, img.naturalHeight];
  cropCtx = Object.assign({}, opts, { url, rot, nat, loupeSrc: rotCanvas(lc, rot), corners: v.corners, curve: v.curve, curveMode: false, o0: opts.corners.map((p) => p.slice()), ocv0: JSON.stringify(curve0 && !curveIsStraight(opts.corners, curve0) ? curve0 : null), drag: null, pipKey: 'crop:' + Date.now() });
  const c = cropCtx;
  pipInit(c);
  await setCropView(c);
  if (cropCtx !== c) return;
  $('#cropRetake').style.display = opts.retake ? '' : 'none';
  $('#cropCancel').textContent = opts.liveCrop ? '稍後裁切' : '取消';
  updateCurveBtn();
  if (opts.replace) { history.replaceState({ s: 'crop', doc: state.docId, i: state.pageIndex }, ''); show('crop'); } else go('crop'); // 3.1 成品畫面按「繼續編輯」：不多疊一層返回紀錄
  requestAnimationFrame(layoutCrop);
}
// 3.1.7：向右轉（順時針 90 度）：照片、框、曲線一起轉，放大鏡與成品預覽換成轉過的照片
$('#cropRot').onclick = async () => {
  const c = cropCtx; if (!c || c.rotating) return;
  c.rotating = true;
  try {
    const v = rotQuad(c.corners, c.curve, 90);
    c.rot = (c.rot + 90) % 360; c.corners = v.corners; c.curve = v.curve;
    c.loupeSrc = rotCanvas(c.loupeSrc, 90); c.nat = [c.nat[1], c.nat[0]];
    c.pipKey = 'crop:' + Date.now(); pipInit(c);
    await setCropView(c);
    if (cropCtx === c) layoutCrop();
  } finally { c.rotating = false; }
};
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
  cropCtx.base = { x, y, w, h }; // 沒有縮放時的位置（3.0.1 雙指縮放：版面改變時恢復原尺寸）
  cropCtx.zs = 1;
  placeCrop({ x, y, w, h });
  pipPlace(false);
}
// 把照片、外框、控制點放到 r（裁切區座標）；縮放時控制點大小不變，所以放大後更好點準
function placeCrop(r) {
  cropCtx.rect = r;
  const ci = $('#cropImg');
  Object.assign(ci.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  for (const id of ['#cropSvg', '#cropHandles']) {
    const svg = $(id);
    Object.assign(svg.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    svg.setAttribute('viewBox', `0 0 ${r.w} ${r.h}`);
  }
  drawCrop();
}
// 縮放 s 倍（1～4），讓照片上的 (u, v)（0～1）落在裁切區的 (mx, my)；放大後照片不會被拖到留出大片空白
function zoomCrop(s, u, v, mx, my) {
  const b = cropCtx.base, st = $('#cropStage').getBoundingClientRect(), pad = 26;
  s = Math.min(4, Math.max(1, s));
  if (s < 1.02) { cropCtx.zs = 1; placeCrop({ ...b }); return; }
  const w = b.w * s, h = b.h * s;
  const fit = (pos, size, view) => (size + pad * 2 <= view ? (view - size) / 2 : Math.min(pad, Math.max(view - size - pad, pos)));
  cropCtx.zs = s;
  placeCrop({ x: fit(mx - u * w, w, st.width), y: fit(my - v * h, h, st.height), w, h });
}
// 邊的中點（畫面座標）：有彎度時取曲線上的中點
function edgeMid(i, w, h) {
  const C = cropCtx.corners, a = C[i], b = C[(i + 1) % 4], k = cropCtx.curve && cropCtx.curve[i];
  const p = k ? edgePoint(a, k, b, 0.5) : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return [p[0] * w, p[1] * h];
}
// 1.30：相鄰的邊沿著自己原本的弧線截短或延長。A→B 是那條邊（ctrl 為內部點，0～1 座標），
// 新的角落在「通過 Q、方向 D 的直線」（被拖那條邊平移後的位置，畫面像素）與這條弧線（兩端順著切線延長）的交點上。
// atEnd＝被拖的那個角是 B（否則是 A）。回傳 { corner, ctrl }，找不到交點回傳 null
function slideAlong(A, ctrl, B, Q, D, atEnd, w, h) {
  const px = (p) => [p[0] * w, p[1] * h];
  const path = edgePath(A, ctrl, B, 16).map(px);
  const n = path.length, L = 2 * Math.max(w, h);
  const ext = (p, q) => { const vx = p[0] - q[0], vy = p[1] - q[1], l = Math.hypot(vx, vy) || 1; return [p[0] + (vx / l) * L, p[1] + (vy / l) * L]; };
  const full = [ext(path[0], path[1]), ...path, ext(path[n - 1], path[n - 2])]; // full[1]＝A、full[n]＝B
  const side = (p) => (p[0] - Q[0]) * D[1] - (p[1] - Q[1]) * D[0];
  const corner0 = atEnd ? full[n] : full[1];
  let best = null;
  for (let s = 0; s < full.length - 1; s++) {
    const f0 = side(full[s]), f1 = side(full[s + 1]);
    if ((f0 > 0) === (f1 > 0) && f0 !== 0) continue;
    const t = f0 === f1 ? 0 : f0 / (f0 - f1);
    const p = [full[s][0] + (full[s + 1][0] - full[s][0]) * t, full[s][1] + (full[s + 1][1] - full[s][1]) * t];
    const d = Math.hypot(p[0] - corner0[0], p[1] - corner0[1]);
    if (!best || d < best.d) best = { p, s, d };
  }
  if (!best) return null;
  // 留下「固定的那個角 → 交點」這一段
  if (atEnd && best.s < 1) return null;
  if (!atEnd && best.s + 1 > n) return null;
  const pts = atEnd ? [...full.slice(1, best.s + 1), best.p] : [best.p, ...full.slice(best.s + 1, n + 1)];
  if (pts.length < 2) return null;
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const tot = cum[cum.length - 1];
  if (tot < 4) return null;
  const at = (target) => {
    let k = 1; while (k < pts.length - 1 && cum[k] < target) k++;
    const seg = cum[k] - cum[k - 1] || 1, f = Math.min(1, Math.max(0, (target - cum[k - 1]) / seg));
    return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f];
  };
  const cl = (v) => Math.min(1, Math.max(0, v));
  const nz = (p) => [cl(p[0] / w), cl(p[1] / h)];
  const ctrlOut = Array.from({ length: CURVE_N }, (_, k) => nz(at(((k + 1) / (CURVE_N + 1)) * tot)));
  return { corner: nz(best.p), ctrl: ctrlOut };
}
// 曲線是否其實是直的（存檔時直的就不存曲線）
function curveIsStraight(C, curve) {
  if (!curve) return true;
  return curve.every((k, i) => {
    const a = C[i], b = C[(i + 1) % 4];
    return k.every((p, j) => { const t = (j + 1) / (k.length + 1); return Math.hypot(p[0] - (a[0] + (b[0] - a[0]) * t), p[1] - (a[1] + (b[1] - a[1]) * t)) < 0.0015; });
  });
}
function drawCrop() {
  const { w, h } = cropCtx.rect;
  // 1.28：彎度不管在哪個模式都保留、都畫出來；模式只決定顯示哪一種把手
  const C = cropCtx.corners, curve = cropCtx.curve;
  const P = C.map((p) => [p[0] * w, p[1] * h]);
  const poly = cropOutline(C, curve).map((p) => (p[0] * w).toFixed(1) + ',' + (p[1] * h).toFixed(1)).join(' ');
  const g = cropCtx.drag;
  let html = `<defs><mask id="m"><rect x="-40" y="-40" width="${w + 80}" height="${h + 80}" fill="#fff"/><polygon points="${poly}" fill="#000"/></mask></defs>`;
  html += `<rect x="0" y="0" width="${w}" height="${h}" fill="rgba(28,19,14,.55)" mask="url(#m)"/>`;
  html += `<polygon points="${poly}" fill="none" stroke="#F2C48D" stroke-width="2.5" stroke-linejoin="round"/>`;
  $('#cropSvg').innerHTML = html;
  // 控制點另外畫在最上層（1.12）：預覽小視窗蓋到時也看得到、拖得到
  html = '';
  if (cropCtx.curveMode && curve) {
    // 正在拉的那一點
    if (g && g.type === 'rope') {
      const p = ropePoint(g);
      html += `<circle cx="${p[0] * w}" cy="${p[1] * h}" r="15" fill="rgba(242,196,141,.35)" stroke="#fff" stroke-width="2.5"/><circle cx="${p[0] * w}" cy="${p[1] * h}" r="3.5" fill="#fff"/>`;
    }
  } else {
    // 四條邊的中點把手（拖動只移動那一條邊；邊彎曲時把手放在曲線中點）
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      const [mx, my] = edgeMid(i, w, h);
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
  // 3.0.1 雙指縮放：兩指捏合放大縮小並平移；放大後單指按在沒有控制點的地方可以平移；在空白處點兩下恢復原尺寸。
  // 第二指放下時，取消第一指正在拖的控制點（回到拖之前），避免縮放時順便把角拖走
  const ptrs = new Map();
  let pinch = null, pan = null, lastEmptyTap = 0;
  const inStage = (x, y) => { const b = stage.getBoundingClientRect(); return [x - b.left, y - b.top]; };
  const cancelDrag = () => {
    const g = cropCtx.drag; if (!g) return;
    cropCtx.corners = g.c0.map((p) => p.slice());
    cropCtx.curve = g.k0 ? g.k0.map((k) => k.map((p) => p.slice())) : null;
    cropCtx.drag = null; $('#loupe').style.display = 'none';
    pipRequest(true); pipHideSoon(); drawCrop();
  };
  const startPinch = () => {
    const [a, b] = [...ptrs.values()].map((p) => inStage(p[0], p[1]));
    const r = cropCtx.rect, m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, s0: cropCtx.zs, u: (m[0] - r.x) / r.w, v: (m[1] - r.y) / r.h };
    pan = null;
  };
  const showLoupe = (lx, ly) => { if (cropCtx.zs < 2.5) loupe(lx, ly); else $('#loupe').style.display = 'none'; }; // 放大很多時不需要放大鏡
  stage.addEventListener('pointerdown', (e) => {
    if (!cropCtx) return;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (ptrs.size >= 2) {
      cancelDrag();
      if (ptrs.size === 2) startPinch();
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      return;
    }
    if (pinch || cropCtx.drag) return;
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
        const [mx, my] = edgeMid(i, w, h);
        const d = Math.hypot(mx - lx, my - ly);
        if (d < bd) { bd = d; best = { type: 'edge', i }; }
      }
    }
    if (!best) {
      // 沒按到控制點：按在小視窗上就是移動或點開小視窗
      if (e.target.closest('#pip') && $('#pip').classList.contains('vis')) { e.preventDefault(); pipFullOpen(); return; }
      // 空白處：點兩下恢復原尺寸；放大時按住可以平移
      const now = Date.now();
      if (cropCtx.zs > 1 && now - lastEmptyTap < 320) { lastEmptyTap = 0; zoomCrop(1); return; }
      lastEmptyTap = now;
      if (cropCtx.zs > 1) {
        const r = cropCtx.rect;
        pan = { id: e.pointerId, start: [e.clientX, e.clientY], r0: { ...r } };
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      }
      return;
    }
    best.start = [lx, ly];
    pipShow(lx + cropCtx.rect.x, ly + cropCtx.rect.y);
    best.c0 = cropCtx.corners.map((p) => p.slice());
    best.k0 = cropCtx.curve ? cropCtx.curve.map((e) => e.map((p) => p.slice())) : null;
    cropCtx.drag = best;
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
    drawCrop(); showLoupe(lx, ly);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!cropCtx) return;
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch) {
      if (ptrs.size < 2) return;
      const [a, b] = [...ptrs.values()].slice(0, 2).map((p) => inStage(p[0], p[1]));
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomCrop(pinch.s0 * d / pinch.d0, pinch.u, pinch.v, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      return;
    }
    if (pan) {
      if (e.pointerId !== pan.id) return;
      // 平移＝縮放倍數不變、照片跟著手指移動（照片左上角＝裁切區的 (0,0) 往回推）
      const r0 = pan.r0, nx = r0.x + e.clientX - pan.start[0], ny = r0.y + e.clientY - pan.start[1];
      zoomCrop(cropCtx.zs, -nx / r0.w, -ny / r0.h, 0, 0);
      return;
    }
    const g = cropCtx.drag;
    if (!g) return;
    const [lx, ly] = local(e);
    const { w, h } = cropCtx.rect;
    const dx = lx - g.start[0], dy = ly - g.start[1];
    if (g.type === 'corner') {
      const c = g.c0[g.i];
      const n = [clamp(c[0] + dx / w), clamp(c[1] + dy / h)];
      cropCtx.corners[g.i] = n;
      // 有彎度時（兩種模式都一樣）：相鄰兩條邊的彎曲點跟著按比例移動，保持原本的彎度
      if (g.k0 && cropCtx.curve) {
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
      // 有彎度時：這條邊整條平移（1.28）；相鄰兩條邊的弧線留在原位，兩個角沿著弧線滑動、弧線只截短或延長（1.30，
      // 作者：拖左右邊時上下邊的弧度會跟著變形、不再貼合紙邊）。找不到交點時才退回按比例移動
      if (g.k0 && cropCtx.curve) {
        const ddx = (dn * nx) / w, ddy = (dn * ny) / h, prev = (i + 3) % 4;
        cropCtx.curve[i] = g.k0[i].map((p) => [clamp(p[0] + ddx), clamp(p[1] + ddy)]);
        const Q = [a[0] + dn * nx, a[1] + dn * ny], D = [ex, ey];
        const sp = slideAlong(g.c0[prev], g.k0[prev], g.c0[i], Q, D, true, w, h);
        const sn = slideAlong(g.c0[j], g.k0[j], g.c0[(j + 1) % 4], Q, D, false, w, h);
        if (sp && sn) {
          cropCtx.corners[i] = sp.corner; cropCtx.curve[prev] = sp.ctrl;
          cropCtx.corners[j] = sn.corner; cropCtx.curve[j] = sn.ctrl;
        } else {
          const mv = (ei, jj, f) => { const p = g.k0[ei][jj]; cropCtx.curve[ei][jj] = [clamp(p[0] + ddx * f), clamp(p[1] + ddy * f)]; };
          for (let jj = 0; jj < CURVE_N; jj++) { const u = (jj + 1) / (CURVE_N + 1); mv(prev, jj, u); mv(j, jj, 1 - u); }
        }
      }
    }
    drawCrop(); showLoupe(lx, ly);
    pipAvoid(lx + cropCtx.rect.x, ly + cropCtx.rect.y);
  });
  let lastRope = null; // 1.28：曲線模式點兩下某條邊＝把那條邊拉直
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (!cropCtx) return;
    if (pinch) { if (ptrs.size < 2) pinch = null; return; } // 捏合結束：剩下的手指不接著拖或平移
    if (pan) { if (e.pointerId === pan.id) pan = null; return; }
    const g = cropCtx.drag, was = !!g;
    if (g && g.type === 'rope' && e.type === 'pointerup') {
      const [lx, ly] = local(e), now = Date.now();
      if (Math.hypot(lx - g.start[0], ly - g.start[1]) < 8) {
        if (lastRope && lastRope.i === g.i && now - lastRope.t < 400) {
          const C = cropCtx.corners, a = C[g.i], b = C[(g.i + 1) % 4];
          cropCtx.curve[g.i] = cropCtx.curve[g.i].map((_, j) => { const t = (j + 1) / (CURVE_N + 1); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; });
          lastRope = null; toast('已把這條邊拉直');
        } else lastRope = { i: g.i, t: now };
      } else lastRope = null;
    }
    cropCtx.drag = null; $('#loupe').style.display = 'none'; drawCrop();
    if (was) { pipRequest(true); pipHideSoon(); }
  };
  window.ropePoint = (g) => { const C = cropCtx.corners, k = cropCtx.curve[g.i]; return edgePoint(C[g.i], k, C[(g.i + 1) % 4], g.s); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => { if (ptrs.has(e.pointerId) && !stage.contains(e.target)) end(e); }); // 在裁切區外放開的手指也要清掉

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
    const Q = cropOutline(C, cropCtx.curve).map(toL);
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
window.addEventListener('resize', () => { if (current === 'crop') layoutCrop(); if (current === 'burst') burstLayout(); if (current === 'page') { if (adj.open) { fitAdj(); scheduleRegion(); } else fitView(); } });
$('#cropFull').onclick = () => {
  cropCtx.corners = FULL.map((p) => p.slice());
  cropCtx.curve = cropCtx.curveMode ? straightCurve(cropCtx.corners) : null;
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
    } else c.curve = null;
    if (cropCtx === c) drawCrop();
  } finally { unbusy(); }
};
// 直線／曲線切換（1.28）：只切換把手，彎度一律保留。
// 直線＝拖角、拖邊的中點整條平移；曲線＝抓邊上任何一點拉彎，點兩下某條邊把它拉直
$('#cropCurve').onclick = async () => {
  const c = cropCtx; if (!c) return;
  if (c.curveMode) {
    c.curveMode = false;
    if (curveIsStraight(c.corners, c.curve)) c.curve = null;
  } else {
    c.curveMode = true;
    if (!c.curve) c.curve = straightCurve(c.corners);
    toast('按住邊拉動可以拉彎，點兩下邊可以拉直');
  }
  if (cropCtx === c) { updateCurveBtn(); drawCrop(); }
};
$('#cropOk').onclick = async () => {
  const c = cropCtx; if (!c) return;
  const q = c.corners;
  const area = Math.abs([0, 1, 2, 3].reduce((a, i) => { const j = (i + 1) % 4; return a + q[i][0] * q[j][1] - q[j][0] * q[i][1]; }, 0)) / 2;
  if (area < 0.01) { toast('範圍太小了'); return; }
  if (c.rotating) return;
  cropCtx = null;
  cropFree(c);
  pipClose();
  // 3.1.7：換算回原始照片座標，旋轉另外交給呼叫的地方存進 page.rotation
  const o = rotQuad(q, c.curve, 360 - c.rot);
  const cv = o.curve && !curveIsStraight(o.corners, o.curve) ? o.curve : null;
  // 1.31：使用者有沒有改過範圍（和打開時比，原始照片座標；只轉向不算）；有的話記成「自己調整過範圍」，統一調整的 AI 框選會先詢問
  const edited = !nearSame(o.corners, c.o0) || JSON.stringify(cv) !== c.ocv0;
  await c.onConfirm(o.corners, cv, edited, c.rot);
};
$('#cropCancel').onclick = () => history.back();
$('#cropRetake').onclick = () => { const c = cropCtx; cropCtx = null; if (c) cropFree(c); pipClose(); if (c && c.onRetake) c.onRetake(); history.back(); };
$('#cropPrev').onclick = () => ($('#pipFull').classList.contains('show') ? pipFullClose() : pipFullOpen()); // 3.1：再按一次回到框選

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
  pip.want = { c, hq, corners: c.corners.map((p) => p.slice()), curve: c.curve ? c.curve.map((e) => e.map((p) => p.slice())) : null };
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
// 5.2：回傳輕量版（只有縮圖和設定）；要大圖的地方自己用 DB.get 讀那一頁
async function getDocPages(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc) return { doc: null, pages: [] };
  return { doc, pages: await pagesOf(doc.pageIds) };
}
// 5.2：只要頁面編號（不讀任何頁面資料；只看編號清單，去掉資料庫裡已經不存在的）
async function docPageIds(docId) {
  const doc = await DB.get('docs', docId);
  if (!doc) return { doc: null, ids: [] };
  const have = new Set(await DB.keys('pages'));
  return { doc, ids: doc.pageIds.filter((id) => have.has(id)) };
}
// 5.2：單頁檢視只留正在看的那一頁的大圖網址，其他頁放掉
function dropViewUrls(keepId) {
  for (const [k, v] of urlCache) if ((k.startsWith('v:') || k.startsWith('plain:')) && k.slice(k.indexOf(':') + 1) !== keepId) { URL.revokeObjectURL(v.url); urlCache.delete(k); }
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
  dropViewUrls(''); // 5.2：回到文件畫面，單頁檢視的大圖網址放掉
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
      if (p.needCrop) openPageCropSoon(p.id); // 待裁切的頁：直接打開裁切
    };
    g.appendChild(b);
  });
  updateCropNote(pages);
  const add = document.createElement('button');
  add.className = 'pg add';
  add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>新增頁面';
  // 3.1.3：偶爾點了沒反應（剛進 App、剛從相簿匯入回來）。排序套件碰到這一格會取消觸控事件，iPhone 有時連點擊一起吞掉；
  // 套件改成不取消（preventOnFilter:false），這一格也直接聽手指放開，兩邊在 400 ms 內只開一次
  let addAt = 0;
  const openAdd = () => { const now = Date.now(); if (now - addAt < 400) return; addAt = now; addSheet(); };
  add.onclick = openAdd;
  let addDown = null; // 只算「點一下」：按下到放開移動不到 10 點（捲動頁面時不會誤開）
  add.addEventListener('pointerdown', (e) => { addDown = [e.clientX, e.clientY, Date.now()]; });
  add.addEventListener('pointerup', (e) => {
    const d = addDown; addDown = null;
    if (e.pointerType === 'mouse' || !d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 10 || Date.now() - d[2] > 600) return;
    openAdd();
  });
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
  await docEdit(async () => { // 5.3：排隊
  for (const id of docSel.ids) { await DB.del('pages', id); dropUrls('t:' + id); dropUrls('v:' + id); dropUrls('home:' + id); dropUrls('lib:' + id); dropUrls('strip:' + id); }
  const d2 = await DB.get('docs', doc.id);
  d2.pageIds = d2.pageIds.filter((id) => !docSel.ids.has(id));
  d2.updated = Date.now();
  await DB.put('docs', d2);
  });
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
    filter: '.add', preventOnFilter: false,
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
      await docEdit(async () => { // 5.3：排隊
        const doc = await DB.get('docs', state.docId);
        if (doc.pageIds.join() === ids.join()) return;
        doc.pageIds = ids; doc.updated = Date.now();
        await DB.put('docs', doc);
      });
    },
  });
}
// 1.33：縮圖照成品比例（outW／outH 已含旋轉）。還沒處理好的頁先用 3:4；格子是 3:4，比它寬就撐滿寬、比它瘦就撐滿高
function cardStyle(p) {
  const ar = p && p.outW && p.outH && !isBroken(p) ? p.outW / p.outH : 0.75;
  return `width:${(Math.min(1, ar / 0.75) * 100).toFixed(2)}%;aspect-ratio:${ar.toFixed(4)}`;
}
function fillPageThumb(el, p, i) {
  const src = p.thumb || p.original;
  const wait = !isBroken(p) && (!p.thumb || processing.has(p.id));
  el.innerHTML = `<div class="card" style="${cardStyle(p)}"><img src="${blobUrl('t:' + p.id, src, verOf(p, 'thumb'))}" alt=""><span class="no">${i + 1}</span>${pageCustom(p) ? `<span class="custom" title="這一頁單獨調整過">${ICON.sliders}</span>` : ''}${p.needCrop ? '<i class="cut" title="待裁切">✂</i>' : ''}${wait ? '<span class="wait"><span class="spin sm"></span></span>' : ''}</div>`;
}
function updateCropNote(pages) {
  const n = pages.filter((p) => p.needCrop).length, el = $('#cropNote');
  el.classList.toggle('on', n > 0);
  el.textContent = n ? `✂ 有 ${n} 頁待裁切，點一下那頁就能調整範圍` : '';
}
// 打開頁面後直接進裁切（等頁面資料載入）
async function openPageCropSoon(pageId) {
  for (let i = 0; i < 40 && !(viewPage && viewPage.id === pageId); i++) await new Promise((r) => setTimeout(r, 25));
  if (current === 'page' && viewPage && viewPage.id === pageId) $('#pgCrop').onclick();
}
async function onPageUpdated(pageId) {
  if (current === 'doc') {
    const el = document.querySelector(`.pg[data-id="${pageId}"]`);
    // 1.34：等資料庫的期間文件頁可能已重畫、元素被移除（以前會跳 Cannot read properties of null (reading 'children')）
    if (el) { const p = await DB.get('pages', pageId); if (p && el.isConnected && el.parentNode) fillPageThumb(el, p, [...el.parentNode.children].indexOf(el)); }
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
$('#docAi').onclick = () => aiFrameDoc(); // 3.0.1：原本的「新增頁面」（頁面列最後的＋已有）換成 AI 框選
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
$('#docMode').onclick = () => openSheet(`<h3>統一調整</h3><div class="note" style="margin:4px 4px 10px">選一個模式套用到全部頁面，接著可以調整這份文件統一的數值</div>${MODES.map((m) => `<button class="srow" data-m="${m.id}"><span>${m.name}<span class="sub">${modeDesc(m.id)}</span></span></button>`).join('')}`, (s) => {
  s.querySelectorAll('.srow').forEach((b) => b.onclick = async () => {
    closeSheet();
    openDocAdjust(b.dataset.m);
  });
});
// 統一調整：全部頁面改成這個模式，再進入調整畫面（預覽第一頁，可左右切換預覽的頁面）
async function openDocAdjust(mode) {
  const { doc, pages } = await getDocPages(state.docId);
  if (!pages.length) return;
  // 1.25：記下調整前的狀態，完成後可以一鍵還原
  docAdjSnap = { docId: doc.id, docAdj: doc.adj ? JSON.parse(JSON.stringify(doc.adj)) : null, pages: pages.map((p) => ({ id: p.id, mode: p.mode, adj: p.adj ? JSON.parse(JSON.stringify(p.adj)) : null })) };
  for (const p of pages) { if (p.mode !== mode) { const q = await DB.get('pages', p.id); if (q) { q.mode = mode; await DB.put('pages', q); } p.mode = mode; } } // 先不重算，按完成後一起處理（5.2：整筆讀出再存）
  state.pageIndex = 0;
  viewPage = await DB.get('pages', pages[0].id); // 5.2：預覽要大圖
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
  // 5.2：只讀頁面編號＋正在看的那一頁（以前每滑一頁就把整份文件每一頁整筆重讀一次）
  const { ids } = await docPageIds(state.docId);
  if (!ids.length) { history.back(); return; }
  state.pageIndex = Math.max(0, Math.min(state.pageIndex, ids.length - 1));
  const p = await DB.get('pages', ids[state.pageIndex]);
  if (!p) { history.back(); return; }
  const pages = ids;
  viewPage = p;
  $('#pageTitle').textContent = `第 ${state.pageIndex + 1} / ${pages.length} 頁`;
  $('#prevBtn').style.visibility = state.pageIndex > 0 ? 'visible' : 'hidden';
  $('#nextBtn').style.visibility = state.pageIndex < pages.length - 1 ? 'visible' : 'hidden';
  const img = $('#viewImg');
  const src = p.processed || p.original;
  const url = blobUrl('v:' + p.id, src, verOf(p, 'processed'));
  if (img.getAttribute('src') !== url) {
    img.onload = () => {
      const nat = img.naturalWidth + 'x' + img.naturalHeight, ar = img.naturalWidth / img.naturalHeight;
      // 4.1.2：比例幾乎一樣（精修開關前後只差一兩個像素）就保留放大的位置，方便比較
      if (!keepZoom || !(zoom.ar && Math.abs(ar / zoom.ar - 1) < 0.01)) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
      zoom.nat = nat; zoom.ar = ar; fitView();
      dropViewUrls(p.id); // 5.2：新的那頁顯示出來後，放掉其他頁的大圖
    };
    img.src = url;
  }
  ensureFresh([p]);
  $('#viewBusy').style.display = processing.has(p.id) || isStale(p) ? 'block' : 'none';
  $('#modeChips').innerHTML = MODES.map((m) => `<button class="chip ${p.mode === m.id ? 'on' : ''}" data-m="${m.id}">${m.name}</button>`).join('') +
    `<button class="chip adj" id="adjBtn">${ICON.sliders}調整</button>`;
  $('#modeChips').querySelectorAll('.chip[data-m]').forEach((b) => b.onclick = () => updatePage({ mode: b.dataset.m }));
  $('#adjBtn').onclick = openAdjust;
  updateHistBtns();
  srBtnState(p);
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
      else if (plainReady(viewPage)) { holdStart = p; holdT = setTimeout(plainShow, 320); } // 4.1.2：按住看精修前
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
    plainHide();
    if (pts.size === 0) { g = null; applyZoom(false); if (adj.open) scheduleRegion(); }
    else if (pts.size === 1) { const q = [...pts.values()][0]; g = { type: 'pan', start: q, x0: zoom.x, y0: zoom.y }; }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
})();
// 4.1.2：已精修的頁按住畫面看「精修前」，放開回到精修後（放大的位置不變：圖片大小由版面決定，只換內容）
const plainReady = (p) => !!(p && p.ai && srReady(p) && p.plain instanceof Blob && p.plainKey === plainKeyOf(p) && p.pkey === procKey(p));
let plainOn = false;
function plainShow() {
  const p = viewPage; if (!plainReady(p) || adj.open) return;
  plainOn = true; if (navigator.vibrate) navigator.vibrate(10);
  const img = $('#viewImg'); img.onload = null; // 只換內容，不重新排版（保留放大的位置）
  img.src = blobUrl('plain:' + p.id, p.plain, p.plainKey);
  $('#cmpTag').textContent = '精修前'; $('#cmpTag').style.display = 'block';
}
function plainHide() {
  if (!plainOn) return; plainOn = false;
  const p = viewPage; $('#cmpTag').style.display = 'none';
  if (p) { const img = $('#viewImg'); img.onload = null; img.src = blobUrl('v:' + p.id, p.processed || p.original, verOf(p, 'processed')); }
}
function step(d) { state.pageIndex += d; zoom.s = 1; renderPage(); history.replaceState({ s: 'page', doc: state.docId, i: state.pageIndex }, ''); }
$('#prevBtn').onclick = () => (adj.open && adj.scope === 'doc' ? adjSwitch(-1) : step(-1));
$('#nextBtn').onclick = () => (adj.open && adj.scope === 'doc' ? adjSwitch(1) : step(1));
$('#pageBack').onclick = () => history.back();
async function updatePage(patch) {
  const p = await DB.get('pages', viewPage.id);
  pushHist(p);
  Object.assign(p, patch);
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete p[k]; // 4.1：undefined＝刪除欄位（關閉精修）
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
    blob: p.original, corners: p.corners, curve: p.curve || null, rotation: p.rotation || 0,
    onConfirm: async (c, cv, edited, rot) => { history.back(); await updatePage(Object.assign({ corners: c, curve: cv, rotation: rot, needCrop: false }, edited ? { cropUser: true } : {})); },
  });
};
// 1.25：往前移／往後移拿掉（文件頁可以拖曳排序），換成上一步／下一步
$('#pgUndo').onclick = () => undoPage(-1);
$('#pgRedo').onclick = () => undoPage(1);
$('#pageDel').onclick = async () => {
  if (!confirm('刪除這一頁？')) return;
  const pid = viewPage.id;
  const left = await docEdit(async () => { // 5.3：排隊
    const doc = await DB.get('docs', state.docId);
    doc.pageIds = doc.pageIds.filter((id) => id !== pid);
    doc.updated = Date.now();
    await DB.del('pages', pid);
    if (!doc.pageIds.length) { await DB.del('docs', doc.id); return 0; }
    await DB.put('docs', doc);
    return doc.pageIds.length;
  });
  dropUrls('t:' + pid); dropUrls('v:' + pid); dropUrls('home:' + pid);
  if (!left) { history.go(-2); return; }
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
    const srOk = srReady(p) ? srMap(p) : null; // 4.1：精修過的頁，預覽也從精修圖開始
    const d = await decodeFull(srOk ? srBlobOf(p) : p.original);
    if (!adj.open || key !== adj.key) return;
    const info = await wcall('prepare', { key, buffer: d.data.buffer, width: d.width, height: d.height, corners: srOk ? srOk.corners : p.corners, curve: srOk ? srOk.curve : p.curve || null, upscale: srOk ? 'off' : settings.upscale, maxSide }, [d.data.buffer]);
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
  const { ids } = await docPageIds(state.docId); // 5.2：只讀要預覽的那一頁
  const j = state.pageIndex + d;
  if (j < 0 || j >= ids.length) return;
  const pj = await DB.get('pages', ids[j]); if (!pj) return;
  state.pageIndex = j; viewPage = pj;
  history.replaceState({ s: 'page', doc: state.docId, i: j, adj: 1, scope: 'doc' }, '');
  setAdjNav(ids.length);
  $('#adjMain').style.display = 'none';
  adjPrepare(pj);
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
  showVal(); hideDetail(); renderAdj(!commit);
  if (commit) scheduleRegion();
}
// 1.28：拖動中用小圖即時預覽（draft），放開後補一張清楚的
$('#adjRange').addEventListener('input', () => setAdjValue(adj.active, +$('#adjRange').value, false));
$('#adjRange').addEventListener('change', () => { renderAdj(false); scheduleRegion(); });

function drawTo(canvas, r) {
  if (canvas.width !== r.width || canvas.height !== r.height) { canvas.width = r.width; canvas.height = r.height; }
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), r.width, r.height), 0, 0);
}
async function renderAdj(draft) {
  if (!adj.open || !adj.ready) return;
  if (adj.busy) { adj.pending = draft && adj.pending !== 'full' ? 'draft' : 'full'; return; }
  adj.busy = true;
  try {
    const key = adj.key;
    const r = await wcall('render', { key, mode: adj.mode, params: adj.vals, rotation: adj.rotation, draft: !!draft });
    if (adj.open && key === adj.key) { drawTo($('#adjMain'), r); $('#adjMain').style.display = 'block'; }
  } catch (e) { console.warn(e); }
  adj.busy = false;
  if (adj.pending) { const p = adj.pending; adj.pending = false; renderAdj(p === 'draft'); }
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
      pushHist(pg);
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
      if (p.adj && p.adj[mode] && (overwrite || JSON.stringify(fillAdj(mode, p.adj[mode])) === JSON.stringify(vals))) { const q = await DB.get('pages', p.id); if (q && q.adj) { delete q.adj[mode]; await DB.put('pages', q); } } // 5.2：整筆讀出再存
    }
  }
  const { pages: fresh } = await getDocPages(docId);
  ensureFresh(fresh);
  if (current === 'doc') renderDoc();
  const snap = docAdjSnap && docAdjSnap.docId === docId ? docAdjSnap : null;
  docAdjSnap = null;
  const msg = changed ? `已套用到全部頁面（${MODES.find((m) => m.id === mode).name}）` : `全部頁面已改成「${MODES.find((m) => m.id === mode).name}」`;
  undoBar(msg, snap ? () => restoreDocAdjust(snap) : null);
}
let docAdjSnap = null;
async function restoreDocAdjust(snap) {
  const doc = await DB.get('docs', snap.docId);
  if (!doc) return;
  if (snap.docAdj) doc.adj = snap.docAdj; else delete doc.adj;
  docAdjCache.set(doc.id, doc.adj);
  await DB.put('docs', doc);
  for (const s of snap.pages) {
    const p = await DB.get('pages', s.id); if (!p) continue;
    p.mode = s.mode; if (s.adj) p.adj = s.adj; else delete p.adj;
    await DB.put('pages', p);
  }
  const { pages } = await getDocPages(doc.id);
  ensureFresh(pages);
  if (current === 'doc') renderDoc();
  toast('已還原統一調整前的設定');
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
    // 5.2：做到這一頁才讀它的大圖，放進 PDF 後就放掉
    const full = pages[i].lite ? await DB.get('pages', pages[i].id) : pages[i];
    if (!full || !full.processed) throw new Error(`第 ${i + 1} 頁讀取失敗`);
    const im = await pageImageForPdf(full);
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
        const ready = pages.filter(hasProc);
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
      const ready = pages.filter(hasProc);
      // 5.2：一頁一頁讀，只留處理後的圖（分享時檔案要同時在，但不再連原圖一起讀進來）
      const files = [];
      for (let i = 0; i < ready.length; i++) {
        busy(`準備圖片 ${i + 1} / ${ready.length}`);
        const q = await DB.get('pages', ready[i].id); if (!q || !q.processed) continue;
        const ext = q.processed.type === 'image/png' ? 'png' : 'jpg';
        const suffix = ready.length > 1 ? '_' + String(i + 1).padStart(2, '0') : '';
        files.push(new File([q.processed], `${name}${suffix}.${ext}`, { type: q.processed.type }));
      }
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
    <div class="switch"><span>✨ 自動 AI 框選<small id="aiStat">即時掃描、高畫質拍照、相簿匯入都自動用 AI 框選紙張</small></span><button class="tg ${settings.autoAI ? 'on' : ''}" id="setAuto"></button></div>
    <div class="switch"><span>倒數拍攝<small>即時掃描偵測不到框選範圍時，拿穩後倒數 3 秒自動拍下（只在自動拍攝時）</small></span><button class="tg ${settings.countdown ? 'on' : ''}" data-k="countdown"></button></div>
    <div class="switch"><span>拍攝動畫<small id="animNote">即時掃描拍下時的攤平、掃描光動畫；手機較舊覺得卡可以關掉</small></span><button class="tg ${animPref() ? 'on' : ''}" id="setAnim"></button></div>
    <div class="switch"><span>拍攝音效<small>快門聲與掃描音效，跟著手機音量（iPhone 開靜音時不會響）</small></span><button class="tg ${settings.sound !== false ? 'on' : ''}" data-k="sound"></button></div>
    <button class="srow" id="setAiUp" style="display:none"><span>有可升級的AI 引擎，點擊升級 ›<span class="sub">AI 框選速度更快，需要下載約 ${AI_UP_MB} MB</span></span></button>
    ${IS_IOS
    ? '<div class="note" style="margin:10px 2px 4px">橫拿拍攝：請關閉螢幕方向鎖定，直接橫拿就可以拍。</div>'
    : !hasMotion() ? '' : `<div class="switch"><span>橫拿拍攝<small>橫拿時按鈕跟著轉、拍好的頁自動轉正</small></span><button class="tg ${settings.landscape !== false ? 'on' : ''}" data-k="landscape"></button></div>`}
    <div class="lbl" style="margin-top:12px">小圖平滑放大<small style="display:block;font-size:12px;margin-top:2px">讓解析度低的圖片（例如別人傳來的照片）轉黑白時邊緣更平順</small></div>
    <div class="seg" id="setUp">${[['auto', '自動'], ['always', '一律'], ['off', '關閉']].map(([k, n]) => `<button data-k="${k}" class="${settings.upscale === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="lbl" style="margin-top:12px">即時掃描畫質<small id="camDesc" style="display:block;font-size:12px;margin-top:2px"></small></div>
    <div class="seg" id="setCam">${[['auto', '自動'], ['high', '高畫質'], ['low', '省記憶體']].map(([k, n]) => `<button data-k="${k}" class="${(settings.camQ || 'auto') === k ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${IS_IOS ? '<button class="srow" id="setCamPerm" style="margin-top:6px"><span>📷 每次都要允許相機？ ›<span class="sub">設定成永遠允許，開即時掃描就不用每次按</span></span></button>' : ''}
    <button class="srow" id="setDefAdj" style="margin-top:6px"><span>預設調整數值 ›<span class="sub">新文件一開始用的曝光、濃淡、銳利度等數值</span></span></button>
    <button class="srow" id="setReport"><span>🐞 回報問題或建議 ›</span></button>
    <button class="srow" id="setLog"><span>更新日誌 ›<span class="sub">目前版本 v${APP_VER}</span></span></button>
    <div class="note">所有掃描只存在這支手機的瀏覽器裡，不會上傳。<br>即時掃描的畫質見上方「即時掃描畫質」：iPhone 最高約 1200 萬畫素（網頁相機的上限），Android 最高 1600 萬畫素。要最清楚的畫質請用「高畫質拍照」。</div>
    <div class="note" id="storeInfo"></div>
    <div class="switch" id="teedMarkRow" style="${settings.teedMarkShown ? '' : 'display:none'}"><span>顯示 TEED 協助標記<small>測試用：即時掃描 TEED 找到的框改成金色；AI 框選時提示 TEED 換了哪幾條邊</small></span><button class="tg ${settings.teedMark ? 'on' : ''}" data-k="teedMark"></button></div>
    <div class="note" id="srInfo" style="font-size:12px;${settings.teedMarkShown ? '' : 'display:none'}"><div id="srInfoTx">${srInfoText()}</div><button class="srow" id="srRebench" style="margin-top:6px"><span>重新測速（精修與框選）</span></button><button class="srow" id="aiUnsafe" style="${settings.aiSafeCPU || settings.aiCrashN ? '' : 'display:none'}"><span>解除框選閃退保護</span></button></div>
    <div class="note" id="setVer" style="font-size:11px;opacity:.7">${viewportInfo()}・v${APP_VER}</div>`, (s) => {
    // 5.0：隱藏區（TEED 協助標記開關、AI 診斷）。5.1.9 起入口改在更新日誌的「目前版本」連點 5 下（logCurrent），這裡不再能點
    s.querySelector('#srRebench').onclick = async () => { // 5.1.7：隱藏區手動重測；5.1.9 精修與框選一起
      try {
        if (!(await srEnsureModel())) return;
        settings.aiBenchV = null; settings.aiBenchN = 0; aiBenchedNow = false; saveSettings();
        await srBenchNow(true); await aiInit(); await aiBench();
      } catch (e) { toast('測速失敗：' + (e && e.message ? e.message : e)); }
      const t = s.querySelector('#srInfoTx'); if (t) t.innerHTML = srInfoText();
    };
    s.querySelector('#aiUnsafe').onclick = () => { // 5.1.9：手動解除框選閃退保護
      settings.aiSafeCPU = false; settings.aiCrashN = 0; aiSafeNow = false; settings.aiBenchV = null; settings.aiBenchN = 0; aiBenchedNow = false; saveSettings();
      aiNote('手動解除框選閃退保護'); aiReleaseNow();
      s.querySelector('#aiUnsafe').style.display = 'none';
      const t = s.querySelector('#srInfoTx'); if (t) t.innerHTML = srInfoText();
      toast('已解除，下次 AI 框選會重新比較 CPU／GPU');
    };
    s.querySelector('#setDefAdj').onclick = () => openDefAdj('bw');
    // 3.0：還在用舊 AI 引擎的人（按過「暫時不要」或還沒被問）才顯示，升級後消失（3.0.1 搬到自動 AI 框選開關下方）
    // 3.0.1：自動 AI 框選開關（和拍攝畫面的 AI 按鈕同一個設定，整個 App 共用）；下面一行顯示 AI 資料的狀態。
    // 還沒下載的人打開時詢問下載，下載完才算開啟；按「暫時不要」或下載失敗維持關閉
    const aiStat = async () => {
      const st = await aiState(), el = s.querySelector('#aiStat'), up = s.querySelector('#setAiUp');
      if (!el) return;
      const ok = st.model && aiPickEngine(st);
      el.textContent = !ok ? `即時掃描、高畫質拍照、相簿匯入都自動用 AI 框選。尚未下載 AI 資料（約 ${AI_DL_MB} MB），打開時會詢問下載`
        : '即時掃描、高畫質拍照、相簿匯入都自動用 AI 框選。AI 資料已下載，離線也能用';
      if (up) up.style.display = aiUpgradable(st) ? '' : 'none';
    };
    aiStat();
    s.querySelector('#setAiUp').onclick = async () => {
      if (await aiUpgrade()) { aiStat(); toast('AI 引擎已升級'); }
    };
    // 3.1 拍攝動畫：沒設定過時弱 Android 預設關；系統開了「減少動態效果」一律不播
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) s.querySelector('#animNote').textContent = '手機已開啟「減少動態效果」，動畫不會播放';
    s.querySelector('#setAnim').onclick = () => { settings.capAnim = !animPref(); saveSettings(); s.querySelector('#setAnim').classList.toggle('on', settings.capAnim); };
    s.querySelector('#setAuto').onclick = async () => {
      const b = s.querySelector('#setAuto');
      if (settings.autoAI) {
        settings.autoAI = false; settings.aiAsked = true; saveSettings(); b.classList.remove('on');
        return;
      }
      if (await aiCached()) {
        settings.autoAI = true; settings.aiAsked = true; saveSettings(); b.classList.add('on');
        return;
      }
      const ok = await aiEnsure(true); // 詢問視窗會蓋掉設定畫面，結束後再打開設定
      if (ok) { settings.autoAI = true; settings.aiAsked = true; saveSettings(); }
      $('#btnSettings').onclick();
      if (ok) toast('已開啟自動 AI 框選');
    };
    if (s.querySelector('#setCamPerm')) s.querySelector('#setCamPerm').onclick = () => camPermHelp();
    const camDesc = () => {
      const q = settings.camQ || 'auto', t = camTier();
      s.querySelector('#camDesc').textContent = q === 'auto'
        ? `自動：依這支手機判斷（目前為「${TIER_NAME[t]}」，每張約 ${tierMP(t) * 100} 萬畫素）${settings.camAutoLow ? '・曾經記憶體不足，已自動改用省記憶體' : ''}`
        : q === 'high' ? `一律最高：每張約 ${tierMP('high') * 100} 萬畫素` : '一律 800 萬畫素，適合較舊的手機';
    };
    camDesc();
    s.querySelectorAll('#setCam button').forEach((b) => b.onclick = () => {
      settings.camQ = b.dataset.k; settings.camAutoLow = false; saveSettings(); // 自己選過就重新開始判斷
      s.querySelectorAll('#setCam button').forEach((x) => x.classList.toggle('on', x === b));
      camDesc();
    });
    s.querySelector('#setReport').onclick = () => window.open(REPORT_URL, '_blank', 'noopener');
    s.querySelector('#setLog').onclick = () => { closeSheet(); showChangelog(); };
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
    s.querySelectorAll('.tg[data-k]').forEach((b) => b.onclick = () => { settings[b.dataset.k] = !settings[b.dataset.k]; saveSettings(); b.classList.toggle('on', settings[b.dataset.k]); });
    if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then((e) => {
      const el = s.querySelector('#storeInfo');
      el.textContent = `已使用空間 ${(e.usage / 1048576).toFixed(0)} MB`;
      storeCounts().then((c) => { el.textContent = `已使用空間 ${(e.usage / 1048576).toFixed(0)} MB・文件 ${c.docs} 份・頁面 ${c.pages} 頁${c.loose ? `（其中 ${c.loose} 頁沒有登記到文件）` : ''}`; }).catch(() => {}); // 4.2.4
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
  if (!seen) { openHelp(); logMarkSeen(); } // 第一次使用：只跳教學，日誌視為已看過
  else if (hasNewLog()) setTimeout(showChangelog, 300);
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
      <li><b>高畫質拍照</b>：單張拍攝，使用手機相機拍，畫質會比即時掃描更清楚。</li>
      <li><b>相簿匯入</b>：使用手機相簿中的相片進行編輯。</li></ul>
    <h4>即時掃描小技巧</h4><ul>
      <li>樂譜放在<b>深色、素面</b>的桌面或布上，框得最準；白桌、床單等淺色或有花紋的背景容易框錯。</li>
      <li>讓紙佔畫面約八分滿，綠框出現後拿穩，看到「✓ 已拍好」就完成；翻頁或換一張紙，會自動拍下一張。</li>
      <li>書本攤開時，對準要拍的那一頁就好；釘起來的講義，把拍完的頁摺到背面再拍。</li>
      <li>框不準時可以直接按快門，拍完再調整範圍，或在裁切畫面按「AI 框選」。</li>
      <li>右上角可以切換「自動／手動拍攝」，以及「立即／稍後裁切」：立即裁切每拍一張就進入裁切畫面，確認成品後再拍下一張；稍後裁切可以連續拍，之後再調整。</li>
      <li>光線不足時，點左上角的 ⚡ 開燈。</li>
      <li>iPhone 每次都要按「允許」使用相機：到 iPhone 的「設定」→「App」→「Safari」→「相機」，改成「允許」。</li></ul>
    <h4>裁切</h4><ul>
      <li>拖四個角或拖邊來調整範圍，放大鏡能幫你對準。兩指捏合可以放大畫面，調得更精準；在空白處點兩下恢復原尺寸。</li>
      <li>書頁彎曲時切到「曲線」，抓住框線哪裡彎就往哪裡拉，存檔時會自動拉平；點兩下某條邊可以把它拉直。切回「直線」時彎度會保留，方便拖角或整條邊。</li>
      <li>拖動時，畫面的另一角會出現成品預覽，可以邊拉邊確認譜是不是平的；按下方的「成品」可以看大圖。</li>
      <li>框得很不準時，按「AI 框選」讓 AI 重新找紙；書頁的上下邊有彎曲時，AI 會自動貼合彎度。文件頁下方的「✨ AI 框選」可以一次處理全部頁面。</li>
      <li>即時掃描左上角的「AI」按鈕，或「設定」裡的開關，可以開啟「自動 AI 框選」：即時掃描、高畫質拍照、相簿匯入都會自動用 AI 框好（即時掃描稍後裁切時，按「完成」後一次處理；立即裁切時先框好再進裁切畫面）。</li></ul>
    <h4>模式與調整</h4><ul>
      <li>黑白最適合樂譜，灰階、彩色適合有照片或顏色的講義。</li>
      <li>「調整」可以改曝光、濃淡、去雜點等。按住畫面，可以和原本的數值比較。</li>
      <li>文件頁的「統一調整」可以一次調整全部頁面；在單頁裡調整只會影響那一頁。</li>
      <li>單頁右上角的「✨ 精修」用 AI 讓線條與文字更清晰，四種模式都適用；處理需要一點時間（較舊的手機可能要幾分鐘），再按一次可以關閉。精修後按住畫面可以看精修前的樣子，放開回到精修後。</li>
      <li>常用的數值可以在「設定 → 預設調整數值」改好，之後的新文件都會從這組數值開始。</li></ul>
    <h4>管理文件</h4><ul>
      <li>長按頁面可以拖曳排序，也可以選取多頁刪除。</li>
      <li>單頁編輯時，可以用「上一步／下一步」復原修改。</li>
      <li>在「全部文件」裡可以合併或刪除文件。</li>
      <li>點文件名稱就能改名，輸入框會自動全選，直接打新名字即可。</li></ul>
    <h4>匯出</h4><ul>
      <li>匯出 PDF 或圖片，檔名可以自己改。</li>
      <li>iPhone 匯出 PDF 後，按「分享／儲存到檔案」會打開 PDF，點右上角的分享圖示，就能傳到 LINE 或存到檔案。</li></ul>
    <div class="warn"><h4>⚠ 重要提醒</h4><ul>
      <li>掃描只存在這支手機裡，不會上傳。</li>
      <li>刪除主畫面上的 App，或清除瀏覽器資料，掃描就會全部消失。重要的樂譜請記得匯出 PDF 備份。</li></ul></div>
    <h4>遇到問題？</h4><ul>
      <li>封面最下方的「🐞 回報問題或建議」可以告訴我；右下角的版本號可以查看更新內容。</li></ul>
    <button class="close-help" id="helpClose">我知道了</button></div>`, (sh) => {
    sh.querySelector('#helpClose').onclick = closeSheet; sh.scrollTop = 0;
    const a = sh.querySelector('#helpA2'); if (a) a.onclick = () => { closeSheet(); tryInstall(); };
  });
}
$('#cvDonate').onclick = () => openDonate();

/* ---------- 上一步／下一步（1.25） ----------
   每一頁各自記錄（轉向、裁切含 AI 框選、模式、單頁調整），最多 20 步；只在這次使用中有效（存在記憶體） */
const hist = new Map();
const HIST_MAX = 20;
function snapOf(p) {
  return JSON.parse(JSON.stringify({ corners: p.corners, curve: p.curve || null, rotation: p.rotation || 0, mode: p.mode, adj: p.adj || null, needCrop: !!p.needCrop, ai: p.ai ? p.aiSide || 1 : 0 }));
}
function pushHist(p, tag) {
  let h = hist.get(p.id);
  if (!h) { h = { past: [], fut: [] }; hist.set(p.id, h); }
  const s = snapOf(p); s.tag = tag || null;
  h.past.push(s); if (h.past.length > HIST_MAX) h.past.shift();
  h.fut = [];
}
async function applySnap(pageId, s) {
  const p = await DB.get('pages', pageId); if (!p) return null;
  p.corners = s.corners; p.curve = s.curve; p.rotation = s.rotation; p.mode = s.mode;
  if (s.adj) p.adj = s.adj; else delete p.adj;
  if (s.needCrop) p.needCrop = true; else delete p.needCrop;
  if (s.ai) { p.ai = true; p.aiSide = s.ai; } else { delete p.ai; delete p.aiSide; } // 4.1（4.1.1 起精修圖留著）
  await DB.put('pages', p);
  enqueue(p.id);
  return p;
}
async function undoPage(dir) {
  if (!viewPage) return;
  const h = hist.get(viewPage.id);
  const from = h && (dir < 0 ? h.past : h.fut);
  if (!from || !from.length) return;
  const cur = await DB.get('pages', viewPage.id); if (!cur) return;
  const s = from.pop();
  (dir < 0 ? h.fut : h.past).push(snapOf(cur));
  const p = await applySnap(viewPage.id, s);
  if (p) viewPage = p;
  renderPage(true);
  toast(dir < 0 ? '已回到上一步' : '已重做下一步');
}
function updateHistBtns() {
  const h = viewPage && hist.get(viewPage.id);
  $('#pgUndo').disabled = !(h && h.past.length);
  $('#pgRedo').disabled = !(h && h.fut.length);
}
let undoT;
function undoBar(msg, fn) {
  const b = $('#undoBar');
  b.querySelector('span').textContent = msg;
  const btn = $('#undoBtn');
  btn.style.display = fn ? '' : 'none';
  btn.onclick = async () => { b.classList.remove('show'); clearTimeout(undoT); if (fn) await fn(); };
  b.classList.add('show');
  clearTimeout(undoT);
  undoT = setTimeout(() => b.classList.remove('show'), fn ? 8000 : 3000);
}

/* ---------- AI 框選（1.25；3.0 新引擎） ----------
   U²-Net（u2netp，4.6 MB）在 ai-worker.js 以 ONNX Runtime Web 執行，找出「哪一塊是紙」；
   worker.js 的 maskQuad 再把遮罩變成四個角並沿紙邊貼齊。模型與執行環境第一次使用時才下載，
   存在獨立的快取 cocoscan-ai（換版本不會被清掉），之後離線也能用。
   3.0：新引擎 ONNX Runtime Web 1.30.0（可用 GPU／WebGPU，約 32 MB；作者決定一律裝新的）。
     - 下載完在背景比較一次 CPU 與 GPU（aiBench），快的記在 settings.aiEP（iPhone 17 實測 GPU 快 4 倍多，Y31 GPU 反而慢）
     - 舊使用者（快取裡只有 1.17.3 舊引擎）：舊引擎照常可用；進拍攝畫面詢問一次升級（settings.aiUpAsked），
       按「暫時不要」的在設定「自動 AI 框選」開關下方出現（3.0.1 前在「預設調整數值」下方）「有可升級的AI 引擎，點擊升級」，升級後消失
     - 安全網：新引擎載入失敗（ENGINE: 錯誤）→ settings.aiForceOld，下載舊引擎改用它；GPU 出錯由 ai-worker 自動改用 CPU */
const AI_MODEL = ['lib/ai/u2netp.onnx', 'application/octet-stream', 4574861];
const AI_NEW = [['lib/ai/ort.webgpu.min.js', 'text/javascript', 66417], ['lib/ai/ort-wasm-simd-threaded.asyncify.mjs', 'text/javascript', 53057], ['lib/ai/ort-wasm-simd-threaded.asyncify.wasm', 'application/wasm', 26781914]];
const AI_OLD = [['lib/ai/ort.wasm.min.js', 'text/javascript', 145070], ['lib/ai/ort-wasm-simd.wasm', 'application/wasm', 10551547]];
const AI_NEW_VER = '1.30.0';
// 4.2：TEED 邊緣模型（MIT，0.25 MB），跟 AI 框選互助（白色／淺色背景、書溝、線圈、隔壁頁）。新下載 AI 資料時一起下載；
// 已經下載過的舊使用者在背景安靜補抓（teedFetchBg），還沒抓到前照舊只用 AI
const TEED_FILE = ['lib/ai/teed.onnx', 'application/octet-stream', 253352];
const AI_CACHE = 'cocoscan-ai';
const mbOf = (list) => Math.ceil(list.reduce((a, f) => a + f[2], 0) / 1e6); // 跟使用者說的 MB（新下載 32、升級 27）
let aiWorker = null, aiSeq = 0, aiInitP = null, aiEngineNow = null;
const aiPending = new Map();
async function aiHas(list) {
  try {
    if (!('caches' in window)) return false;
    const c = await caches.open(AI_CACHE);
    for (const [f] of list) if (!(await c.match(new URL(f, location.href).href))) return false;
    return true;
  } catch (_) { return false; }
}
async function aiState() {
  const [model, neu, old] = await Promise.all([aiHas([AI_MODEL]), aiHas(AI_NEW), aiHas(AI_OLD)]);
  return { model, neu, old };
}
// 能用 AI 的引擎：新引擎（沒被安全網停用）優先，其次舊引擎
function aiPickEngine(st) { return st.neu && !aiOldNow ? 'new' : st.old ? 'old' : st.neu ? 'new' : null; }
/* 5.1.7：AI 的「退一步」都只算暫時，之後自動再試（作者：不希望正式版使用者被永久卡在慢速；測試版 iPhone 17 精修一頁超過 1 分鐘、GPU 無法使用，
   正式版同一支手機不到 20 秒）。原本三個永久降級：
   (1) 新引擎載入失敗一次 → settings.aiForceOld 永久用舊引擎（沒有 GPU）→ 改成 aiOldNow 只在這次打開期間；舊的 aiForceOld 啟動時清掉、記一筆
   (2) 精修測速只測一次 → 測到 CPU（GPU 無法使用或比較慢）就每次打開第一次精修重測，連續 3 次（SR_RETRY）才定案；精修途中 GPU 出錯改用 CPU 的那次不算進速度
   (3) 框選閃退保護一次就永久 CPU → 第一次只在這次打開期間用 CPU（aiSafeNow），下次再試 GPU；第二次（settings.aiCrashN ≥ 2）才永久；GPU 批次框選順利做完就歸零
   設定最下方隱藏區（連點版號 5 次）顯示引擎、GPU 狀態、原因與最近紀錄（settings.aiLog，保留 8 筆），並有「重新測速」按鈕 */
let aiOldNow = false, aiSafeNow = false, aiEPNow = null, srBenchedNow = false;
function aiNote(t) {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  settings.aiLog = [`${d.getMonth() + 1}/${d.getDate()} ${z(d.getHours())}:${z(d.getMinutes())} ${t}`, ...(settings.aiLog || [])].slice(0, 8); saveSettings();
}
if (settings.aiForceOld) { settings.aiForceOld = false; saveSettings(); aiNote('啟動時是相容模式（舊引擎），改試新引擎'); }
if (settings.aiSafeCPU && settings.aiCrashN == null) { settings.aiSafeCPU = false; settings.aiCrashN = 1; settings.aiBenchV = null; saveSettings(); aiNote('框選閃退保護（舊版一次就永久 CPU）改回可試 GPU'); }
// 5.1.9：閃退保護定案（一律 CPU）後，更新到新版本時再給一次機會（再中斷一次就又定案）
else if (settings.aiSafeCPU && settings.aiSafeVer !== APP_VER) { settings.aiSafeCPU = false; settings.aiCrashN = 1; settings.aiBenchV = null; settings.aiBenchN = 0; saveSettings(); aiNote('更新到新版本，框選閃退保護再給一次 GPU 機會'); }
async function aiCached() { const st = await aiState(); return st.model && !!aiPickEngine(st); }
const aiUpgradable = (st) => st.model && st.old && !st.neu && !aiOldNow;
function aiReset() {
  if (aiWorker) aiWorker.terminate();
  for (const p of aiPending.values()) p.rej(new Error('AI 重新載入'));
  aiPending.clear(); aiWorker = null; aiInitP = null; aiEngineNow = null;
}
/* 4.2.1：用完就釋放 AI 引擎（整個 ai-worker 結束掉，GPU 與 WebAssembly 的記憶體都還給系統；下次用再載入，約 0.5 秒）。
   一次框選做完、AI 精修做完後排一次；閒置 3 秒、沒有工作、沒有批次與精修進行中才真的釋放 */
let aiLastUse = 0, aiRelT = 0, aiBatchOn = false;
// 4.2.3：沒有工作在跑就馬上釋放，有的話等閒置再釋放
function aiReleaseNow() { if (aiWorker && !aiPending.size && !aiBatchOn && !srProg.size) aiReset(); else aiReleaseSoon(); }
function aiReleaseSoon() {
  clearTimeout(aiRelT);
  aiRelT = setTimeout(() => {
    if (!aiWorker) return;
    if (aiPending.size || aiBatchOn || srProg.size || performance.now() - aiLastUse < 2500) { aiReleaseSoon(); return; }
    aiReset();
  }, 3000);
}
// 4.2.1 閃退保護：批次框選開始時記下、結束清掉；下次打開還在＝上次框到一半閃退 → AI 框選改用 CPU（較省記憶體）並提示
const AI_BATCH_KEY = 'cocoscan-aibatch';
function aiBatchMark(on) {
  aiBatchOn = on;
  try { if (on) localStorage.setItem(AI_BATCH_KEY, String(Date.now())); else localStorage.removeItem(AI_BATCH_KEY); } catch (_) {}
  if (!on && aiEPNow === 'webgpu' && settings.aiCrashN) { settings.aiCrashN = 0; saveSettings(); } // 5.1.7：GPU 順利做完一批，閃退次數歸零
}
function aiCrashCheck() {
  let was = null; try { was = localStorage.getItem(AI_BATCH_KEY); localStorage.removeItem(AI_BATCH_KEY); } catch (_) {}
  if (!was) return;
  settings.aiCrashN = (settings.aiCrashN || 0) + 1; aiSafeNow = true; // 5.1.7：這次打開期間先用 CPU
  if (settings.aiCrashN >= 2) { settings.aiEP = 'wasm'; settings.aiSafeCPU = true; settings.aiSafeVer = APP_VER; aiNote('框選又中斷（第 2 次），這個版本一律用 CPU'); }
  else aiNote('框選中斷（第 1 次），這次先用 CPU，下次打開再試 GPU');
  saveSettings();
  setTimeout(() => toast('上次 AI 框選中斷，已改用較省記憶體的方式'), 1500);
}
aiCrashCheck();
function aiPost(payload, transfer) {
  aiLastUse = performance.now();
  return new Promise((res, rej) => { const id = ++aiSeq; aiPending.set(id, { res, rej }); aiWorker.postMessage(Object.assign({ id }, payload), transfer || []); });
}
function aiInit() {
  if (aiInitP) return aiInitP;
  aiInitP = (async () => {
    const st = await aiState();
    const eng = aiPickEngine(st) || 'new';
    aiWorker = new Worker('ai-worker.js');
    aiWorker.onmessage = (e) => { const p = aiPending.get(e.data.id); if (!p) return; aiPending.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); };
    aiWorker.onerror = (e) => { for (const p of aiPending.values()) p.rej(new Error('ENGINE:' + (e.message || 'AI 載入失敗'))); aiPending.clear(); aiWorker = null; aiInitP = null; };
    const r0 = await aiPost({ type: 'init', engine: eng, ep: aiSafeNow ? 'wasm' : settings.aiEP || 'wasm' });
    aiEngineNow = eng; aiEPNow = r0 && r0.ep;
    // 新引擎還沒比較過 CPU／GPU（例如剛下載完、或新版第一次用）：在背景比較一次
    // 5.1.9：比出 CPU（GPU 無法使用或比較慢）就每次打開再比一次，連續 3 次（AI_RETRY）才定案；閃退保護中不比
    if (eng === 'new' && !settings.aiSafeCPU && (settings.aiBenchV !== AI_NEW_VER || (settings.aiEP !== 'webgpu' && (settings.aiBenchN || 1) < AI_RETRY && !aiBenchedNow))) aiBench();
  })();
  aiInitP.catch(() => { aiInitP = null; }); // 載入失敗下次重來
  return aiInitP;
}
const AI_RETRY = 3;
let aiBenchedNow = false, aiBenchP = null;
function aiBench() { return aiBenchP || (aiBenchP = aiBench0().finally(() => { aiBenchP = null; })); } // 同時叫兩次共用同一次
async function aiBench0() {
  try {
    const r = await aiPost({ type: 'bench' });
    const prev = settings.aiBenchV === AI_NEW_VER ? settings.aiEP : null;
    settings.aiEP = !settings.aiSafeCPU && r.gpu != null && r.gpu < r.cpu * 0.8 ? 'webgpu' : 'wasm'; // 4.2.1：閃退保護改過 CPU 就不再改回 GPU
    settings.aiBenchN = settings.aiEP === 'webgpu' ? 0 : prev === 'wasm' ? (settings.aiBenchN || 1) + 1 : 1; // 5.1.9：連續比出 CPU 的次數
    settings.aiBenchR = { cpu: Math.round(r.cpu), gpu: r.gpu != null ? Math.round(r.gpu) : null };
    if (prev && prev !== settings.aiEP) aiNote(`框選重新比較：${prev === 'webgpu' ? 'GPU' : 'CPU'} → ${settings.aiEP === 'webgpu' ? 'GPU' : 'CPU'}`);
    aiBenchedNow = true; settings.aiBenchV = AI_NEW_VER; saveSettings();
    console.info('AI bench', r, settings.aiEP);
    aiEPNow = await aiPost({ type: 'setEP', ep: aiSafeNow ? 'wasm' : settings.aiEP }); // 5.1.7：閃退保護第一次只影響這次打開
  } catch (e) { console.warn('AI bench', e); }
}
// 送一個工作給 AI；新引擎載入失敗（ENGINE:）時啟動安全網：改用舊引擎再試一次
async function aiCall(payload, transfer, retried) {
  const keep = payload.buffer ? payload.buffer.slice(0) : null; // 送出時 buffer 會被轉走，重試要用備份
  try {
    await aiInit();
    return await aiPost(payload, transfer);
  } catch (e) {
    const m = String(e && e.message);
    if (retried || !m.startsWith('ENGINE:') || aiEngineNow === 'old') throw new Error(m.replace(/^ENGINE:/, ''));
    console.warn('AI 新引擎載入失敗，改用舊引擎', m);
    aiOldNow = true; aiReset(); aiNote('新引擎載入失敗，這次改用相容模式：' + m.replace(/^ENGINE:/, '').slice(0, 60)); // 5.1.7：只在這次打開期間
    if (!(await aiHas(AI_OLD)) && !(await aiDownload(AI_OLD, 'AI 改用相容模式，下載中…'))) throw new Error('無法載入 AI 引擎');
    return aiCall(keep ? Object.assign({}, payload, { buffer: keep }) : payload, keep ? [keep] : [], true);
  }
}
// 下載一組檔案放進 AI 快取（顯示百分比）
async function aiDownload(list, label) {
  const total = list.reduce((a, f) => a + f[2], 0);
  let got = 0;
  busy(`${label} 0%`);
  try {
    const cache = 'caches' in window ? await caches.open(AI_CACHE) : null;
    for (const [f, type] of list) {
      const res = await fetch(f, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rd = res.body.getReader(), parts = [];
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        parts.push(value); got += value.length;
        $('#busyMsg').textContent = `${label} ${Math.min(99, Math.round((got / total) * 100))}%`;
      }
      if (cache) await cache.put(new URL(f, location.href).href, new Response(new Blob(parts, { type }), { headers: { 'Content-Type': type } }));
    }
    unbusy();
    return true;
  } catch (e) {
    console.warn('AI download', e); unbusy();
    toast('下載失敗，請確認網路後再試一次');
    return false;
  }
}
async function aiDropOld() {
  try { const c = await caches.open(AI_CACHE); for (const [f] of AI_OLD) await c.delete(new URL(f, location.href).href); } catch (_) {}
}
const AI_DL_MB = mbOf([AI_MODEL, ...AI_NEW, TEED_FILE]), AI_UP_MB = mbOf(AI_NEW);
async function aiEnsure(inApp, noAsk, what) {
  if (await aiCached()) return true;
  const ask = `${what || 'AI 框選'}需要先下載約 ${what ? AI_DL_MB + 3 : AI_DL_MB} MB 的資料（只需一次，之後離線也能用），建議在 Wi-Fi 下使用。要下載嗎？`;
  if (!noAsk && (inApp ? !(await askSheet('下載 AI 資料', ask, '下載')) : !confirm(ask))) return false; // 2.1：noAsk＝已經在預設開啟的詢問裡問過
  const st = await aiState();
  const need = [...(st.model ? [] : [AI_MODEL]), ...AI_NEW, ...((await aiHas([TEED_FILE])) ? [] : [TEED_FILE])];
  if (!(await aiDownload(need, '下載 AI 資料中…'))) return false;
  aiOldNow = false; settings.aiBenchV = null; saveSettings();
  await aiDropOld(); aiReset();
  return true;
}
// 舊使用者升級成新引擎（拍攝畫面的詢問、設定裡的按鈕）
async function aiUpgrade() {
  if (!(await aiDownload(AI_NEW, '升級 AI 引擎中…'))) return false;
  aiOldNow = false; settings.aiBenchV = null; settings.aiUpAsked = true; saveSettings();
  await aiDropOld(); aiReset();
  aiInit().catch(() => {}); // 載入新引擎並在背景比較 CPU／GPU
  return true;
}
// 一張圖 → { corners } 或 { reject }
async function aiFrame(img) {
  await whenReady();
  const c = canvasOf(320, 320), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, 320, 320);
  const d = x.getImageData(0, 0, 320, 320);
  const mask = await aiCall({ type: 'mask', buffer: d.data.buffer }, [d.data.buffer]);
  const teed = await teedMap(img); // 4.2：沒有 TEED 資料或出錯時是 null，只用 AI
  const f = smallFrame(img, 900);
  const pl = { buffer: f.data.buffer, width: f.width, height: f.height, mask }, tr = [f.data.buffer, mask];
  if (teed) { pl.teed = teed; tr.push(teed.buffer); }
  return wcall('maskQuad', pl, tr);
}
// 4.2：照片縮成長邊 640（寬高取 8 的倍數）交給 TEED，回傳邊緣強度圖 { buffer, width, height }
let teedOk = false, teedFetching = null;
async function teedMap(img) {
  try {
    if (!teedOk) { teedOk = await aiHas([TEED_FILE]); if (!teedOk) { teedFetchBg(); return null; } }
    const [w, h] = sourceSize(img), s = 640 / Math.max(w, h);
    const W = Math.max(8, Math.floor((w * s) / 8) * 8), H = Math.max(8, Math.floor((h * s) / 8) * 8);
    const c = canvasOf(W, H), x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H);
    const buffer = await aiCall({ type: 'teed', buffer: d.data.buffer, width: W, height: H }, [d.data.buffer]);
    return { buffer, width: W, height: H };
  } catch (e) { console.warn('TEED', e); return null; }
}
// 已經下載過 AI 資料、還沒有 TEED 的人：背景安靜補抓（不顯示進度、失敗下次再試）
function teedFetchBg() {
  if (teedFetching) return teedFetching;
  teedFetching = (async () => {
    try {
      if (!('caches' in window) || !(await aiHas([AI_MODEL])) || (await aiHas([TEED_FILE]))) return;
      const res = await fetch(TEED_FILE[0], { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const c = await caches.open(AI_CACHE);
      await c.put(new URL(TEED_FILE[0], location.href).href, new Response(blob, { headers: { 'Content-Type': TEED_FILE[1] } }));
    } catch (e) { console.warn('TEED 補抓', e); }
    finally { teedFetching = null; }
  })();
  return teedFetching;
}
setTimeout(() => { if (navigator.onLine !== false) teedFetchBg(); }, 8000);
// 5.0：TEED 協助標記（設定裡隱藏的開關，作者測試用）：這次的 AI 框選 TEED 有沒有介入
function teedNote(r) {
  const src = r && r.fuse && r.fuse.src;
  if (!r || !r.corners || !src || !src.includes('t')) return null;
  if (src === 'tttt' && !r.aiCorners) return 'TEED 補框';
  return 'TEED 協助：' + ['上', '右', '下', '左'].filter((_, i) => src[i] === 't').map((x) => x + '邊').join('、');
}
const teedMarkOn = () => !!settings.teedMark;
const teedCount = (n) => (teedMarkOn() && n ? `（TEED 協助 ${n} 頁）` : '');
function aiRejectMsg(r) {
  return r && r.reject === 'book' ? '這頁看起來是攤開的書，AI 框選不適合，請用「自動偵測」或手動調整' : 'AI 找不到合適的紙張範圍，請手動調整';
}
$('#cropAI').onclick = async () => {
  const c = cropCtx; if (!c) return;
  if (!(await aiEnsure())) return;
  busy('AI 框選中…');
  try {
    const r = await aiFrame($('#cropImg'));
    if (cropCtx !== c) return;
    if (!r || !r.corners) { toast(aiRejectMsg(r)); return; }
    c.corners = r.corners;
        // 1.28：AI 找到書頁彎曲時擺好彎度；1.30：維持目前的模式（預設直線），彎度照樣顯示、保留
    if (r.curve) c.curve = normCurve(c.corners, r.curve);
    else c.curve = c.curveMode ? straightCurve(c.corners) : null;
    drawCrop();
    const tn = teedMarkOn() && teedNote(r); // 5.0
    toast((r.curve ? '已用 AI 框選，並貼合書頁彎曲' : '已用 AI 框選，可以再微調') + (tn ? `｜${tn}` : ''));
  } catch (e) { console.warn(e); toast('AI 框選失敗：' + e.message); }
  finally { unbusy(); }
};
const nearSame = (a, b) => !!a && !!b && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 0.004 && Math.abs(p[1] - b[i][1]) < 0.004);
async function aiFrameDoc() {
  const docId = state.docId;
  const { pages } = await getDocPages(docId);
  if (!pages.length) return;
  if (!(await aiEnsure())) return;
  // 1.31：自己調整過範圍的頁（裁切畫面改過再按確定），先問要不要一起覆蓋（比照統一調整）
  const mine = pages.filter((p) => p.cropUser).length;
  let overwrite = true;
  if (mine) overwrite = confirm(`有 ${mine} 頁自己調整過範圍。\n要一起用 AI 重新框選嗎？\n\n確定：全部重新框選\n取消：保留那幾頁`);
  const before = [], tag = 'ai:' + Date.now();
  let changed = 0, kept = 0, tdone = 0;
  busy(`AI 框選中 1 / ${pages.length}`);
  await holdQueue(); aiBatchMark(true);
  try {
    for (let i = 0; i < pages.length; i++) {
      busy(`AI 框選中 ${i + 1} / ${pages.length}`);
      const p = await DB.get('pages', pages[i].id); if (!p) continue;
      if (p.cropUser && !overwrite) { kept++; continue; }
      let r = null;
      try { const { img, url } = await loadImg(p.original); try { r = await aiFrame(img); } finally { URL.revokeObjectURL(url); } }
      catch (e) { console.warn('ai page', e); }
      if (teedNote(r)) tdone++;
      if (r && r.corners && !(nearSame(r.corners, p.corners) && !p.curve && !r.curve)) {
        pushHist(p, tag);
        before.push({ id: p.id, corners: p.corners, curve: p.curve || null, needCrop: !!p.needCrop, cropUser: !!p.cropUser });
        p.corners = r.corners; p.curve = r.curve ? normCurve(r.corners, r.curve) : null; delete p.needCrop; delete p.cropUser;
        await DB.put('pages', p);
        enqueue(p.id);
        changed++;
      } else kept++;
    }
  } finally { aiBatchMark(false); unbusy(); releaseQueue(); aiReleaseSoon(); }
  if (current === 'doc' && state.docId === docId) renderDoc();
  undoBar(`AI 框選完成：${changed} 頁已重新框選${kept ? `，${kept} 頁維持原框` : ''}${teedCount(tdone)}`, changed ? async () => {
    for (const b of before) {
      const p = await DB.get('pages', b.id); if (!p) continue;
      p.corners = b.corners; p.curve = b.curve; if (b.needCrop) p.needCrop = true; else delete p.needCrop;
      if (b.cropUser) p.cropUser = true; else delete p.cropUser;
      await DB.put('pages', p); enqueue(p.id);
      const h = hist.get(b.id); if (h && h.past.length && h.past[h.past.length - 1].tag === tag) h.past.pop();
    }
    if (current === 'doc') renderDoc();
    toast('已還原 AI 框選前的範圍');
  } : null);
}

/* ---------- 1.28 防止誤觸 ----------
   長按不跳出系統選單（輸入框除外）、iPhone 不能雙指或雙擊放大整個頁面（App 自己的放大用 pointer 事件，不受影響）、
   裁切與調整畫面攔截從螢幕最左右邊緣開始的滑動，避免誤觸返回手勢 */
(() => {
  const isField = (t) => t && t.closest && t.closest('input:not([type=range]),textarea,[contenteditable]');
  document.addEventListener('contextmenu', (e) => { if (!isField(e.target)) e.preventDefault(); });
  document.addEventListener('selectstart', (e) => { if (!isField(e.target)) e.preventDefault(); });
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault());
  document.addEventListener('touchstart', (e) => {
    if (current !== 'crop' && current !== 'page') return;
    const x = e.touches[0] && e.touches[0].clientX;
    if (x != null && (x < 20 || x > window.innerWidth - 20) && !(e.target.closest && e.target.closest('button,a,label,input,textarea,select'))) e.preventDefault();
  }, { passive: false });
})();

/* ---------- 4.1 AI 精修（Real-ESRGAN 線稿模型） ----------
   作者實驗：AI 放在「轉黑白之前」才有用；紙張先縮到長邊 aiSide（預設 2000）再放大 4 倍，最後照常套用模式（四種模式都可以）。
   4.1.1：精修的不是拉正後的頁，而是原照片上「框的外接矩形＋四周各多 10%」那一塊（page.srBox，0～1；碰到照片邊就停），
   縮放比例讓紙張仍分到長邊 aiSide；結果縮回該區塊的原解析度存成 page.srBuf（JPEG 的 ArrayBuffer，4.1.2 起；4.1／4.1.1 是 Blob 的 page.sr）。之後只要新的框（含曲線）還在這塊裡面，
   就直接從精修圖拉正（四角換算成區塊座標），微調框、換模式、調數值、轉向、關掉再打開都不用重跑；框超出才重跑。
   關閉精修只關開關、精修圖留著（作者：關掉又想開回來不用再等）。
   速度看實測（不看有沒有 GPU，Y31 有 GPU 但很慢）：第一次先測一塊的時間（srBench），推算整塊：
   ≤ 20 秒用 2000；否則選 1600／1200 中 ≤ 60 秒的最大值；都超過就用 1200 並先跳字卡確認。實際跑完會更新每塊時間。 */
const SR_FILE = ['lib/ai/sr-anime.onnx', 'application/octet-stream', 2492830];
const SR_VER = 3, SR_TILE = 192, SR_PAD = 12, SR_IN = SR_TILE + SR_PAD * 2, SR_MARGIN = 0.1;
const srProg = new Map(), srCancel = new Set();
// 框（四角＋曲線）的所有點，0～1 原照片座標
const srPts = (p) => [...p.corners, ...(p.curve ? p.curve.flat() : [])];
function srBoxOf(p) {
  const P = srPts(p); let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const mx = (x1 - x0) * SR_MARGIN, my = (y1 - y0) * SR_MARGIN;
  return [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(1, x1 + mx), Math.min(1, y1 + my)];
}
// 精修圖還能用嗎（不管開關）：同一版、框的每個點都在精修區塊裡
// 4.1.2：精修圖改存 ArrayBuffer（srBuf）。iPhone 上存成 Blob 的精修圖，關掉再打開時讀不出來（「無法讀取圖片」）
const srBlobOf = (p) => (p.srBuf ? new Blob([p.srBuf], { type: 'image/jpeg' }) : null);
function srDrop(p) { for (const k of ['sr', 'srBuf', 'srBox', 'srSide', 'srV', 'srKey']) delete p[k]; }
function srUsable(p) {
  if (!p || !(p.lite ? p.liteSr > 0 : p.srBuf instanceof ArrayBuffer && p.srBuf.byteLength) || p.srV !== SR_VER || !p.srBox) return false;
  const [x0, y0, x1, y1] = p.srBox, e = 1e-6;
  return srPts(p).every(([x, y]) => x >= x0 - e && x <= x1 + e && y >= y0 - e && y <= y1 + e);
}
const srReady = (p) => !!(p && p.ai && srUsable(p) && p.srSide === (p.aiSide || 2000));
// 原照片座標 → 精修區塊座標
function srMap(p) {
  const [x0, y0, x1, y1] = p.srBox, f = ([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)];
  return { corners: p.corners.map(f), curve: p.curve ? p.curve.map((e) => e.map(f)) : null };
}
async function srEnsureModel() {
  if (!(await aiEnsure(true, false, 'AI 精修'))) return false;
  if (await aiHas([SR_FILE])) return true;
  return aiDownload([SR_FILE], '下載 AI 精修資料中…');
}
/* 5.1.6：測速結果改版 v2，舊的（v1）作廢重測一次。測試版 iPhone 曾被記成 CPU（可能測的時候 GPU 被框選佔著），之後永遠用 CPU，
   一頁超過 1 分鐘（正式版同一支手機重測後用 GPU，約 20 秒內）。測之前先把 AI 引擎整個重開，讓 GPU 乾淨 */
const SR_BENCH_V = 2, SR_RETRY = 3;
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// 5.1.7：隱藏區的 AI 診斷（引擎、GPU 狀態與原因、精修速度、框選、最近紀錄）
function srInfoText() {
  const b = settings.srBench, L = settings.srLast, out = [];
  out.push(`AI 引擎：${aiEngineNow ? (aiEngineNow === 'new' ? '新引擎' : '舊引擎（相容模式）') + `，框選用 ${aiEPNow === 'webgpu' ? 'GPU' : 'CPU'}` : aiOldNow ? '這次用相容模式（尚未載入）' : '尚未載入'}`);
  const ab = settings.aiBenchR, abN = settings.aiBenchN || 1;
  out.push(`框選：${settings.aiSafeCPU ? '閃退保護，這個版本一律 CPU' : aiSafeNow ? '閃退保護，這次先用 CPU' : settings.aiEP === 'webgpu' ? 'GPU' : 'CPU'}${settings.aiCrashN ? `（中斷 ${settings.aiCrashN} 次）` : ''}` +
    (ab ? `（比較 CPU ${ab.cpu}、${ab.gpu != null ? 'GPU ' + ab.gpu : 'GPU 無法使用'}${settings.aiEP !== 'webgpu' && !settings.aiSafeCPU ? `；第 ${abN} 次，${abN >= AI_RETRY ? '已定案' : '下次打開再比'}` : ''}）` : ''));
  if (b && b.v === SR_BENCH_V && b.ms > 0) {
    const why = b.gpu != null ? `GPU ${b.gpu}` : `GPU 無法使用${b.gpuWhy ? '：' + b.gpuWhy : ''}`;
    out.push(`精修：${b.ep === 'webgpu' ? 'GPU' : 'CPU'}，每塊約 ${b.ms} 毫秒（測速 CPU ${b.cpu}、${why}${b.ep === 'wasm' ? `；第 ${b.n || 1} 次，${(b.n || 1) >= SR_RETRY ? '已定案' : '下次打開再測'}` : ''}）`);
  } else out.push('精修：尚未測速（下次精修時測）');
  if (L) out.push(`上次精修：${L.ep === 'webgpu' ? 'GPU' : 'CPU'}，每塊 ${L.per} 毫秒${L.fell ? `（途中 GPU 出錯改 CPU：${L.err || ''}）` : ''}`);
  for (const t of settings.aiLog || []) out.push('・' + t);
  return out.map(esc).join('<br>');
}
async function srBenchNow(force) {
  const b = settings.srBench;
  // 5.1.7：GPU 的結果沿用；CPU 的結果每次打開第一次精修重測，連續 SR_RETRY 次才定案
  if (!force && b && b.v === SR_BENCH_V && b.ms > 0 && (b.ep === 'webgpu' || (b.n || 1) >= SR_RETRY || srBenchedNow)) return b;
  busy('正在測試這支手機的速度…');
  try {
    if (!aiPending.size && !aiBatchOn && !srProg.size) aiReset(); // 5.1.6：重開 AI 引擎，框選、TEED 的記憶體都清掉再測
    const r = await aiCall({ type: 'srBench', n: SR_IN });
    const ep = r.gpu != null && r.gpu < r.cpu * 0.8 ? 'webgpu' : 'wasm';
    const n = ep === 'webgpu' || force ? 1 : b && b.v === SR_BENCH_V && b.ep === 'wasm' ? (b.n || 1) + 1 : 1;
    srBenchedNow = true;
    settings.srBench = { v: SR_BENCH_V, ep, ms: Math.round(ep === 'webgpu' ? r.gpu : r.cpu), cpu: Math.round(r.cpu), gpu: r.gpu != null ? Math.round(r.gpu) : null, gpuWhy: r.why || '', n };
    if (b && b.v === SR_BENCH_V && b.ep !== ep) aiNote(`精修重新測速：${b.ep === 'webgpu' ? 'GPU' : 'CPU'} → ${ep === 'webgpu' ? 'GPU' : 'CPU'}${r.why ? '（' + r.why + '）' : ''}`);
    saveSettings(); console.info('SR bench', r, settings.srBench);
    return settings.srBench;
  } finally { unbusy(); }
}
// 塊數估計：紙張（成品尺寸，沒有就估 2400×3200）縮到 side，再乘上「精修區塊／框的外接矩形」的面積比（多留的那圈）
function srTiles(p, side) {
  const [w, h] = p.outW && p.outH ? [p.outW, p.outH] : [2400, 3200], s = Math.min(1, side / Math.max(w, h));
  const P = srPts(p), xs = P.map((q) => q[0]), ys = P.map((q) => q[1]);
  const bw = Math.max(...xs) - Math.min(...xs) || 1, bh = Math.max(...ys) - Math.min(...ys) || 1, [x0, y0, x1, y1] = srBoxOf(p);
  const k = Math.sqrt(((x1 - x0) * (y1 - y0)) / (bw * bh));
  return Math.ceil((w * s * k) / SR_TILE) * Math.ceil((h * s * k) / SR_TILE);
}
function srPlan(p, ms) {
  const est = (side) => srTiles(p, side) * ms;
  if (est(2000) <= 20000) return { side: 2000, est: est(2000) };
  for (const side of [1600, 1200]) if (est(side) <= 60000) return { side, est: est(side) };
  return { side: 1200, est: est(1200), ask: true };
}
// 精修區塊：原照片取 srBox → 縮到「紙張長邊＝aiSide」的比例 → 分塊放大 4 倍 → 縮回區塊原解析度；回傳 { blob, box, side }。關掉（srCancel）回傳 null
async function srRun(page) {
  const side = page.aiSide || 2000, box = srBoxOf(page);
  const { img, url } = await loadImg(page.original);
  const NW = img.naturalWidth, NH = img.naturalHeight;
  // 紙張在原照片上的大約像素長邊（四條邊的長度）
  const C = page.corners.map(([x, y]) => [x * NW, y * NH]), L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const pageLong = Math.max((L(C[0], C[1]) + L(C[3], C[2])) / 2, (L(C[0], C[3]) + L(C[1], C[2])) / 2) || 1;
  const s = Math.min(1, side / pageLong);
  const rx = box[0] * NW, ry = box[1] * NH, RW = (box[2] - box[0]) * NW, RH = (box[3] - box[1]) * NH;
  const sw = Math.max(1, Math.round(RW * s)), sh = Math.max(1, Math.round(RH * s));
  const small = canvasOf(sw, sh), sx = small.getContext('2d', { willReadFrequently: true }); sx.imageSmoothingQuality = 'high';
  sx.drawImage(img, rx, ry, RW, RH, 0, 0, sw, sh); URL.revokeObjectURL(url);
  let scale = Math.min(4, RW / sw); if (sw * sh * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (sw * sh));
  const OW = Math.max(1, Math.round(sw * scale)), OH = Math.max(1, Math.round(sh * scale));
  const out = canvasOf(OW, OH), ox = out.getContext('2d'); ox.imageSmoothingQuality = 'high';
  const tmp = canvasOf(SR_IN * 4, SR_IN * 4), tx = tmp.getContext('2d');
  const nx = Math.ceil(sw / SR_TILE), ny = Math.ceil(sh / SR_TILE), total = nx * ny;
  await aiCall({ type: 'srEP', ep: (settings.srBench && settings.srBench.ep) || 'wasm' });
  const t0 = performance.now(); let done = 0;
  try {
    for (let ty = 0; ty < ny; ty++) for (let txi = 0; txi < nx; txi++) {
      if (srCancel.has(page.id)) return null;
      const x0 = txi * SR_TILE, y0 = ty * SR_TILE;
      const gx = Math.max(0, x0 - SR_PAD), gy = Math.max(0, y0 - SR_PAD), ex = Math.min(sw, x0 + SR_TILE + SR_PAD), ey = Math.min(sh, y0 + SR_TILE + SR_PAD);
      const g = sx.getImageData(gx, gy, ex - gx, ey - gy).data, gw = ex - gx, gh = ey - gy;
      const buf = new Uint8ClampedArray(SR_IN * SR_IN * 4);
      for (let y = 0; y < SR_IN; y++) {
        const yy = Math.min(gh - 1, Math.max(0, y0 - SR_PAD + y - gy));
        for (let x = 0; x < SR_IN; x++) { const xx = Math.min(gw - 1, Math.max(0, x0 - SR_PAD + x - gx)), k = (yy * gw + xx) * 4, i = (y * SR_IN + x) * 4; buf[i] = g[k]; buf[i + 1] = g[k + 1]; buf[i + 2] = g[k + 2]; buf[i + 3] = 255; }
      }
      const r = await aiCall({ type: 'srTile', buffer: buf.buffer, n: SR_IN }, [buf.buffer]);
      tx.putImageData(new ImageData(new Uint8ClampedArray(r), SR_IN * 4, SR_IN * 4), 0, 0);
      const tw = Math.min(SR_TILE, sw - x0), th = Math.min(SR_TILE, sh - y0);
      ox.drawImage(tmp, SR_PAD * 4, SR_PAD * 4, tw * 4, th * 4, x0 * scale, y0 * scale, tw * scale, th * scale);
      done++; srProg.set(page.id, done / total); srBtnProgress(page.id);
    }
    // 實際每塊時間（指數平均），下次預估更準
    const per = (performance.now() - t0) / total, b = settings.srBench;
    // 5.1.7：問 worker 這次實際用什麼跑；GPU 途中出錯改 CPU 的那次不算進速度（免得以為手機變慢、改用小尺寸）
    let st = null; try { st = await aiCall({ type: 'srState' }); } catch (_) {}
    const used = st ? st.ep : b && b.ep, fell = !!(b && b.ep === 'webgpu' && used !== 'webgpu');
    settings.srLast = { ep: used, per: Math.round(per), fell, err: fell && st ? String(st.err || '').slice(0, 60) : '' };
    if (fell) aiNote('精修途中 GPU 出錯，這頁改用 CPU' + (st && st.err ? '：' + String(st.err).slice(0, 60) : ''));
    if (b && b.v === SR_BENCH_V && !fell) b.ms = Math.round(b.ms * 0.5 + per * 0.5);
    saveSettings();
    return { blob: await toBlob(out, 'image/jpeg', 0.95), box, side };
  } finally {
    small.width = small.height = 0; out.width = out.height = 0; tmp.width = tmp.height = 0;
    srProg.delete(page.id);
  }
}
// 處理佇列裡呼叫：精修圖不能用就重跑並存起來；回傳 { blob, corners, curve }（區塊座標）或 null
async function srEnsurePage(page) {
  if (!srReady(page)) {
    srCancel.delete(page.id);
    let r = null;
    try { await srEnsureModel(); r = await srRun(page); }
    catch (e) { console.warn('AI 精修', e); toast('AI 精修失敗：' + (e && e.message ? e.message : e)); }
    finally { aiReleaseSoon(); } // 4.2.1：精修完釋放 AI 引擎（4.1 起精修的 GPU 記憶體一直沒還）
    if (!r || !r.blob) return null;
    const latest = await DB.get('pages', page.id);
    if (!latest) return null;
    const buf = await r.blob.arrayBuffer();
    srDrop(latest); Object.assign(latest, { srBuf: buf, srBox: r.box, srSide: r.side, srV: SR_VER });
    await DB.put('pages', latest);
    srDrop(page); Object.assign(page, { srBuf: buf, srBox: r.box, srSide: r.side, srV: SR_VER });
    if (!srReady(page)) return null;
  }
  return Object.assign({ blob: srBlobOf(page) }, srMap(page));
}
function srBtnState(p) {
  const b = $('#pageAi'); if (!b || !p) return;
  const prog = srProg.get(p.id), ready = srReady(p);
  b.classList.toggle('on', !!p.ai && ready);
  b.classList.toggle('busy', !!p.ai && !ready);
  b.textContent = !p.ai ? '✨ 精修' : ready ? '✨ 已精修' : `✨ ${prog !== undefined ? Math.round(prog * 100) + '%' : '精修中'}`;
}
function srBtnProgress(id) { if (current === 'page' && viewPage && viewPage.id === id) srBtnState(viewPage); }
$('#pageAi').onclick = async () => {
  const p = viewPage; if (!p) return;
  if (p.ai) { srCancel.add(p.id); await updatePage({ ai: undefined, aiSide: undefined }); toast('已關閉 AI 精修'); return; } // 4.1.1：精修圖留著
  // 4.1.1：之前精修過、框還在範圍裡：直接用，不用等
  if (srUsable(p) && p.srSide) { await updatePage({ ai: true, aiSide: p.srSide }); return; }
  try {
    if (!(await srEnsureModel())) return;
    const b = await srBenchNow();
    const plan = srPlan(p, b.ms);
    if (plan.ask) {
      const min = Math.max(1, Math.round(plan.est / 6000) / 10);
      if (!(await askSheet('✨ AI 精修', `此功能效能需求較高，每頁約需 ${min} 分鐘，處理期間手機可能會發熱，確定要精修嗎？`, '精修'))) return;
    }
    if (!viewPage || viewPage.id !== p.id) return;
    await updatePage({ ai: true, aiSide: plan.side });
  } catch (e) { console.warn(e); toast('AI 精修無法使用：' + (e && e.message ? e.message : e)); }
};

/* ---------- 版本、更新日誌、問題回報（1.18，比照音樂聽力練習 App） ----------
   APP_VER：封面右下角與設定顯示的完整版號，每次打包都要改（與打包名稱 cocoa-scan.vX.Y 一致；sw.js VERSION 另外每次加 1）。
   日誌只有一欄「v1」，條列目前的功能；新增項目時加 since: '1.xx'，該版之後第一次進首頁會自動跳出一次（3.0.1 起一律黑字，不標紅） */
// APP_VER 在檔案開頭宣告（5.1.9：AI 閃退保護在載入時就要用到）
const REPORT_URL = 'https://forms.gle/PgTtxmJ7itWyKD3T7';
const CHANGELOG = [
  // 2.0：正式版上線（2.0.1 只改 README，since 跟著改成 2.0.1，紅字與自動跳出才不會因為版號變了而消失）；1.x 的功能濃縮成 v1 的 10 條（黑字）。舊的在上、新的在下（打開時捲到最底）。之後新增的項目加 since，只有目前這一版的才是紅字
  { v: 'v1', items: [
    { t: '三種拍法：即時掃描（自動或手動拍攝）、高畫質拍照、相簿匯入' },
    { t: '自動找出紙張並校正；書本攤開時沿書溝只框一頁，角被遮住也能推算' },
    { t: 'AI 框選：一鍵重新找紙並貼合書頁彎曲；即時掃描可開「自動 AI 框選」' },
    { t: '裁切有放大鏡與成品預覽，「曲線」可以把彎曲的書頁拉平' },
    { t: '黑白、灰階、彩色、原圖四種模式，黑白自動去雜點、線條平滑' },
    { t: '細部調整即時預覽：「統一調整」整份文件或只調單頁；上一步／下一步可以復原' },
    { t: '立即裁切或稍後裁切，待裁切的頁標上 ✂；頁面縮圖照成品比例顯示' },
    { t: '橫拿手機也能拍，拍好的頁自動轉正；畫質依手機自動調整' },
    { t: '匯出 PDF 與圖片，可自訂檔名；頁面拖曳排序，文件與頁面多選、合併、刪除' },
    { t: '光線不足提示開閃光燈；使用教學、加入主畫面教學、問題回報' },
  ] },
  { v: 'v2', items: [
    { t: '正式版上線 🎉', since: '2.0.1' },
  ] },
  { v: 'v3', items: [
    { t: 'AI框選全面加速：新的AI引擎會運用 GPU 提升框選速度', since: '3.0' },
    { t: '最佳化 AI 書頁框選，攤開的書框得更準', since: '3.0' },
    { t: '自動 AI 框選預設開啟，並於第一次拍攝時詢問下載', since: '3.0' },
    { t: '加入主畫面說明，並新增影片教學', since: '3.0' },
    { t: '框選畫面支援雙指縮放；相簿匯入與高畫質拍照也能自動 AI 框選', since: '3.0.1' },
  ] },
  // 4.0：3.1～3.1.7 沒上正式版，整理成 v4 一組（作者定的文字）
  { v: 'v4', items: [
    { t: '即時掃描、高畫質拍照加入框選動畫與音效', since: '4.0' },
    { t: '最佳化立即裁切：編輯時暫停相機，減少耗電與發熱', since: '4.0' },
    { t: '最佳化高畫質拍照流程體驗', since: '4.0' },
    { t: '新增 ✨ AI 精修：讓樂譜線條與文字更清晰', since: '4.1.2' },
    { t: '最佳化拍攝運作流程，減少拍攝時發熱', since: '4.1.7' },
  ] },
  // 5.0：加入 TEED 邊緣模型的 AI 框選升級（作者選的切法：4.2 起的框選改進都放 v5）
  { v: 'v5', items: [
    { t: '最佳化淺色背景AI框選準確度', since: '4.2' },
    { t: '偵測不到框選範圍時，將提示直接按快門', since: '4.2' },
    { t: '淺色背景即時掃描時，也能自動找到框選範圍', since: '4.3' },
    { t: '提升 AI 框選穩定性，減少一次處理多張時閃退', since: '5.0' },
    { t: '新增倒數拍攝按鈕：當偵測不到框選範圍時，將自動倒數 3 秒拍下', since: '5.1' },
    { t: '加入拍攝聚焦動畫，框到後更有預備感', since: '5.1' },
    { t: '修正大量讀檔有可能閃退的問題', since: '5.2' },
    { t: '提升即時掃描框選準確度（紙張靠近畫面邊緣時）', since: '5.3' },
    { t: '修正連拍時偶爾漏存頁面的問題', since: '5.3' },
  ] },
];
const LOG_KEY = 'cocoscan-log-seen'; // 看過日誌時的 App 版號
const verNum = (v) => v.split('.').map(Number);
const verGt = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
function logSeen() { try { return localStorage.getItem(LOG_KEY); } catch (_) { return null; } }
function logMarkSeen() { try { localStorage.setItem(LOG_KEY, APP_VER); } catch (_) {} }
// 1.29：只有「目前這一版」新增的項目是紅字；之前版本的一律黑字
setTimeout(() => { DB.open().then(() => { if (DB.found) { toast(`找回 ${DB.found} 頁之前漏存的頁面`); if (current === 'home') renderHome(); } else if (DB.cleaned) toast(`已清除 ${DB.cleaned} 頁未使用的資料`); }).catch(() => {}); }, 1200); // 4.2.4；5.3 找回散頁
const isNewItem = (it) => it.since === APP_VER; // 只用來判斷要不要自動跳出日誌（3.0.1 起不再標紅字，一律黑字）
function showChangelog() {
  const seen = logSeen();
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 5.3：作者：一個大版本的項目全擠在一起，看不出哪一次修的（選丙）。順序照舊：舊的在上、新的在最下面，打開時捲到最底；
  //   目前的大版本展開、依小版本分段（項目的 since）；舊的大版本收起來（點標題展開）；這次更新新增的項目前面標「新」
  //   v5 裡 since 4.2／4.3 的項目（4.2 起的功能當初併進 v5，切法 B）歸在 v5.0 那段
  const cur = 'v' + APP_VER.split('.')[0];
  const isNew = (it) => !!(seen && it.since && verGt(it.since, seen));
  const subOf = (g, it) => { const base = g.v.slice(1); if (!it.since) return null; return 'v' + (verGt(base + '.0', it.since) || it.since.split('.')[0] !== base ? base + '.0' : it.since); };
  const part = (g) => {
    const subs = []; // [標題, 項目]，依出現順序
    for (const it of g.items) { const k = subOf(g, it); const last = subs[subs.length - 1]; if (last && last[0] === k) last[1].push(it); else subs.push([k, [it]]); }
    return subs.map(([k, its]) => `${k ? `<div class="log-sub">${esc(k)}</div>` : ''}<ul>${its.map((it) => `<li>${isNew(it) ? '<span class="log-new">新</span>' : ''}${esc(it.t)}</li>`).join('')}</ul>`).join('');
  };
  // 作者：每個舊大版本各一行收起來，上面空空的又佔位置 → 舊的大版本全部收進一個「過去版本」，點開後全部列出（大版本＋小版本分段）
  const old = CHANGELOG.filter((g) => g.v !== cur), now = CHANGELOG.filter((g) => g.v === cur);
  const block = (g) => `<div class="log-item"><div class="log-ver">${esc(g.v)}</div>${part(g)}</div>`;
  $('#logList').innerHTML = (old.length ? `<details class="log-old"><summary class="log-ver">過去版本（${esc(old[0].v)}～${esc(old[old.length - 1].v)}）</summary>${old.map(block).join('')}</details>` : '') + now.map(block).join('');
  const od = $('#logList').querySelector('details.log-old');
  if (od) od.addEventListener('toggle', () => { $('#logList').scrollTop = $('#logList').scrollHeight; }); // 5.3.1：點開「過去版本」也置底，從新的往回看
  $('#logCurrent').textContent = '目前版本 v' + APP_VER;
  logMarkSeen();
  openModal('logModal');
  setTimeout(() => { $('#logList').scrollTop = $('#logList').scrollHeight; }, 30);
}
// 有沒有「看過之後才新增」的項目
// 4.0.2：改成「比上次看過的版本還新」的項目（原本只認 since === APP_VER，出小版本 4.0.1 時 since '4.0' 的項目就不會跳）
// 5.1.9：更新日誌的「目前版本」快速連點 5 下，顯示／隱藏設定最下方的測試資訊（TEED 協助標記開關、AI 診斷；隱藏時一併關掉標記）
{
  let taps = 0, tapT = 0;
  $('#logCurrent').addEventListener('click', () => {
    clearTimeout(tapT); tapT = setTimeout(() => { taps = 0; }, 1500);
    if (++taps < 5) return;
    taps = 0;
    settings.teedMarkShown = !settings.teedMarkShown;
    if (!settings.teedMarkShown) settings.teedMark = false;
    saveSettings();
    toast(settings.teedMarkShown ? '已顯示測試資訊（在設定最下方）' : '已隱藏測試資訊');
  });
}
function hasNewLog() { const seen = logSeen() || '0'; return seen !== APP_VER && CHANGELOG.some((g) => g.items.some((it) => it.since && verGt(it.since, seen))); }
$('#cvVer').textContent = '▸ v' + APP_VER;
$('#cvVer').onclick = () => showChangelog();
$('#cvReport').onclick = () => window.open(REPORT_URL, '_blank', 'noopener');
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
  $('#a2Video').style.display = env.isAndroid ? 'none' : ''; // 2.2：影片是 iPhone 的操作
  $('#a2BrIOS').style.display = env.isAndroid ? 'none' : '';
  $('#a2BrAnd').style.display = env.isAndroid ? '' : 'none';
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
