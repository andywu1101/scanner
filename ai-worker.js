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

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') { load(e.data.engine); ep = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: { engine, ep } }); return; }
    if (!engine) load('old');
    if (type === 'bench') { self.postMessage({ id, ok: true, result: await bench() }); return; }
    if (type === 'setEP') { ep = engine === 'new' && e.data.ep === 'webgpu' ? 'webgpu' : 'wasm'; self.postMessage({ id, ok: true, result: ep }); return; }
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
