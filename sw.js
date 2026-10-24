/* 伍線譜樂譜掃描 — Service Worker（離線可用） */
const VERSION = 'cocoscan-v28';
// AI 框選的模型與執行環境（約 15 MB）：第一次使用時由 app.js 下載放進這個快取，換版本不清掉（1.25）
const AI_CACHE = 'cocoscan-ai';
const ASSETS = [
  './', 'index.html', 'app.js', 'worker.js', 'ai-worker.js', 'lib/opencv.js', 'lib/Sortable.min.js', 'lib/qrcode.js', 'manifest.webmanifest', 'jkopay-qr.png',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== AI_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // 程式檔：先網路後快取（方便更新）；OpenCV 等大檔：快取優先
  if (req.url.includes('/lib/ai/')) { e.respondWith(caches.match(req).then((r) => r || fetch(req))); return; }
  const big = req.url.includes('/lib/') || req.url.includes('/icons/');
  if (big) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    })));
  } else {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
  }
});
