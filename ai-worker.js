/* 伍線譜樂譜掃描 — AI 框選 Worker（1.25；3.0 新引擎）
   U²-Net（u2netp，4.6 MB）找出畫面主體（紙張）的遮罩；用 ONNX Runtime Web 執行（單執行緒，GitHub Pages 沒有跨來源隔離）。
   輸入：320×320 RGBA；輸出：320×320 的 0～255 遮罩。四個角由 worker.js 的 maskQuad 依遮罩與紙邊求出。
   3.0：兩種引擎（app.js 用 init 指定，同一個 Worker 只載入一種）
     new＝ONNX Runtime Web 1.30.0（ort.webgpu.min.js＋ort-wasm-simd-threaded.asyncify.mjs／.wasm），可用 GPU（WebGPU）或 CPU
     old＝1.17.3（ort.wasm.min.js＋ort-wasm-simd.wasm），只有 CPU；新引擎載入失敗時的安全網、還沒升級的舊使用者
   ep＝'webgpu' 或 'wasm'（app.js 依 bench 結果決定）；GPU 建立或執行出錯時，這個 Worker 之後都改用 CPU */
const MODEL = new URL('lib/ai/u2netp.onnx', self.location.href).href;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const N = 320 * 320;
let engine = null, ep = 'wasm', sess = null, sessEP = null;

// 引擎載入失敗的錯誤前面加 ENGINE:，app.js 看到就改用舊引擎
function load(eng) {
  if (engine) return;
  try {
    self.importScripts(eng === 'new' ? 'lib/ai/ort.webgpu.min.js' : 'lib/ai/ort.wasm.min.js');
  } catch (err) { throw new Error('ENGINE:' + (err && err.message ? err.message : String(err))); }
  ort.env.wasm.wasmPaths = new URL('lib/ai/', self.location.href).href; // 要完整網址，相對路徑會被當成模組名稱
  ort.env.wasm.numThreads = 1;
  if (eng === 'old') ort.env.wasm.simd = true;
  engine = eng;
}
async function create(want) {
  try {
    return await ort.InferenceSession.create(MODEL, { executionProviders: [want], graphOptimizationLevel: 'all' });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(want === 'wasm' ? 'ENGINE:' + msg : msg);
  }
}
async function release() { if (sess) { try { await sess.release(); } catch (_) {} } sess = null; sessEP = null; }
async function getSess() {
  if (sess && sessEP === ep) return sess;
  await release();
  try { sess = await create(ep); sessEP = ep; }
  catch (err) {
    if (ep !== 'webgpu') throw err;
    ep = 'wasm'; sess = await create('wasm'); sessEP = 'wasm'; // GPU 建立失敗：改用 CPU
  }
  return sess;
}
function input(buffer) {
  // 前處理照 rembg：除以整張最大值，再依 ImageNet 平均／標準差正規化
  const src = new Uint8ClampedArray(buffer);
  let mx = 1; for (let i = 0; i < src.length; i += 4) { if (src[i] > mx) mx = src[i]; if (src[i + 1] > mx) mx = src[i + 1]; if (src[i + 2] > mx) mx = src[i + 2]; }
  const f = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) f[c * N + i] = (src[i * 4 + c] / mx - MEAN[c]) / STD[c];
  return f;
}
async function run(s, f) {
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 320, 320]) });
  const t = out[s.outputNames[0]];
  return t.getData ? await t.getData() : t.data; // GPU 的結果要讀回來
}
// 一次性的速度比較：CPU 跑一次、GPU 跑一次（GPU 第一次已含準備時間，實測和之後差不多），回傳毫秒；不支援 GPU 時 gpu＝null
async function bench() {
  const f = new Float32Array(3 * N).fill(0.1);
  await release();
  let cpu = null, gpu = null;
  const sc = await create('wasm');
  let t = performance.now(); await run(sc, f); cpu = performance.now() - t;
  try { await sc.release(); } catch (_) {}
  let hasGpu = false;
  try { hasGpu = !!(self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) {}
  if (engine === 'new' && hasGpu) {
    try {
      const sg = await create('webgpu');
      t = performance.now(); await run(sg, f); gpu = performance.now() - t;
      try { await sg.release(); } catch (_) {}
    } catch (_) { gpu = null; }
  }
  return { cpu, gpu };
}

/* 4.1：AI 精修（Real-ESRGAN animevideov3「線稿」模型，2.5 MB，BSD-3）。app.js 把拉正後的頁面縮小、切成固定大小的塊送來，
   每塊 SR_IN×SR_IN（RGBA）→ 放大 4 倍的 RGBA；接縫由 app.js 多讀邊緣處理。和框選用不同的 session，GPU／CPU 各自選（srEP） */
const SR_MODEL = new URL('lib/ai/sr-anime.onnx', self.location.href).href;
let srSess = null, srSessEP = null, srEP = 'wasm';
async function srCreate(want) { return ort.InferenceSession.create(SR_MODEL, { executionProviders: [want], graphOptimizationLevel: 'all' }); }
async function srRelease() { if (srSess) { try { await srSess.release(); } catch (_) {} } srSess = null; srSessEP = null; }
async function srGet() {
  if (srSess && srSessEP === srEP) return srSess;
  await srRelease();
  try { srSess = await srCreate(srEP); srSessEP = srEP; }
  catch (err) { if (srEP !== 'webgpu') throw err; srEP = 'wasm'; srSess = await srCreate('wasm'); srSessEP = 'wasm'; }
  return srSess;
}
async function srRun(s, buf, n) {
  const src = new Uint8ClampedArray(buf), N2 = n * n, f = new Float32Array(3 * N2);
  for (let i = 0; i < N2; i++) { f[i] = src[i * 4] / 255; f[N2 + i] = src[i * 4 + 1] / 255; f[2 * N2 + i] = src[i * 4 + 2] / 255; }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, n, n]) });
  const t = out[s.outputNames[0]], y = t.getData ? await t.getData() : t.data;
  const O = n * 4, M = O * O, p = new Uint8ClampedArray(M * 4);
  for (let i = 0; i < M; i++) { const a = i * 4; p[a] = y[i] * 255 + 0.5; p[a + 1] = y[M + i] * 255 + 0.5; p[a + 2] = y[2 * M + i] * 255 + 0.5; p[a + 3] = 255; }
  return p.buffer;
}
// 精修測速：同一塊各跑兩次（第一次含 GPU 準備時間），量第二次；回傳每塊毫秒 { cpu, gpu }
async function srBench(n) {
  const buf = () => new Uint8ClampedArray(n * n * 4).fill(200).buffer;
  await srRelease();
  let cpu = null, gpu = null, t;
  const sc = await srCreate('wasm');
  await srRun(sc, buf(), n); t = performance.now(); await srRun(sc, buf(), n); cpu = performance.now() - t;
  try { await sc.release(); } catch (_) {}
  let hasGpu = false;
  try { hasGpu = !!(self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) {}
  if (engine === 'new' && hasGpu) {
    try { const sg = await srCreate('webgpu'); await srRun(sg, buf(), n); t = performance.now(); await srRun(sg, buf(), n); gpu = performance.now() - t; try { await sg.release(); } catch (_) {} }
    catch (_) { gpu = null; }
  }
  return { cpu, gpu };
}

/* 4.2：TEED 邊緣模型（MIT，0.25 MB）。app.js 送來照片縮小後的 RGBA（長邊 640、寬高為 8 的倍數），
   回傳每個像素的邊緣強度（0～255）。worker.js 的 teedFuse 用它跟 AI 遮罩互助框選。4.2.1 起一律用 CPU */
const TEED_MODEL = new URL('lib/ai/teed.onnx', self.location.href).href;
let teedSess = null, teedSessEP = null, teedNoGpu = true; // 4.2.1：一律用 CPU（iPhone 只多約 0.1 秒，少占 GPU 記憶體；輸入大小隨照片比例變，GPU 每種大小都要另開記憶體）
async function teedGet() {
  const want = teedNoGpu ? 'wasm' : ep;
  if (teedSess && teedSessEP === want) return teedSess;
  if (teedSess) { try { await teedSess.release(); } catch (_) {} teedSess = null; teedSessEP = null; }
  try { teedSess = await ort.InferenceSession.create(TEED_MODEL, { executionProviders: [want], graphOptimizationLevel: 'all' }); teedSessEP = want; }
  catch (err) { if (want !== 'webgpu') throw err; teedNoGpu = true; return teedGet(); }
  return teedSess;
}
async function teedRun(buffer, w, h) {
  const d = new Uint8ClampedArray(buffer), n = w * h, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = d[i * 4 + 2] - 103.939; f[n + i] = d[i * 4 + 1] - 116.779; f[2 * n + i] = d[i * 4] - 123.68; } // BGR 減平均
  const go = async (s) => { const o = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, h, w]) }); const t = o[s.outputNames[0]]; return t.getData ? await t.getData() : t.data; };
  let y;
  try { y = await go(await teedGet()); }
  catch (err) { if (teedSessEP !== 'webgpu') throw err; teedNoGpu = true; y = await go(await teedGet()); } // GPU 出錯改用 CPU
  const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = Math.round(y[i] * 255);
  return u.buffer;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') { load(e.data.engine); ep = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: { engine, ep } }); return; }
    if (!engine) load('old');
    if (type === 'bench') { self.postMessage({ id, ok: true, result: await bench() }); return; }
    if (type === 'setEP') { ep = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: ep }); return; }
    if (type === 'srBench') { self.postMessage({ id, ok: true, result: await srBench(e.data.n) }); return; }
    if (type === 'srEP') { srEP = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: srEP }); return; }
    if (type === 'srTile') {
      let r;
      try { r = await srRun(await srGet(), e.data.buffer, e.data.n); }
      catch (err) { if (srSessEP !== 'webgpu') throw err; srEP = 'wasm'; r = await srRun(await srGet(), e.data.buffer, e.data.n); } // GPU 出錯改用 CPU（buffer 還在：送進來的是複本）
      self.postMessage({ id, ok: true, result: r }, [r]); return;
    }
    if (type === 'srRelease') { await srRelease(); self.postMessage({ id, ok: true, result: null }); return; }
    if (type === 'teed') { const r = await teedRun(e.data.buffer, e.data.width, e.data.height); self.postMessage({ id, ok: true, result: r }, [r]); return; }
    const s = await getSess();
    if (type === 'warm') { self.postMessage({ id, ok: true, result: { ep: sessEP } }); return; }
    const f = input(e.data.buffer);
    let d;
    try { d = await run(s, f); }
    catch (err) {
      if (sessEP !== 'webgpu') throw err;
      ep = 'wasm'; d = await run(await getSess(), f); // GPU 執行出錯（例如切到背景後 GPU 被收回）：改用 CPU 重跑
    }
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
    const m = new Uint8Array(N), k = hi > lo ? 255 / (hi - lo) : 0;
    for (let i = 0; i < N; i++) m[i] = Math.round((d[i] - lo) * k);
    self.postMessage({ id, ok: true, result: m.buffer }, [m.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
