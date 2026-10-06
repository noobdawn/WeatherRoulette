// 强制渲染一个「没有壁纸」的新增城市，用来检查首字插画兜底的观感。
//
// 为什么单独做：audit-image-coverage.mjs 已经能从数据层确认「100 个新增城市没有壁纸候选」，
// 但要**看**兜底长什么样，得让那个城市真的渲染到屏幕上。
// 靠反复 next() 去碰运气不可靠（会取消进行中的地球过场），
// 这里直接调 screen.renderCard() 把指定城市画出来。
//
//   python tools/serve.py -p 8099
//   node tools/preview-fallback-city.mjs 8099 三亚市
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8099);
// 城市名参数：data/cities.json 里的 zh 已统一去掉「市」后缀（是「桂林」不是「桂林市」），
// 所以两种写法都收（传「桂林市」时去掉后缀再匹配）。
const CITY_RAW = process.argv.slice(2).find((a) => !/^\d+$/.test(a) && !a.startsWith('--')) || '桂林';
const CITY = CITY_RAW.endsWith('市') ? CITY_RAW.slice(0, -1) : CITY_RAW;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT_DIR, { recursive: true });

const profile = mkdtempSync(path.join(tmpdir(), 'wr-fb-'));
const port = 9900 + Math.floor(Math.random() * 90);
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1440,900',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
  } catch { /* 等待 */ }
  await sleep(250);
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
});
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  }
});
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description };
  return r.result.value;
};

await send('Page.navigate', { url: `${BASE}/index.html` }, sessionId);
for (let i = 0; i < 120; i++) {
  await sleep(500);
  if (await ev(`Boolean(window.__wrTimings?.playingAt)`)) break;
}

console.log(`强制渲染「${CITY}」（该城在壁纸清单里没有条目，应走首字插画兜底）\n`);
const result = await ev(`(async () => {
  // ★ 必须先停掉播报器！否则它会在我们等待期间自动切到下一个城市，
  //   把手工渲染的结果覆盖掉 —— 上一版就是这样，截出来的是上一座城市
  //   （画面显示「宿迁市」、背景大字是「宿」，而我要看的是三亚）。
  window.__wr?.pause?.();

  const [{ Screen }, fmt, assets] = await Promise.all([
    import('/js/ui/screen.js'),
    import('/js/core/format.js'),
    import('/js/ui/assets.js'),
  ]);
  const raw = await (await fetch('./data/cities.json')).json();
  const cities = raw.cities ?? raw;
  const city = cities.find((c) => c.zh === ${JSON.stringify(CITY)});
  if (!city) return { error: '找不到城市 ' + ${JSON.stringify(CITY)} };
  const manifest = await assets.loadImageManifest();
  const cands = assets.resolveCityImage(city, manifest);
  const day = { code: 1, tMax: 27, tMin: 20, date: '2026-10-05' };
  const card = { city, day, dayIndex: 0, forecast: [{ code: 2, tMax: 28, tMin: 21, dayIndex: 1 },
                                                  { code: 3, tMax: 26, tMin: 20, dayIndex: 2 }] };
  const desc = fmt.describeCard(card);
  const screen = new Screen(document);
  screen.renderCard(desc, { city, imageUrls: cands.map((c) => c.url), dayIndex: 0, forecast: card.forecast });
  // 等背景兜底真的画上去（#applyImageQueue 是异步的，队列为空时才走 setBackgroundFallback）
  let sceneReady = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const sc = document.getElementById('bg-scene');
    if (sc && sc.classList.contains('is-fallback') && sc.dataset.char === city.zh.slice(0, 1)) {
      sceneReady = true;
      break;
    }
  }
  const scene = document.getElementById('bg-scene');
  const a = document.getElementById('bg-img-a');
  const b = document.getElementById('bg-img-b');
  return {
    city: city.zh,
    renderedCity: document.getElementById('city-zh')?.textContent?.trim() ?? '',
    candidates: cands.length,
    sceneReady,
    sceneVisible: Boolean(scene) && scene.classList.contains('is-fallback'),
    dataChar: scene?.dataset?.char ?? null,
    photoNatural: [a?.naturalWidth, b?.naturalWidth],
    textOn: document.getElementById('app')?.dataset?.textOn ?? null,
    scrollW: document.documentElement.scrollWidth,
    innerW: innerWidth,
    cityFs: getComputedStyle(document.getElementById('city-zh')).fontSize,
  };
})()`);
console.log(JSON.stringify(result, null, 2));

const s = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
const file = path.join(SHOT_DIR, `fallback-${CITY}.png`);
writeFileSync(file, Buffer.from(s.data, 'base64'));
console.log(`\n截图：${path.relative(ROOT, file)}`);

try { proc.kill(); } catch { /* 忽略 */ }
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(0);
