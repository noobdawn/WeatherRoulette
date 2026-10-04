// 城市壁纸资源层：清单加载 / 候选解析 / 可用性探测。
//
// 对外接口（契约，勿改签名）：
//   loadImageManifest()                 -> Promise<{images:{}}>  (失败返回空清单，绝不 reject)
//   resolveCityImage(city, manifest)    -> [{ url, credit, author, page, license }, ...]
//   probeImage(url, timeoutMs = 8000)   -> Promise<boolean>
// 额外便利导出（可选使用）：
//   firstAvailableImage(candidates, timeoutMs) -> Promise<{url, credit}|null>
//   resetImageManifestCache()
//
// 设计要点：
// - loadImageManifest 用 import.meta.url 解析清单地址（模块在哪都能算对站点根目录），
//   失败再退回契约里写死的相对路径 'assets/images/manifest.json'，两条都失败才返回空清单。
// - probeImage 只做「预加载探测」：new Image() 加载成功且 naturalWidth > 0 才算可用；
//   探测与真实 <img> 用同样的默认 referrer 策略，避免探针通过、真图却挂掉。

/** 契约路径（相对站点根目录） */
export const IMAGE_MANIFEST_PATH = 'assets/images/manifest.json';

/** 探测默认超时：8 秒 */
export const PROBE_TIMEOUT = 8000;

const EMPTY_MANIFEST = Object.freeze({
  version: 0,
  generatedAt: null,
  note: 'image manifest unavailable',
  images: Object.freeze({}),
});

/** 空清单（冻结副本） */
export function emptyImageManifest() {
  return { ...EMPTY_MANIFEST, images: {} };
}

/** 清单地址候选：先用模块 URL 推导，再退回契约里的相对路径 */
function manifestCandidates() {
  const list = [];
  try {
    list.push(new URL(`../../${IMAGE_MANIFEST_PATH}`, import.meta.url).href);
  } catch {
    /* import.meta.url 不可用时忽略 */
  }
  list.push(IMAGE_MANIFEST_PATH);
  return list;
}

/** 统一清单结构，防止字段缺失把调用方搞崩 */
function normalizeManifest(data) {
  if (!data || typeof data !== 'object') return emptyImageManifest();
  const images = data.images && typeof data.images === 'object' && !Array.isArray(data.images)
    ? data.images
    : {};
  return {
    version: Number.isFinite(data.version) ? data.version : 1,
    generatedAt: data.generatedAt ?? null,
    note: typeof data.note === 'string' ? data.note : '',
    images,
  };
}

let manifestPromise = null;

/**
 * 读取 assets/images/manifest.json（带内存缓存，多次调用只请求一次）。
 * 任何异常都吞掉并返回 { images: {} }，界面据此走插画兜底。
 * @returns {Promise<{version:number, generatedAt:(string|null), note:string, images:object}>}
 */
export function loadImageManifest() {
  if (!manifestPromise) {
    manifestPromise = fetchManifest().catch(() => emptyImageManifest());
  }
  return manifestPromise;
}

async function fetchManifest() {
  let fallback = null;
  for (const url of manifestCandidates()) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : 0;
    try {
      const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!res.ok) continue;
      const manifest = normalizeManifest(await res.json());
      if (Object.keys(manifest.images).length > 0) return manifest;
      fallback = fallback || manifest;   // 读到了但内容为空：留作兜底继续试下一条
    } catch {
      /* 网络/解析失败：换下一个候选地址 */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return fallback || emptyImageManifest();
}

/** 清掉内存缓存（测试或换清单时用） */
export function resetImageManifestCache() {
  manifestPromise = null;
}

/**
 * 取某城市的图片候选：primary 在前，fallbacks 依次在后。
 * @param {{id?:string}|string} city data/cities.json 里的城市对象（或直接给 id）
 * @param {object} manifest loadImageManifest() 的返回值
 * @returns {{url:string, credit:string, author:string, page:string, license:string}[]}
 */
export function resolveCityImage(city, manifest) {
  const id = typeof city === 'string' ? city : city?.id;
  if (!id) return [];

  const entry = manifest?.images?.[id];
  if (!entry) return [];

  const raw = [];
  if (typeof entry === 'string') {
    raw.push(entry);
  } else if (typeof entry === 'object') {
    if (typeof entry.primary === 'string') raw.push(entry.primary);
    if (Array.isArray(entry.fallbacks)) raw.push(...entry.fallbacks);
    if (Array.isArray(entry.urls)) raw.push(...entry.urls);   // 容错：等价写法
    if (typeof entry.url === 'string') raw.push(entry.url);
  }

  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const url = typeof item === 'string' ? item.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      credit: entry.credit || entry.author || id,
      author: entry.author || '',
      page: entry.page || '',
      license: entry.license || '',
    });
  }
  return out;
}

/**
 * 用 new Image() 预加载探测图片是否真的能取回。
 * 失败 / 超时 / 空地址一律 resolve(false)，不 reject。
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function probeImage(url, timeoutMs = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    if (!url || typeof url !== 'string' || typeof Image === 'undefined') {
      resolve(false);
      return;
    }

    const img = new Image();
    let settled = false;
    let timer = 0;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      img.onabort = null;
      if (!ok) {
        try { img.src = ''; } catch { /* 中断下载，忽略 */ }
      }
      resolve(ok);
    };

    timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs) || PROBE_TIMEOUT));
    img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0);
    img.onerror = () => finish(false);
    img.onabort = () => finish(false);
    img.decoding = 'async';
    img.alt = '';
    img.src = url;
  });
}

/**
 * 依次探测候选，返回第一个可用的（顺序探测：不会同时下载一堆图，省流量）。
 * @param {({url:string}|string)[]} candidates resolveCityImage() 的结果
 * @param {number} timeoutMs
 * @returns {Promise<{url:string, credit?:string}|null>}
 */
export async function firstAvailableImage(candidates, timeoutMs = PROBE_TIMEOUT) {
  for (const item of candidates || []) {
    const url = typeof item === 'string' ? item : item?.url;
    if (!url) continue;
    if (await probeImage(url, timeoutMs)) {
      return typeof item === 'string' ? { url, credit: '' } : item;
    }
  }
  return null;
}

/** 清单里是否有该城市的图（不探测，只看清单） */
export function hasCityImage(manifest, cityId) {
  return Boolean(manifest?.images?.[cityId]);
}
