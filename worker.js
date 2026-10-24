/* 小伍敵樂譜掃描 — 影像處理 Worker（OpenCV.js） */
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

// 從邊緣圖收集所有「像一張紙」的四邊形（1.19 起全部收集，交給 detectQuad 評分挑選）
function quadsFromEdges(cv, edges, w, h, out) {
  const contours = new cv.MatVector();
  const hier = new cv.Mat();
  cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const frame = w * h;
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
      const n = approx.rows; // 先讀出點數，再釋放
      if (n === 4) quad = matToPts(approx);
      approx.delete();
      if (n <= 4) break;
    }
    hull.delete(); c.delete();
    if (!quad) continue;
    const q = orderCorners(quad);
    const a = polyArea(q);
    // 排除整個畫面邊框
    const m = 3;
    const touching = q.filter((p) => p[0] <= m || p[1] <= m || p[0] >= w - 1 - m || p[1] >= h - 1 - m).length;
    if (touching === 4 && a > frame * 0.93) continue;
    out.push({ quad: q, area: a / frame });
  }
  contours.delete(); hier.delete();
}

// 框邊「裡亮外暗」的程度（1.19）：紙在桌上，邊框內側是白紙、外側是桌面 → 差很多；
// 紙上印的框線、譜表區塊，框內外都是紙 → 差不多或裡面反而比較暗。貼著畫面邊緣的那一邊看不到外側，不算。
function edgeContrast(g, w, h, q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const d = Math.max(3, Math.round(Math.min(w, h) * 0.02)), m = 3;
  const at = (x, y) => g[Math.round(y) * w + Math.round(x)];
  let sum = 0, sides = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const onBorder = (a[0] <= m && b[0] <= m) || (a[1] <= m && b[1] <= m) || (a[0] >= w - 1 - m && b[0] >= w - 1 - m) || (a[1] >= h - 1 - m && b[1] >= h - 1 - m);
    if (onBorder) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (nx * (mx - cx) + ny * (my - cy) < 0) { nx = -nx; ny = -ny; } // 法向量朝外
    let s = 0, n = 0;
    for (let k = 1; k <= 12; k++) {
      const t = 0.08 + 0.84 * (k - 0.5) / 12;
      const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      const ix = px - nx * d, iy = py - ny * d, ox = px + nx * d, oy = py + ny * d;
      if (ox < 0 || oy < 0 || ox > w - 1 || oy > h - 1 || ix < 0 || iy < 0 || ix > w - 1 || iy > h - 1) continue;
      s += at(ix, iy) - at(ox, oy); n++;
    }
    if (n >= 4) { sum += s / n; sides++; }
  }
  return sides ? sum / sides : null;
}

// 書溝（1.19）：在框裡找一條從上到下的陰影谷線，找到就把框切成左右兩頁，回傳比較完整的那一頁
function splitGutter(cv, gray, q, w, h) {
  const RW = 240, RH = 320;
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [].concat(...q));
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, RW, 0, RW, RH, 0, RH]);
  const M = cv.getPerspectiveTransform(from, to);
  const Minv = cv.getPerspectiveTransform(to, from);
  const r = new cv.Mat();
  cv.warpPerspective(gray, r, M, new cv.Size(RW, RH), cv.INTER_AREA, cv.BORDER_REPLICATE);
  const prof = (y0, y1, R) => {
    const out = new Float32Array(RW), Y0 = Math.round(RH * y0), Y1 = Math.round(RH * y1);
    for (let x = 0; x < RW; x++) { let s = 0; for (let y = Y0; y < Y1; y++) s += r.data[y * RW + x]; out[x] = s / (Y1 - Y0); }
    if (!R) return out;
    const sm = new Float32Array(RW); // 平滑（R=4 約 3.5%），抹掉小節線這類細線
    for (let x = 0; x < RW; x++) { let s = 0, n = 0; for (let k = -R; k <= R; k++) { const j = x + k; if (j >= 0 && j < RW) { s += out[j]; n++; } } sm[x] = s / n; }
    return sm;
  };
  const mid = prof(0.15, 0.85, 4), topB = prof(0.02, 0.12, 1), botB = prof(0.88, 0.98, 1);
  const Minv64 = Minv.data64F.slice();
  from.delete(); to.delete(); M.delete(); Minv.delete(); r.delete();
  const depthAt = (P, k, thr) => {
    const w1 = Math.round(RW * 0.25), w0 = Math.round(RW * 0.03);
    let lm = -1, rm = -1, v = 1e9;
    for (let j = k - 3; j <= k + 3; j++) if (j >= 0 && j < RW) v = Math.min(v, P[j]);
    for (let j = k - w1; j <= k - w0; j++) if (j >= 0) lm = Math.max(lm, P[j]);
    for (let j = k + w0; j <= k + w1; j++) if (j < RW) rm = Math.max(rm, P[j]);
    if (lm < 0 || rm < 0) return 0;
    const side = Math.min(lm, rm);
    return side - v >= thr && v < side * 0.9 ? side - v : 0;
  };
  // 書溝陰影有寬度：在留白帶裡，比「一半深度」還暗的範圍至少要 2%（印刷框線只有 1、2 像素寬）
  const wideAt = (P, k) => {
    let v = 1e9, kk = k;
    for (let j = k - 4; j <= k + 4; j++) if (j >= 0 && j < RW && P[j] < v) { v = P[j]; kk = j; }
    const dpt = depthAt(P, kk, 8);
    if (!dpt) return false;
    const half = v + dpt / 2;
    let a = kk, b = kk;
    while (a > 0 && P[a - 1] < half) a--;
    while (b < RW - 1 && P[b + 1] < half) b++;
    return b - a + 1 >= Math.max(4, RW * 0.02);
  };
  // 中段的谷（局部最低點）由深到淺逐一檢查；上下留白也要看得到同一條寬陰影才算書溝
  // （譜號、大括號造成的暗帶只出現在譜表區，留白沒有，這樣可避免誤判）
  const vals = [];
  for (let k = Math.round(RW * 0.06); k <= Math.round(RW * 0.94); k++) {
    let isMin = true;
    for (let j = k - 3; j <= k + 3; j++) if (j !== k && j >= 0 && j < RW && mid[j] < mid[k]) { isMin = false; break; }
    if (!isMin) continue;
    const dpt = depthAt(mid, k, 18);
    if (dpt) vals.push([dpt, k]);
  }
  vals.sort((a, b) => b[0] - a[0]);
  let best = -1;
  for (const [, k] of vals) {
    if (wideAt(topB, k) && wideAt(botB, k)) { best = k; break; }
  }
  if (best < 0) return null;
  const map = (x, y) => {
    const H = Minv64, z = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
  };
  const gt = map(best, 0), gb = map(best, RH);
  const L = [q[0], gt, gb, q[3]], R = [gt, q[1], q[2], gb];
  const m = Math.min(w, h) * 0.015;
  const touch = (Q) => Q.filter((p) => p[0] <= m || p[1] <= m || p[0] >= w - 1 - m || p[1] >= h - 1 - m).length;
  // 切出來的那一頁要像一頁樂譜（寬至少是高的一半）；對折過的單張紙，半邊太窄，不算書溝
  const asp = (Q) => {
    const wd = (Math.hypot(Q[1][0] - Q[0][0], Q[1][1] - Q[0][1]) + Math.hypot(Q[2][0] - Q[3][0], Q[2][1] - Q[3][1])) / 2;
    const ht = (Math.hypot(Q[3][0] - Q[0][0], Q[3][1] - Q[0][1]) + Math.hypot(Q[2][0] - Q[1][0], Q[2][1] - Q[1][1])) / 2;
    return Math.min(wd, ht) / Math.max(wd, ht, 1);
  };
  const ctr = (Q) => Math.hypot(Q.reduce((a, p) => a + p[0], 0) / 4 / w - 0.5, Q.reduce((a, p) => a + p[1], 0) / 4 / h - 0.5);
  const tL = touch(L), tR = touch(R);
  // 優先：沒有超出畫面的那頁 → 比較靠近畫面中央的那頁
  const pick = tL !== tR ? (tL < tR ? L : R) : (ctr(L) <= ctr(R) ? L : R);
  if (asp(pick) < 0.5) return null;
  return { quad: pick, area: polyArea(pick) / (w * h) };
}

// 兩頁交界的凹口（1.20）：書本攤開或兩張紙疊在一起時，白色區塊（紙）的外緣在兩頁交界處會往內凹。
// 想像用橡皮筋把整塊白色圍起來（凸包），外緣比橡皮筋凹進去的地方就是凹口。上下兩個凹口連成的線＝兩頁的分界。
// 回傳 { kind: 2, p, q }（兩個凹口）、{ kind: 1, p, side, weak }（只有一個，旁邊那頁超出畫面）或 null
function notchLine(cv, bin, w, h) {
  const cs = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(bin, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
  let c = null, ca = 0;
  for (let i = 0; i < cs.size(); i++) { const t = cs.get(i), a = cv.contourArea(t); if (a > ca) { if (c) c.delete(); c = t; ca = a; } else t.delete(); }
  hier.delete(); cs.delete();
  if (!c || ca < w * h * 0.12) { if (c) c.delete(); return null; }
  const P = []; for (let i = 0; i < c.rows; i++) P.push([c.data32S[i * 2], c.data32S[i * 2 + 1]]);
  const hm = new cv.Mat(); cv.convexHull(c, hm, false, false);
  const idx = Array.from(hm.data32S).sort((a, b) => a - b);
  hm.delete(); c.delete();
  // 每兩個相鄰的凸包點之間，離凸包邊最遠的輪廓點＝凹口（自己算，不依賴 OpenCV.js 有沒有 convexityDefects）
  const m = Math.min(w, h), minDep = Math.max(3, m * 0.008), defs = [], weak = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], j = idx[(k + 1) % idx.length];
    const A = P[i], B = P[j], L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < 1) continue;
    let best = 0, bi = -1;
    for (let t = (i + 1) % P.length; t !== j; t = (t + 1) % P.length) {
      const d = Math.abs((B[0] - A[0]) * (A[1] - P[t][1]) - (A[0] - P[t][0]) * (B[1] - A[1])) / L;
      if (d > best) { best = d; bi = t; }
    }
    if (bi >= 0 && best >= minDep) defs.push({ p: P[bi], d: best });
    if (bi >= 0 && best >= 1.2) weak.push({ p: P[bi], d: best });
  }
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const [x, y] of P) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  const bh = by1 - by0, bw = bx1 - bx0;
  // 兩個凹口連成分界線（手影造成的缺口在紙中間，連不成這種線）：
  //  第一輪找接近直的（左右偏 ≤ 上下距離 0.35 倍；書本、一般散頁）
  //  找不到才接受較斜的（≤ 0.6 倍，1.22）：散頁斜斜壓在角落時紙邊是斜的；但兩個凹口都要在同一側外緣 30% 內，
  //  否則會把紙中間的手影缺口誤配成一對（試過不加這條，作者 15 張照片有 4 張被誤切）
  const sideOf = (x) => (x - bx0 < bw * 0.3 ? 'L' : bx1 - x < bw * 0.3 ? 'R' : '');
  let best = null;
  for (const lim of [0.35, 0.6]) {
    for (let a = 0; a < defs.length; a++) for (let b = a + 1; b < defs.length; b++) {
      const p = defs[a].p, q = defs[b].p, dx = q[0] - p[0], dy = q[1] - p[1];
      if (Math.abs(dy) < bh * 0.08 || Math.abs(dx) > Math.abs(dy) * lim) continue;
      if (lim > 0.35 && (!sideOf(p[0]) || sideOf(p[0]) !== sideOf(q[0]))) continue;
      const sc = defs[a].d + defs[b].d;
      if (!best || sc > best.sc) best = { sc, p, q };
    }
    if (best) break;
  }
  if (best) return { kind: 2, p: best.p, q: best.q };
  // 只有一個凹口：要在上緣或下緣附近、靠左右外側 30%，而且那一側的白色區塊延伸到畫面外
  const touchL = bx0 <= 2, touchR = bx1 >= w - 3;
  let one = null;
  for (const d of defs) {
    const [x, y] = d.p;
    const nearTB = y - by0 < bh * 0.15 || by1 - y < bh * 0.15;
    const side = x - bx0 < bw * 0.3 ? 'L' : bx1 - x < bw * 0.3 ? 'R' : '';
    if (!nearTB || !side || (side === 'L' && !touchL) || (side === 'R' && !touchR)) continue;
    if (!one || d.d > one.d.d) one = { d, side };
  }
  return one ? { kind: 1, p: one.d.p, side: one.side, weak } : null;
}

// 沿凹口分界切掉旁邊那頁（1.20）：在白色遮罩上沿分界線畫一條黑線把兩頁分開，再重新找框。
// 保險：分界線往旁邊那頁多留 1.5%（寧可多框一點書溝，不要切到內容）；切掉超過 35%、或切完不像一頁（寬不到高的一半）就不切
function cutAtNotch(cv, bin, r, w, h) {
  const ns = Math.min(1, 480 / Math.max(w, h)); // 凹口一律在長邊約 480 的遮罩上找，即時與完整偵測結果才會一致
  let nb = bin;
  if (ns < 1) { nb = new cv.Mat(); cv.resize(bin, nb, new cv.Size(Math.round(w * ns), Math.round(h * ns)), 0, 0, cv.INTER_AREA); cv.threshold(nb, nb, 127, 255, cv.THRESH_BINARY); }
  const nl = notchLine(cv, nb, nb.cols, nb.rows);
  if (nb !== bin) nb.delete();
  if (!nl) return null;
  const up = (p) => [p[0] / ns, p[1] / ns];
  const a = up(nl.p);
  let b;
  if (nl.kind === 2) b = up(nl.q);
  else {
    // 只有一個凹口：先假設分界線與框另一側的紙邊平行；再到另一端預估位置左右 10% 內找較淺的凹口當第二點
    // （手機斜拿時，透視會讓同一頁左右兩邊在照片裡不平行，只靠平行會越往下越偏）
    const e = nl.side === 'L' ? [r.quad[1], r.quad[2]] : [r.quad[0], r.quad[3]];
    const vx = e[1][0] - e[0][0], vy = e[1][1] - e[0][1];
    if (Math.abs(vy) < 1) return null;
    b = [a[0] + vx, a[1] + vy];
    const top = a[1] < h / 2;
    let sec = null;
    for (const d of nl.weak) {
      const P2 = up(d.p);
      const far = top ? P2[1] > h * 0.6 : P2[1] < h * 0.4;
      const xAt = a[0] + vx * ((P2[1] - a[1]) / vy);
      if (!far || Math.abs(P2[0] - xAt) > w * 0.10) continue;
      if (!sec || d.d > sec.d) sec = { p: P2, d: d.d };
    }
    if (sec) b = sec.p;
  }
  let dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.abs(dy) < 1) return null;
  // 往旁邊那頁（遠離框中心的那一側）平移 1.5%
  const Ln = Math.hypot(dx, dy), nx = dy / Ln, ny = -dx / Ln;
  const cx = r.quad.reduce((s, p) => s + p[0], 0) / 4, cy = r.quad.reduce((s, p) => s + p[1], 0) / 4;
  const sgn = (cx - a[0]) * nx + (cy - a[1]) * ny > 0 ? -1 : 1, sh = w * 0.015 * sgn;
  const a2 = [a[0] + nx * sh, a[1] + ny * sh];
  const t0 = -a2[1] / dy, t1 = (h - a2[1]) / dy;
  const cut = bin.clone();
  cv.line(cut, new cv.Point(Math.round(a2[0] + dx * t0), 0), new cv.Point(Math.round(a2[0] + dx * t1), h), new cv.Scalar(0), 3);
  const nc = []; quadsFromEdges(cv, cut, w, h, nc); cut.delete();
  let bestN = null; for (const c2 of nc) if (!bestN || c2.area > bestN.area) bestN = c2;
  if (!bestN || bestN.area <= 0.1 || bestN.area >= r.area * 0.97) return null;
  if (bestN.area < r.area * 0.62) return null; // 切掉太多（超過約 35%）
  const Q = bestN.quad;
  const wd = (Math.hypot(Q[1][0] - Q[0][0], Q[1][1] - Q[0][1]) + Math.hypot(Q[2][0] - Q[3][0], Q[2][1] - Q[3][1])) / 2;
  const ht = (Math.hypot(Q[3][0] - Q[0][0], Q[3][1] - Q[0][1]) + Math.hypot(Q[2][0] - Q[1][0], Q[2][1] - Q[1][1])) / 2;
  if (Math.min(wd, ht) / Math.max(wd, ht, 1) < 0.5) return null; // 切完不像一頁
  return { quad: Q, area: bestN.area, notch: nl.kind };
}

// 三個角推算第四個角（1.23）：只有一個角貼到畫面邊緣、另外三個角都在畫面內時，那個角多半找錯了
// （例如散頁疊著，被旁邊的紙帶偏）。從兩個相鄰的好角出發，沿原本的邊在附近找真正的紙邊（裡亮外暗最明顯處），
// 各擬合一條直線，兩線交點就是第四個角（照片有透視，兩邊不平行，所以不用平行四邊形去補）。
function inferCorner(G, w, h, q) {
  const m = 0.01, inner = 0.03;
  const near = q.map(([x, y]) => x < w * m || x > w * (1 - m) || y < h * m || y > h * (1 - m));
  const safe = q.map(([x, y]) => x > w * inner && x < w * (1 - inner) && y > h * inner && y < h * (1 - inner));
  const bad = near.indexOf(true);
  if (bad < 0 || near.filter(Boolean).length !== 1 || q.some((p, i) => i !== bad && !safe[i])) return null;
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : G[yi * w + xi]; };
  const range = Math.min(w, h) * 0.07, step = 2;
  // 從好角 A 往壞角 B 的方向找紙邊，回傳擬合的直線 {p, d}
  const fitEdge = (A, B) => {
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy); if (L < 10) return null;
    let nx = -dy / L, ny = dx / L;
    if (nx * (A[0] + dx / 2 - cx) + ny * (A[1] + dy / 2 - cy) < 0) { nx = -nx; ny = -ny; } // 朝外
    const pts = [];
    for (let t = 0.06; t <= 0.62; t += 0.04) {
      const px = A[0] + dx * t, py = A[1] + dy * t;
      let best = 0, bo = null;
      for (let o = -range; o <= range; o += 1) {
        const ix = px + nx * (o - step), iy = py + ny * (o - step), ox = px + nx * (o + step), oy = py + ny * (o + step);
        const vi = at(ix, iy), vo = at(ox, oy); if (vi < 0 || vo < 0) continue;
        const d = vi - vo; if (d > best) { best = d; bo = o; }
      }
      if (bo !== null && best >= 12) pts.push([px + nx * bo, py + ny * bo]);
    }
    if (pts.length < 6) return null;
    // 兩次最小平方，第二次去掉離太遠的點
    let fit = null, use = pts;
    for (let it = 0; it < 2; it++) {
      const n = use.length, mx = use.reduce((s, p) => s + p[0], 0) / n, my = use.reduce((s, p) => s + p[1], 0) / n;
      let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of use) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      fit = { p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] };
      const dist = (p) => Math.abs((p[0] - mx) * fit.d[1] - (p[1] - my) * fit.d[0]);
      const tol = Math.max(2, Math.min(w, h) * 0.006);
      const keep = pts.filter((p) => dist(p) <= tol);
      if (keep.length < 5) return null;
      use = keep;
    }
    // 方向要和原本的邊差不多（30 度內）
    const cosA = Math.abs(fit.d[0] * dx + fit.d[1] * dy) / L; if (cosA < 0.87) return null;
    return fit;
  };
  const prev = q[(bad + 3) % 4], next = q[(bad + 1) % 4], B = q[bad];
  const e1 = fitEdge(prev, B), e2 = fitEdge(next, B);
  if (!e1 || !e2) return null;
  const den = e1.d[0] * e2.d[1] - e1.d[1] * e2.d[0]; if (Math.abs(den) < 0.2) return null;
  const t = ((e2.p[0] - e1.p[0]) * e2.d[1] - (e2.p[1] - e1.p[1]) * e2.d[0]) / den;
  const D = [e1.p[0] + e1.d[0] * t, e1.p[1] + e1.d[1] * t];
  if (D[0] < w * m || D[0] > w * (1 - m) || D[1] < h * m || D[1] > h * (1 - m)) return null; // 推算的角也要在畫面內
  const moved = Math.hypot((D[0] - B[0]) / w, (D[1] - B[1]) / h);
  if (moved < 0.012 || moved > 0.2) return null;
  const nq = q.map((p, i) => (i === bad ? D : p));
  // 要是凸四邊形
  let sg = 0; for (let i = 0; i < 4; i++) { const a = nq[i], b = nq[(i + 1) % 4], c = nq[(i + 2) % 4]; const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]); if (sg && Math.sign(cr) !== sg) return null; sg = Math.sign(cr); }
  return nq;
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

  // 評分（1.19）：面積 ×「裡亮外暗」程度。紙張與桌面的交界最高分，紙上的框線、譜表區塊分數低
  const g = blur.data;
  const scoreAll = () => {
    for (const c of candidates) {
      if (c.score !== undefined) continue;
      const ec = edgeContrast(g, w, h, c.quad);
      c.contrast = ec;
      c.f = ec === null ? 0.6 : 0.3 + 0.7 * Math.min(1, Math.max(0, ec / 30));
      c.score = c.area * c.f;
    }
  };
  const confident = () => { scoreAll(); return candidates.some((c) => c.f >= 0.95 && c.area > 0.15); };
  // 策略 1：Canny（強）
  cv.Canny(blur, edges, 60, 160);
  cv.dilate(edges, edges, k);
  quadsFromEdges(cv, edges, w, h, candidates);
  // 策略 2：Otsu 二值化（白紙在深色桌面；紙超出畫面時也只有這個找得到）
  const bin = new cv.Mat();
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
  quadsFromEdges(cv, bin, w, h, candidates);
  // 策略 3：Canny（弱）；即時模式已經找到很像紙的框就省掉，弱手機才跟得上
  if (!fast || !confident()) {
    cv.Canny(blur, edges, 25, 75);
    cv.dilate(edges, edges, k);
    quadsFromEdges(cv, edges, w, h, candidates);
  }
  // 策略 4：飽和度通道（白紙在有色桌面）
  if (!candidates.length) {
    const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const ch = new cv.MatVector(); cv.split(hsv, ch);
    const sat = ch.get(1);
    cv.GaussianBlur(sat, sat, new cv.Size(5, 5), 0);
    cv.threshold(sat, edges, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    quadsFromEdges(cv, edges, w, h, candidates);
    sat.delete(); ch.delete(); hsv.delete(); rgb.delete();
  }

  let r = null;
  if (candidates.length) {
    scoreAll();
    for (const c of candidates) if (!r || c.score > r.score) r = c;
    // 兩頁交界的凹口（1.20）：切掉旁邊那頁露出的一條（書本攤開、散頁疊在一起）
    try { const nc = cutAtNotch(cv, bin, r, w, h); if (nc) r = Object.assign({}, r, nc); }
    catch (e) { /* 失敗就用原本的框 */ }
    // 書溝：框裡有一條直的陰影谷線 → 只框其中一頁
    try { const sp = splitGutter(cv, blur, r.quad, w, h); if (sp && sp.area > 0.1) r = Object.assign({}, r, sp, { gutter: true }); }
    catch (e) { /* 找不到就算了 */ }
  }
  if (r) { try { const iq = inferCorner(blur.data, w, h, r.quad); if (iq) r = Object.assign({}, r, { quad: iq, area: polyArea(iq) / (w * h), inferred: true }); } catch (e) { /* 推不出來就用原本的 */ } }
  src.delete(); gray.delete(); blur.delete(); k.delete(); edges.delete(); bin.delete();
  if (!r) return null;
  // 往中心內縮約 0.6%，避免把紙張邊緣外的桌面拍進去
  const cx = r.quad.reduce((a, p) => a + p[0], 0) / 4, cy = r.quad.reduce((a, p) => a + p[1], 0) / 4;
  const inset = 0.006;
  const q = r.quad.map((p) => [p[0] + (cx - p[0]) * inset * 2, p[1] + (cy - p[1]) * inset * 2]);
  return { corners: q.map((p) => [Math.min(1, Math.max(0, p[0] / w)), Math.min(1, Math.max(0, p[1] / h))]), area: r.area, gutter: !!r.gutter, notch: r.notch || 0, inferred: !!r.inferred };
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
  bw: { exposure: 0, contrast: 0, density: 0, sharp: 82, despeckle: 35, smooth: 50 }, // 1.15 起銳利度 82、去雜點 35（原 35、20）
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
  // 修掉鋸齒與單點雜訊；只在接近全解析度時做（縮小預覽的線條只有 1 像素寬，會被誤刪）
  if (s <= 50 && k >= 0.75) cv.medianBlur(bw, bw, 3);
  const area = Math.pow((p.despeckle || 0) / 100, 1.5) * 90 * k * k;
  despeckle(cv, bw, area);
  // 邊緣平滑：在已去雜點的黑白結果上，只讓線條與文字邊緣留 1~2 像素灰階過渡（反鋸齒），紙面仍是純白
  const sm2 = p.smooth || 0;
  if (sm2 > 0) {
    cv.GaussianBlur(bw, bw, new cv.Size(0, 0), sig(0.25 + (sm2 / 100) * 0.9));
    const lut = new cv.Mat(1, 256, cv.CV_8UC1);
    for (let x = 0; x < 256; x++) { const v = (x - 128) * 1.4 + 128; lut.data[x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
    cv.LUT(bw, lut, bw);
    lut.delete();
  }
  return bw;
}

/* ---------- 曲線工具（與 app.js 的同名函式相同） ---------- */
function crPt(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
}
// 通過 a、p1、p2、b 四點的平滑曲線（Catmull-Rom），回傳折線
function edgePath(a, ctrl, b, n) {
  const pts = [a, ...ctrl, b], m = pts.length;
  const P = [[2 * a[0] - pts[1][0], 2 * a[1] - pts[1][1]], ...pts, [2 * b[0] - pts[m - 2][0], 2 * b[1] - pts[m - 2][1]]];
  const out = [];
  for (let s = 1; s < m; s++) for (let i = 0; i < n; i++) out.push(crPt(P[s - 1], P[s], P[s + 1], P[s + 2], i / n));
  out.push(b.slice());
  return out;
}
function polyLen(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
// 依弧長平均取 m+1 個點
function resample(pts, m) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1] || 1, out = [];
  let j = 1;
  for (let k = 0; k <= m; k++) {
    const target = (k / m) * L;
    while (j < pts.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1] || 1, f = Math.min(1, Math.max(0, (target - cum[j - 1]) / seg));
    out.push([pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * f, pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * f]);
  }
  return out;
}
function homog(cv, from, to) {
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, from.flat()), b = cv.matFromArray(4, 1, cv.CV_32FC2, to.flat());
  const M = cv.getPerspectiveTransform(a, b);
  const h = Array.from(M.data64F);
  a.delete(); b.delete(); M.delete();
  return h;
}
const applyH = (h, p) => { const w = h[6] * p[0] + h[7] * p[1] + h[8]; return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w]; };
const isCurved = (curve) => Array.isArray(curve) && curve.length === 4;

// 透視校正（直線）或曲面攤平（曲線）
// opts: { maxSide（預覽縮小）, curve（四條邊各兩個彎曲點，0~1）, upscale: 'auto'|'always'|'off' }
function warpPage(cv, rgb, width, height, corners, opts) {
  opts = opts || {};
  const P = corners.map((c) => [c[0] * width, c[1] * height]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let outW = Math.round(Math.max(dist(P[0], P[1]), dist(P[3], P[2])));
  let outH = Math.round(Math.max(dist(P[0], P[3]), dist(P[1], P[2])));
  const ar = trueAspect(P, width, height);
  if (ar) {
    // 以較長邊的像素數為準，依真實長寬比重算另一邊，避免透視造成頁面被壓扁
    if (outW / outH > ar) outH = Math.round(outW / ar); else outW = Math.round(outH * ar);
  }
  // 曲線：先用四角做透視校正，在校正後的平面上量曲線的弧長，當作紙張真正的寬高
  let curves = null;
  if (isCurved(opts.curve)) {
    const C = opts.curve.map((e) => e.map((p) => [p[0] * width, p[1] * height]));
    const H = homog(cv, P, [[0, 0], [outW, 0], [outW, outH], [0, outH]]);
    const ed = (i) => edgePath(P[i], C[i], P[(i + 1) % 4], Math.ceil(72 / (C[i].length + 1))).map((p) => applyH(H, p));
    const top = ed(0), right = ed(1), bottom = ed(2).reverse(), left = ed(3).reverse();
    const rw = Math.max(polyLen(top), polyLen(bottom)) / outW, rh = Math.max(polyLen(left), polyLen(right)) / outH;
    curves = { top, right, bottom, left, rw: outW, rh: outH, Hinv: homog(cv, [[0, 0], [outW, 0], [outW, outH], [0, outH]], P) };
    outW = Math.round(outW * rw); outH = Math.round(outH * rh);
  }
  // 小圖平滑放大
  const up = opts.upscale || 'auto';
  const minS = Math.min(outW, outH);
  let f = 1;
  if (up === 'auto' && minS < 1600) f = Math.min(3, 2400 / minS);
  else if (up === 'always') f = 3;
  const cap = 16000000;
  f = Math.min(f, Math.sqrt(cap / (outW * outH)));
  if (f > 1) { outW = Math.round(outW * f); outH = Math.round(outH * f); }
  if (outW * outH > cap) { const s = Math.sqrt(cap / (outW * outH)); outW = Math.floor(outW * s); outH = Math.floor(outH * s); }
  if (opts.maxSide && Math.max(outW, outH) > opts.maxSide) { const s = opts.maxSide / Math.max(outW, outH); outW = Math.round(outW * s); outH = Math.round(outH * s); }
  outW = Math.max(outW, 16); outH = Math.max(outH, 16);
  const interp = opts.maxSide ? cv.INTER_AREA : cv.INTER_CUBIC;

  if (!curves) {
    const M = cv.matFromArray(3, 3, cv.CV_64F, homog(cv, P, [[0, 0], [outW, 0], [outW, outH], [0, outH]]));
    const warped = new cv.Mat();
    cv.warpPerspective(rgb, warped, M, new cv.Size(outW, outH), interp, cv.BORDER_REPLICATE);
    M.delete();
    return warped;
  }
  return coonsWarp(cv, rgb, curves, outW, outH, opts.maxSide ? cv.INTER_LINEAR : cv.INTER_CUBIC);
}

// Coons 曲面：用四條邊界曲線在（透視校正後的）平面上內插出整頁的網格，再對應回原圖取樣
function coonsWarp(cv, rgb, c, outW, outH, interp) {
  const step = 8;
  const GW = Math.ceil(outW / step), GH = Math.ceil(outH / step);
  const T = resample(c.top, GW), B = resample(c.bottom, GW), L = resample(c.left, GH), R = resample(c.right, GH);
  const p00 = T[0], p10 = T[GW], p01 = B[0], p11 = B[GW];
  const gx = new Float32Array((GW + 1) * (GH + 1)), gy = new Float32Array((GW + 1) * (GH + 1));
  for (let j = 0; j <= GH; j++) {
    const v = j / GH;
    for (let i = 0; i <= GW; i++) {
      const u = i / GW;
      const q = [0, 1].map((k) =>
        (1 - v) * T[i][k] + v * B[i][k] + (1 - u) * L[j][k] + u * R[j][k]
        - ((1 - u) * (1 - v) * p00[k] + u * (1 - v) * p10[k] + (1 - u) * v * p01[k] + u * v * p11[k]));
      const im = applyH(c.Hinv, q);
      gx[j * (GW + 1) + i] = im[0]; gy[j * (GW + 1) + i] = im[1];
    }
  }
  const out = new cv.Mat(outH, outW, cv.CV_8UC3);
  const ci = new Int32Array(outW), ct = new Float32Array(outW);
  for (let x = 0; x < outW; x++) { const fx = (x / outW) * GW; ci[x] = Math.min(GW - 1, Math.floor(fx)); ct[x] = fx - ci[x]; }
  const rx = new Float32Array(GW + 1), ry = new Float32Array(GW + 1);
  const strip = 256;
  for (let y0 = 0; y0 < outH; y0 += strip) {
    const sh = Math.min(strip, outH - y0);
    const mx = new cv.Mat(sh, outW, cv.CV_32FC1), my = new cv.Mat(sh, outW, cv.CV_32FC1);
    const X = mx.data32F, Y = my.data32F;
    for (let y = 0; y < sh; y++) {
      const fy = ((y0 + y) / outH) * GH, j = Math.min(GH - 1, Math.floor(fy)), ty = fy - j;
      // 先在這一列把上下兩排網格內插好，再沿 x 內插
      const a0 = j * (GW + 1), b0 = a0 + GW + 1;
      for (let i = 0; i <= GW; i++) { rx[i] = gx[a0 + i] + (gx[b0 + i] - gx[a0 + i]) * ty; ry[i] = gy[a0 + i] + (gy[b0 + i] - gy[a0 + i]) * ty; }
      const o = y * outW;
      for (let x = 0; x < outW; x++) {
        const i = ci[x], tx = ct[x];
        X[o + x] = rx[i] + (rx[i + 1] - rx[i]) * tx;
        Y[o + x] = ry[i] + (ry[i + 1] - ry[i]) * tx;
      }
    }
    const part = new cv.Mat();
    cv.remap(rgb, part, mx, my, interp, cv.BORDER_REPLICATE);
    const roi = out.roi(new cv.Rect(0, y0, outW, sh));
    part.copyTo(roi);
    roi.delete(); part.delete(); mx.delete(); my.delete();
  }
  return out;
}

// 自動偵測四條邊的彎曲：沿著每條直邊，往垂直方向找「紙（亮）→ 背景（暗）」的交界，
// 擬合成平滑曲線，回傳每條邊 1/3、2/3 處的彎曲點（0~1）；彎曲太小或找不到時回傳 null
function detectCurve(cv, msg) {
  const { buffer, width: w, height: h, corners } = msg;
  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(buffer));
  const g = new cv.Mat();
  cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
  src.delete();
  cv.GaussianBlur(g, g, new cv.Size(5, 5), 0);
  const D = g.data;
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return -1;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (D[i] * (1 - fx) + D[i + 1] * fx) * (1 - fy) + (D[i + w] * (1 - fx) + D[i + w + 1] * fx) * fy;
  };
  const P = corners.map((c) => [c[0] * w, c[1] * h]);
  const R = Math.round(0.07 * Math.max(w, h));
  const result = [];
  let maxBulge = 0;
  for (let e = 0; e < 4; e++) {
    const A = P[e], Bp = P[(e + 1) % 4];
    const ex = Bp[0] - A[0], ey = Bp[1] - A[1], len = Math.hypot(ex, ey) || 1;
    const nx = ey / len, ny = -ex / len; // 往紙張外側
    const ts = [], ds = [];
    for (let k = 0; k <= 24; k++) {
      const t = 0.06 + (0.88 * k) / 24;
      const bx = A[0] + ex * t, by = A[1] + ey * t;
      let best = 0, bestD = 0;
      for (let d = -R; d <= R; d++) {
        const inn = at(bx + nx * (d - 2), by + ny * (d - 2)), out = at(bx + nx * (d + 2), by + ny * (d + 2));
        if (inn < 0 || out < 0) continue;
        const c = inn - out; // 內亮外暗
        if (c > best) { best = c; bestD = d; }
      }
      if (best >= 14) { ts.push(t); ds.push(bestD); }
    }
    // 擬合 f(t) = c + t(1-t)(a + b t)，c 是整條邊的固定偏移（四角本來就略往內縮），只取彎曲部分
    let fit = null;
    let idx = ts.map((_, i) => i);
    for (let iter = 0; iter < 3 && idx.length >= 8; iter++) {
      fit = lsq(idx.map((i) => [1, ts[i] * (1 - ts[i]), ts[i] * ts[i] * (1 - ts[i])]), idx.map((i) => ds[i]));
      if (!fit) break;
      const res = idx.map((i) => Math.abs(ds[i] - (fit[0] + ts[i] * (1 - ts[i]) * (fit[1] + fit[2] * ts[i]))));
      const mad = res.slice().sort((a, b) => a - b)[res.length >> 1] || 1;
      const keep = idx.filter((_, k) => res[k] <= Math.max(2, 3 * mad));
      if (keep.length === idx.length) break;
      idx = keep;
    }
    const bulge = (t) => (fit && idx.length >= 8 ? t * (1 - t) * (fit[1] + fit[2] * t) : 0);
    const pts = [1 / 3, 2 / 3].map((t) => {
      const b = Math.max(-R, Math.min(R, bulge(t)));
      maxBulge = Math.max(maxBulge, Math.abs(b) / Math.max(w, h));
      return [(A[0] + ex * t + nx * b) / w, (A[1] + ey * t + ny * b) / h];
    });
    result.push(pts);
  }
  g.delete();
  return { curve: result, bulge: maxBulge };
}
// 最小平方法（3 個參數）
function lsq(rows, ys) {
  const n = rows[0].length, M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  rows.forEach((r, k) => { for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i][j] += r[i] * r[j]; M[i][n] += r[i] * ys[k]; } });
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-9) return null;
    for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => r[n] / r[i]);
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
  const warped = warpPage(cv, rgb, width, height, corners, { curve: msg.curve, upscale: msg.upscale });
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
  const full = warpPage(cv, rgb, width, height, corners, { curve: msg.curve, upscale: msg.upscale });
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

// 裁切畫面的即時成品預覽（1.12）：保留一張縮小的原圖，拖動時只做拉平轉正（不做增強），所以很快
let cropCache = null;
function cropRelease() { if (cropCache) { cropCache.rgb.delete(); cropCache = null; } }
function cropSrc(cv, msg) {
  cropRelease();
  cropCache = { key: msg.key, rgb: rgbFromBuffer(cv, msg.buffer, msg.width, msg.height), w: msg.width, h: msg.height };
  return { ok: true };
}
function cropWarp(cv, msg) {
  if (!cropCache || cropCache.key !== msg.key) throw new Error('crop-missing');
  const c = cropCache;
  const warped = warpPage(cv, c.rgb, c.w, c.h, msg.corners, { curve: msg.curve, upscale: 'off', maxSide: msg.maxSide });
  return finish(cv, warped, 0);
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
    } else if (type === 'detectCurve') {
      self.postMessage({ id, ok: true, result: detectCurve(cv, e.data) });
    } else if (type === 'region') {
      const r = renderRegion(cv, e.data);
      self.postMessage({ id, ok: true, result: r }, [r.buffer]);
    } else if (type === 'cropSrc') {
      self.postMessage({ id, ok: true, result: cropSrc(cv, e.data) });
    } else if (type === 'cropWarp') {
      const r = cropWarp(cv, e.data);
      self.postMessage({ id, ok: true, result: r }, [r.buffer]);
    } else if (type === 'cropRelease') {
      cropRelease();
      self.postMessage({ id, ok: true, result: null });
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
