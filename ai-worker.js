/* 伍線譜樂譜掃描 — AI 框選 Worker（1.25；3.0 新引擎）
   U²-Net（u2netp，4.6 MB）找出畫面主體（紙張）的遮罩；用 ONNX Runtime Web 執行（單執行緒，GitHub Pages 沒有跨來源隔離）。
   輸入：320×320 RGBA；輸出：320×320 的 0～255 遮罩。四個角由 worker.js 的 maskQuad 依遮罩與紙邊求出。
   3.0：兩種引擎（app.js 用 init 指定，同一個 Worker 只載入一種）
     new＝ONNX Runtime Web 1.30.0（ort.webgpu.min.js＋ort-wasm-simd-threaded.asyncify.mjs／.wasm），可用 GPU（WebGPU）或 CPU
     old＝1.17.3（ort.wasm.min.js＋ort-wasm-simd.wasm），只有 CPU；新引擎載入失敗時的安全網、還沒升級的舊使用者
   ep＝'webgpu' 或 'wasm'（app.js 依 bench 結果決定）；GPU 建立或執行出錯時，這個 Worker 之後都改用 CPU
   6.2：跨來源隔離（sw.js 補標頭）時新引擎可用多執行緒：init 的 threads（app.js 的「最佳化 AI 效能」選出，Y31 實測 2 條快約 1.9 倍）；
     沒有隔離或舊引擎一律 1 條。ONNX Runtime 的條數只能在第一次建立前設定，所以每種條數要開新的 Worker（optRun 測速用） */
const MODEL = new URL('lib/ai/u2netp.onnx', self.location.href).href;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const N = 320 * 320;
let engine = null, ep = 'wasm', sess = null, sessEP = null, threads = 1;

// 引擎載入失敗的錯誤前面加 ENGINE:，app.js 看到就改用舊引擎
function load(eng, want) {
  if (engine) return;
  try {
    self.importScripts(eng === 'new' ? 'lib/ai/ort.webgpu.min.js' : 'lib/ai/ort.wasm.min.js');
  } catch (err) { throw new Error('ENGINE:' + (err && err.message ? err.message : String(err))); }
  ort.env.wasm.wasmPaths = new URL('lib/ai/', self.location.href).href; // 要完整網址，相對路徑會被當成模組名稱
  threads = eng === 'new' && self.crossOriginIsolated === true && want > 1 ? Math.min(8, want | 0) : 1; // 6.2
  ort.env.wasm.numThreads = threads;
  if (eng === 'old') ort.env.wasm.simd = true;
  engine = eng;
}
/* 5.1.8：所有 AI 工作（框選、精修、TEED、測速）的建立與執行一律排隊（aiQ），一個做完才做下一個。ONNX Runtime 同時做會撞車：
   GPU：「another WebGPU EP inference session is being created」→ 這一頁或這次測速改用 CPU（作者 iPhone 17 實測，精修一頁變 1 分鐘以上）；
   新 worker 第一次同時建立：「multiple calls to 'initWasm()' detected」→ 被當成新引擎載入失敗，改用相容模式（舊引擎沒有 GPU）。
   GPU 工作在執行時建立另一個 GPU 工作：兩個都卡住不動（軟體 WebGPU 重現）。所以執行也排進同一條隊伍。
   這個 worker 本來就是單執行緒，排隊只差在 GPU 計算時不能同時建別的工作；即時 TEED 最多多等一塊精修（iPhone GPU 約 0.15 秒）。
   萬一還是遇到「being created」，等一下再試（最多 5 次），不馬上改用 CPU */
let aiQ = Promise.resolve();
function serial(fn) { const job = aiQ.then(fn); aiQ = job.catch(() => {}); return job; }
const qRel = (s) => serial(() => s.release()).catch(() => {}); // 釋放也排隊
// 執行一次並讀回第一個輸出（GPU 的結果要讀回來，讀回也算在執行裡）
// tm：測速時傳入，記下真正執行的時間（不含排隊等待），免得排隊時把 GPU 量成比較慢
function qRun(s, feeds, tm) { return serial(async () => { const t0 = performance.now(); const o = await s.run(feeds); const t = o[s.outputNames[0]]; const d = t.getData ? await t.getData() : t.data; if (tm) tm.ms = performance.now() - t0; return d; }); }
// 同一種工作同時有好幾個請求（例如連拍時框選）：共用同一次建立，不重複建立兩份（多一份就多占一份記憶體）
const once = (fn) => { let p = null; return () => p || (p = fn().finally(() => { p = null; })); };
const getSess = once(() => getSess0()), srGet = once(() => srGet0()), teedGet = once(() => teedGet0());
function mkSess(model, want) {
  return serial(async () => {
    for (let k = 0; ; k++) {
      // 6.2.6：多條時關掉執行緒「空轉等工作」（ORT 預設會空轉一陣子佔著 CPU；作者 Y31 開 2 條後即時框選變少、AI 也沒感覺變快）
      const o = { executionProviders: [want], graphOptimizationLevel: 'all' };
      if (threads > 1) o.extra = { session: { intra_op: { allow_spinning: '0' }, inter_op: { allow_spinning: '0' } } };
      try { return await ort.InferenceSession.create(model, o); }
      catch (err) { if (k >= 4 || !/being created|initWasm/i.test(String(err && err.message))) throw err; await new Promise((r) => setTimeout(r, 300 * (k + 1))); }
    }
  });
}
async function create(want) {
  try {
    return await mkSess(MODEL, want);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(want === 'wasm' ? 'ENGINE:' + msg : msg);
  }
}
async function release() { const s0 = sess; sess = null; sessEP = null; if (s0) await qRel(s0); }
async function getSess0() {
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
async function run(s, f, tm) {
  return qRun(s, { [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 320, 320]) }, tm); // 5.1.8 排隊
}
// 一次性的速度比較：CPU 跑一次、GPU 跑一次（GPU 第一次已含準備時間，實測和之後差不多），回傳毫秒；不支援 GPU 時 gpu＝null
async function bench(noGpu) { // 6.2.2：noGpu＝GPU 停用中（iOS 26／閃退保護），只測 CPU
  const f = new Float32Array(3 * N).fill(0.1);
  await release();
  let cpu = null, gpu = null;
  const sc = await create('wasm');
  const tm = {}; await run(sc, f, tm); cpu = tm.ms;
  await qRel(sc);
  let hasGpu = false;
  try { hasGpu = !!(self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) {}
  if (engine === 'new' && hasGpu && !noGpu) {
    try {
      const sg = await create('webgpu');
      await run(sg, f, tm); gpu = tm.ms;
      await qRel(sg);
    } catch (_) { gpu = null; }
  }
  return { cpu, gpu };
}

/* 6.2「最佳化 AI 效能」：在這個 Worker（固定條數）建一個工作，跑兩次取快的（第一次含準備時間），回傳毫秒；GPU 用不了回傳 null。
   model：'u2'（AI 框選，320×320）或 'teed'（640×480，跟即時掃描與框選用的大小相同）。測完就釋放 */
async function optRun(model, want) {
  if (want === 'webgpu') {
    if (engine !== 'new') return null;
    try { if (!(self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter()))) return null; } catch (_) { return null; }
  }
  const u2 = model === 'u2', w = u2 ? 320 : 640, h = u2 ? 320 : 480;
  const f = new Float32Array(3 * w * h).fill(u2 ? 0.1 : 20);
  let s;
  try { s = await mkSess(u2 ? MODEL : TEED_MODEL, want); } catch (err) { if (want === 'webgpu') return null; throw err; }
  let best = Infinity;
  try {
    for (let k = 0; k < 2; k++) { const tm = {}; await qRun(s, { [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, h, w]) }, tm); best = Math.min(best, tm.ms); }
  } catch (err) { await qRel(s); if (want === 'webgpu') return null; throw err; }
  await qRel(s);
  return best;
}

/* 4.1：AI 精修（Real-ESRGAN animevideov3「線稿」模型，2.5 MB，BSD-3）。app.js 把拉正後的頁面縮小、切成固定大小的塊送來，
   每塊 SR_IN×SR_IN（RGBA）→ 放大 4 倍的 RGBA；接縫由 app.js 多讀邊緣處理。和框選用不同的 session，GPU／CPU 各自選（srEP） */
const SR_MODEL = new URL('lib/ai/sr-anime.onnx', self.location.href).href;
let srSess = null, srSessEP = null, srEP = 'wasm', srErr = '';
async function srCreate(want) { return mkSess(SR_MODEL, want); }
async function srRelease() { const s0 = srSess; srSess = null; srSessEP = null; if (s0) await qRel(s0); }
async function srGet0() {
  if (srSess && srSessEP === srEP) return srSess;
  await srRelease();
  try { srSess = await srCreate(srEP); srSessEP = srEP; }
  catch (err) { if (srEP !== 'webgpu') throw err; srErr = err && err.message ? err.message : String(err); srEP = 'wasm'; srSess = await srCreate('wasm'); srSessEP = 'wasm'; }
  return srSess;
}
async function srRun(s, buf, n, tm) {
  const src = new Uint8ClampedArray(buf), N2 = n * n, f = new Float32Array(3 * N2);
  for (let i = 0; i < N2; i++) { f[i] = src[i * 4] / 255; f[N2 + i] = src[i * 4 + 1] / 255; f[2 * N2 + i] = src[i * 4 + 2] / 255; }
  const y = await qRun(s, { [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, n, n]) }, tm); // 5.1.8 排隊
  const O = n * 4, M = O * O, p = new Uint8ClampedArray(M * 4);
  for (let i = 0; i < M; i++) { const a = i * 4; p[a] = y[i] * 255 + 0.5; p[a + 1] = y[M + i] * 255 + 0.5; p[a + 2] = y[2 * M + i] * 255 + 0.5; p[a + 3] = 255; }
  return p.buffer;
}
// 精修測速：同一塊各跑兩次（第一次含 GPU 準備時間），量第二次；回傳每塊毫秒 { cpu, gpu }
async function srBench(n, noGpu) {
  const buf = () => new Uint8ClampedArray(n * n * 4).fill(200).buffer;
  await srRelease();
  let cpu = null, gpu = null, why = '';
  const sc = await srCreate('wasm');
  const tm = {}; await srRun(sc, buf(), n); await srRun(sc, buf(), n, tm); cpu = tm.ms;
  await qRel(sc);
  // 5.1.7：GPU 用不了時記下原因（舊引擎／瀏覽器沒有 WebGPU／拿不到顯示卡／建立或執行出錯）
  let hasGpu = false;
  if (noGpu) why = 'GPU 停用中（iOS 26 或閃退保護）';
  else if (engine !== 'new') why = '舊引擎（相容模式）';
  else if (!(self.navigator && self.navigator.gpu)) why = '這個環境沒有 WebGPU';
  else { try { hasGpu = !!(await self.navigator.gpu.requestAdapter()); if (!hasGpu) why = '拿不到 GPU'; } catch (err) { why = '拿不到 GPU：' + (err && err.message ? err.message : err); } }
  if (engine === 'new' && hasGpu) {
    try { const sg = await srCreate('webgpu'); await srRun(sg, buf(), n); await srRun(sg, buf(), n, tm); gpu = tm.ms; await qRel(sg); }
    catch (err) { gpu = null; why = 'GPU 出錯：' + (err && err.message ? err.message : err); }
  }
  return { cpu, gpu, why: why.slice(0, 80) };
}

/* 4.2：TEED 邊緣模型（MIT，0.25 MB）。app.js 送來照片縮小後的 RGBA（長邊 640、寬高為 8 的倍數），
   回傳每個像素的邊緣強度（0～255）。worker.js 的 teedFuse 用它跟 AI 遮罩互助框選。4.2.1 起一律用 CPU */
const TEED_MODEL = new URL('lib/ai/teed.onnx', self.location.href).href;
let teedSess = null, teedSessEP = null, teedNoGpu = true; // 4.2.1：一律用 CPU（iPhone 只多約 0.1 秒，少占 GPU 記憶體；輸入大小隨照片比例變，GPU 每種大小都要另開記憶體）
async function teedGet0() {
  const want = teedNoGpu ? 'wasm' : ep;
  if (teedSess && teedSessEP === want) return teedSess;
  if (teedSess) { const s0 = teedSess; teedSess = null; teedSessEP = null; await qRel(s0); }
  try { teedSess = await mkSess(TEED_MODEL, want); teedSessEP = want; }
  catch (err) { if (want !== 'webgpu') throw err; teedNoGpu = true; return teedGet0(); }
  return teedSess;
}
let teedQ = Promise.resolve();
async function teedRun(buffer, w, h) {
  const d = new Uint8ClampedArray(buffer), n = w * h, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { f[i] = d[i * 4 + 2] - 103.939; f[n + i] = d[i * 4 + 1] - 116.779; f[2 * n + i] = d[i * 4] - 123.68; } // BGR 減平均
  const go = (s) => qRun(s, { [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, h, w]) }); // 5.1.8 排隊
  let y;
  try { y = await go(await teedGet()); }
  catch (err) { if (teedSessEP !== 'webgpu') throw err; teedNoGpu = true; y = await go(await teedGet()); } // GPU 出錯改用 CPU
  const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = Math.round(y[i] * 255);
  return u.buffer;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') { load(e.data.engine, e.data.threads); ep = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: { engine, ep, threads } }); return; }
    if (!engine) load('old');
    if (type === 'bench') { self.postMessage({ id, ok: true, result: await bench(e.data.noGpu) }); return; }
    if (type === 'setEP') { ep = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: ep }); return; }
    if (type === 'optRun') { self.postMessage({ id, ok: true, result: await optRun(e.data.model, e.data.ep) }); return; } // 6.2
    if (type === 'srBench') { self.postMessage({ id, ok: true, result: await srBench(e.data.n, e.data.noGpu) }); return; }
    if (type === 'srEP') { srErr = ''; srEP = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: srEP }); return; }
    if (type === 'srTile') {
      let r;
      try { r = await srRun(await srGet(), e.data.buffer, e.data.n); }
      catch (err) { if (srSessEP !== 'webgpu') throw err; srErr = err && err.message ? err.message : String(err); srEP = 'wasm'; r = await srRun(await srGet(), e.data.buffer, e.data.n); } // GPU 出錯改用 CPU（buffer 還在：送進來的是複本）
      self.postMessage({ id, ok: true, result: r }, [r]); return;
    }
    if (type === 'srState') { self.postMessage({ id, ok: true, result: { ep: srSessEP || srEP, err: srErr } }); return; } // 5.1.7
    if (type === 'srRelease') { await srRelease(); self.postMessage({ id, ok: true, result: null }); return; }
    if (type === 'teed') { // 4.3：即時掃描與框選可能同時送來，排隊一個一個跑（同一個 session 不能同時跑）
      const job = teedQ.then(() => teedRun(e.data.buffer, e.data.width, e.data.height)); teedQ = job.catch(() => {});
      const r = await job; self.postMessage({ id, ok: true, result: r }, [r]); return;
    }
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
