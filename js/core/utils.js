// 通用小工具：随机、洗牌、并发、DOM、事件。
// 注意：随机数一律走 crypto.getRandomValues，避免孩子按刷新时出现固定序列。

/** [0, n) 的随机整数 */
export function randInt(n) {
  if (n <= 0) return 0;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

/** 从数组里随机取一个 */
export function pick(arr) {
  return arr[randInt(arr.length)];
}

/** Fisher–Yates 原地洗牌，返回同一数组 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 不重复的随机洗牌副本 */
export function shuffled(arr) {
  return shuffle(arr.slice());
}

/** 带种子的洗牌：同一天刷新时顺序稳定，不同天自动变化 */
export function shuffledWithSeed(arr, seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 并发受限的 map，保持返回顺序 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 某地当地时间格式化：{ time: '14:05', label: '巴黎 08:05' } */
export function localTime(timezone, date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return fmt.format(date);
  } catch {
    return null;
  }
}

/** 是否为白天（用于决定壁纸遮罩明暗） */
export function isDaytime(timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', hour12: false,
    });
    const h = Number(fmt.format(new Date()));
    return h >= 7 && h < 19;
  } catch {
    return true;
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 安全设置文本 */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** 创建一个元素 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('data-') || k === 'role' || k === 'aria-label' || k === 'title') {
      node.setAttribute(k, v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else {
      node[k] = v;
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
