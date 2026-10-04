// 离线可用性验收：先在线跑一次让 Service Worker 装满缓存，再断网重载，验证页面照常工作。
//
//   node tools/e2e-offline.mjs
//
// 前置：python tools/serve.py -p 8099
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.WR_BASE ?? 'http://127.0.0.1:8099';
const TARGET = `${BASE}/index.html`;

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome，请设置 CHROME_PATH');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.failed = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push(msg.params.exceptionDetails?.exception?.description ?? '异常');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push((msg.params.args ?? []).map((a) => a.value ?? '').join(' '));
      }
      if (msg.method === 'Network.loadingFailed') {
        this.failed.push(`${msg.params.type} ${msg.params.errorText} ${msg.params.requestId}`);
      }
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expression, { timeoutMs = 40000, intervalMs = 250, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try { last = await this.eval(expression); if (last) return last; } catch (err) { last = err.message; }
      await sleep(intervalMs);
    }
    throw new Error(`等待超时：${label}（最后取值 ${JSON.stringify(last)}）`);
  }
}

const profile = mkdtempSync(path.join(tmpdir(), 'wr-offline-'));
const port = 9800 + Math.floor(Math.random() * 400);
const chromeProc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const cleanup = () => {
  try { chromeProc.kill(); } catch { /* 忽略 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
};
process.on('exit', cleanup);

console.log(`目标：${TARGET}`);
console.log('阶段 1：在线首次访问，等 Service Worker 安装并预缓存\n');

const deadline = Date.now() + 25000;
let wsUrl = null;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (res.ok) { wsUrl = (await res.json()).webSocketDebuggerUrl; break; }
  } catch { /* 等 */ }
  await sleep(300);
}
if (!wsUrl) { console.error('DevTools 未就绪'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', () => j(new Error('连接失败')), { once: true });
});
const browser = new CDP(ws);
const { targetId } = await browser.send('Target.createTarget', { url: TARGET });
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

const send = (method, params = {}, t) => {
  const id = ++browser.id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { browser.pending.delete(id); reject(new Error(`超时 ${method}`)); }, t ?? 30000);
    browser.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, { timeoutMs = 40000, label = expression } = {}) => {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await evaluate(expression); if (last) return last; } catch (err) { last = err.message; }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}（最后取值 ${JSON.stringify(last)}）`);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
// 注入错误/状态探针，随后 reload 使其生效
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__wrErrors = [];
    window.addEventListener('error', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
        window.__wrErrors.push('资源加载失败 <' + t.tagName + '> ' + (t.src || t.href));
      } else {
        window.__wrErrors.push('error: ' + (e.message || '空') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
      }
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      window.__wrErrors.push('unhandledrejection: ' + String((r && (r.stack || r.message)) || r).slice(0, 300));
    });
    window.__wrNavId = (window.__wrNavId ?? 0) + 1;
  })()`,
});
const reloadAndWait = async (label, timeoutMs = 40000) => {
  const before = await evaluate(`window.__wrNavId ?? 0`);
  await send('Page.reload', { ignoreCache: true });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const now = await evaluate(`window.__wrNavId ?? 0`);
      const rs = await evaluate(`document.readyState`);
      if (now > before && rs === 'complete') return true;
    } catch { /* 导航中求值会短暂失败，忽略 */ }
    await sleep(300);
  }
  throw new Error(`reload 未完成：${label}`);
};

await reloadAndWait('首次在线加载');
await waitFor(`document.getElementById('city-zh')?.textContent.trim().length > 0`, { label: '城市名渲染' });

// 等 SW 接管。注意：getRegistrations() 在部分无头环境会返回空，
// 所以以「核心缓存是否被 SW 装好」作为真正的判据（只有 SW install 才会填它）。
let swDiag = null;
let swState = false;
for (let i = 0; i < 60; i++) {
  swDiag = await evaluate(`(async () => {
    const out = { hasApi: 'serviceWorker' in navigator, controller: !!navigator.serviceWorker.controller };
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      out.hasReg = !!reg;
      out.active = reg?.active?.state ?? null;
    } catch (e) { out.err = String(e); }
    try {
      const names = await caches.keys();
      out.caches = {};
      for (const n of names) out.caches[n] = (await (await caches.open(n)).keys()).length;
    } catch (e) { out.cacheErr = String(e); }
    return out;
  })()`);
  const coreCount = swDiag?.caches?.['wr-core-v1'] ?? 0;
  if (coreCount >= 20) { swState = 'activated'; break; }
  await sleep(500);
}
if (swState !== 'activated') {
  console.log(`      诊断：${JSON.stringify(swDiag)}`);
  const errs = await evaluate(`(window.__wrErrors ?? []).slice(-6)`);
  if (errs?.length) for (const e of errs) console.log(`      页面错误 · ${String(e).slice(0, 220)}`);
}
check('Service Worker 已安装并完成核心预缓存', swState === 'activated',
  `wr-core-v1 = ${swDiag?.caches?.['wr-core-v1'] ?? 0} 项，controller=${swDiag?.controller}`);

// 等待缓存被填满
let inventory = { total: 0, core: 0, audio: 0, images: 0 };
for (let i = 0; i < 40; i++) {
  inventory = await evaluate(`(async () => {
    const names = await caches.keys();
    const out = { total: 0, core: 0, audio: 0, images: 0, names };
    for (const n of names) {
      const c = await caches.open(n);
      const keys = await c.keys();
      out.total += keys.length;
      if (n.includes('core')) out.core = keys.length;
      if (n.includes('audio')) out.audio = keys.length;
      if (n.includes('images')) out.images = keys.length;
    }
    return out;
  })()`);
  if (inventory.core >= 20) break;
  await sleep(500);
}
console.log(`      缓存分区：${inventory.names?.join(', ')}`);
check('核心资源已预缓存（≥20 项）', inventory.core >= 20, `${inventory.core} 项`);

// 再点一次开始，让语音与音乐进入缓存。
// Service Worker 在 boot() 开头就注册了，所以此时通常已经就绪。
await evaluate(`document.getElementById('btn-start').click()`);
await sleep(8000);
let afterAudio = 0;
for (let i = 0; i < 20; i++) {
  afterAudio = await evaluate(`(async () => {
    const names = await caches.keys();
    let total = 0;
    for (const n of names) {
      if (!n.includes('audio')) continue;
      total += (await (await caches.open(n)).keys()).length;
    }
    return total;
  })()`);
  if (afterAudio > 0) break;
  await sleep(700);
}
console.log(`      音频缓存：${afterAudio} 个片段（含背景音乐）`);

console.log('\n阶段 2：断网重载（模拟离线）\n');
await send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
try {
  await reloadAndWait('离线重载');
} catch (err) {
  console.log(`      ⚠ ${err.message}`);
}
await sleep(2500);

let offlineCity = '';
let offlineStatus = '';
try {
  offlineCity = await waitFor(
    `document.getElementById('city-zh')?.textContent.trim() ?? ''`,
    { timeoutMs: 25000, label: '离线时城市名渲染' },
  );
  offlineStatus = await evaluate(`document.getElementById('status-text')?.textContent.trim() ?? ''`);
} catch (err) {
  offlineCity = `（失败：${err.message}）`;
}
check('离线状态下页面仍能打开并渲染城市', offlineCity.length > 0 && !offlineCity.startsWith('（失败'),
  `城市="${offlineCity}"，状态="${offlineStatus}"`);

const offlineAssets = await evaluate(`(async () => {
  const probe = async (src) => {
    try { const r = await fetch(src, { cache: 'no-store' }); return r.ok; } catch { return false; }
  };
  return {
    css: await probe('style.css'),
    main: await probe('js/main.js'),
    cities: await probe('data/cities.json'),
    audioManifest: await probe('assets/audio/manifest.json'),
    // 音频走 SW 的 cache-first，即使 network 关闭也应命中
    musicHead: await probe('assets/audio/music/yuzhouchangwan.mp3'),
  };
})()`);
check('离线时核心资源仍可取回', Object.values(offlineAssets).every(Boolean),
  Object.entries(offlineAssets).map(([k, v]) => `${k}=${v ? 'ok' : 'fail'}`).join(' '));

// 离线状态下播放链路是否还能起来：真的点一次开始，看它能否靠缓存里的音频推进到下一座城市。
// 注意：不用 window.__wrAudio 判定 —— 那依赖 addScriptToEvaluateOnNewDocument 的探针，
// 在某些无头时序下不一定装上；「城市自动推进」是端到端行为，更可信。
const offlineBefore = await evaluate(`document.getElementById('city-zh')?.textContent.trim() ?? ''`);
const offlineStart = await evaluate(
  `(() => { const b = document.getElementById('btn-start'); if (!b) return false; b.click(); return true; })()`,
);
check('离线时「开始播报」按钮仍可点击', offlineStart === true);

let offlineAdvanced = false;
for (let i = 0; i < 60; i++) {
  const cur = await evaluate(`document.getElementById('city-zh')?.textContent.trim() ?? ''`);
  if (cur && cur !== offlineBefore) { offlineAdvanced = true; console.log(`      离线播报推进：${offlineBefore} → ${cur}`); break; }
  await sleep(700);
}
const offlineTimeline = await evaluate(`(window.__wrTimeline ?? []).slice(0, 6)`);
check('离线时播报链路仍能自动推进（音频来自缓存）', offlineAdvanced,
  offlineAdvanced ? '' : `城市停在 ${offlineBefore}`);
if (offlineTimeline.length) {
  console.log(`      离线播放片段：${offlineTimeline.map((x) => x.src).join(', ')}`);
}
const offlineVoice = await evaluate(`(async () => {
  // 直接从缓存里取一个语音片段，确认 SW 离线也能供上
  try {
    const res = await fetch('assets/audio/zh/city/beijing.mp3');
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, err: String(e) }; }
})()`);
check('离线时语音片段可从缓存取回', offlineVoice.ok === true,
  `HTTP ${offlineVoice.status ?? offlineVoice.err}`);

await send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});

console.log('\n' + '─'.repeat(60));
const failed = results.filter((r) => !r.ok);
console.log(`结果：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
cleanup();
process.exit(failed.length ? 1 : 0);
