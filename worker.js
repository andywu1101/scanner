/* 可可掃描 — 影像處理 Worker（OpenCV.js） */
self.importScripts('lib/opencv.js');

let cvReady = null;
function getCv() {
  if (cvReady) return cvReady;
  // 注意：OpenCV 的 Module 是「thenable」，直接 resolve 會無限遞迴，所以包一層物件
  cvReady = new Promise((resolve) => {
    const c = self.cv;
    let fired = false;
    const done = (m) => {
      if (fired) return; fired = true;
      try { delete m.then; } catch (_) {}
      self.cv = m; resolve({ cv: m });
    };
    if (c && c.Mat && c.getPerspectiveTransform) done(c);
    else if (c && typeof c.then === 'function') {
      c.then((m) => done(m && m.Mat ? m : c));
      const t = setInterval(() => { if (c.Mat && c.getPerspectiveTransform) { clearInterval(t); done(c); } }, 100);
    } else if (c) c.onRuntimeInitialized = () => done(c);
  });
  return cvReady;
}
getCv().then(() => self.postMessage({ type: 'ready' }));

/* ---------- 工具 ---------- */
function orderCorners(pts) {
  // pts: [[x,y]x4] → TL, TR, BR, BL
  const s = pts.map((p) => p[0] + p[1]);
  const d = pts.map((p) => p[1] - p[0]);
  const tl = pts[s.indexOf(Math.min(...s))];
  const br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.min(...d))];
  const bl = pts[d.indexOf(Math.max(...d))];
  const out = [tl, tr, br, bl];
  // 若有重複點（極端角度），改用極角排序
  const uniq = new Set(out.map((p) => p.join(',')));
  if (uniq.size < 4) {
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
    const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    // 從左上開始
    let idx = 0, best = Infinity;
    sorted.forEach((p, i) => { if (p[0] + p[1] < best) { best = p[0] + p[1]; idx = i; } });
    return [0, 1, 2, 3].map((k) => sorted[(idx + k) % 4]);
  }
  return out;
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a += q[i][0] * q[j][1] - q[j][0] * q[i][1]; }
  return Math.abs(a) / 2;
}

function matToPts(m) {
  const pts = [];
  for (let i = 0; i < m.rows; i++) pts.push([m.data32S[i * 2], m.data32S[i * 2 + 1]]);
  return pts;
}

function bestQuadFromEdges(cv, edges, w, h) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const frame = w * h;
  let best = null, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area < frame * 0.12) { c.delete(); continue; }
    const hull = new cv.Mat();
    cv.convexHull(c, hull, false, true);
    const peri = cv.arcLength(hull, true);
    let quad = null;
    for (const eps of [0.02, 0.03, 0.04, 0.06, 0.08]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4) { quad = matToPts(approx); approx.delete(); break; }
      approx.delete();
      if (approx.rows < 4) break;
    }
    hull.delete(); c.delete();
    if (!quad) continue;
    const q = orderCorners(quad);
    const a = polyArea(q);
    // 排除整個畫面邊框
    const m = 3;
    const touching = q.filter((p) => p[0] <= m || p[1] <= m || p[0] >= w - 1 - m || p[1] >= h - 1 - m).length;
    if (touching === 4 && a > frame * 0.93) continue;
    if (a > bestArea) { bestArea = a; best = q; }
  }
  contours.delete(); hier.delete();
  return best ? { quad: best, area: bestArea / frame } : null;
}

function detectQuad(cv, rgba, w, h, fast) {
  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(rgba);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const candidates = [];
  const edges = new cv.Mat();

  // 策略 1、2：Canny（強 / 弱）
  for (const [lo, hi] of [[60, 160], [25, 75]]) {
    cv.Canny(blur, edges, lo, hi);
    cv.dilate(edges, edges, k);
    const r = bestQuadFromEdges(cv, edges, w, h);
    if (r) candidates.push(r);
    if (fast && r && r.area > 0.15) break; // 即時模式：找到就停，省時間也讓框更穩定
  }
  // 策略 3：Otsu 二值化（白紙在深色桌面）
  if (!(fast && candidates.length)) {
  cv.threshold(blur, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
  { const r = bestQuadFromEdges(cv, edges, w, h); if (r) candidates.push(r); }
  }
  // 策略 4：飽和度通道（白紙在有色桌面）
  if (!candidates.length) {
    const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const ch = new cv.MatVector(); cv.split(hsv, ch);
    const sat = ch.get(1);
    cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
    cv.threshold(sat, edges, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const r = bestQuadFromEdges(cv, edges, w, h); if (r) candidates.push(r);
    sat.delete(); ch.delete(); hsv.delete(); rgb.delete();
  }

  src.delete(); gray.delete(); blur.delete(); k.delete(); edges.delete();
  if (!candidates.length) return null;
  // 取面積最大但不貼滿畫面的
  candidates.sort((a, b) => b.area - a.area);
  const r = candidates[0];
  // 往中心內縮約 0.6%，避免把紙張邊緣外的桌面拍進去
  const cx = r.quad.reduce((a, p) => a + p[0], 0) / 4, cy = r.quad.reduce((a, p) => a + p[1], 0) / 4;
  const inset = 0.006;
  const q = r.quad.map((p) => [p[0] + (cx - p[0]) * inset * 2, p[1] + (cy - p[1]) * inset * 2]);
  return { corners: q.map((p) => [Math.min(1, Math.max(0, p[0] / w)), Math.min(1, Math.max(0, p[1] / h))]), area: r.area };
}

/* ---------- 真實長寬比（Zhang & He 白板掃描法） ---------- */
function trueAspect(P, width, height) {
  const u0 = width / 2, v0 = height / 2;
  const h = (p) => [p[0] - u0, p[1] - v0, 1];
  const m1 = h(P[0]), m2 = h(P[1]), m3 = h(P[3]), m4 = h(P[2]); // TL, TR, BL, BR
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const naive = Math.max(Math.hypot(P[0][0] - P[1][0], P[0][1] - P[1][1]), Math.hypot(P[3][0] - P[2][0], P[3][1] - P[2][1])) /
    Math.max(Math.hypot(P[0][0] - P[3][0], P[0][1] - P[3][1]), Math.hypot(P[1][0] - P[2][0], P[1][1] - P[2][1]));
  if (!isFinite(k2) || !isFinite(k3)) return null;
  const denom = n2[2] * n3[2];
  const maxDim = Math.max(width, height);
  let f2 = Math.abs(denom) > 1e-9 ? -(n2[0] * n3[0] + n2[1] * n3[1]) / denom : NaN;
  // 幾乎正對拍攝時焦距無法估計，用典型手機焦距（約 0.8 倍長邊）
  if (!(f2 > (0.4 * maxDim) ** 2 && f2 < (4 * maxDim) ** 2)) f2 = (0.8 * maxDim) ** 2;
  const q = (n) => (n[0] * n[0] + n[1] * n[1]) / f2 + n[2] * n[2];
  const ar = Math.sqrt(q(n2) / q(n3));
  if (!isFinite(ar) || ar <= 0 || ar / naive > 1.8 || naive / ar > 1.8) return null;
  return ar;
}

/* ---------- 增強 ---------- */
// 「紙張底色」的低解析度估計（整頁），img: 8UC1 或 8UC3
function backgroundSmall(cv, img) {
  const w = img.cols, h = img.rows;
  const scale = Math.min(1, 700 / Math.max(w, h));
  const small = new cv.Mat();
  cv.resize(img, small, new cv.Size(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11));
  cv.dilate(small, small, k);
  cv.medianBlur(small, small, 21);
  k.delete();
  return small;
}
// 把整頁底色放大到目前影像的尺寸；crop（整頁像素座標）有值時只取那一塊
function expandBackground(cv, small, outW, outH, full) {
  const bg = new cv.Mat();
  if (!full) { cv.resize(small, bg, new cv.Size(outW, outH), 0, 0, cv.INTER_LINEAR); return bg; }
  const sx = small.cols / full.w, sy = small.rows / full.h;
  const x0 = Math.max(0, Math.floor(full.x * sx) - 1), y0 = Math.max(0, Math.floor(full.y * sy) - 1);
  const x1 = Math.min(small.cols, Math.ceil((full.x + outW) * sx) + 1), y1 = Math.min(small.rows, Math.ceil((full.y + outH) * sy) + 1);
  const roi = small.roi(new cv.Rect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)));
  // 先放大這一小塊，再精準切出 crop 對應的範圍
  const fx = (x1 - x0) / sx, fy = (y1 - y0) / sy;
  const big = new cv.Mat();
  cv.resize(roi, big, new cv.Size(Math.max(1, Math.round(fx)), Math.max(1, Math.round(fy))), 0, 0, cv.INTER_LINEAR);
  roi.delete();
  const ox = Math.max(0, Math.min(big.cols - outW, Math.round(full.x - x0 / sx)));
  const oy = Math.max(0, Math.min(big.rows - outH, Math.round(full.y - y0 / sy)));
  const cut = big.roi(new cv.Rect(ox, oy, Math.min(outW, big.cols - ox), Math.min(outH, big.rows - oy)));
  if (cut.cols === outW && cut.rows === outH) cut.copyTo(bg); else cv.resize(cut, bg, new cv.Size(outW, outH), 0, 0, cv.INTER_LINEAR);
  cut.delete(); big.delete();
  return bg;
}

function sharpen(cv, img, amount, sigma) {
  if (amount <= 0.001) return;
  const blur = new cv.Mat();
  cv.GaussianBlur(img, blur, new cv.Size(0, 0), sigma);
  cv.addWeighted(img, 1 + amount, blur, -amount, 0, img);
  blur.delete();
}

// ctx.bg：預先算好的整頁底色（gray / rgb）；ctx.crop：這張影像在整頁中的位置
function normalizeLight(cv, img, ctx) {
  const key = img.channels() === 1 ? 'gray' : 'rgb';
  const pre = ctx && ctx.bg && ctx.bg[key];
  const small = pre || backgroundSmall(cv, img);
  const bg = expandBackground(cv, small, img.cols, img.rows, ctx && ctx.crop);
  if (!pre) small.delete();
  const out = new cv.Mat();
  cv.divide(img, bg, out, 255);
  bg.delete();
  return out;
}

/* ---------- 調整參數 ----------
   exposure / contrast / saturation / temp / density：-100 ~ 100（0 = 預設）
   sharp / despeckle：0 ~ 100
   空間相關的數值（模糊半徑、雜點面積）依頁面短邊等比例換算，預覽與全解析度效果一致 */
const ADJ_DEFAULTS = {
  bw: { exposure: 0, contrast: 0, density: 0, sharp: 35, despeckle: 20 },
  gray: { exposure: 0, contrast: 0, sharp: 50 },
  color: { exposure: 0, contrast: 0, sharp: 50, saturation: 0, temp: 0 },
  original: { exposure: 0, contrast: 0, sharp: 0, saturation: 0, temp: 0 },
};

// 曝光（約 ±1 級）＋對比，做成查表一次套用；base 是各模式原本的固定調整
function toneLUT(cv, p, baseGain, baseOff) {
  const gain = Math.pow(2, (p.exposure || 0) / 100);
  const con = p.contrast || 0;
  const c = con >= 0 ? 1 + con / 100 : 1 + con / 150;
  const lut = new cv.Mat(1, 256, cv.CV_8UC1);
  for (let x = 0; x < 256; x++) {
    let v = (x * baseGain + baseOff) * gain;
    v = (v - 128) * c + 128;
    lut.data[x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return lut;
}
function applyTone(cv, img, p, baseGain, baseOff) {
  const lut = toneLUT(cv, p, baseGain, baseOff);
  cv.LUT(img, lut, img);
  lut.delete();
}
// 飽和度與色溫（RGB）
function applyColor(cv, img, p) {
  const sat = 1 + (p.saturation || 0) / 100;
  if (Math.abs(sat - 1) > 0.001) {
    const g = new cv.Mat(), g3 = new cv.Mat();
    cv.cvtColor(img, g, cv.COLOR_RGB2GRAY);
    cv.cvtColor(g, g3, cv.COLOR_GRAY2RGB);
    cv.addWeighted(img, sat, g3, 1 - sat, 0, img);
    g.delete(); g3.delete();
  }
  const t = (p.temp || 0) / 100;
  if (Math.abs(t) > 0.001) {
    const ch = new cv.MatVector();
    cv.split(img, ch);
    const r = ch.get(0), b = ch.get(2);
    r.convertTo(r, -1, 1 + 0.18 * t, 0);
    b.convertTo(b, -1, 1 - 0.18 * t, 0);
    cv.merge(ch, img);
    r.delete(); b.delete(); ch.delete();
  }
}
// 去雜點：移除面積小於 area 的孤立黑點
function despeckle(cv, bw, area) {
  if (area < 1) return;
  const inv = new cv.Mat();
  cv.bitwise_not(bw, inv);
  const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S);
  const kill = new Uint8Array(n);
  let any = false;
  for (let i = 1; i < n; i++) {
    if (stats.intAt(i, cv.CC_STAT_AREA) < area) { kill[i] = 1; any = true; }
  }
  if (any) {
    const L = labels.data32S, D = bw.data;
    for (let i = 0; i < L.length; i++) if (kill[L[i]]) D[i] = 255;
  }
  inv.delete(); labels.delete(); stats.delete(); cents.delete();
}

// 對已校正的 RGB 頁面套用模式與調整（會用掉 warped），回傳 1 或 3 通道結果
// ctx（可省略）：{ minSide 整頁短邊, bg 整頁底色, crop 區域位置 } —— 讓區域計算與整頁結果一致
function enhance(cv, warped, mode, params, ctx) {
  const p = Object.assign({}, ADJ_DEFAULTS[mode] || {}, params || {});
  const minSide = (ctx && ctx.minSide) || Math.min(warped.cols, warped.rows);
  const k = Math.max(0.25, minSide / 2400);
  const sig = (s) => Math.max(0.35, s * k);

  if (mode === 'original') {
    applyTone(cv, warped, p, 1, 0);
    applyColor(cv, warped, p);
    sharpen(cv, warped, (p.sharp / 100) * 1.2, sig(1.2));
    return warped;
  }
  if (mode === 'color') {
    const norm = normalizeLight(cv, warped, ctx);
    warped.delete();
    applyTone(cv, norm, p, 1.1, -22);
    applyColor(cv, norm, p);
    sharpen(cv, norm, (p.sharp / 100) * 1.2, sig(1.2));
    return norm;
  }
  const gray = new cv.Mat();
  cv.cvtColor(warped, gray, cv.COLOR_RGB2GRAY);
  warped.delete();
  const norm = normalizeLight(cv, gray, ctx);
  gray.delete();
  if (mode === 'gray') {
    applyTone(cv, norm, p, 1.15, -30);
    sharpen(cv, norm, (p.sharp / 100) * 1.4, sig(1.2));
    return norm;
  }
  // 黑白
  applyTone(cv, norm, p, 1, 0);
  const s = p.sharp;
  const sm = new cv.Mat();
  if (s <= 50) {
    // 越低越柔：門檻前先模糊，可同時壓掉紙紋
    cv.GaussianBlur(norm, sm, new cv.Size(0, 0), sig(0.6 + ((50 - s) / 50) * 1.4));
  } else {
    cv.GaussianBlur(norm, sm, new cv.Size(0, 0), sig(0.6));
    sharpen(cv, sm, ((s - 50) / 50) * 1.5, sig(1.0));
  }
  norm.delete();
  let block = Math.round(minSide / 45);
  if (block % 2 === 0) block++;
  block = Math.max(block, 15);
  const d = p.density || 0;
  const C = 16 - d * 0.11; // 越大越不容易變黑；預設比舊版（14）寬鬆一點
  const bw = new cv.Mat();
  cv.adaptiveThreshold(sm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, C);
  const dark = new cv.Mat();
  cv.threshold(sm, dark, 110 + d * 0.5, 255, cv.THRESH_BINARY); // 很暗的地方一定是黑（填滿符頭）
  cv.bitwise_and(bw, dark, bw);
  dark.delete(); sm.delete();
  if (s <= 50) cv.medianBlur(bw, bw, 3); // 修掉鋸齒與單點雜訊
  const area = Math.pow((p.despeckle || 0) / 100, 1.5) * 90 * k * k;
  despeckle(cv, bw, area);
  return bw;
}

// 透視校正；maxSide 有值時（預覽）以較小尺寸輸出
function warpPage(cv, rgb, width, height, corners, maxSide) {
  const P = corners.map((c) => [c[0] * width, c[1] * height]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let outW = Math.round(Math.max(dist(P[0], P[1]), dist(P[3], P[2])));
  let outH = Math.round(Math.max(dist(P[0], P[3]), dist(P[1], P[2])));
  const ar = trueAspect(P, width, height);
  if (ar) {
    // 以較長邊的像素數為準，依真實長寬比重算另一邊，避免透視造成頁面被壓扁
    if (outW / outH > ar) outH = Math.round(outW / ar); else outW = Math.round(outH * ar);
  }
  const cap = 16000000;
  if (outW * outH > cap) { const s = Math.sqrt(cap / (outW * outH)); outW = Math.floor(outW * s); outH = Math.floor(outH * s); }
  if (maxSide && Math.max(outW, outH) > maxSide) { const s = maxSide / Math.max(outW, outH); outW = Math.round(outW * s); outH = Math.round(outH * s); }
  outW = Math.max(outW, 16); outH = Math.max(outH, 16);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, P.flat());
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const warped = new cv.Mat();
  cv.warpPerspective(rgb, warped, M, new cv.Size(outW, outH), maxSide ? cv.INTER_AREA : cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  srcTri.delete(); dstTri.delete(); M.delete();
  return warped;
}
function rgbFromBuffer(cv, buffer, width, height) {
  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(new Uint8Array(buffer));
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();
  return rgb;
}
function finish(cv, result, rotation) {
  const rot = (((rotation || 0) % 360) + 360) % 360;
  if (rot) {
    const r = new cv.Mat();
    const code = rot === 90 ? cv.ROTATE_90_CLOCKWISE : rot === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
    cv.rotate(result, r, code);
    result.delete();
    result = r;
  }
  const rgba = new cv.Mat();
  cv.cvtColor(result, rgba, result.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
  const out = new Uint8ClampedArray(rgba.data); // 複製
  const res = { buffer: out.buffer, width: rgba.cols, height: rgba.rows };
  result.delete(); rgba.delete();
  return res;
}

function processPage(cv, msg) {
  const { buffer, width, height, corners, rotation, mode, params } = msg;
  const rgb = rgbFromBuffer(cv, buffer, width, height);
  const warped = warpPage(cv, rgb, width, height, corners);
  rgb.delete();
  return finish(cv, enhance(cv, warped, mode, params), rotation);
}

// 調整拉桿的預覽：worker 保留「全解析度校正圖」與縮小版
//  - 整頁預覽用縮小版（快），數值依整頁尺度換算
//  - 放大檢查時，用全解析度只算看得到的那一塊（與匯出結果一致）
let previewCache = null;
function releaseCache() {
  if (!previewCache) return;
  const c = previewCache;
  c.full.delete(); c.small.delete();
  for (const k of ['gray', 'rgb']) if (c.bg[k]) c.bg[k].delete();
  previewCache = null;
}
function prepare(cv, msg) {
  releaseCache();
  const { key, buffer, width, height, corners, maxSide } = msg;
  const rgb = rgbFromBuffer(cv, buffer, width, height);
  const full = warpPage(cv, rgb, width, height, corners);
  rgb.delete();
  const s = Math.min(1, maxSide / Math.max(full.cols, full.rows));
  const small = new cv.Mat();
  cv.resize(full, small, new cv.Size(Math.max(1, Math.round(full.cols * s)), Math.max(1, Math.round(full.rows * s))), 0, 0, cv.INTER_AREA);
  // 整頁底色一次算好（灰階與彩色各一份）
  const g = new cv.Mat();
  cv.cvtColor(full, g, cv.COLOR_RGB2GRAY);
  const bg = { gray: backgroundSmall(cv, g), rgb: backgroundSmall(cv, full) };
  g.delete();
  previewCache = { key, full, small, bg };
  return { width: small.cols, height: small.rows, fullW: full.cols, fullH: full.rows };
}
function cacheFor(key) {
  if (!previewCache || previewCache.key !== key) throw new Error('preview-missing');
  return previewCache;
}
function renderPreview(cv, msg) {
  const c = cacheFor(msg.key);
  const ctx = { minSide: Math.min(c.full.cols, c.full.rows), bg: c.bg, scale: c.small.cols / c.full.cols };
  // 縮小版的模糊半徑、雜點面積要依縮小比例換算，所以傳「整頁短邊 × 縮小比例」
  ctx.minSide *= ctx.scale;
  return finish(cv, enhance(cv, c.small.clone(), msg.mode, msg.params, ctx), msg.rotation);
}
// rect：旋轉後畫面上的區域（0~1）。換回未旋轉的座標
function unrotateRect(r, rot) {
  const pts = [[r.x, r.y], [r.x + r.w, r.y + r.h]].map(([u, v]) => {
    if (rot === 90) return [v, 1 - u];
    if (rot === 180) return [1 - u, 1 - v];
    if (rot === 270) return [1 - v, u];
    return [u, v];
  });
  const x0 = Math.min(pts[0][0], pts[1][0]), x1 = Math.max(pts[0][0], pts[1][0]);
  const y0 = Math.min(pts[0][1], pts[1][1]), y1 = Math.max(pts[0][1], pts[1][1]);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function renderRegion(cv, msg) {
  const c = cacheFor(msg.key);
  const rot = (((msg.rotation || 0) % 360) + 360) % 360;
  const F = c.full, W = F.cols, H = F.rows;
  const u = unrotateRect(msg.rect, rot);
  let x = Math.max(0, Math.floor(u.x * W)), y = Math.max(0, Math.floor(u.y * H));
  let x2 = Math.min(W, Math.ceil((u.x + u.w) * W)), y2 = Math.min(H, Math.ceil((u.y + u.h) * H));
  if (x2 - x < 8 || y2 - y < 8) throw new Error('region-too-small');
  // 四周多算一圈，避免邊界的模糊、門檻、去雜點效果不正確
  const m = 96;
  const mx = Math.max(0, x - m), my = Math.max(0, y - m), mx2 = Math.min(W, x2 + m), my2 = Math.min(H, y2 + m);
  const roi = F.roi(new cv.Rect(mx, my, mx2 - mx, my2 - my));
  const crop = roi.clone(); roi.delete();
  const ctx = { minSide: Math.min(W, H), bg: c.bg, crop: { x: mx, y: my, w: W, h: H } };
  const out = enhance(cv, crop, msg.mode, msg.params, ctx);
  const inner = out.roi(new cv.Rect(x - mx, y - my, x2 - x, y2 - y));
  const res = inner.clone(); inner.delete(); out.delete();
  const r = finish(cv, res, rot);
  // 回傳實際範圍（旋轉後 0~1）
  const back = [[x / W, y / H], [x2 / W, y2 / H]].map(([a, b]) => {
    if (rot === 90) return [1 - b, a];
    if (rot === 180) return [1 - a, 1 - b];
    if (rot === 270) return [b, 1 - a];
    return [a, b];
  });
  r.rect = { x: Math.min(back[0][0], back[1][0]), y: Math.min(back[0][1], back[1][1]), w: Math.abs(back[1][0] - back[0][0]), h: Math.abs(back[1][1] - back[0][1]) };
  return r;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const { cv } = await getCv();
    if (type === 'detect') {
      const { buffer, width, height, fast } = e.data;
      const r = detectQuad(cv, new Uint8Array(buffer), width, height, !!fast);
      self.postMessage({ id, ok: true, result: r });
    } else if (type === 'process') {
      const r = processPage(cv, e.data);
      self.postMessage({ id, ok: true, result: r }, [r.buffer]);
    } else if (type === 'prepare') {
      self.postMessage({ id, ok: true, result: prepare(cv, e.data) });
    } else if (type === 'render') {
      const r = renderPreview(cv, e.data);
      self.postMessage({ id, ok: true, result: r }, [r.buffer]);
    } else if (type === 'region') {
      const r = renderRegion(cv, e.data);
      self.postMessage({ id, ok: true, result: r }, [r.buffer]);
    } else if (type === 'release') {
      releaseCache();
      self.postMessage({ id, ok: true, result: null });
    }
  } catch (err) {
    let m = err && err.message ? err.message : String(err);
    if (typeof err === 'number' && self.cv && self.cv.exceptionFromPtr) {
      try { m = self.cv.exceptionFromPtr(err).msg; } catch (_) {}
    }
    self.postMessage({ id, ok: false, error: m });
  }
};
