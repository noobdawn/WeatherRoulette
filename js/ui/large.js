// ============================================================================
// 大屏版渲染层（LargeScreen）：整屏单城展示。
//
// 只读复用以下队友模块（缺失或接口不符时自动降级，绝不修改它们的文件）：
//   js/ui/assets.js        loadImageManifest / resolveCityImage / probeImage
//   js/ui/weather-icon.js  renderWeatherIcon(iconKey, { size })
// 两个模块都用「动态 import + try/catch」，因此某个文件还不存在时
// 大屏版依然能独立打开、不报错，只是走本文件内置的降级实现。
// ============================================================================

import { localTime, isDaytime } from '../core/utils.js';
import { dayLabel, dayLabelEn, toF } from '../core/format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 进度点阵一次最多显示多少个点（城市多于此时用滑动窗口） */
const DOT_WINDOW = 21;

function setText(node, text) {
  if (!node) return;
  const next = String(text ?? '');
  if (node.textContent !== next) node.textContent = next;
}

function byId(root, id) {
  if (!root) return null;
  return (typeof root.getElementById === 'function' ? root.getElementById(id) : null)
    ?? (typeof root.querySelector === 'function' ? root.querySelector(`#${id}`) : null);
}

/** 动态 import 包装：模块不存在 / 语法错误 / 导出缺失都不抛出 */
async function tryImport(loader, label) {
  try {
    return await loader();
  } catch (err) {
    console.warn(`[大屏版] 可选模块 ${label} 不可用，使用内置降级实现：`, err?.message ?? err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内置降级实现（契约同 js/ui/assets.js，仅在队友模块缺失时使用）
// ---------------------------------------------------------------------------
function localAssets() {
  return {
    async loadImageManifest() {
      try {
        const res = await fetch('assets/images/manifest.json', { cache: 'no-store' });
        if (!res.ok) return { images: {} };
        const json = await res.json();
        return json && typeof json === 'object' ? json : { images: {} };
      } catch {
        return { images: {} };
      }
    },
    resolveCityImage(city, manifest) {
      const entry = manifest?.images?.[city?.id];
      if (!entry) return [];
      const list = [];
      if (entry.primary) {
        list.push({ url: entry.primary, credit: entry.credit ?? entry.author ?? city?.zh ?? '' });
      }
      for (const url of entry.fallbacks ?? []) {
        if (url) list.push({ url, credit: entry.credit ?? entry.author ?? '' });
      }
      return list;
    },
    probeImage(url, timeoutMs = 8000) {
      return new Promise((resolve) => {
        if (!url) return resolve(false);
        const img = new Image();
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          img.onload = null;
          img.onerror = null;
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = url;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 内置降级天气图标（仅在 js/ui/weather-icon.js 不可用时使用）
// 纯代码绘制的卡通风格 SVG，覆盖 ICON_LABELS 的全部 13 个键。
// ---------------------------------------------------------------------------
const ICON_SPEC = {
  sun: { sun: [60, 58, 22] },
  'cloud-sun': { sun: [38, 42, 14], cloud: true },
  cloud: { cloud: true },
  fog: { cloud: true, fog: true },
  'rain-light': { cloud: true, drops: [1] },
  rain: { cloud: true, drops: [1, 2] },
  'rain-heavy': { cloud: true, drops: [1, 2, 3] },
  shower: { sun: [38, 42, 13], cloud: true, drops: [1, 2] },
  thunder: { cloud: true, bolt: true },
  sleet: { cloud: true, drops: [1, 2], flakes: [1] },
  'snow-light': { cloud: true, flakes: [1] },
  snow: { cloud: true, flakes: [1, 2] },
  'snow-heavy': { cloud: true, flakes: [1, 2, 3] },
};

function sunGroup(cx, cy, r) {
  const rays = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    const x1 = cx + Math.cos(a) * (r + 5);
    const y1 = cy + Math.sin(a) * (r + 5);
    const x2 = cx + Math.cos(a) * (r + 13);
    const y2 = cy + Math.sin(a) * (r + 13);
    rays.push(`<line class="lg-sun-ray" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
  }
  return `<g class="lg-sun" style="transform-origin:${cx}px ${cy}px">${rays.join('')}`
    + `<circle class="lg-sun-core" cx="${cx}" cy="${cy}" r="${r}"/></g>`;
}

const CLOUD_GROUP = '<g class="lg-cloud">'
  + '<circle cx="42" cy="72" r="16"/><circle cx="62" cy="62" r="22"/>'
  + '<circle cx="84" cy="72" r="14"/><rect x="40" y="72" width="46" height="15" rx="7.5"/></g>';

const DROP_X = { 1: 44, 2: 60, 3: 76 };
const DROP_DELAY = { 1: 0, 2: 0.28, 3: 0.56 };

function fallbackIconSvg(iconKey) {
  const spec = ICON_SPEC[iconKey] ?? ICON_SPEC.sun;
  const parts = [];
  if (spec.sun) parts.push(sunGroup(spec.sun[0], spec.sun[1], spec.sun[2]));
  if (spec.cloud) parts.push(CLOUD_GROUP);
  for (const n of spec.drops ?? []) {
    parts.push(`<rect class="lg-drop" x="${DROP_X[n]}" y="94" width="8" height="17" rx="4"`
      + ` style="animation-delay:${DROP_DELAY[n]}s"/>`);
  }
  const flakeX = { 1: 46, 2: 62, 3: 78 };
  const flakeDelay = { 1: 0, 2: 0.8, 3: 1.5 };
  for (const n of spec.flakes ?? []) {
    const x = flakeX[n];
    parts.push(`<g class="lg-flake" style="animation-delay:${flakeDelay[n]}s">`
      + `<path d="M${x} 92 v16 M${x - 8} 100 h16" fill="none" stroke="#eaf6ff" stroke-width="4" stroke-linecap="round"/></g>`);
  }
  if (spec.bolt) {
    parts.push('<polygon class="lg-bolt" points="62,80 76,80 65,98 77,98 52,120 61,99 49,99"/>');
  }
  if (spec.fog) {
    parts.push('<g class="lg-fog-line"><line x1="30" y1="96" x2="92" y2="96"/>'
      + '<line x1="38" y1="107" x2="86" y2="107"/><line x1="30" y1="118" x2="70" y2="118"/></g>');
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('role', 'img');
  svg.setAttribute('class', 'lg-fallback-icon');
  svg.innerHTML = parts.join('');
  return svg;
}

// ---------------------------------------------------------------------------
// LargeScreen
// ---------------------------------------------------------------------------
export class LargeScreen {
  constructor(root = document) {
    this.root = root;
    this.doc = root?.documentElement ? root : document;
    this.app = byId(root, 'large-app');
    this.nodes = {
      bg: byId(root, 'lg-bg'),
      bgA: byId(root, 'lg-bg-a'),
      bgB: byId(root, 'lg-bg-b'),
      bgFallbackChar: byId(root, 'lg-bg-fallback-char'),
      cityZh: byId(root, 'lg-city-zh'),
      cityEn: byId(root, 'lg-city-en'),
      dayZh: byId(root, 'lg-day-zh'),
      dayEn: byId(root, 'lg-day-en'),
      icon: byId(root, 'lg-weather-icon'),
      weatherZh: byId(root, 'lg-weather-zh'),
      weatherEn: byId(root, 'lg-weather-en'),
      tempC: byId(root, 'lg-temp-c'),
      tempF: byId(root, 'lg-temp-f'),
      noteZh: byId(root, 'lg-temp-note-zh'),
      noteEn: byId(root, 'lg-temp-note-en'),
      timeZh: byId(root, 'lg-local-time-zh'),
      timeEn: byId(root, 'lg-local-time-en'),
      precipZh: byId(root, 'lg-precip-zh'),
      precipEn: byId(root, 'lg-precip-en'),
      windZh: byId(root, 'lg-wind-zh'),
      windEn: byId(root, 'lg-wind-en'),
      dots: byId(root, 'lg-dots'),
      progressText: byId(root, 'lg-progress-text'),
      status: byId(root, 'lg-status'),
      overlay: byId(root, 'lg-start-overlay'),
      hint: byId(root, 'lg-start-hint'),
      btnStart: byId(root, 'lg-btn-start'),
      btnPrev: byId(root, 'lg-btn-prev'),
      btnPlay: byId(root, 'lg-btn-play'),
      btnNext: byId(root, 'lg-btn-next'),
      btnMusic: byId(root, 'lg-btn-music'),
      btnShuffle: byId(root, 'lg-btn-shuffle'),
    };

    this.assets = localAssets();
    this.assetsSource = '内置降级';
    this.iconRenderer = null;
    this.iconSource = '内置降级';
    this.iconLoadTried = false;
    /** 可选模块降级说明，供 ?diag=1 自测报告使用 */
    this.degraded = [];
    this.imageManifest = { images: {} };
    this.imageState = 'none';
    this.credit = '';
    this.bgIsA = true;
    this.iconToken = 0;
    this.index = 0;
    this.total = 0;
    this.dotEls = [];
    this.dotWindowStart = -1;
    this.resizeTimer = null;
    this.playing = false;
    this.paused = false;
    this.lastDesc = null;

    // 视口变化（旋转 iPad 等）时重新计算点阵：宽屏每城一个点，窄屏才用滑动窗口
    window.addEventListener?.('resize', () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        this.dotWindowStart = -1;
        this.#renderDots();
      }, 200);
    });
    window.addEventListener?.('orientationchange', () => {
      this.dotWindowStart = -1;
      this.#renderDots();
    });
  }

  /** 载入可选模块（图片清单 / 天气图标）。失败也不影响页面渲染。 */
  async prepare() {
    await Promise.all([this.#loadAssets(), this.#loadIcon()]);
    return this;
  }

  get buttons() {
    return {
      start: this.nodes.btnStart,
      prev: this.nodes.btnPrev,
      play: this.nodes.btnPlay,
      next: this.nodes.btnNext,
      music: this.nodes.btnMusic,
      shuffle: this.nodes.btnShuffle,
    };
  }

  async #loadAssets() {
    const mod = await tryImport(() => import('./assets.js'), 'js/ui/assets.js');
    const local = localAssets();
    const pick = (name) => (typeof mod?.[name] === 'function' ? mod[name].bind(mod) : local[name]);
    if (mod) this.assetsSource = 'js/ui/assets.js';
    else this.degraded.push('js/ui/assets.js 不可用，图片候选/探测使用 large.js 内置实现');
    this.assets = {
      async loadImageManifest() {
        try {
          const manifest = await pick('loadImageManifest')();
          if (manifest && typeof manifest === 'object') {
            return { ...manifest, images: manifest.images ?? {} };
          }
        } catch (err) {
          console.warn('[大屏版] 读取图片清单失败，改用渐变插画：', err?.message ?? err);
        }
        return { images: {} };
      },
      resolveCityImage(city, manifest) {
        try {
          const list = pick('resolveCityImage')(city, manifest);
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      },
      async probeImage(url, timeoutMs = 8000) {
        try {
          return Boolean(await pick('probeImage')(url, timeoutMs));
        } catch {
          return false;
        }
      },
    };
    this.imageManifest = await this.assets.loadImageManifest();
    return this.imageManifest;
  }

  async #loadIcon() {
    if (this.iconLoadTried) return this.iconRenderer;   // 失败只尝试一次，不为每张卡重试
    this.iconLoadTried = true;
    const mod = await tryImport(() => import('./weather-icon.js'), 'js/ui/weather-icon.js');
    const fn = mod?.renderWeatherIcon
      ?? mod?.default?.renderWeatherIcon
      ?? (typeof mod?.default === 'function' ? mod.default : null);
    if (typeof fn === 'function') {
      this.iconRenderer = fn;
      this.iconSource = 'js/ui/weather-icon.js';
    } else {
      this.degraded.push('js/ui/weather-icon.js 不可用，天气图标使用 large.js 内置绘制');
    }
    return this.iconRenderer;
  }

  // -------------------------------------------------------------------------
  // 卡片渲染
  // -------------------------------------------------------------------------
  renderCard(desc, opts = {}) {
    const app = this.app;
    if (!app) return;
    const city = opts.city ?? desc?.city ?? {};
    const day = desc?.day ?? {};

    app.dataset.weather = desc?.weather?.icon ?? 'sun';
    app.classList.toggle('is-night', city.timezone ? !isDaytime(city.timezone) : false);

    const zh = city.zh ?? '';
    setText(this.nodes.cityZh, zh);
    app.style.setProperty('--lg-chars', String(Math.max(1, [...zh].length)));

    const en = city.en ?? '';
    setText(this.nodes.cityEn, en);
    app.style.setProperty('--lg-en-num', String(Math.max(3, [...en].length * 0.62)));

    const dayIndex = opts.dayIndex ?? desc?.dayIndex ?? 0;
    setText(this.nodes.dayZh, dayLabel(dayIndex));
    setText(this.nodes.dayEn, dayLabelEn(dayIndex));

    setText(this.nodes.weatherZh, desc?.weather?.zh ?? '');
    setText(this.nodes.weatherEn, desc?.weather?.en ?? '');

    const hasTemp = Number.isFinite(desc?.hi);
    const hi = hasTemp ? Math.round(desc.hi) : null;
    const lo = Number.isFinite(desc?.lo) ? Math.round(desc.lo) : null;
    const cText = hi == null ? '--' : String(hi);
    const fText = hi == null ? '--' : String(toF(hi));
    setText(this.nodes.tempC, cText);
    setText(this.nodes.tempF, fText);
    app.style.setProperty('--lg-temp-num', String(Math.max(cText.length, fText.length)));

    setText(this.nodes.noteZh, hi == null ? '' : `最高 ${hi}° · 最低 ${lo}°`);
    setText(this.nodes.noteEn, hi == null ? '' : `High ${toF(hi)}° · Low ${toF(lo)}°F`);

    const now = city.timezone ? localTime(city.timezone) : null;
    setText(this.nodes.timeZh, now ? `当地时间 ${now}` : '当地时间 --:--');
    setText(this.nodes.timeEn, now ? `Local ${now}` : 'Local --:--');

    const precip = Number.isFinite(Number(day.precip)) ? Math.round(Number(day.precip)) : null;
    setText(this.nodes.precipZh, precip == null ? '降水概率 —' : `降水概率 ${precip}%`);
    setText(this.nodes.precipEn, precip == null ? 'Rain —' : `Rain ${precip}%`);

    const wind = Number.isFinite(Number(day.wind)) ? Math.round(Number(day.wind)) : null;
    setText(this.nodes.windZh, wind == null ? '风速 —' : `风速 ${wind} 公里/时`);
    setText(this.nodes.windEn, wind == null ? 'Wind —' : `Wind ${wind} km/h`);

    this.#paintIcon(desc?.weather?.icon ?? 'sun');
    if (Number.isFinite(opts.cardIndex) && Number.isFinite(opts.total)) {
      this.setProgress(opts.cardIndex, opts.total);
    }
    this.lastDesc = desc;
  }

  async #paintIcon(iconKey) {
    const host = this.nodes.icon;
    if (!host) return;
    const token = ++this.iconToken;
    host.dataset.icon = iconKey;
    if (!this.iconRenderer) await this.#loadIcon();
    if (token !== this.iconToken) return;   // 期间已切换到别的城市
    let node = null;
    if (this.iconRenderer) {
      try {
        // 不传 size：尺寸交给 CSS（clamp + 100%）控制，缩放窗口时图标跟着变
        node = this.iconRenderer(iconKey);
      } catch (err) {
        console.warn('[大屏版] renderWeatherIcon 抛错，改用内置图标：', err?.message ?? err);
        this.iconRenderer = null;
        this.iconSource = '内置降级';
      }
    }
    if (token !== this.iconToken) return;
    const finalNode = node ?? fallbackIconSvg(iconKey);
    // 若图标模块写死了内联 width/height，清掉，让大屏的响应式 CSS 生效
    if (finalNode?.style && (finalNode.style.width || finalNode.style.height)) {
      finalNode.style.width = '';
      finalNode.style.height = '';
    }
    host.replaceChildren(finalNode.nodeType ? finalNode : document.createTextNode(String(finalNode)));
  }

  // -------------------------------------------------------------------------
  // 背景
  // -------------------------------------------------------------------------
  /** 交叉淡入切换壁纸；url 不可用时返回 false（由调用方决定是否降级） */
  async setBackground(url, { skipProbe = false } = {}) {
    if (!url) return false;
    if (!skipProbe) {
      const ok = await this.assets.probeImage(url, 8000);
      if (!ok) return false;
    }
    const next = this.bgIsA ? this.nodes.bgB : this.nodes.bgA;
    const prev = this.bgIsA ? this.nodes.bgA : this.nodes.bgB;
    if (!next || !prev) return false;
    try {
      await this.#assignImage(next, url);
    } catch {
      return false;
    }
    next.classList.add('is-active');
    prev.classList.remove('is-active');
    this.bgIsA = !this.bgIsA;
    this.nodes.bg?.classList.remove('is-fallback');
    this.imageState = 'photo';
    return true;
  }

  #assignImage(img, url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      const onLoad = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('壁纸加载失败'));
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      if (img.getAttribute('src') !== url) img.src = url;
      if (img.complete && img.naturalWidth > 0) onLoad();
    });
  }

  /** 所有候选图都失败时的插画降级：渐变 + 城市首字（绝不留白） */
  setBackgroundFallback(city) {
    const name = String(city?.zh ?? city?.en ?? '天');
    setText(this.nodes.bgFallbackChar, [...name][0] ?? '天');
    let hue = 0;
    for (const ch of String(city?.id ?? name)) hue = (hue * 31 + ch.codePointAt(0)) % 360;
    this.nodes.bg?.style.setProperty('--lg-hue', String(hue));
    this.nodes.bg?.classList.add('is-fallback');
    this.nodes.bgA?.classList.remove('is-active');
    this.nodes.bgB?.classList.remove('is-active');
    this.bgIsA = true;
    this.imageState = 'fallback';
    return 'fallback';
  }

  /**
   * 依次尝试 primary / fallbacks，全部失败就用渐变插画。
   * @returns {Promise<'photo'|'fallback'>}
   */
  async applyCityBackground(city) {
    let candidates = [];
    try {
      candidates = this.assets.resolveCityImage(city, this.imageManifest) ?? [];
    } catch {
      candidates = [];
    }
    for (const cand of candidates) {
      const url = typeof cand === 'string' ? cand : cand?.url;
      if (!url) continue;
      const ok = await this.assets.probeImage(url, 8000);
      if (!ok) continue;
      if (await this.setBackground(url, { skipProbe: true })) {
        this.credit = (typeof cand === 'object' && cand?.credit) || '';
        return 'photo';
      }
    }
    this.credit = '';
    return this.setBackgroundFallback(city);
  }

  // -------------------------------------------------------------------------
  // HUD / 状态
  // -------------------------------------------------------------------------
  setStatus(text) {
    setText(this.nodes.status, text ?? '');
  }

  setHint(text) {
    setText(this.nodes.hint, text ?? '');
  }

  setProgress(index, total) {
    this.index = Math.max(0, Number(index) || 0);
    this.total = Math.max(0, Number(total) || 0);
    setText(this.nodes.progressText, this.total ? `${this.index + 1} / ${this.total}` : '');
    this.#renderDots();
  }

  #renderDots() {
    const host = this.nodes.dots;
    if (!host) return;
    const total = this.total;
    if (!total) {
      host.replaceChildren();
      this.dotEls = [];
      this.dotWindowStart = 'empty';
      return;
    }
    // 宽屏（投屏/平板/桌面）：每城一个点，当前点高亮；
    // 窄屏（手机竖屏）：81 个点会细到看不清，改为 21 点滑动窗口 + 「12 / 81」数字进度。
    const gap = Math.min(6, Math.max(2, (window.innerWidth || 1024) * 0.003));
    const perDot = ((window.innerWidth || 1024) - 40 - (total - 1) * gap) / total;
    const showAll = perDot >= 3;
    const count = showAll ? total : Math.min(total, DOT_WINDOW);
    const start = showAll
      ? 0
      : (total > DOT_WINDOW
        ? Math.min(Math.max(0, this.index - Math.floor(DOT_WINDOW / 2)), total - DOT_WINDOW)
        : 0);
    const hasLeading = start > 0;
    const hasTrailing = start + count < total;
    const signature = `${total}:${start}:${count}:${hasLeading}:${hasTrailing}`;
    if (this.dotWindowStart !== signature) {
      this.dotWindowStart = signature;
      const frag = document.createDocumentFragment();
      this.dotEls = [];
      if (hasLeading) {
        const gap = document.createElement('i');
        gap.className = 'is-gap';
        frag.append(gap);
      }
      for (let i = 0; i < count; i++) {
        const dot = document.createElement('i');
        dot.dataset.index = String(start + i);
        frag.append(dot);
        this.dotEls.push(dot);
      }
      if (hasTrailing) {
        const gap = document.createElement('i');
        gap.className = 'is-gap';
        frag.append(gap);
      }
      host.replaceChildren(frag);
    }
    for (const dot of this.dotEls) {
      const i = Number(dot.dataset.index);
      dot.classList.toggle('is-current', i === this.index);
      dot.classList.toggle('is-past', i < this.index);
    }
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);
    this.#syncPlayButton();
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.nodes.overlay) this.nodes.overlay.dataset.paused = String(this.paused);
    this.#syncPlayButton();
  }

  #syncPlayButton() {
    const btn = this.nodes.btnPlay;
    if (!btn) return;
    const running = this.playing && !this.paused;
    setText(btn, running ? '⏸' : '▶');
    btn.setAttribute('aria-label', running ? '暂停播报' : '继续播报');
    btn.setAttribute('aria-pressed', String(!running));
    this.app?.classList.toggle('is-paused', this.paused);
  }

  setMusicPressed(on) {
    this.nodes.btnMusic?.setAttribute('aria-pressed', String(Boolean(on)));
  }

  hideOverlay() {
    this.nodes.overlay?.classList.add('is-hidden');
  }

  showOverlay() {
    this.nodes.overlay?.classList.remove('is-hidden');
  }

  // -------------------------------------------------------------------------
  // 自测：溢出与字号体检（?diag=1 时由 large-main.js 写入 body.dataset）
  // -------------------------------------------------------------------------
  measure() {
    const docEl = document.documentElement;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
        sw: node.scrollWidth, sh: node.scrollHeight,
      };
    };
    const overflow = [];
    const watch = {
      cityZh: this.nodes.cityZh,
      cityEn: this.nodes.cityEn,
      weatherRow: this.nodes.icon?.parentElement,
      tempRow: this.nodes.tempC?.closest('#lg-temp-row'),
      tempNote: this.nodes.noteZh?.closest('#lg-temp-note'),
      metaRow: this.nodes.timeZh?.closest('#lg-meta-row'),
      hudRow: this.nodes.progressText?.parentElement,
      dotRow: this.nodes.dots,
      stage: this.nodes.cityZh?.closest('#lg-stage'),
      hud: this.nodes.dots?.closest('#lg-hud'),
      panel: this.nodes.hint?.closest('.lg-start-panel'),
    };
    for (const [name, node] of Object.entries(watch)) {
      const r = rect(node);
      if (!r) continue;
      if (r.x < -1 || r.y < -1 || r.x + r.w > vw + 1 || r.y + r.h > vh + 1) {
        overflow.push({ name, ...r });
      }
    }
    return {
      viewport: { w: vw, h: vh },
      doc: {
        sw: docEl.scrollWidth, sh: docEl.scrollHeight,
        cw: docEl.clientWidth, ch: docEl.clientHeight,
      },
      body: { sw: document.body.scrollWidth, sh: document.body.scrollHeight },
      fonts: {
        cityZh: this.nodes.cityZh ? getComputedStyle(this.nodes.cityZh).fontSize : null,
        cityEn: this.nodes.cityEn ? getComputedStyle(this.nodes.cityEn).fontSize : null,
        temp: this.nodes.tempC ? getComputedStyle(this.nodes.tempC).fontSize : null,
        weatherZh: this.nodes.weatherZh ? getComputedStyle(this.nodes.weatherZh).fontSize : null,
        button: this.nodes.btnPlay ? getComputedStyle(this.nodes.btnPlay).width : null,
      },
      sizes: Object.fromEntries(Object.entries(watch).map(([k, n]) => [k, rect(n)])),
      overflow,
      weather: this.app?.dataset.weather ?? null,
      night: Boolean(this.app?.classList.contains('is-night')),
      imageState: this.imageState,
      credit: this.credit,
      assetsSource: this.assetsSource,
      iconSource: this.iconSource,
      degraded: this.degraded.slice(),
      index: this.index,
      total: this.total,
    };
  }
}

export { fallbackIconSvg, ICON_SPEC };
