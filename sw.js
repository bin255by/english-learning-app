/* ==========================================================================
 * sw.js — PWA Service Worker（正式版）
 * --------------------------------------------------------------------------
 * 缓存策略：
 *   1. 安装时预缓存 App Shell（HTML / CSS / JS / 图标 / Manifest）
 *   2. 页面导航：网络优先 → 离线回退缓存的 index.html
 *   3. 跨域资源（CDN，如后续的 Swiper / Fuse.js）：缓存优先
 *   4. 同源静态资源：网络优先（开发期避免读到旧文件）→ 缓存兜底
 * 版本升级：修改 CACHE_VERSION，activate 时旧缓存会被自动清理。
 * ========================================================================== */

const CACHE_VERSION = 'v0.9.0';
const SHELL_CACHE = `shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;

/**
 * 预缓存清单（相对 sw.js 所在目录）
 * 除了 App Shell，把 5 份数据也一起缓存：这样断网时所有内容照样能看、能搜、能收藏。
 */
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/base.css',
  './css/components.css',
  './css/home.css',
  './css/roots.css',
  './css/dialogues.css',
  './css/vocabulary.css',
  './css/websites.css',
  './js/app.js',
  './js/tts.js',
  './js/speech-feedback.js',
  './js/home.js',
  './js/search.js',
  './js/favorites.js',
  './data/home-cards.json',
  './data/roots.json',
  './data/dialogues.json',
  './data/vocabulary.json',
  './data/websites.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png'
];

/* ---------------------------- install：预缓存 ---------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 逐个添加：个别资源 404 也不会导致整个安装失败
    await Promise.allSettled(
      SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

/* ---------------------------- activate：清理旧版本 ---------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

/* ---------------------------- fetch：分流处理 ---------------------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) 页面导航：网络优先，离线回退 App Shell
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 2) 跨域资源（CDN）：缓存优先
  if (url.origin !== self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.status === 200) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // 3) 同源静态资源：网络优先 → 缓存兜底（离线也能打开已访问过的页面）
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      return cached || Response.error();
    }
  })());
});

/* ---------------------------- message：页面触发立即更新 ---------------------------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
