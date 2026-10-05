// 静态一致性核查：不需要浏览器，把整个站点当作依赖图来体检。
//   - HTML 里引用的每个本地资源是否存在
//   - JS 里 import 的每个相对路径是否存在
//   - JS 通过 querySelector/getElementById 取的节点在 HTML 里是否真的存在（DOM 契约）
//   - CSS 括号是否配平、是否引用了不存在的本地资源
//
//   node tools/lint-site.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const problems = [];
const notes = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

function walk(dir, out = []) {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    // 临时抓取/探测目录不参与站点体检
    if (entry.name === '_probe' || entry.name === 'tmp' || entry.name === 'node_modules') continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const allFiles = walk('.');
// 测试过程产生的临时产物不参与体检
const IGNORE = [/^tools\/last-dom\.html$/, /^tools\/shots\//];
const keep = (f) => !IGNORE.some((re) => re.test(f));
const jsFiles = allFiles.filter((f) => keep(f) && (f.endsWith('.js') || f.endsWith('.mjs')));
const htmlFiles = allFiles.filter((f) => keep(f) && f.endsWith('.html'));
const cssFiles = allFiles.filter((f) => keep(f) && f.endsWith('.css'));

console.log(`扫描：${htmlFiles.length} 个 HTML，${jsFiles.length} 个 JS，${cssFiles.length} 个 CSS\n`);

// ------------------------------------------------------------------ 1. JS 依赖解析
console.log('[1] JS 模块依赖');
const unresolved = [];
for (const file of jsFiles) {
  const src = read(file);
  const dir = path.posix.dirname(file);
  const specs = [
    ...src.matchAll(/(?:^|\n)\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/g),
    ...src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g),
    ...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue; // 裸模块名（Node 内置等）跳过
    const target = path.posix.normalize(path.posix.join(dir, spec));
    if (!existsSync(path.join(ROOT, target))) unresolved.push(`${file} → ${spec}`);
  }
}
if (unresolved.length) unresolved.forEach((u) => fail('import', `无法解析 ${u}`));
console.log(`  ${unresolved.length === 0 ? '✓' : '✗'} 共 ${jsFiles.length} 个模块的相对导入全部可解析`);

// ------------------------------------------------------------------ 2. HTML 资源引用
console.log('\n[2] HTML 引用的本地资源');
for (const file of htmlFiles) {
  const src = read(file);
  const dir = path.posix.dirname(file);
  const refs = [
    ...src.matchAll(/<script[^>]+src=["']([^"']+)["']/g),
    ...src.matchAll(/<link[^>]+href=["']([^"']+)["']/g),
    ...src.matchAll(/<img[^>]+src=["']([^"']+)["']/g),
  ].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|data:|\/\/|#)/.test(ref)) continue;
    const target = path.posix.normalize(path.posix.join(dir, ref));
    if (!existsSync(path.join(ROOT, target))) fail(file, `引用了不存在的资源 ${ref}`);
  }
  console.log(`  ✓ ${file} 的 ${refs.length} 个本地引用已核对`);
}

// ------------------------------------------------------------------ 3. DOM 契约
console.log('\n[3] DOM 契约（JS 取的节点是否存在于 HTML）');
const htmlIds = new Map();
for (const file of htmlFiles) {
  const ids = new Set([...read(file).matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
  htmlIds.set(file, ids);
}
const entryHtml = 'index.html';
const entryIds = htmlIds.get(entryHtml) ?? new Set();
/** 哪些 JS 属于主页面（大屏版有自己的一套 DOM） */
const mainPageJs = jsFiles.filter(
  (f) => !f.includes('large') && f !== 'sw.js' && f !== 'tools/browser-check.mjs',
);
const seenSelectors = [];
for (const file of mainPageJs) {
  const src = read(file);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]/g)) {
    const sel = m[1];
    // ⚠ 只认真正的 id 选择器：`#` 必须出现在选择器开头，
    //   或紧跟在后代/兄弟组合符（空格 > + ~ ,）之后。
    //   早期写的是 /#([A-Za-z][\w-]*)/（取第一个 #），
    //   于是组合选择器 '#wr-loading .wr-fill' 会把 **class** `.wr-fill` 也当成 id，
    //   报出「找不到 #wr-fill」这种假问题（class 当然不在 HTML 的 id 清单里）。
    const idMatch = sel.match(/(?:^|[\s>+~,])#([A-Za-z][\w-]*)/);
    if (idMatch) {
      seenSelectors.push({ file, sel, id: idMatch[1] });
    }
  }
  // 模板字符串里动态拼的（getElementById + JSON.stringify）取不到字面量，这里只收字面量形式。
  // ⚠ 反引号也要认，否则用反引号写的 getElementById 会被漏掉。
  //   （别把反引号示例直接写进注释——正则的字符类会匹配到自己，这是自指陷阱。）
  const BT = String.fromCharCode(96);
  const getIdRe = new RegExp(`getElementById\\(\\s*['"${BT}]([^'"${BT}]+)['"${BT}]`, 'g');
  for (const m of src.matchAll(getIdRe)) {
    seenSelectors.push({ file, sel: `#${m[1]}`, id: m[1] });
  }
}
// 运行时动态创建、HTML 里刻意不写的节点：
//   error-overlay  —— boot.js 的错误浮层
//   status-text    —— 只有大屏版才有的可见状态栏
//   start-overlay / btn-start / start-hint —— 「进去就自动播报」后已从 HTML 删除，
//                     仅在浏览器拦截自动播放时由 main.js 的 ensureAutoplay() 动态生成
//   wr-loading     —— 毛玻璃加载界面，由 js/ui/loading.js 动态注入
//   wr-globe-style —— 3D 地球过场的样式表，由 js/ui/globe.js 动态注入
const RUNTIME_CREATED = new Set([
  'error-overlay', 'status-text', 'start-overlay', 'btn-start', 'start-hint',
  'wr-loading', 'wr-globe-style',
]);
const missingIds = seenSelectors.filter((s) => !entryIds.has(s.id) && !RUNTIME_CREATED.has(s.id));
if (missingIds.length) {
  for (const s of missingIds) fail(s.file, `selector "${s.sel}" 在 ${entryHtml} 里找不到 #${s.id}`);
}
console.log(
  `  ${missingIds.length === 0 ? '✓' : '✗'} 主页面 ${seenSelectors.length} 处 id 选择器全部命中`,
);

// index.html 必需的 id（极简版契约：满屏壁纸 + 居中大字两块 + 角落两个小按钮 + 隐藏状态位）
const REQUIRED = [
  'app', 'bg', 'bg-img-a', 'bg-img-b', 'bg-scene', 'card', 'city-zh', 'city-en',
  'now-block', 'weather-row', 'weather-icon', 'weather-zh', 'weather-en', 'temp-row', 'temp-c',
  'forecast-block', 'forecast-list',
  'btn-pause', 'btn-music', 'sr-only-status',
];
const lostIds = REQUIRED.filter((id) => !entryIds.has(id));
if (lostIds.length) lostIds.forEach((id) => fail(entryHtml, `缺少必需节点 #${id}`));
console.log(`  ${lostIds.length === 0 ? '✓' : '✗'} 极简版契约要求的 ${REQUIRED.length} 个 id 齐全`);

// 极简改版 + 「进去就自动播报」要求删掉的节点。
// start-overlay / btn-start 已从 HTML 移除：只在浏览器拦截自动播放时由 main.js 动态创建。
const MUST_BE_GONE = [
  'hud', 'progress-track', 'progress-fill', 'hud-row', 'progress-text', 'hud-buttons',
  'btn-prev', 'btn-play', 'btn-next', 'btn-shuffle', 'status-text',
  'meta-row', 'local-time', 'precip', 'wind', 'temp-f',
  'start-overlay', 'btn-start', 'start-hint',
];
const resurrected = MUST_BE_GONE.filter((id) => entryIds.has(id));
if (resurrected.length) {
  resurrected.forEach((id) => fail(entryHtml, `极简改版应删掉的 #${id} 又出现了（有人回退了？）`));
}
console.log(`  ${resurrected.length === 0 ? '✓' : '✗'} 极简改版要求移除的 ${MUST_BE_GONE.length} 个节点确实不存在`);

// ------------------------------------------------------------------ 4. CSS 体检
console.log('\n[4] CSS');
for (const file of cssFiles) {
  const src = read(file);
  const open = (src.match(/\{/g) ?? []).length;
  const close = (src.match(/\}/g) ?? []).length;
  if (open !== close) fail(file, `花括号不配平：{ ×${open} vs } ×${close}`);
  const refs = [...src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
  const dir = path.posix.dirname(file);
  for (const ref of refs) {
    if (/^(https?:|data:|#)/.test(ref)) continue;
    const target = path.posix.normalize(path.posix.join(dir, ref));
    if (!existsSync(path.join(ROOT, target))) fail(file, `url(${ref}) 指向不存在的文件`);
  }
  console.log(`  ✓ ${file}：${(src.length / 1024).toFixed(0)} KB，括号配平，${refs.length} 个 url() 已核对`);
}

// ------------------------------------------------------------------ 5. 主题键一致性
console.log('\n[5] 天气主题键一致性');
const css = read('style.css');
const constants = read('js/core/constants.js');
const iconKeys = [...constants.matchAll(/^\s{2}'?([a-z-]+)'?:\s*'[^']+',/gm)].map((m) => m[1]);
const wmo = JSON.parse(read('data/wmo-map.json'));
const usedIcons = new Set(Object.values(wmo.codes).map((c) => c.icon));
const themeMissing = [...usedIcons].filter(
  (k) => !new RegExp(`data-weather\\s*[=~|^$*]?=\\s*['"]${k}['"]`).test(css),
);
if (themeMissing.length) {
  notes.push(`style.css 里没有为这些天气主题单独定义样式（会走默认配色）：${themeMissing.join(', ')}`);
}
console.log(`  ✓ wmo-map 用到 ${usedIcons.size} 种图标；CSS 主题覆盖 ${usedIcons.size - themeMissing.length} 种`);

// ------------------------------------------------------------------ 6. Service Worker 清单
console.log('\n[6] Service Worker 预缓存清单');
const sw = read('sw.js');
const swAssets = [...sw.matchAll(/'(\.\/[^']+)'/g)].map((m) => m[1])
  .filter((p) => !p.startsWith('./assets/audio/zh'));
const swMissing = swAssets.filter((p) => {
  const rel = p.replace(/^\.\//, '');
  if (rel === '' || rel === './') return false;
  return !existsSync(path.join(ROOT, rel));
});
if (swMissing.length) swMissing.forEach((p) => fail('sw.js', `预缓存清单里的 ${p} 不存在`));
console.log(`  ${swMissing.length === 0 ? '✓' : '✗'} 预缓存 ${swAssets.length} 个条目全部存在`);

// ------------------------------------------------------------------ 汇总
console.log('\n' + '─'.repeat(60));
if (notes.length) {
  console.log('提示：');
  for (const n of notes) console.log(`  · ${n}`);
}
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\n全部静态检查通过 ✓');
