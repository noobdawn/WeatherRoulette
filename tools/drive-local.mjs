// 连到「已经打开的可见 Chrome」上操作，用户能实时看到每一步。
//
// 设计意图：这个脚本**不自己启动浏览器**，只连 tools/open-local-chrome.ps1 起的那个窗口。
// 每一步都先打印"我要做什么"，再执行；用户盯着浏览器就能看到点击、解锁、开播的全过程。
//
// 用法：
//   pwsh -File tools/open-local-chrome.ps1 -Port 8099            # 先起一个可见窗口
//   node tools/drive-local.mjs 8099                              # 再让脚本接管操作
//   node tools/drive-local.mjs 8099 --debug-port 9333
//
// 参数：
//   --debug-port=9333   调试端口（与 open-local-chrome.ps1 保持一致）
//   --observe-only      只观察不点击（看自然加载过程）
import { existsSync } from 'node:fs';

const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8099);
const DEBUG_PORT = Number(
  (process.argv.find((a) => a.startsWith('--debug-port=')) || '').split('=')[1] || 9333,
);
const OBSERVE_ONLY = process.argv.includes('--observe-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl = null;
try {
  const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
} catch { /* 下面报错 */ }
if (!wsUrl) {
  console.error(`✗ 连不上调试端口 ${DEBUG_PORT}。请先运行：`);
  console.error(`    pwsh -File tools/open-local-chrome.ps1 -Port ${PORT}`);
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
  } else if (m.method) events.push(m);
});
const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
  const i = ++msgId;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
});

// 找到页面 target（不是 service worker / 其他）
const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes(`:${PORT}`))
  || targets.find((t) => t.type === 'page');
if (!page) {
  console.error('✗ 没有找到页面 target');
  process.exit(1);
}
const { sessionId } = await send('Target.attachToTarget', { targetId: page.id, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};

const log = (...a) => console.log(...a);
const step = (n, what) => log(`\n▸ 第 ${n} 步：${what}`);

/**
 * 等某个条件的**每次变化**都记下来，而不是高频轮询 DOM。
 *
 * ⚠ 教训：早期版本每 150ms 发一次 CDP eval 去查 #wr-skip，结果把页面 JS 饿死
 * （LoadingScreen.show() 排在数据加载之后，被高频轮询挤到后面），
 * 于是"按钮从没出现过"，而事后它又明明在 —— 测量手段干扰了被测对象。
 * 现在改成：等间隔（默认 400ms）采样 + 让 MutationObserver 在页面内自己记时间线。
 */
async function waitForChange(expr, { timeoutMs = 25000, intervalMs = 400, label = expr } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const seen = [];
  while (Date.now() < deadline) {
    const v = await ev(expr);
    const key = JSON.stringify(v);
    if (key !== last) {
      last = key;
      seen.push({ at: new Date().toISOString().slice(11, 23), v });
      if (v === true) return { ok: true, seen };
    }
    await sleep(intervalMs);
  }
  return { ok: false, seen };
}

const state = async (label) => {
  const s = await ev(`({
    url: location.href,
    isPlaying: document.body.classList.contains('is-playing'),
    wr: window.__wr ? window.__wr.state : null,
    playingAt: window.__wrTimings?.playingAt ?? 0,
    preload: window.__wrTimings?.preload ?? null,
    decision: window.__wrDiag?.decision ?? null,
    why: window.__wrDiag?.why ?? null,
    city: document.getElementById('city-zh')?.textContent?.trim() || null,
    temp: document.getElementById('temp-c')?.textContent?.trim() || null,
    loadingPresent: Boolean(document.getElementById('wr-loading')),
    // 「强制进入」是 class 不是 id（loading.js 里 skip.className = 'wr-skip'）
    skipPresent: Boolean(document.querySelector('.wr-skip')),
    overlayPresent: Boolean(document.getElementById('start-overlay')),
    audioCreated: window.__wrAudio?.created ?? null,
    audioPlays: window.__wrAudio?.plays ?? null,
    globeMode: window.__wr?.globeRef?.rendererMode ?? null,
  })`);
  log(`  ${label}`);
  log(`    地址=${s.url}`);
  log(`    加载页=${s.loadingPresent ? (s.skipPresent ? '在（含强制进入按钮）' : '在') : '无'}`
    + `  解锁遮罩=${s.overlayPresent ? '在' : '无'}  播放中=${s.isPlaying}`);
  log(`    状态=${s.wr ? JSON.stringify(s.wr) : 'null'}  playingAt=${s.playingAt}`
    + `  预下载=${s.preload ? `${s.preload.done}/${s.preload.total}` : '无'}`);
  log(`    城市=${s.city ?? '（空）'}  温度=${s.temp ?? '（空）'}`
    + `  解锁判定=${s.decision ?? '无'}${s.why ? ` (${s.why})` : ''}`);
  log(`    音频元素=${s.audioCreated ?? 'n/a'}  播放事件=${s.audioPlays ?? 'n/a'}  地球渲染=${s.globeMode ?? 'n/a'}`);
  return s;
};

log('═'.repeat(70));
log('连上了！接下来的操作都会显示在这个浏览器窗口里，你可以直接看。');
log('═'.repeat(70));

// 埋探针并重新加载，保证统计从零开始。
// 注意 MutationObserver 必须等 document.documentElement 存在，否则会抛
// "parameter 1 is not of type 'Node'"（documentElement 在文档解析前是 null）。
step(1, '埋 Audio/DOM 探针，然后重新加载页面（请看着浏览器窗口）');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Orig = window.Audio;
    const stats = { created: 0, plays: 0, errors: [], srcs: [] };
    window.__wrAudio = stats;
    class Probed extends Orig {
      constructor(...a) {
        super(...a); stats.created++;
        this.addEventListener('play', () => {
          stats.plays++;
          try { stats.srcs.push((this.currentSrc || this.src).split('/').slice(-2).join('/')); } catch (e) {}
        });
        this.addEventListener('error', () => stats.errors.push('element error'));
      }
      play() {
        const p = super.play();
        if (p && p.catch) p.catch((e) => stats.errors.push('play() rejected: ' + e.name));
        return p;
      }
    }
    window.Audio = Probed;

    // DOM 时间线：记录加载页/强制进入/解锁遮罩的出现与消失
    window.__wrDomLog = [];
    window.__wrNavT0 = Date.now();
    const mark = (what) => window.__wrDomLog.push({
      t: Date.now() - window.__wrNavT0,
      what,
      snap: ['wr-loading', 'wr-skip', 'start-overlay']
        .map((id) => (document.getElementById(id) ? id : '-')).join('|'),
    });
    let lastSnap = null;
    const tick = () => {
      const snap = ['wr-loading', 'wr-skip', 'start-overlay']
        .map((id) => (document.getElementById(id) ? id : '-')).join('|');
      if (snap !== lastSnap) { lastSnap = snap; mark(snap); }
    };
    const startObserving = () => {
      tick();
      const mo = new MutationObserver(tick);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      setInterval(tick, 100);   // 兜底：MutationObserver 之外的时序也能记到
    };
    if (document.documentElement) startObserving();
    else document.addEventListener('readystatechange', function once() {
      if (document.documentElement) { document.removeEventListener('readystatechange', once); startObserving(); }
    });
  })()`,
}, sessionId);
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` }, sessionId);

const bootWatch = await waitForChange(
  // ⚠ 「强制进入」是 class 不是 id：loading.js 里 skip.className = 'wr-skip'
  `Boolean(document.querySelector('#wr-loading .wr-skip'))`,
  { timeoutMs: 30000, intervalMs: 150, label: '强制进入按钮出现' },
);
log(`  加载页/强制进入按钮出现：${bootWatch.ok ? '是' : '否（超时）'}`);
log(`  状态变化序列：${bootWatch.seen.map((x) => `${x.at}=${JSON.stringify(x.v)}`).join(' → ') || '（无）'}`);

if (bootWatch.ok) {
  step(2, '点「强制进入」按钮（请看着窗口）');
  const clicked = await ev(`(() => {
    const b = document.querySelector('#wr-loading .wr-skip');
    if (!b) return '按钮已消失';
    b.click();
    return 'ok';
  })()`);
  log(`  已点击：${clicked}`);
  await sleep(3000);
  const after = await state('点击「强制进入」后 3 秒：');
  log(`  >>> 结论：${after.isPlaying && after.wr?.playing ? '✓ 成功开播' : '✗ 仍然没有开播'}`);
} else {
  step(2, '没抓到「强制进入」，改为等自然开播');
  await sleep(6000);
  await state('等待 6 秒后：');
}

const domLog = await ev(`window.__wrDomLog ?? []`);
log('\n── DOM 时间线（wr-loading / wr-skip / start-overlay 的存在组合变化）──');
for (const e of domLog) log(`  ${String(e.t).padStart(5)}ms  ${e.what}`);

const logs = await ev(`(window.__wrLogs ?? []).slice(-15)`);
const errs = await ev(`(window.__wrErrors ?? []).slice(-10)`);
log('\n── 页面 console 告警/错误 ──');
for (const l of (Array.isArray(logs) ? logs : [])) log(`  ${l}`);
if (Array.isArray(errs) && errs.length) {
  log('── 未捕获错误 ──');
  for (const l of errs) log(`  ${l}`);
}

const consoleLines = events
  .filter((e) => e.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(e.params.type))
  .map((e) => `[${e.params.type}] ${e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
if (consoleLines.length) {
  log('\n── 浏览器侧 warn/error ──');
  for (const l of [...new Set(consoleLines)].slice(-15)) log(`  ${l}`);
}

const excLines = events.filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => String(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).split('\n')[0]);
if (excLines.length) {
  log('\n── 未捕获异常 ──');
  for (const l of [...new Set(excLines)].slice(-10)) log(`  ${l}`);
}

log('\n完成。浏览器窗口保持打开，你可以自己继续点。');
process.exit(0);
