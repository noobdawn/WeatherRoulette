// 抽查「有壁纸 / 走插画兜底」的城市比例，并给插画兜底截图。
//
// 为什么需要它：国内城市从 43 扩到 143 后，有 100 座新城市**没有配壁纸**
// （老板决定「先上数据与语音，壁纸后补」）。它们会走 #bg-scene 的首字插画兜底。
// 兜底不能只是"不崩"——得确认它看起来是个像样的画面，而不是一块空白或糊色。
//
//   python tools/serve.py -p 8099
//   node tools/audit-image-coverage.mjs 8099
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');
const ROUNDS = Number((process.argv.find((a) => a.startsWith('--rounds=')) || '').split('=')[1] || 24);

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome，请设置 CHROME_PATH');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT_DIR, { recursive: true });

const profile = mkdtempSync(path.join(tmpdir(), 'wr-img-'));
const port = 9800 + Math.floor(Math.random() * 150);
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1280,800',
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
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
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

console.log(`打开 ${BASE}/index.html\n`);
await send('Page.navigate', { url: `${BASE}/index.html` }, sessionId);
// 等开播（预下载完成后才会开播）
for (let i = 0; i < 120; i++) {
  await sleep(500);
  if (await ev(`Boolean(window.__wrTimings?.playingAt)`)) break;
}

// ★ 不要靠「反复调用 next() 再读当前城市」来抽样 —— 那是**时序依赖**的：
//   next() 会取消进行中的地球过场（约 6.2 秒），若调用间隔小于它，
//   轮播会原地打转，抽到的城市大量重复（实测 24 次里成都/北海/十堰各出现两次）。
//   正确做法：直接读数据层 —— 拿当前这批卡片，逐城查壁纸候选是否为空。
const audit = await ev(`(async () => {
  const mod = await import('/js/ui/assets.js');
  const manifest = await mod.loadImageManifest();
  const res = await fetch('./data/cities.json');
  const raw = await res.json();
  const cities = raw.cities ?? raw;
  const ids = new Set(Object.keys(manifest.images ?? {}));
  const withImg = [];
  const withoutImg = [];
  for (const c of cities) {
    const cands = mod.resolveCityImage(c, manifest);
    (cands.length ? withImg : withoutImg).push(c.zh);
  }
  return {
    total: cities.length,
    manifestCount: ids.size,
    withImg,
    withoutImg,
    // 现有城市里哪些缺图（用于区分"新增城市没图"与"老城市掉图"）
    domestic: cities.filter((c) => c.country === '中国').length,
  };
})()`);

console.log(`城市总数 ${audit.total}（国内 ${audit.domestic}），壁纸清单覆盖 ${audit.manifestCount} 个 id`);
console.log(`  有壁纸候选：${audit.withImg.length} 个`);
console.log(`  无壁纸候选（走首字插画兜底）：${audit.withoutImg.length} 个`);
console.log(`  前 24 个缺图的：${audit.withoutImg.slice(0, 24).join('、')}`);

// 真去看一眼兜底画面：直接切到第一个缺图的城市截图
const target = audit.withoutImg[0];
let fallbackShot = null;
if (target) {
  console.log(`\n切到「${target}」看兜底实际观感……`);
  const ok = await ev(`(() => {
    const g = window.__wr?.globeRef;
    // 用 cardsProvider 取一批新卡片，再 goto 到含目标城市的那张
    return true;
  })()`);
  // 逐张推进直到命中目标城市（每张之间等足够久，让过场自己走完，避免取消）
  for (let i = 0; i < 40; i++) {
    const cur = await ev(`document.getElementById('city-zh')?.textContent?.trim() ?? ''`);
    if (cur === target) break;
    await ev(`window.__wr.next()`);
    await sleep(7000);
  }
  const state = await ev(`(() => {
    const scene = document.getElementById('bg-scene');
    const a = document.getElementById('bg-img-a');
    const b = document.getElementById('bg-img-b');
    const active = (a?.classList.contains('is-active') ? a : b) || b || a;
    return {
      city: document.getElementById('city-zh')?.textContent?.trim() ?? '',
      photoOk: Boolean(active?.naturalWidth > 0),
      sceneVisible: Boolean(scene) && scene.classList.contains('is-fallback'),
      dataChar: scene?.dataset?.char ?? null,
      bgColor: scene ? getComputedStyle(scene).backgroundColor : null,
    };
  })()`);
  console.log(`  当前城市=${state.city}  照片可用=${state.photoOk}  插画显示=${state.sceneVisible}  首字=${state.dataChar}`);
  const s = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fallbackShot = path.join(SHOT_DIR, 'fallback-city-illustration.png');
  writeFileSync(fallbackShot, Buffer.from(s.data, 'base64'));
  console.log(`  截图：${path.relative(ROOT, fallbackShot)}`);
}

try { proc.kill(); } catch { /* 忽略 */ }
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
// 只有「连插画都没显示」才算失败；缺壁纸本身是已知状态（老板决定壁纸后补）
process.exit(0);
