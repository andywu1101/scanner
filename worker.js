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

function detectQuad(cv, rgba, w, h) {
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
  }
  // 策略 3：Otsu 二值化（白紙在深色桌面）
  cv.threshold(blur, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, k);
  { const r = bestQuadFromEdges(cv, edges, w, h); if (r) candidates.push(r); }
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
function estimateBackground(cv, img) {
  // img: 8UC1 或 8UC3。回傳同尺寸的「紙張底色」估計
  const w = img.cols, h = img.rows;
  const scale = Math.min(1, 700 / Math.max(w, h));
  const small = new cv.Mat();
  cv.resize(img, small, new cv.Size(Math.round(w * scale), Math.round(h * scale)), 0, 0, cv.INTER_AREA);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11));
  cv.dilate(small, small, k);
  cv.medianBlur(small, small, 21);
  const bg = new cv.Mat();
  cv.resize(small, bg, new cv.Size(w, h), 0, 0, cv.INTER_LINEAR);
  small.delete(); k.delete();
  return bg;
}

function sharpen(cv, img, amount, sigma) {
  const blur = new cv.Mat();
  cv.GaussianBlur(img, blur, new cv.Size(0, 0), sigma);
  cv.addWeighted(img, 1 + amount, blur, -amount, 0, img);
  blur.delete();
}

function normalizeLight(cv, img) {
  const bg = estimateBackground(cv, img);
  const out = new cv.Mat();
  cv.divide(img, bg, out, 255);
  bg.delete();
  return out;
}

function processPage(cv, msg) {
  const { buffer, width, height, corners, rotation, mode } = msg;
  let src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(new Uint8Array(buffer));
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  src.delete();

  // 透視校正（以原始解析度）
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
  outW = Math.max(outW, 16); outH = Math.max(outH, 16);
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, P.flat());
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  let warped = new cv.Mat();
  cv.warpPerspective(rgb, warped, M, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
  rgb.delete(); srcTri.delete(); dstTri.delete(); M.delete();

  let result;
  if (mode === 'original') {
    result = warped;
  } else if (mode === 'color') {
    const norm = normalizeLight(cv, warped);
    warped.delete();
    // 黑位略壓、對比略增
    norm.convertTo(norm, -1, 1.1, -22);
    sharpen(cv, norm, 0.6, 1.2);
    result = norm;
  } else {
    const gray = new cv.Mat();
    cv.cvtColor(warped, gray, cv.COLOR_RGB2GRAY);
    warped.delete();
    const norm = normalizeLight(cv, gray);
    gray.delete();
    if (mode === 'gray') {
      norm.convertTo(norm, -1, 1.15, -30);
      sharpen(cv, norm, 0.7, 1.2);
      result = norm;
    } else {
      // 黑白：自適應門檻 + 深色區保底
      const bw = new cv.Mat();
      let block = Math.round(Math.min(outW, outH) / 45);
      if (block % 2 === 0) block++;
      block = Math.max(block, 15);
      const sm = new cv.Mat();
      cv.GaussianBlur(norm, sm, new cv.Size(3, 3), 0);
      cv.adaptiveThreshold(sm, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 14);
      const dark = new cv.Mat();
      cv.threshold(sm, dark, 110, 255, cv.THRESH_BINARY);
      cv.bitwise_and(bw, dark, bw);
      dark.delete(); sm.delete(); norm.delete();
      result = bw;
    }
  }

  // 旋轉
  const rot = ((rotation % 360) + 360) % 360;
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

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const { cv } = await getCv();
    if (type === 'detect') {
      const { buffer, width, height } = e.data;
      const r = detectQuad(cv, new Uint8Array(buffer), width, height);
      self.postMessage({ id, ok: true, result: r });
    } else if (type === 'process') {
      const r = processPage(cv, e.data);
      self.postMessage({ id, ok: true, result: r }, [r.buffer]);
    }
  } catch (err) {
    let m = err && err.message ? err.message : String(err);
    if (typeof err === 'number' && self.cv && self.cv.exceptionFromPtr) {
      try { m = self.cv.exceptionFromPtr(err).msg; } catch (_) {}
    }
    self.postMessage({ id, ok: false, error: m });
  }
};
