// GA 比賽助手：離線與更新（Service Worker）
// 改了 APP 檔案清單或這支程式時，把 VERSION 往前推，手機就會跳出「有新版本」。
const VERSION = '20261031d';
const SHELL = 'ga-shell-' + VERSION;   // APP 本身
const RT = 'ga-runtime';               // 字型、英雄卡圖
const FILES = ['./', 'index.html', 'config.js', 'deck.js', 'ascent.js', 'display.js', 'logo.webp', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  // 個別存，其中一個檔案失敗也不影響其他
  e.waitUntil(caches.open(SHELL).then(c => Promise.allSettled(FILES.map(f => fetch(new Request(f, { cache: 'reload' })).then(r => r.ok && c.put(f, r))))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('ga-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });

// APP 本身：有網路就拿最新的（3.5 秒沒回應就用存好的），沒網路用存好的
async function networkFirst(req) {
  const c = await caches.open(SHELL);
  const key = new URL(req.url); key.search = '';
  try {
    const r = await Promise.race([fetch(req, { cache: 'no-cache' }), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3500))]);
    if (r && r.ok) c.put(key.href, r.clone());
    return r;
  } catch (err) {
    const hit = await c.match(key.href) || await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await c.match('index.html')) || (await c.match('./'));
    throw err;
  }
}
// 字型與卡圖：先用存好的，沒有才上網抓（卡圖最多留 200 張）
async function cacheFirst(req) {
  const c = await caches.open(RT);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && (r.ok || r.type === 'opaque')) {
    c.put(req, r.clone());
    c.keys().then(ks => { if (ks.length > 260) ks.slice(0, ks.length - 200).forEach(k => c.delete(k)); });
  }
  return r;
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) return e.respondWith(networkFirst(req));
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) || (u.hostname === 'api.gatcg.com' && u.pathname.startsWith('/cards/images/'))) return e.respondWith(cacheFirst(req));
  // 配對、成績表、對手資料：一律即時上網，不存
});
