// 启动衔接：等 DOM 就绪、注册 Service Worker、暴露全局错误到界面。
export function domReady() {
  if (document.readyState === 'loading') {
    return new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }
  return Promise.resolve();
}

/** 抓取 JSON，失败时抛出带路径的可读错误 */
export async function fetchJSON(path, { cache = 'default' } = {}) {
  const res = await fetch(path, { cache });
  if (!res.ok) throw new Error(`读取 ${path} 失败：HTTP ${res.status}`);
  return res.json();
}

/** 注册 Service Worker（离线缓存）。失败不阻塞主流程。 */
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  if (location.protocol === 'file:') return null;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    return reg;
  } catch (err) {
    console.warn('[WeatherRoulette] Service Worker 注册失败，离线缓存不可用：', err);
    return null;
  }
}

/** 把未捕获错误显示在页面上，方便手机上排查 */
export function installErrorOverlay(doc = document) {
  const show = (msg) => {
    let box = doc.getElementById('error-overlay');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'error-overlay';
      doc.body.appendChild(box);
    }
    box.textContent = `出错了：${msg}`;
  };
  window.addEventListener('error', (e) => show(e.message || '未知错误'));
  window.addEventListener('unhandledrejection', (e) => show(String(e.reason?.message || e.reason)));
}
