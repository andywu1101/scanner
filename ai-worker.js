/* 伍線譜樂譜掃描 — AI 框選 Worker（1.25）
   U²-Net（u2netp，4.6 MB）找出畫面主體（紙張）的遮罩；用 ONNX Runtime Web（WebAssembly，單執行緒）執行。
   輸入：320×320 RGBA；輸出：320×320 的 0～255 遮罩。四個角由 worker.js 的 maskQuad 依遮罩與紙邊求出。 */
self.importScripts('lib/ai/ort.wasm.min.js');
ort.env.wasm.wasmPaths = new URL('lib/ai/', self.location.href).href;
ort.env.wasm.numThreads = 1; // GitHub Pages 沒有跨來源隔離，不能用多執行緒
ort.env.wasm.simd = true;
let sess = null;
async function getSess() {
  if (!sess) sess = ort.InferenceSession.create(new URL('lib/ai/u2netp.onnx', self.location.href).href, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return sess;
}
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const s = await getSess();
    if (type === 'warm') { self.postMessage({ id, ok: true, result: null }); return; }
    // 前處理照 rembg：除以整張最大值，再依 ImageNet 平均／標準差正規化
    const src = new Uint8ClampedArray(e.data.buffer), N = 320 * 320;
    let mx = 1; for (let i = 0; i < src.length; i += 4) { if (src[i] > mx) mx = src[i]; if (src[i + 1] > mx) mx = src[i + 1]; if (src[i + 2] > mx) mx = src[i + 2]; }
    const f = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) f[c * N + i] = (src[i * 4 + c] / mx - MEAN[c]) / STD[c];
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, 320, 320]) });
    const d = out[s.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
    const m = new Uint8Array(N), k = hi > lo ? 255 / (hi - lo) : 0;
    for (let i = 0; i < N; i++) m[i] = Math.round((d[i] - lo) * k);
    self.postMessage({ id, ok: true, result: m.buffer }, [m.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
