// 天气图标：纯代码绘制的内联 SVG，零外部资源、零网络请求。
// 覆盖 js/core/constants.js 里 ICON_LABELS 的全部 13 个键。
//
// 对外接口（契约，勿改签名）：
//   renderWeatherIcon(iconKey, { size }) -> SVGSVGElement
//
// 关于动画：.wi-* 的 keyframes 由本模块自注入 <style>（只注入一次）。
// 这样任何页面（index.html + style.css、large.html + large.css）只要 import 本模块，
// 图标就自带「太阳光芒旋转 / 雨滴下落 / 雪花飘落 / 雷电闪烁」的轻微动画，
// 不依赖某个特定样式表，也不会和页面样式表里的 keyframes 重名打架。
//
// 动画元素的约定：**带动画的元素自身不能有 transform 属性**，
// 位移/缩放一律交给外层 <g transform="...">，CSS 动画只动内层元素，
// 并使用 transform-box: fill-box; transform-origin: center 保证旋转中心正确。

import { ICON_LABELS } from '../core/constants.js';

const NS = 'http://www.w3.org/2000/svg';

/** 13 个合法图标键（与 ICON_LABELS 一致，顺序固定便于自查） */
export const WEATHER_ICON_KEYS = Object.freeze([
  'sun', 'cloud-sun', 'cloud', 'fog',
  'rain-light', 'rain', 'rain-heavy', 'shower', 'thunder',
  'sleet', 'snow-light', 'snow', 'snow-heavy',
]);

const FALLBACK_KEY = 'cloud-sun';

/** 本地兜底标签：万一 constants.js 缺失也不至于读出 undefined */
const LOCAL_LABELS = Object.freeze({
  sun: '晴',
  'cloud-sun': '多云',
  cloud: '阴',
  fog: '有雾',
  'rain-light': '小雨',
  rain: '中雨',
  'rain-heavy': '大雨',
  shower: '阵雨',
  thunder: '雷阵雨',
  sleet: '雨夹雪',
  'snow-light': '小雪',
  snow: '中雪',
  'snow-heavy': '大雪',
});

/* ----------------------------------------------------------- 卡通配色 ---- */

const C = {
  sunBody: '#ffc93c',
  sunCore: '#ffdf6b',
  sunFace: '#8a4b00',
  cloud: '#ffffff',
  cloudShade: '#cfdcef',
  stormCloud: '#a9a3c9',
  stormShade: '#847dab',
  heavyCloud: '#c6d6ea',
  heavyShade: '#a2b6d0',
  rain: '#4aa3f0',
  rainDeep: '#2f7fd0',
  sleet: '#8fd0f5',
  snow: '#cfe9ff',
  bolt: '#ffd54a',
  boltEdge: '#f0a800',
  fog: '#e8f2f8',
  ground: 'rgba(6, 12, 30, 0.16)',
};

/* ------------------------------------------------------------- 零件 ------ */

/** 云朵：先用「下沉 4px 的深色版」打底，再画白色版，得到一条卡通描边感 */
function cloud({ x = 50, y = 50, s = 1, body = C.cloud, shade = C.cloudShade, shadow = true } = {}) {
  const puffs = [[-18, 0, 13], [-6, -8, 16], [11, -2, 15], [21, 3, 11]];
  const circles = (dy, fill) =>
    puffs.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy + dy}" r="${r}" fill="${fill}"/>`).join('');
  const base = (dy, fill) =>
    `<rect x="-31" y="${-2 + dy}" width="62" height="20" rx="10" fill="${fill}"/>`;

  return `<g transform="translate(${x} ${y}) scale(${s})">
    ${shadow ? `<ellipse cx="0" cy="23" rx="29" ry="4" fill="${C.ground}"/>` : ''}
    <g class="wi-cloud">
      ${circles(4, shade)}${base(4, shade)}
      ${circles(0, body)}${base(0, body)}
    </g>
  </g>`;
}

/** 太阳：光芒（整组旋转）+ 圆盘（呼吸）+ 笑脸（4~6 岁孩子更爱看） */
function sun({ x = 50, y = 50, r = 20, s = 1, face = true, body = C.sunBody, core = C.sunCore } = {}) {
  // 光芒外沿 = r + 16，保证任意摆位都不越出 0~100 的 viewBox
  let rays = '';
  for (let i = 0; i < 8; i++) {
    rays += `<rect x="-3" y="${-(r + 6)}" width="6" height="10" rx="3" fill="${body}" transform="rotate(${i * 45})"/>`;
  }
  const smile = face
    ? `<circle cx="-6.5" cy="-3" r="2.5" fill="${C.sunFace}"/>
       <circle cx="6.5" cy="-3" r="2.5" fill="${C.sunFace}"/>
       <path d="M-7.5 4.5 Q0 12 7.5 4.5" fill="none" stroke="${C.sunFace}" stroke-width="2.6" stroke-linecap="round"/>`
    : '';

  return `<g transform="translate(${x} ${y}) scale(${s})">
    <g class="wi-sun-body">
      <g class="wi-rays">${rays}</g>
      <g class="wi-sun-core">
        <circle cx="0" cy="0" r="${r}" fill="${body}"/>
        <circle cx="0" cy="0" r="${r * 0.66}" fill="${core}"/>
        ${smile}
      </g>
    </g>
  </g>`;
}

/** 雨滴（水滴形，下落动画） */
function drop(x, y, s = 1, color = C.rain, delay = 0) {
  const d = 'M0 -9.5 C 4.3 -3.4 6.6 1 6.6 4.4 A 6.6 6.6 0 0 1 -6.6 4.4 C -6.6 1 -4.3 -3.4 0 -9.5 Z';
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path class="wi-drop" style="animation-delay:${delay}s" d="${d}" fill="${color}"/>
  </g>`;
}

/** 雪花（六角，飘落 + 自转） */
function flake(x, y, r = 5.4, color = C.snow, delay = 0) {
  const spokes = [0, 60, 120]
    .map((a) => `<line x1="${-r}" y1="0" x2="${r}" y2="0" stroke="${color}" stroke-width="${Math.max(2, r * 0.44)}" stroke-linecap="round" transform="rotate(${a})"/>`)
    .join('');
  return `<g transform="translate(${x} ${y})">
    <g class="wi-flake" style="animation-delay:${delay}s">${spokes}</g>
  </g>`;
}

/** 闪电（闪烁） */
function bolt(x = 0, y = 0, s = 1, delay = 0) {
  const d = 'M54 40 L39.5 68 L49 68 L43 90 L63.5 60 L52.5 60 L59.5 40 Z';
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <path class="wi-bolt" style="animation-delay:${delay}s" d="${d}"
          fill="${C.bolt}" stroke="${C.boltEdge}" stroke-width="2.4" stroke-linejoin="round"/>
  </g>`;
}

/** 雾线（左右漂移） */
function fogLines(rows = [[24, 48, 52], [16, 58, 68], [30, 68, 42], [21, 78, 58]]) {
  return rows
    .map(([x, y, w], i) => `<rect class="wi-fog-line" style="animation-delay:${(i * 0.45).toFixed(2)}s"
      x="${x}" y="${y}" width="${w}" height="7.5" rx="3.75" fill="${C.fog}" opacity="${(0.95 - i * 0.09).toFixed(2)}"/>`)
    .join('');
}

/* -------------------------------------------------------- 13 个图标 ------ */

const BUILDERS = {
  /* 1. 晴 */
  sun: () => sun({ x: 50, y: 50, r: 21, s: 1 }),

  /* 2. 多云：太阳躲在云后 */
  'cloud-sun': () =>
    sun({ x: 66, y: 32, r: 13.5, s: 1, face: false }) +
    cloud({ x: 45, y: 60, s: 0.86 }),

  /* 3. 阴 */
  cloud: () => cloud({ x: 50, y: 52, s: 1.12 }),

  /* 4. 有雾 */
  fog: () => cloud({ x: 50, y: 28, s: 0.78, shadow: false }) + fogLines(),

  /* 5. 小雨 */
  'rain-light': () =>
    cloud({ x: 50, y: 44, s: 0.94 }) +
    drop(38, 76, 0.85, C.rain, -0.15) +
    drop(62, 80, 0.85, C.rainDeep, -0.7),

  /* 6. 中雨 */
  rain: () =>
    cloud({ x: 50, y: 42, s: 0.98 }) +
    drop(32, 74, 0.95, C.rain, -0.1) +
    drop(46, 80, 0.95, C.rainDeep, -0.45) +
    drop(60, 74, 0.95, C.rain, -0.8) +
    drop(72, 80, 0.95, C.rainDeep, -1.15),

  /* 7. 大雨 */
  'rain-heavy': () =>
    cloud({ x: 50, y: 40, s: 1.02, body: C.heavyCloud, shade: C.heavyShade }) +
    drop(26, 72, 1.05, C.rain, -0.05) +
    drop(38, 79, 1.05, C.rainDeep, -0.3) +
    drop(50, 72, 1.05, C.rain, -0.55) +
    drop(62, 79, 1.05, C.rainDeep, -0.8) +
    drop(74, 72, 1.05, C.rain, -1.05) +
    drop(84, 79, 0.9, C.rainDeep, -1.3),

  /* 8. 阵雨：太阳 + 云 + 雨 */
  shower: () =>
    sun({ x: 30, y: 28, r: 11.5, face: false }) +
    cloud({ x: 52, y: 46, s: 0.92 }) +
    drop(36, 78, 0.92, C.rain, -0.2) +
    drop(50, 82, 0.92, C.rainDeep, -0.55) +
    drop(64, 78, 0.92, C.rain, -0.9) +
    drop(76, 82, 0.8, C.rainDeep, -1.25),

  /* 9. 雷阵雨：暗云 + 闪电 + 雨 */
  thunder: () =>
    cloud({ x: 50, y: 40, s: 1.0, body: C.stormCloud, shade: C.stormShade }) +
    drop(30, 70, 0.85, C.rainDeep, -0.3) +
    drop(74, 70, 0.85, C.rainDeep, -0.9) +
    bolt(0, 0, 1),

  /* 10. 雨夹雪 */
  sleet: () =>
    cloud({ x: 50, y: 40, s: 0.96 }) +
    drop(34, 74, 0.88, C.rain, -0.1) +
    drop(48, 79, 0.88, C.rainDeep, -0.5) +
    flake(64, 76, 5.2, C.sleet, -0.3) +
    flake(78, 82, 4.4, C.sleet, -1.1),

  /* 11. 小雪 */
  'snow-light': () =>
    cloud({ x: 50, y: 42, s: 0.96 }) +
    flake(34, 74, 4.8, C.snow, -0.2) +
    flake(52, 80, 5.4, C.snow, -1.1) +
    flake(70, 74, 4.8, C.snow, -2.0),

  /* 12. 中雪 */
  snow: () =>
    cloud({ x: 50, y: 40, s: 1.0 }) +
    flake(28, 72, 4.8, C.snow, -0.2) +
    flake(44, 79, 5.6, C.snow, -0.8) +
    flake(58, 71, 5.0, C.snow, -1.4) +
    flake(72, 78, 5.4, C.snow, -2.0) +
    flake(84, 70, 4.2, C.snow, -2.6),

  /* 13. 大雪 */
  'snow-heavy': () =>
    cloud({ x: 50, y: 38, s: 1.04, body: C.heavyCloud, shade: C.heavyShade }) +
    flake(22, 70, 5.0, C.snow, -0.1) +
    flake(35, 79, 5.8, C.snow, -0.6) +
    flake(48, 70, 5.2, C.snow, -1.1) +
    flake(61, 79, 5.8, C.snow, -1.6) +
    flake(74, 70, 5.0, C.snow, -2.1) +
    flake(85, 79, 4.6, C.snow, -2.6) +
    flake(28, 88, 4.2, C.snow, -3.1),
};

/* ---------------------------------------------------------- 样式注入 ---- */

const STYLE_ID = 'wi-css';
const ICON_CSS = `
.wi { display: block; width: 100%; height: 100%; overflow: visible; }
.wi .wi-rays,
.wi .wi-sun-core,
.wi .wi-flake { transform-box: fill-box; transform-origin: center; }
.wi .wi-rays      { animation: wi-spin 20s linear infinite; }
.wi .wi-sun-core  { animation: wi-sun-pulse 3.6s ease-in-out infinite; }
.wi .wi-cloud     { animation: wi-float 6.4s ease-in-out infinite; }
.wi .wi-drop      { animation: wi-fall 1.15s linear infinite; }
.wi .wi-flake     { animation: wi-snow 4.4s ease-in-out infinite; }
.wi .wi-bolt      { animation: wi-flash 2.8s steps(1, end) infinite; }
.wi .wi-fog-line  { animation: wi-fog 5.6s ease-in-out infinite; }
@keyframes wi-spin      { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes wi-sun-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.055); } }
@keyframes wi-float     { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.6px); } }
@keyframes wi-fall {
  0%   { transform: translateY(-7px); opacity: 0; }
  18%  { opacity: 1; }
  76%  { opacity: 1; }
  100% { transform: translateY(14px); opacity: 0; }
}
@keyframes wi-snow {
  0%   { transform: translateY(-6px) rotate(0deg); opacity: 0; }
  16%  { opacity: 1; }
  78%  { opacity: 1; }
  100% { transform: translateY(15px) rotate(170deg); opacity: 0; }
}
@keyframes wi-flash {
  0%, 34%, 100% { opacity: 0.96; }
  36%  { opacity: 0.18; }
  38%  { opacity: 1; }
  42%  { opacity: 0.32; }
  44%  { opacity: 1; }
}
@keyframes wi-fog {
  0%, 100% { transform: translateX(-4.5px); opacity: 0.5; }
  50%      { transform: translateX(4.5px);  opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .wi .wi-rays, .wi .wi-sun-core, .wi .wi-cloud,
  .wi .wi-drop, .wi .wi-flake, .wi .wi-bolt, .wi .wi-fog-line { animation: none !important; }
}
`;

/** 注入图标 keyframes（幂等，只注入一次） */
export function injectWeatherIconStyles(doc = document) {
  if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = ICON_CSS;
  doc.head.append(style);
}

/* ------------------------------------------------------------ 主入口 ---- */

/** 把任意输入归一化到 13 个合法键之一 */
export function normalizeIconKey(iconKey) {
  const key = String(iconKey ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(BUILDERS, key) ? key : FALLBACK_KEY;
}

/**
 * 渲染天气图标。
 * @param {string} iconKey 13 个键之一；不认识时降级为 cloud-sun，不抛错
 * @param {{size?: number|string}} [options] size 传数字按 px 处理，传字符串按 CSS 长度处理
 * @returns {SVGSVGElement} 可直接 append 的内联 SVG
 */
export function renderWeatherIcon(iconKey, { size } = {}) {
  const key = normalizeIconKey(iconKey);
  const label = ICON_LABELS?.[key] || LOCAL_LABELS[key] || '天气';

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', `wi wi-${key}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.dataset.icon = key;

  try {
    svg.innerHTML = BUILDERS[key]();
  } catch (err) {
    // 极老浏览器不支持在 SVG 元素上 innerHTML 时的兜底：至少给一个圆，绝不空白
    console.warn('[weather-icon] innerHTML 绘制失败，降级为简单图形', err);
    const fallback = document.createElementNS(NS, 'circle');
    fallback.setAttribute('cx', '50');
    fallback.setAttribute('cy', '50');
    fallback.setAttribute('r', '30');
    fallback.setAttribute('fill', C.sunBody);
    svg.append(fallback);
  }

  if (size != null && size !== '') {
    const css = typeof size === 'number' ? `${size}px` : String(size);
    svg.style.width = css;
    svg.style.height = css;
  }

  injectWeatherIconStyles();
  return svg;
}

export default renderWeatherIcon;
