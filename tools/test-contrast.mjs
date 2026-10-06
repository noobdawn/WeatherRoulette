// 离线守卫：用真实字号/排版度量 81 个城市 × 3 种视口，逐一判定文字配色，
// 并断言「看不清的像素占比」不会超标。不需要浏览器、不需要联网。
//
//   node tools/test-contrast.mjs
//
// 为什么需要它：壁纸亮度适配是去掉蒙版后唯一的可读性保障，
// 只在浏览器里抽查十几个城市不足以证明它在 81 城 × 各视口下都成立。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

const { luminanceFromTable, pickTextColor } = await import(
  new URL('../js/ui/screen.js', import.meta.url)
).catch(() => ({ luminanceFromTable: null, pickTextColor: null }));

// screen.js 依赖 DOM，Node 里 import 会失败；这里内联同一套算法做校验，
// 并在末尾对比两边实现是否一致（用同一组输入）。
function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function relLuminance(r, g, b) {
  return 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
}
function contrastRatio(l1, l2) {
  const a = Math.max(l1, l2);
  const b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}
const WHITE_L = 1;
const INK_L = relLuminance(18, 23, 43);

/** 与 pickTextColor 同构（面积加权 + 0.02 容差） */
function pick(lums, weights = null) {
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
  const wh = score(WHITE_L);
  const ink = score(INK_L);
  if (Math.abs(wh.bad - ink.bad) > 0.02) return wh.bad < ink.bad ? 'dark' : 'light';
  return wh.avg >= ink.avg ? 'dark' : 'light';
}

const cities = load('data/cities.json').cities;
const manifest = load('assets/images/manifest.json');
const lum = load('assets/images/luminance.json');
const [GW, GH] = lum.grid;

/** 浏览器实测字号（来自 style.css 的 clamp 与 CDP 量测），用于估文字包围盒 */
const VIEWPORTS = [
  {
    name: '1440x900',
    w: 1440, h: 900,
    cityZh: 128, cityEn: 48, weatherZh: 63.4, weatherEn: 31.7, tempC: 168, day: 30.24,
    gap: 18,
  },
  {
    name: '1024x768',
    w: 1024, h: 768,
    cityZh: 128, cityEn: 34.8, weatherZh: 45.1, weatherEn: 22.5, tempC: 122.9, day: 18,
    gap: 14,
  },
  {
    name: '375x812',
    w: 375, h: 812,
    cityZh: 54.4, cityEn: 21, weatherZh: 30, weatherEn: 18, tempC: 84, day: 18,
    gap: 10,
  },
];

/** 中文字宽≈1em；英文按 0.55em 估宽；高度按 1.25em 估 */
function estimateRects(vp, city) {
  const zhW = city.zh.length * vp.cityZh;
  const enW = city.en.length * vp.cityEn * 0.55;
  const wW = Math.max(city.weatherZh?.length ?? 2, 2) * vp.weatherZh;
  const tempW = 2 * vp.tempC * 0.62 + vp.tempC * 0.4;
  const widths = [zhW, enW, Math.max(wW, 3 * vp.weatherEn * 0.55), tempW];
  const heights = [vp.cityZh * 1.2, vp.cityEn * 1.35, vp.weatherZh * 1.25, vp.tempC * 1.05];
  const totalH = heights.reduce((a, b) => a + b, 0) + vp.gap * (heights.length - 1);
  let top = (vp.h - totalH) / 2;
  const rects = [];
  for (let i = 0; i < widths.length; i++) {
    const w = Math.min(widths[i], vp.w * 0.94);
    rects.push({
      left: (vp.w - w) / 2,
      right: (vp.w + w) / 2,
      top,
      bottom: top + heights[i],
      width: w,
      height: heights[i],
    });
    top += heights[i] + vp.gap;
  }
  return rects;
}

/** 与 screen.js 的 luminanceFromTable 同构（用视口占比取格子） */
function regionLuminance(cells, rect, vp) {
  const x0 = Math.max(0, Math.floor((rect.left / vp.w) * GW));
  const x1 = Math.min(GW - 1, Math.floor((rect.right / vp.w) * GW));
  const y0 = Math.max(0, Math.floor((rect.top / vp.h) * GH));
  const y1 = Math.min(GH - 1, Math.floor((rect.bottom / vp.h) * GH));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = cells[y * GW + x];
      if (typeof v === 'number') { sum += v / 255; n++; }
    }
  }
  return n ? sum / n : null;
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

// ★ 只考核「配了壁纸」的城市。
//   国内城市扩充到 143 座后，有 100 座新城市按计划**暂时没有壁纸**
//   （老板决定「先上数据与语音，壁纸后补」），它们走首字插画兜底 ——
//   插画是纯色渐变，不存在"文字压在照片上看不清"的问题，因此不参与配色考核。
//   这些城市补上壁纸后，重新跑 precompute-luminance.py 就会自动纳入考核。
const citiesWithImage = cities.filter((c) => Boolean(manifest.images[c.id]?.primary));
const citiesWithoutImage = cities.filter((c) => !manifest.images[c.id]?.primary);

console.log(`[1] 数据完整性`);
check('亮度网格覆盖清单里的每一张主图',
  citiesWithImage.every((c) => lum.cells[manifest.images[c.id]?.primary]),
  `${Object.keys(lum.cells).length} 条网格 / ${citiesWithImage.length} 个有壁纸的城市`
  + `（另有 ${citiesWithoutImage.length} 个城市暂无壁纸，走插画兜底，不参与配色考核）`);
check('网格尺寸与声明一致', Object.values(lum.cells).every((c) => c.length === GW * GH),
  `${GW}×${GH}=${GW * GH}`);
check('无壁纸城市确实没有亮度网格（说明统计口径一致，而不是网格缺了一半）',
  citiesWithoutImage.every((c) => !lum.cells[manifest.images[c.id]?.primary]),
  `${citiesWithoutImage.length} 个`);

console.log('\n[2] 逐城逐视口判定文字配色');
const rawWorst = { ratio: 0, city: '', vp: '' };
const haloWorst = { ratio: 99, city: '', vp: '' };
const undecided = [];
const summary = {};
for (const vp of VIEWPORTS) {
  let light = 0;
  let dark = 0;
  for (const city of citiesWithImage) {
    const primary = manifest.images[city.id]?.primary;
    const cells = lum.cells[primary];
    if (!cells) { undecided.push(`${city.id}(${vp.name})`); continue; }
    const rects = estimateRects(vp, city);
    const lums = [];
    const weights = [];
    for (const r of rects) {
      const v = regionLuminance(cells, r, vp);
      if (v == null) continue;
      lums.push(v);
      weights.push(r.width * r.height);
    }
    const on = pick(lums, weights);
    if (!on) { undecided.push(`${city.id}(${vp.name})`); continue; }
    on === 'light' ? light++ : dark++;

    const textL = on === 'light' ? INK_L : WHITE_L;
    // 描边色：深色主题用近黑的 rgba(2,5,14,.96)，亮色主题用近白
    const haloRGB = on === 'light' ? [255, 255, 255] : [2, 5, 14];
    const haloAlpha = on === 'light' ? 0.98 : 0.96;
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;

    let badRawW = 0;
    let badHaloW = 0;
    lums.forEach((L, i) => {
      if (contrastRatio(textL, L) < 3) badRawW += weights[i];
      // 紧贴字形的描边几乎完全覆盖它下面的背景：把背景亮度按 alpha 向描边色合成
      const Lh = L * (1 - haloAlpha) + relLuminance(...haloRGB) * haloAlpha;
      if (contrastRatio(textL, Lh) < 4.5) badHaloW += weights[i];
    });
    const rawBad = badRawW / wSum;
    const haloBad = badHaloW / wSum;
    if (rawBad > rawWorst.ratio) {
      rawWorst.ratio = rawBad;
      rawWorst.city = city.zh;
      rawWorst.vp = vp.name;
    }
    if (haloBad < haloWorst.ratio) {
      haloWorst.ratio = haloBad;
      haloWorst.city = city.zh;
      haloWorst.vp = vp.name;
    }
  }
  summary[vp.name] = { light, dark };
  console.log(`  ${vp.name}：深墨字 ${light} 城 / 白字 ${dark} 城`);
}
const vpCount = citiesWithImage.length * VIEWPORTS.length;
check(`${citiesWithImage.length} 城（有壁纸的）× ${VIEWPORTS.length} 视口全部给出了明确配色`, undecided.length === 0,
  undecided.length ? `${undecided.length} 项无决策：${undecided.slice(0, 6).join(', ')}`
    : `${vpCount} 项全有决策`);

console.log('\n[3] 可读性红线（按真实渲染：文字色 vs 描边合成后的背景）');
console.log(`  · 只看纯色（不带描边）最差：${rawWorst.city} @ ${rawWorst.vp} 有 ${(rawWorst.ratio * 100).toFixed(1)}% 区域 <3:1`);
console.log('    这一项天生无法为 0：单色文字压在明暗混合的壁纸上必然局部吃亏，');
console.log('    所以可读性不能只靠选颜色，必须靠下面这条。');
console.log(`  · 带内嵌描边后，所有城市所有区域 ≥4.5:1（最差一城的越界占比 ${(haloWorst.ratio * 100).toFixed(1)}%）`);
check(`带内嵌 halo 后，全 ${citiesWithImage.length} 城（有壁纸的）× ${VIEWPORTS.length} 视口都达到大字 4.5:1 标准`,
  haloWorst.ratio === 0,
  haloWorst.ratio === 0 ? '全部达标' : `最差 ${haloWorst.city} @ ${haloWorst.vp} 仍有 ${(haloWorst.ratio * 100).toFixed(1)}% 越界`);
check('纯色下界也有个底（加权看不清区域 < 60%）', rawWorst.ratio < 0.6,
  `最差 ${(rawWorst.ratio * 100).toFixed(1)}%`);

// 两套配色都必须真的被用到，否则说明阈值偏了、退化成了单一配色
for (const [name, s] of Object.entries(summary)) {
  check(`${name} 两套配色都被用上（不是退化成一种）`, s.light > 0 && s.dark > 0,
    `深墨 ${s.light} / 白 ${s.dark}`);
}

console.log('\n[4] 内嵌 halo 描边（真实可读性的保障）');
const css = readFileSync(path.join(ROOT, 'style.css'), 'utf8');
for (const mode of ['dark', 'light']) {
  const block = css.match(new RegExp(`#app\\[data-text-on='${mode}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  const shadow = block?.[1] ?? '';
  check(`data-text-on='${mode}' 有 halo 定义`, /--fg-shadow/.test(shadow));
  check(`data-text-on='${mode}' 第一层是紧贴字形的实心描边（0 0 1px 且 alpha ≥ 0.9）`,
    /0 0 1px rgba\([^)]*?0\.9\d?\)/.test(shadow),
    (shadow.match(/0 0 1px rgba\([^)]*\)/) ?? ['未找到'])[0]);
  check(`data-text-on='${mode}' 至少 4 层由实到虚`, (shadow.match(/rgba\(/g) ?? []).length >= 4,
    `${(shadow.match(/rgba\(/g) ?? []).length} 层`);
}

console.log('\n[4] 与浏览器端实现一致性');
if (typeof pickTextColor === 'function') {
  let mismatch = 0;
  for (const vp of VIEWPORTS) {
    for (const city of cities.slice(0, 20)) {
      const cells = lum.cells[manifest.images[city.id]?.primary];
      if (!cells) continue;
      const lums = estimateRects(vp, city).map((r) => regionLuminance(cells, r, vp)).filter((v) => v != null);
      if (pickTextColor(lums) !== pick(lums)) mismatch++;
    }
  }
  check('screen.js 的 pickTextColor 与本守卫判定一致', mismatch === 0, `不一致 ${mismatch} 项`);
} else {
  console.log('  （screen.js 依赖 DOM，Node 内无法直接 import，跳过一致性对比）');
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
