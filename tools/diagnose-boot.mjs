// 现场诊断：用真实 Chrome 打开本地站点，抓「加载页卡住 / 无声音」的原因。
//
// 与 e2e.mjs 的区别：这个脚本不做断言，只把 boot 全过程的 console、
// 未捕获异常、网络失败、__wrDiag / __wrTimings 原样打出来，
// 用于对着用户描述的现象定位问题。
//
//   python tools/serve.py -p 8099
//   node tools/diagnose-boot.mjs                # 默认 8099
//   node tools/diagnose-boot.mjs 8098
//   node tools/diagnose-boot.mjs 8099 --autoplay-gesture   # 不放开自动播放策略，模拟"被拦截"
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.argv[2] || 8099);
const NO_AUTOPLAY_FLAG = process.argv.includes('--autoplay-gesture');
const URL_BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = path.resolve('tools/shots');
mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(path.join(tmpdir(), 'wr-diag-'));
const dbgPort = 9600 + Math.floor(Math.random() * 200);
const args = [
  '--headless=new',
  `--remote-debugging-port=${dbgPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1280,800',
  '--disable-features=Translate,MediaRouter',
  ...(NO_AUTOPLAY_FLAG ? [] : ['--autoplay-policy=no-user-gesture-required']),
  'about:blank',
];
const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (b) => { chromeErr += b.toString(); });

let wsUrl = null;
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!wsUrl) {
  console.error('✗ 连不上 Chrome 调试端口');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
});
let msgId = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// 先建 target 再挂事件，避免 addScriptToEvaluateOnNewDocument 与新导航竞争（踩过）
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) {
    return `EXC: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
  }
  return r.result.value;
};

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);

console.log(`\n打开 ${URL_BASE}/index.html`);
console.log(`自动播放策略：${NO_AUTOPLAY_FLAG ? '不放开（模拟被浏览器拦截）' : '放开'}\n`);
await send('Page.navigate', { url: `${URL_BASE}/index.html` }, sessionId);

// 观察 20 秒：加载页何时消失、何时开始出声
// --gesture-after=4 可提前模拟用户手势（用来专门验证「强制进入」按钮）
const GESTURE_AFTER = Number(
  (process.argv.find((a) => a.startsWith('--gesture-after=')) || '').split('=')[1] || 20,
);
const timeline = [];
let gestured = false;
let afterGesture = null;
const totalRounds = 40;
for (let i = 0; i < totalRounds; i++) {
  await sleep(500);
  const snap = await ev(`(() => {
    const app = document.getElementById('app');
    const loading = document.getElementById('wr-loading');
    const bar = document.querySelector('#wr-loading .wr-fill');
    // 「强制进入」是 class 不是 id（loading.js 里 skip.className = 'wr-skip'）
    const skip = document.querySelector('.wr-skip');
    return {
      loadingVisible: Boolean(loading) && !loading.hidden && getComputedStyle(loading).display !== 'none',
      barWidth: bar ? bar.style.width || getComputedStyle(bar).width : null,
      skipPresent: Boolean(skip),
      isPlaying: document.body.classList.contains('is-playing'),
      state: window.__wr ? window.__wr.state : null,
      hasOverlay: Boolean(document.getElementById('start-overlay')),
      cityZh: document.getElementById('city-zh')?.textContent?.trim() ?? null,
    };
  })()`);
  timeline.push(snap);

  // 到点后模拟用户手势
  if (!gestured && (i + 1) * 0.5 >= GESTURE_AFTER) {
    gestured = true;
    console.log(`⚠ ${GESTURE_AFTER}s 时模拟用户手势（优先点「强制进入」，没有就点解锁按钮）……`);
    const which = await ev(`(() => {
      const skip = document.querySelector('.wr-skip');
      if (skip && skip.offsetParent !== null) { skip.click(); return 'wr-skip(强制进入)'; }
      const start = document.getElementById('btn-start');
      if (start) { start.click(); return 'btn-start(点一下开始)'; }
      document.getElementById('app')?.click();
      return 'app 任意处';
    })()`);
    console.log(`   实际点的是：${which}`);
    await sleep(2500);
    afterGesture = await ev(`({
      isPlaying: document.body.classList.contains('is-playing'),
      state: window.__wr ? window.__wr.state : null,
      cityZh: document.getElementById('city-zh')?.textContent?.trim() ?? null,
      loadingVisible: (() => { const l = document.getElementById('wr-loading'); return Boolean(l) && !l.hidden; })(),
      overlayGone: !document.getElementById('start-overlay'),
      timings: window.__wrTimings ?? null,
      diag: window.__wrDiag ?? null,
    })`);
  }

  if (snap.isPlaying && snap.state?.playing && !snap.loadingVisible && !snap.hasOverlay) break;
}

const t = await ev(`({
  timings: window.__wrTimings ?? null,
  diag: window.__wrDiag ?? null,
  hasWr: typeof window.__wr === 'object',
  hasBegin: typeof window.__wr?.begin === 'function',
})`);

const consoleMsgs = events.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => ({
  type: e.params.type,
  text: e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
}));
const exceptions = events.filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
const failedReqs = events.filter((e) => e.method === 'Network.loadingFailed')
  .map((e) => `${e.params.type} ${e.params.errorText}${e.params.blockedReason ? ` (${e.params.blockedReason})` : ''}`);
const logEntries = events.filter((e) => e.method === 'Log.entryAdded')
  .map((e) => `[${e.params.entry.level}] ${e.params.entry.text}`);

console.log('── 加载过程时间线（每 0.5 秒）──');
const seen = new Set();
for (let i = 0; i < timeline.length; i++) {
  const s = timeline[i];
  const key = `${s.loadingVisible}|${s.barWidth}|${s.isPlaying}|${s.hasOverlay}|${s.cityZh}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  ${((i + 1) * 0.5).toFixed(1)}s  加载页=${s.loadingVisible ? '在' : '已收'}`
    + ` 进度条=${s.barWidth}  解锁遮罩=${s.hasOverlay ? '在' : '无'}`
    + ` 播放中=${s.isPlaying}  城市=${s.cityZh}`
    + ` state=${s.state ? JSON.stringify(s.state) : 'null'}`);
}

console.log('\n── __wrTimings / __wrDiag ──');
console.log(JSON.stringify(t, null, 2));
if (afterGesture) {
  console.log('\n── 用户手势之后 ──');
  console.log(JSON.stringify(afterGesture, null, 2));
}

console.log(`\n── console（${consoleMsgs.length} 条）──`);
for (const m of consoleMsgs.slice(-40)) console.log(`  [${m.type}] ${m.text}`);

if (exceptions.length) {
  console.log(`\n── 未捕获异常（${exceptions.length} 条）──`);
  for (const e of exceptions) console.log(`  ${e}`);
} else {
  console.log('\n── 未捕获异常：无 ──');
}

if (failedReqs.length) {
  console.log(`\n── 失败请求（${failedReqs.length} 条）──`);
  for (const r of [...new Set(failedReqs)].slice(0, 20)) console.log(`  ${r}`);
} else {
  console.log('── 失败请求：无 ──');
}

if (logEntries.length) {
  console.log(`\n── 浏览器日志（${logEntries.length} 条）──`);
  for (const l of [...new Set(logEntries)].slice(0, 20)) console.log(`  ${l}`);
}

// 截一张图，便于看加载页到底停在哪
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const file = path.join(SHOTS, 'diag-boot.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图：${path.relative(process.cwd(), file)}`);
} catch { /* 忽略 */ }

try { chrome.kill(); } catch { /* 忽略 */ }
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
if (chromeErr.includes('ERROR')) {
  const interesting = chromeErr.split('\n').filter((l) => !l.includes('update_service_dialer')).slice(0, 5);
  if (interesting.length) console.log(`\nChrome stderr：\n${interesting.join('\n')}`);
}
process.exit(0);
