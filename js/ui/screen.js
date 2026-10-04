// 界面同步层：把 describeCard() 的结果画到 index.html 的 DOM 契约上，并驱动背景交叉淡入。
//
// 极简版（老板要求）：整屏只有「一张满屏城市壁纸 + 居中大字」，没有任何面板与蒙版。
// 因为没有蒙版压暗背景，文字可读性必须靠**自动亮度适配**：
// 采样壁纸中心区域的相对亮度，在 #app 上设 data-text-on="light|dark"，
// 由 style.css 切换深墨字/白字两套变量。读不到像素时退回柔和文字阴影兜底。
//
// 契约（签名不可改）：
//   new Screen(root = document)
//   renderCard(desc, { city, imageUrls, dayIndex, cardIndex, total })
//   setBackground(url) / setBackgroundFallback(city)
//   setStatus(text) / setProgress(i, total) / setPaused(bool) / setPlaying(bool)
//
// js/ui/weather-icon.js 与 js/ui/assets.js 由队友并行开发：这里用惰性动态导入 + 兜底实现，
// 保证任何一个还没就绪时页面都不会整块挂掉；两个模块就绪后自动用真实现。
import { dayLabel, dayLabelEn, toF } from '../core/format.js';
import { ICON_LABELS } from '../core/constants.js';
import { isDaytime, localTime } from '../core/utils.js';

/** 背景交叉淡入时长，与 style.css 里的 .bg-img 过渡保持一致 */
export const BG_FADE_MS = 900;
/** 兜底图片探测超时 */
const PROBE_TIMEOUT = 8000;

/** weather-icon.js 不可用时的兜底字形（不是替代实现，只是不让页面留白） */
const ICON_GLYPHS = {
  sun: '☀️', 'cloud-sun': '⛅', cloud: '☁️', fog: '🌫️',
  'rain-light': '🌦️', rain: '🌧️', 'rain-heavy': '🌧️', shower: '🌦️',
  thunder: '⛈️', sleet: '🌨️', 'snow-light': '🌨️', snow: '❄️', 'snow-heavy': '❄️',
};

/** 惰性模块加载：失败后 10 秒内不重试，之后就绪了还能自动用上 */
function lazyModule(loader) {
  let mod = null;
  let pending = null;
  let failedAt = 0;
  return async () => {
    if (mod) return mod;
    if (pending) {
      const fresh = failedAt && Date.now() - failedAt < 10000;
      if (fresh) return pending;
      pending = null;
      failedAt = 0;
    }
    pending = loader().then(
      (m) => {
        mod = m;
        return m;
      },
      () => {
        failedAt = Date.now();
        return null;
      },
    );
    return pending;
  };
}

const loadIconModule = lazyModule(() => import('./weather-icon.js'));
const loadAssetsModule = lazyModule(() => import('./assets.js'));

/** 默认图片探测：优先用队友的 probeImage，没有就自己 new Image() */
function defaultProbe(url, timeoutMs = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    const Img = globalThis.Image;
    if (typeof Img !== 'function') return resolve(false);
    const img = new Img();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.decoding = 'async';
    img.src = url;
  });
}

const numOr = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 亮度采样区域：文字所在的中线区域，取中心 60% 宽、50% 高 */
export const LUMINANCE_SAMPLE = { wRatio: 0.60, hRatio: 0.50 };

/** sRGB 相对亮度（WCAG 定义） */
function relLuminance(r, g, b) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** 两色对比度（WCAG），1~21 */
export function contrastRatio(l1, l2) {
  const a = Math.max(l1, l2);
  const b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}

const WHITE_L = 1;
const INK_L = relLuminance(18, 23, 43); // 深墨色 #12172b

/** 离线预计算的亮度网格（tools/precompute-luminance.py 生成）。只加载一次。 */
let luminanceTable = null;
let luminanceTablePromise = null;

/** 站点根路径（支持部署在子目录，如 GitHub Pages 的 /WeatherRoulette/） */
function siteBase() {
  try {
    return new URL('../../', import.meta.url);
  } catch {
    return new URL('./', location.href);
  }
}

/**
 * 读取离线亮度网格。这是首选路径：
 * cdn.pixabay.com 不返回 CORS 头，浏览器端 canvas 读像素会直接失败（实测对比度掉到 1.46:1），
 * 服务端预算好的网格没有这个限制，且省掉一次图片解码。
 */
export function loadLuminanceTable() {
  if (luminanceTable) return Promise.resolve(luminanceTable);
  if (luminanceTablePromise) return luminanceTablePromise;
  luminanceTablePromise = fetch(new URL('assets/images/luminance.json', siteBase()))
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      luminanceTable = data?.cells ? data : null;
      return luminanceTable;
    })
    .catch(() => null);
  return luminanceTablePromise;
}

/** 用离线网格算某个视口矩形内的亮度均值（0~1）；没有数据返回 null */
export function luminanceFromTable(url, rect) {
  const data = luminanceTable;
  const cells = data?.cells?.[url];
  if (!Array.isArray(cells) || !rect || rect.width < 2 || rect.height < 2) return null;
  const [gw, gh] = data.grid ?? [8, 6];
  // 网格坐标是按图片自身比例切的，而背景图以 object-fit:cover 铺满视口，
  // 所以按「视口占比」取格子是等价的（cover 只做等比缩放 + 居中裁剪）。
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  const x0 = Math.max(0, Math.floor((rect.left / vw) * gw));
  const x1 = Math.min(gw - 1, Math.floor((rect.right / vw) * gw));
  const y0 = Math.max(0, Math.floor((rect.top / vh) * gh));
  const y1 = Math.min(gh - 1, Math.floor((rect.bottom / vh) * gh));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = cells[y * gw + x];
      if (typeof v === 'number') { sum += v / 255; n++; }
    }
  }
  return n ? sum / n : null;
}

/**
 * 从一组「区域平均亮度」里选文字配色。
 * 判据按**区域面积加权**：城市名占的像素最多，就不该和一行小字等权。
 * 先比"看不清（对比度<3:1）的加权占比"，并列时比平均对比度。
 */
export function pickTextColor(lums, weights = null) {
  const valid = lums.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!valid.length) return null;
  const w = valid.map((_, i) => {
    const x = weights?.[i];
    return typeof x === 'number' && x > 0 ? x : 1;
  });
  const wSum = w.reduce((a, b) => a + b, 0) || 1;
  const score = (textL) => {
    let badW = 0;
    let ratioW = 0;
    valid.forEach((L, i) => {
      const r = contrastRatio(textL, L);
      if (r < 3) badW += w[i];
      ratioW += Math.min(r, 21) * w[i];
    });
    return { bad: badW / wSum, avg: ratioW / wSum };
  };
  const white = score(WHITE_L);
  const ink = score(INK_L);
  // 容差 0.02：差距极小的时候别来回横跳，优先保住整体平均对比度
  if (Math.abs(white.bad - ink.bad) > 0.02) return white.bad < ink.bad ? 'dark' : 'light';
  return white.avg >= ink.avg ? 'dark' : 'light';
}

/**
 * 采样壁纸**文字实际覆盖区域**的像素亮度分布，选出可读性最好的文字配色。
 *
 * 为什么不用「平均亮度」：平均会被大片中间调掩盖最坏区域——实测「阿姆斯特丹」这张图
 * 平均亮度偏亮（于是选了深色字），但文字实际压在深色窗格上，结果深字压深底几乎看不清。
 * 改用分布决策：统计每个像素分别与白字、墨字的对比度，选"看不清的像素更少、看得清的更清"的那一套。
 *
 * @returns {Promise<{on:'light'|'dark'|null, whiteBad:number, inkBad:number, avg:number|null, pixels:number}>}
 */
export async function analyzeImageForText(url, rects = [], { timeoutMs = 10000 } = {}) {
  const empty = { on: null, whiteBad: 1, inkBad: 1, avg: null, pixels: 0 };
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.referrerPolicy = 'no-referrer';
      const timer = setTimeout(() => reject(new Error('加载超时')), timeoutMs);
      el.onload = () => { clearTimeout(timer); resolve(el); };
      el.onerror = () => { clearTimeout(timer); reject(new Error('加载失败')); };
      el.src = url;
    });
    const iw = img.naturalWidth || 640;
    const ih = img.naturalHeight || 360;

    // 文字区域 → 图片坐标（背景图是 object-fit:cover 铺满视口的，需要换算）
    const vw = window.innerWidth || iw;
    const vh = window.innerHeight || ih;
    const scale = Math.max(vw / iw, vh / ih); // cover
    const dw = iw * scale;
    const dh = ih * scale;
    const ox = (vw - dw) / 2;
    const oy = (vh - dh) / 2;

    const regions = [];
    for (const r of rects) {
      if (!r || r.width < 4 || r.height < 4) continue;
      const x0 = Math.max(0, (r.left - ox) / scale);
      const y0 = Math.max(0, (r.top - oy) / scale);
      const x1 = Math.min(iw, (r.right - ox) / scale);
      const y1 = Math.min(ih, (r.bottom - oy) / scale);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      regions.push({ x0, y0, x1, y1 });
    }
    // 拿不到文字框（DOM 还没布局好）时退回中心区域
    if (!regions.length) {
      regions.push({
        x0: iw * (0.5 - LUMINANCE_SAMPLE.wRatio / 2),
        y0: ih * (0.5 - LUMINANCE_SAMPLE.hRatio / 2),
        x1: iw * (0.5 + LUMINANCE_SAMPLE.wRatio / 2),
        y1: ih * (0.5 + LUMINANCE_SAMPLE.hRatio / 2),
      });
    }

    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return empty;

    let whiteBad = 0;
    let inkBad = 0;
    let total = 0;
    let lumSum = 0;
    for (const rg of regions) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, rg.x0, rg.y0, rg.x1 - rg.x0, rg.y1 - rg.y0, 0, 0, canvas.width, canvas.height);
      let data;
      try {
        data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      } catch {
        return empty; // 跨域被拒（CDN 没给 CORS 头）
      }
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue; // 透明像素不算
        const L = relLuminance(data[i], data[i + 1], data[i + 2]);
        lumSum += L;
        if (contrastRatio(WHITE_L, L) < 3) whiteBad++;
        if (contrastRatio(INK_L, L) < 3) inkBad++;
        total++;
      }
    }
    if (!total) return empty;
    return {
      on: inkBad <= whiteBad ? 'light' : 'dark', // 亮底用墨字
      whiteBad: whiteBad / total,
      inkBad: inkBad / total,
      avg: lumSum / total,
      pixels: total,
    };
  } catch {
    return empty;
  }
}

export class Screen {
  constructor(root = document) {
    this.root = root || document;
    this.doc = this.root?.nodeType === 9 ? this.root : (this.root?.ownerDocument ?? document);
    this._city = null;
    this._imageQueue = [];
    this._iconToken = 0;
    this._bgIndex = 0;
    this._bgToken = 0;
    this._currentUrl = null;
    this._probes = new Map();
    this._cardTimer = null;
  }

  // ---------------------------------------------------------------- 渲染

  /**
   * @param {object} desc describeCard(card) 的结果
   * @param {{city?:object, imageUrls?:Array, dayIndex?:number, cardIndex?:number, total?:number}} [opts]
   */
  renderCard(desc, { city, imageUrls = [], dayIndex = 0, cardIndex = 0, total = 0 } = {}) {
    if (!desc) return;
    const c = city || desc.city || {};
    this._city = c;
    const day = desc.day || {};
    const weather = desc.weather || {};

    const app = this.#node('app');
    if (app) {
      app.dataset.weather = weather.icon || 'cloud-sun';
      app.classList.toggle('is-night', !isDaytime(c.timezone));
    }

    this.#text('city-zh', c.zh ?? '');
    this.#text('city-en', c.en ?? '');
    this.#text('weather-zh', weather.zh ?? '');
    this.#text('weather-en', weather.en ?? '');
    this.#text('card-day', `${dayLabel(dayIndex)} ${dayLabelEn(dayIndex)}`);

    this.#renderIcon(weather.icon)?.catch?.(() => { /* 图标失败不影响其它信息 */ });

    const hi = numOr(desc.hi, null);
    const lo = numOr(desc.lo, hi);
    this.#renderTemps(hi, lo);

    const tz = c.timezone;
    const local = tz ? localTime(tz) : null;

    this.#restartCardAnimation();

    // 背景：候选图逐个探测，全部失败就上插画，绝不留白
    this._imageQueue = (Array.isArray(imageUrls) ? imageUrls : [])
      .map((it) => (typeof it === 'string' ? { url: it } : it))
      .filter((it) => it && it.url);
    this.#applyImageQueue();

    // 文字框此时已是新城市的内容，立刻按新壁纸重算配色（#crossfade 里还会再算一次，
    // 因为换图有 900ms 过渡，期间必须已经是对的配色）
    if (this._imageQueue[0]?.url) this.applyTextContrast(this._imageQueue[0].url);

    // 极简版没有进度条与状态栏；但给屏幕阅读器留一句可读描述（同时供自动化测试读取）
    this.setStatus(`${c.zh ?? ''} ${weather.zh ?? ''} ${hi == null ? '' : `${hi}度`}${local ? ` · 当地时间 ${local}` : ''}`.trim());
  }

  /** 交叉淡入切换背景图（#bg-img-a / #bg-img-b 轮流 is-active）
   *  返回 Promise<boolean>：true = 真的换上了照片，false = 走了插画兜底。
   *  不会 reject，调用方 await 它就能等到背景稳定下来。 */
  setBackground(url) {
    if (!url) return this.#fallbackOrQueue(null);
    const token = ++this._bgToken;
    return this.#probe(url).then((ok) => {
      if (token !== this._bgToken) return false; // 已经换成别的卡片了
      if (ok) return this.#crossfade(url);
      // 这张不行：先把候选队列里剩下的图试完，全失败才用插画
      return this.#fallbackOrQueue(url);
    });
  }

  /** 所有图都失败时的插画兜底：渐变 + 城市首字，不允许留白 */
  setBackgroundFallback(city) {
    const c = city || this._city || {};
    const name = String(c.zh || c.en || '天气').trim() || '天气';
    const glyph = name.slice(0, 1);

    // 首选：index.html 的 #bg-scene 加 .is-fallback，由 style.css 出主题渐变 + data-char 大字
    const scene = this.#node('bg-scene');
    if (scene) {
      scene.hidden = false;
      scene.classList.add('is-fallback');
      scene.dataset.char = glyph;
      scene.textContent = '';
      const legacy = this.#node('bg-fallback');
      if (legacy) legacy.style.display = 'none';
    } else {
      this.#paintFallbackBlock(glyph, name, c);
    }

    // 隐藏照片层，避免露出上一城的图
    for (const id of ['bg-img-a', 'bg-img-b']) this.#node(id)?.classList.remove('is-active');
    this._currentUrl = null;
    return false;
  }

  setStatus(text) {
    // 极简版没有可见状态栏：写进隐藏的状态位（屏幕阅读器 + 自动化测试用它）
    this.#text('sr-only-status', text == null ? '' : String(text));
    this.#text('status-text', text == null ? '' : String(text));
  }

  /** i 为 0 基下标；进度条按「第 i+1 / total 个」计算 */
  setProgress(i, total) {
    const n = Math.max(0, Math.round(numOr(total, 0)));
    const cur = Math.max(0, Math.round(numOr(i, 0)));
    const shown = n ? Math.min(n, cur + 1) : 0;
    const ratio = n ? shown / n : 0;

    const fill = this.#node('progress-fill');
    if (fill) fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    const track = this.#node('progress-track');
    if (track) {
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', String(n));
      track.setAttribute('aria-valuenow', String(shown));
      track.setAttribute('aria-valuetext', n ? `第 ${shown} / ${n} 个城市` : '');
    }
    this.#text('progress-text', n ? `${shown} / ${n}` : '');
  }

  setPaused(paused) {
    const app = this.#node('app');
    app?.classList.toggle('is-paused', Boolean(paused));
    const btn = this.#node('btn-play');
    if (btn) {
      btn.setAttribute('aria-pressed', String(Boolean(paused)));
      if (paused) btn.setAttribute('aria-label', '继续播报');
      else btn.setAttribute('aria-label', '暂停播报');
    }
  }

  setPlaying(playing) {
    const on = Boolean(playing);
    const app = this.#node('app');
    app?.classList.toggle('is-playing', on);
    if (on) {
      this.hideOverlay();
      app?.classList.remove('is-paused');
    }
  }

  /** 隐藏「开始播报」遮罩（浏览器要求用户点一下才解锁声音） */
  hideOverlay() {
    const box = this.#node('start-overlay');
    if (!box) return;
    box.classList.add('is-hidden');
    // 先让 CSS 过渡淡出，再彻底 hidden（style.css 同时支持 .is-hidden 与 [hidden]）
    setTimeout(() => box.setAttribute('hidden', ''), 320);
  }

  showOverlay(hint) {
    const box = this.#node('start-overlay');
    if (box) {
      box.classList.remove('is-hidden');
      box.removeAttribute('hidden');
      box.style.display = '';
    }
    if (hint != null) this.#text('start-hint', String(hint));
  }

  /** 更新遮罩里的提示文案（例如「网络不通，正在用演示数据」） */
  setStartHint(text) {
    this.#text('start-hint', text == null ? '' : String(text));
  }

  /**
   * 根据壁纸**文字实际覆盖区域**的亮度切换文字配色（去蒙版后的可读性保障）。
   *
   * 两条路径，优先用离线预算的亮度网格：
   *   1) 网格命中 → 逐行取该行覆盖格子的亮度，逐行投票（某一行压在暗处就偏白字），
   *      能处理"上半张亮、下半张暗"的壁纸；
   *   2) 网格没有这条 URL → 退回浏览器端 canvas 采样（Pixabay 会因缺 CORS 头失败）
   *      → 再退回柔和文字阴影兜底。
   */
  async applyTextContrast(url) {
    const app = this.#node('app');
    if (!app) return null;

    const rects = this.#textRects();
    let table = null;
    try {
      table = await loadLuminanceTable();
    } catch {
      table = null;
    }

    if (table && rects.length) {
      // 按区域面积加权投票：城市名占的像素最多，权重最大
      const votes = [];
      const weights = [];
      for (const r of rects) {
        const lum = luminanceFromTable(url, r);
        if (lum == null) continue;
        votes.push(lum);
        weights.push(r.width * r.height);
      }
      const on = pickTextColor(votes, weights);
      if (on) {
        app.removeAttribute('data-contrast-fallback');
        app.dataset.textOn = on;
        this.textOn = on;
        this.lastAnalysis = { on, source: 'table', samples: votes.length, lums: votes };
        return on;
      }
    }

    // 兜底路径：浏览器端采样
    const analysis = await analyzeImageForText(url, rects);
    if (!analysis.on) {
      app.setAttribute('data-contrast-fallback', '1');
      this.textOn = null;
      this.lastAnalysis = { ...analysis, source: 'fallback' };
      return null;
    }
    app.removeAttribute('data-contrast-fallback');
    app.dataset.textOn = analysis.on;
    this.textOn = analysis.on;
    this.lastAnalysis = { ...analysis, source: 'canvas' };
    return analysis.on;
  }

  /** 取所有可见文字节点的包围盒（视口坐标），交给亮度采样按区域统计 */
  #textRects() {
    const ids = ['city-zh', 'city-en', 'weather-zh', 'weather-en', 'temp-c', 'card-day'];
    const rects = [];
    for (const id of ids) {
      const el = this.#node(id);
      if (!el || !el.getClientRects) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 4 && r.height >= 4) rects.push(r);
    }
    return rects;
  }

  /** 当前文字配色：'light'（亮底深字）/ 'dark'（暗底白字）/ null（用兜底阴影） */
  get textOn() {
    return this._textOn ?? 'dark';
  }

  set textOn(v) {
    this._textOn = v;
  }

  // ---------------------------------------------------------------- 内部

  #node(id) {
    const r = this.root;
    let hit = null;
    if (r && typeof r.getElementById === 'function') hit = r.getElementById(id);
    if (!hit && r && typeof r.querySelector === 'function') hit = r.querySelector(`#${id}`);
    if (!hit && this.doc && this.doc !== r && typeof this.doc.getElementById === 'function') {
      hit = this.doc.getElementById(id);
    }
    return hit || null;
  }

  #text(id, value) {
    const el = this.#node(id);
    if (el && el.textContent !== value) el.textContent = value;
  }

  async #renderIcon(iconKey) {
    const host = this.#node('weather-icon');
    if (!host) return;
    const key = iconKey || 'cloud-sun';
    const token = ++this._iconToken;

    const mod = await loadIconModule();
    const render = mod?.renderWeatherIcon;
    if (typeof render === 'function') {
      let svg = null;
      try {
        svg = render(key, {});
      } catch {
        try {
          svg = render(key);
        } catch {
          svg = null;
        }
      }
      if (svg) {
        if (token === this._iconToken) {
          host.textContent = '';
          host.append(svg);
        }
        return;
      }
    }

    // 队友模块还没就绪：用字形兜底，保证有东西可看
    if (token !== this._iconToken) return;
    const span = this.doc.createElement('span');
    span.className = 'icon-fallback';
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', ICON_LABELS[key] || '天气');
    span.textContent = ICON_GLYPHS[key] || '⛅';
    span.style.cssText = 'font-size:clamp(40px,12vmin,140px);line-height:1;filter:drop-shadow(0 8px 18px rgba(0,0,0,.35));';
    host.textContent = '';
    host.append(span);
  }

  #renderTemps(hi, lo) {
    const cEl = this.#node('temp-c');
    if (cEl) {
      cEl.textContent = '';
      const main = this.doc.createElement('span');
      main.className = 'temp-main';
      main.textContent = hi == null ? '—' : String(hi);
      const unit = this.doc.createElement('sup');
      unit.className = 'temp-unit';
      unit.textContent = '°C';
      unit.style.cssText = 'font-size:.34em;font-weight:700;margin-left:.06em;vertical-align:.55em;';
      cEl.append(main, unit);
    }
    const fEl = this.#node('temp-f');
    if (fEl) fEl.textContent = hi == null ? '—' : `${toF(hi)}°F`;

    const row = this.#node('temp-row');
    if (row && hi != null) {
      const low = lo == null ? hi : lo;
      const range = `${low}~${hi}°C`;
      row.setAttribute('aria-label', `最低 ${low} 摄氏度，最高 ${hi} 摄氏度（${toF(low)}~${toF(hi)} 华氏度）`);
      row.title = `${range} / ${toF(low)}~${toF(hi)}°F`;
      if (fEl) {
        let small = row.querySelector('.temp-range');
        if (!small) {
          small = this.doc.createElement('span');
          small.className = 'temp-range';
          small.style.cssText = 'font-size:clamp(11px,1.5vmin,18px);font-weight:600;opacity:.85;white-space:nowrap;align-self:center;margin-left:.5em;';
          row.append(small);
        }
        small.textContent = range;
      }
    }
  }

  /** 卡片入场动画：加类 → 强刷 → 下一帧去掉，CSS 动画每次都能重播 */
  #restartCardAnimation() {
    const card = this.#node('card');
    if (!card) return;
    clearTimeout(this._cardTimer);
    card.classList.remove('is-entering');
    void card.offsetWidth;
    card.classList.add('is-entering');
    this._cardTimer = setTimeout(() => card.classList.remove('is-entering'), 900);
  }

  /** 没有 #bg-scene 时的自绘插画（老版 index.html 兜底，正常不会走到） */
  #paintFallbackBlock(glyph, name, city) {
    const host = this.#node('bg') || this.#node('app') || this.doc.body;
    if (!host) return;
    let wrap = this.#node('bg-fallback');
    if (!wrap) {
      wrap = this.doc.createElement('div');
      wrap.id = 'bg-fallback';
      wrap.setAttribute('aria-hidden', 'true');
      host.append(wrap);
    }
    const hue = hashHue(String(city?.id || name));
    wrap.style.cssText = [
      'position:absolute', 'inset:0', 'z-index:0',
      `background:linear-gradient(160deg,hsl(${hue} 78% 64%) 0%,hsl(${(hue + 46) % 360} 72% 48%) 55%,hsl(${(hue + 104) % 360} 62% 34%) 100%)`,
      'display:grid', 'place-items:center', 'align-content:center', 'gap:.02em', 'overflow:hidden',
    ].join(';');
    wrap.textContent = '';
    const big = this.doc.createElement('div');
    big.textContent = glyph;
    big.style.cssText = 'font-size:min(46vh,42vw);line-height:1;font-weight:900;color:rgba(255,255,255,.94);text-shadow:0 12px 42px rgba(0,0,0,.35);user-select:none;';
    const label = this.doc.createElement('div');
    label.textContent = name;
    label.style.cssText = 'font-size:clamp(18px,4vmin,44px);font-weight:800;color:rgba(255,255,255,.92);letter-spacing:.08em;text-shadow:0 6px 22px rgba(0,0,0,.35);';
    wrap.append(big, label);
  }

  /** 某张图不可用：先试候选队列里剩下的，全失败才插画兜底 */
  async #fallbackOrQueue(failedUrl) {
    const hasOther = this._imageQueue.some((it) => it.url && it.url !== failedUrl);
    if (hasOther) return this.#applyImageQueue();
    return this.setBackgroundFallback(this._city);
  }

  /** 候选图逐个探测；第一个可用的上屏，全不行就插画兜底 */
  async #applyImageQueue() {
    const token = ++this._bgToken;
    const queue = this._imageQueue;
    if (!queue.length) return this.setBackgroundFallback(this._city);
    for (const item of queue) {
      const ok = await this.#probe(item.url);
      if (token !== this._bgToken) return false; // 已经换成别的卡片了
      if (ok) return this.#crossfade(item.url, item.credit);
    }
    if (token !== this._bgToken) return false;
    return this.setBackgroundFallback(this._city);
  }

  async #probe(url) {
    if (this._probes.has(url)) return this._probes.get(url);
    const p = (async () => {
      const mod = await loadAssetsModule();
      if (typeof mod?.probeImage === 'function') {
        try {
          return Boolean(await mod.probeImage(url, PROBE_TIMEOUT));
        } catch {
          return false;
        }
      }
      return defaultProbe(url, PROBE_TIMEOUT);
    })();
    this._probes.set(url, p);
    return p;
  }

  #crossfade(url, credit) {
    if (url === this._currentUrl) return true;
    const a = this.#node('bg-img-a');
    const b = this.#node('bg-img-b');
    const imgs = [a, b].filter(Boolean);
    if (!imgs.length) {
      this.setBackgroundFallback(this._city);
      return false;
    }
    const token = ++this._bgToken;
    const next = imgs[1 - this._bgIndex] || imgs[0];
    const cur = imgs[this._bgIndex];

    next.classList.remove('is-active');
    next.alt = this._city?.zh ? `${this._city.zh}城市实景` : '城市实景';
    next.src = url;
    if (credit) next.title = credit;

    // 有照片了，文字颜色交给照片亮度决定（这是去掉蒙版后可读性的唯一保障）
    this.applyTextContrast(url);

    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      if (token !== this._bgToken) return;
      next.classList.add('is-active');
      if (cur && cur !== next) cur.classList.remove('is-active');
      this._bgIndex = 1 - this._bgIndex;
      this._currentUrl = url;
      // 有照片了：收掉插画兜底，让 #bg-scene 回到装饰层
      const scene = this.#node('bg-scene');
      if (scene) {
        scene.classList.remove('is-fallback');
        delete scene.dataset.char;
      }
      const legacy = this.#node('bg-fallback');
      if (legacy) legacy.style.display = 'none';
    };
    const giveUp = () => {
      if (swapped) return;
      swapped = true;
      this.setBackgroundFallback(this._city);
    };

    // 先挂监听再设 src（缓存命中时 load 可能同步发生，错过就永远不切了）
    next.addEventListener('load', swap, { once: true });
    next.addEventListener('error', giveUp, { once: true });
    if (next.getAttribute('src') !== url) next.src = url;
    if (next.complete && next.naturalWidth > 0) {
      swap(); // 已经在缓存里：立刻切，不用等事件
    } else if (typeof next.decode === 'function') {
      next.decode().then(swap, () => { /* 解码失败交给 error 事件 / 保险丝 */ });
    }
    // 保险丝：图片既不 load 也不 error 时（无头浏览器、极端网络）也要把画面切过去
    setTimeout(swap, 2000);
    return true;
  }
}

/** 由字符串派生一个稳定的色相，让插画兜底每城不同色 */
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export default Screen;
