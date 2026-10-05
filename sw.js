/* WeatherRoulette Service Worker —— 离线优先缓存
 *
 * 策略分区：
 *   核心页面与数据 …… stale-while-revalidate（先用缓存秒开，后台悄悄更新）
 *   音频片段与音乐 …… cache-first（内容不变，命中即返回，永不再请求网络）
 *   城市壁纸图片   …… cache-first + 单独图片缓存（体积大，独立配额便于清理）
 *
 * 修改任何资源后请把 CACHE_VERSION 加一，否则老用户会一直看到旧缓存。
 */
const CACHE_VERSION = 'v4';
const CORE_CACHE = `wr-core-${CACHE_VERSION}`;
const AUDIO_CACHE = `wr-audio-${CACHE_VERSION}`;
const IMAGE_CACHE = `wr-images-${CACHE_VERSION}`;
const KEEP = new Set([CORE_CACHE, AUDIO_CACHE, IMAGE_CACHE]);

/** 核心资源：首次安装就预缓存，保证断网也能打开 */
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './large.html',
  './large.css',
  './data/cities.json',
  './data/wmo-map.json',
  './assets/images/manifest.json',
  './assets/images/luminance.json',
  './assets/audio/manifest.json',
  './assets/globe/albedo.jpg',
  './assets/globe/normal.jpg',
  './assets/globe/countries.png',
  './assets/globe/palette.png',
  './js/main.js',
  './js/core/constants.js',
  './js/core/paths.js',
  './js/core/utils.js',
  './js/core/boot.js',
  './js/core/weather.js',
  './js/core/format.js',
  './js/core/cards.js',
  './js/audio/manifest.js',
  './js/audio/loader.js',
  './js/audio/preload.js',
  './js/audio/speech.js',
  './js/audio/music.js',
  './js/audio/player.js',
  './js/ui/screen.js',
  './js/ui/loading.js',
  './js/ui/globe.js',
  './js/ui/globe-data.js',
  './js/ui/weather-icon.js',
  './js/ui/assets.js',
  './js/ui/large.js',
  './js/large-main.js',
];

/** 壁纸是远程 CDN 图片，按需缓存即可，这里只记下允许缓存的来源 */
const IMAGE_HOSTS = ['images.unsplash.com', 'images.pexels.com', 'picsum.photos'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CORE_CACHE);
      // 逐个添加：任一资源缺失不至于让整次安装失败
      await Promise.all(
        CORE_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (err) {
            console.warn('[SW] 预缓存失败：', url, err);
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((n) => (KEEP.has(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })(),
  );
});

/** 页面加载完成后请求音乐（体积大，不放在 install 里拖慢首屏），并逐城预缓存壁纸 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'cache-music') {
    event.waitUntil(cacheOne(AUDIO_CACHE, data.url));
  } else if (data.type === 'cache-images' && Array.isArray(data.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE);
        for (const url of data.urls) {
          try {
            if (!(await cache.match(url))) await cache.add(new Request(url, { mode: 'cors' }));
          } catch (err) {
            /* 单张失败不影响其它 */
          }
        }
      })(),
    );
  }
});

async function cacheOne(cacheName, url) {
  if (!url) return;
  try {
    const cache = await caches.open(cacheName);
    if (await cache.match(url)) return;
    await cache.add(new Request(url, { cache: 'reload' }));
  } catch (err) {
    console.warn('[SW] 缓存失败：', url, err);
  }
}

function isAudio(url) {
  return url.pathname.includes('/assets/audio/');
}

function isImageRequest(request, url) {
  return request.destination === 'image' || IMAGE_HOSTS.includes(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 天气接口永远走网络：离线时交给 weather.js 的缓存/演示数据兜底
  if (url.hostname.endsWith('open-meteo.com')) return;

  // 音频：内容不会变，缓存优先
  if (isAudio(url)) {
    event.respondWith(cacheFirst(request, AUDIO_CACHE));
    return;
  }

  // 壁纸：缓存优先，独立缓存区
  if (isImageRequest(request, url)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // 同源静态资源：先用缓存秒开，后台更新
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, CORE_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: false });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const loose = await cache.match(request, { ignoreSearch: true });
    if (loose) return loose;
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (hit) return hit;
  const res = await network;
  if (res) return res;
  // 导航请求离线时回退到首页
  if (request.mode === 'navigate') {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
}
