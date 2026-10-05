// 「自动播放被浏览器拦截」这条路径的回归测试。
//
// 为什么单独一个文件：
//   tools/e2e.mjs 启动 Chrome 时带了 `--autoplay-policy=no-user-gesture-required`
//   （无头环境没有真实手势，为了让主链路能跑通），所以它**永远走不到解锁路径**。
//   结果就是一个致命 bug 溜过了全部 52 项断言：
//     ensureAutoplay() 里 showUnlock() 一进来就把 settled 置为 true，
//     而 finish() 开头是 `if (settled) return` —— 用户点「点一下开始」/「强制进入」
//     时 finish() 被当成重复调用丢弃，onReady()（= beginBroadcast）永不执行。
//   现象：进度条走到头没反应，点了也没声音（实测 playingAt=0、state.playing=false）。
//
// 这个脚本**故意不带那个 flag**，让浏览器真的拦截自动播放，然后分别验证三条解锁路径：
//   A. 加载页上的「强制进入」按钮（skipGate）
//   B. 解锁遮罩上的「点一下开始」按钮
//   C. 点页面任意处（armAnyGesture 兜底）
// 每条都必须真正进入播放态，并且真的开始出声。
//
// 用法：
//   python tools/serve.py -p 8099
//   node tools/e2e-unlock.mjs                # 默认 8099
//   node tools/e2e-unlock.mjs 8099 --keep-shots
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8099);
const KEEP_SHOTS = process.argv.includes('--keep-shots');
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome/Edge，请设置 CHROME_PATH');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
let shots = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
}

/** 起一个全新 Chrome（不带 autoplay 放宽 flag），返回会话操作句柄 */
async function startBrowser() {
  const profile = mkdtempSync(path.join(tmpdir(), 'wr-unlock-'));
  const port = 9700 + Math.floor(Math.random() * 200);
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,800',
    // ★ 故意不加 --autoplay-policy=no-user-gesture-required：
    //   就是要让浏览器真的拦截自动播放，才能测到解锁路径。
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!wsUrl) throw new Error('Chrome DevTools 端口未就绪');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 失败')), { once: true });
  });
  let id = 0;
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
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      return { __exc: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    }
    return r.result.value;
  };

  return {
    send, ev, events, sessionId,
    async goto(url) {
      await send('Page.navigate', { url }, sessionId);
    },
    async shot(name) {
      try {
        const s = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
        const file = path.join(SHOT_DIR, name);
        writeFileSync(file, Buffer.from(s.data, 'base64'));
        shots.push(file);
        return file;
      } catch { return null; }
    },
    close() {
      try { proc.kill(); } catch { /* 忽略 */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
    },
  };
}

/** 等页面出现某个条件 */
async function waitFor(session, expr, { timeoutMs = 15000, label = expr } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await session.ev(expr);
    if (v === true) return true;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

const READ_STATE = `({
  isPlaying: document.body.classList.contains('is-playing'),
  state: window.__wr ? window.__wr.state : null,
  playingAt: window.__wrTimings?.playingAt ?? 0,
  diag: window.__wrDiag ? { decision: window.__wrDiag.decision, why: window.__wrDiag.why } : null,
  audioCreated: window.__wrAudio ? window.__wrAudio.created : (window.__wrAudioProbe?.created ?? null),
  audioPlays: window.__wrAudio ? window.__wrAudio.plays : null,
  cityZh: document.getElementById('city-zh')?.textContent?.trim() ?? null,
  loadingPresent: Boolean(document.getElementById('wr-loading')),
  loadingVisible: (() => { const l = document.getElementById('wr-loading'); return Boolean(l) && !l.hidden; })(),
  overlayPresent: Boolean(document.getElementById('start-overlay')),
})`;

/**
 * 在页面脚本执行前埋 Audio 探针。
 * e2e.mjs 里也有一份同样的探针 —— 那边包了 window.Audio 统计创建数与播放数，
 * 因为 new Audio() 创建的元素不进入 DOM，querySelectorAll('audio') 查不到。
 */
const AUDIO_PROBE = `(() => {
  const Orig = window.Audio;
  const stats = { created: 0, plays: 0, errors: [] };
  window.__wrAudio = stats;
  class Probed extends Orig {
    constructor(...a) {
      super(...a);
      stats.created++;
      this.addEventListener('play', () => { stats.plays++; });
      this.addEventListener('error', () => { stats.errors.push('element error'); });
    }
    play() {
      const p = super.play();
      if (p && p.catch) p.catch((e) => { stats.errors.push('play() rejected: ' + e.name); });
      return p;
    }
  }
  window.Audio = Probed;
})()`;

// ─────────────────────────────────────────────────────────── 场景
console.log(`浏览器：${CHROME}`);
console.log(`目标：${BASE}/index.html`);
console.log('注意：本脚本**故意不放开自动播放策略**，浏览器会真的拦截，才能测到解锁路径\n');

// ── 场景 A：加载页上的「强制进入」
{
  console.log('[A] 加载页上的「强制进入」按钮');
  const s = await startBrowser();
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_PROBE }, s.sessionId);
  // ★ 不要用「每 150ms 发一次 CDP eval 轮询 DOM」来抓这个按钮。
  //   那样会把页面的 JS 饿死：LoadingScreen.show() 排在数据加载之后，
  //   被高频轮询挤到后面，结果 #wr-loading 在整个轮询期都没机会插入 DOM
  //   （实测 60 次探测里 skipExists 全是 false，而事后它又明明在）。
  //   正确做法：让页面自己用 MutationObserver 记时间线，脚本只在最后读结果。
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__wrDomLog = [];
      const mark = (what) => window.__wrDomLog.push({ t: Math.round(performance.now()), what });
      const snap = () => ['wr-loading', 'wr-skip', 'start-overlay']
        .map((id) => (document.getElementById(id) ? id : '-')).join('|');
      let last = null;
      const tick = () => { const cur = snap(); if (cur !== last) { last = cur; mark(cur); } };
      // ⚠ MutationObserver.observe(null) 会抛
      //   "parameter 1 is not of type 'Node'"（documentElement 在解析前是 null），
      //   所以必须等到它存在再挂。
      const start = () => { tick(); new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true }); };
      if (document.documentElement) start();
      else document.addEventListener('readystatechange', function once() {
        if (document.documentElement) { document.removeEventListener('readystatechange', once); start(); }
      });
    })()`,
  }, s.sessionId);
  await s.goto(`${BASE}/index.html`);

  // 等页面把加载页建立起来（用一次长间隔查询，不做高频轮询）
  // ⚠ 「强制进入」是 **class** 不是 id：loading.js 里 `skip.className = 'wr-skip'`，
  //   早期用 getElementById 查 wr-skip 永远查不到（它是 class），误判成"按钮不存在"。
  const SKIP_SEL = '#wr-loading .wr-skip';
  await waitFor(s, `Boolean(document.querySelector('${SKIP_SEL}'))`, { timeoutMs: 12000, label: '加载页出现' })
    .then(() => true).catch(() => false);

  const domLog = await s.ev(`window.__wrDomLog ?? []`);
  console.log(`      DOM 时间线：${domLog.map((e) => `${e.t}ms ${e.what}`).join(' | ') || '（空）'}`);
  const pageLogs = await s.ev(`({
    logs: (window.__wrLogs ?? []).slice(-10),
    errors: (window.__wrErrors ?? []).slice(-10),
    timings: window.__wrTimings ?? null,
  })`);
  const consoleLines = s.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .map((e) => `[${e.params.type}] ${e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
  const excLines = s.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  console.log(`      页面 console（${consoleLines.length} 条）：`);
  for (const l of consoleLines.slice(-12)) console.log(`        ${l}`);
  if (excLines.length) {
    console.log(`      未捕获异常（${excLines.length} 条）：`);
    for (const l of excLines.slice(-5)) console.log(`        ${String(l).split('\n')[0]}`);
  }
  if (pageLogs.timings) console.log(`      timings=${JSON.stringify(pageLogs.timings)}`);
  if (pageLogs.logs?.length) {
    console.log('      __wrLogs：');
    for (const l of pageLogs.logs) console.log(`        ${l}`);
  }
  if (pageLogs.errors?.length) {
    console.log('      __wrErrors：');
    for (const l of pageLogs.errors) console.log(`        ${l}`);
  }

  const clicked = await s.ev(`(() => {
    const b = document.querySelector('${SKIP_SEL}');
    if (!b) return null;
    b.click();
    return 'wr-skip';
  })()`);
  check('A1 加载页上存在可点的「强制进入」按钮（#wr-loading .wr-skip）', clicked === 'wr-skip',
    `点击结果=${clicked}；DOM 时间线=${domLog.length} 条`);
  await sleep(3500);
  const st = await s.ev(READ_STATE);
  check('A2 点了「强制进入」后真的进入播放态',
    st.isPlaying === true && st.state?.playing === true,
    `isPlaying=${st.isPlaying} state=${JSON.stringify(st.state)} decision=${st.diag?.decision}`);
  check('A3 记录到了开播时间点（onReady 确实执行了）', st.playingAt > 0,
    `playingAt=${st.playingAt}`);
  check('A4 加载页已收起', st.loadingPresent === false && st.loadingVisible === false,
    `loadingPresent=${st.loadingPresent} loadingVisible=${st.loadingVisible}`);
  check('A5 已经建立音频元素（播报链路启动）', (st.audioCreated ?? 0) > 0,
    `Audio 创建数=${st.audioCreated}`);
  await s.shot('unlock-A-skip.png');
  s.close();
}

// ── 场景 B：解锁遮罩上的「点一下开始」
{
  console.log('\n[B] 解锁遮罩上的「点一下开始」按钮');
  const s = await startBrowser();
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_PROBE }, s.sessionId);
  await s.goto(`${BASE}/index.html`);

  let appeared = true;
  try {
    await waitFor(s, `Boolean(document.getElementById('btn-start'))`, { timeoutMs: 12000, label: '解锁遮罩出现' });
  } catch { appeared = false; }
  check('B1 自动播放被拦截时出现解锁遮罩', appeared, `overlayPresent 见下表`);

  if (appeared) {
    const before = await s.ev(READ_STATE);
    check('B2 解锁前确实没有在播放', before.isPlaying === false && before.playingAt === 0,
      `isPlaying=${before.isPlaying} playingAt=${before.playingAt} why=${before.diag?.why}`);

    await s.ev(`document.getElementById('btn-start').click()`);
    await sleep(2000);
    const after = await s.ev(READ_STATE);
    check('B3 点了解锁按钮后进入播放态',
      after.isPlaying === true && after.state?.playing === true && after.playingAt > 0,
      `isPlaying=${after.isPlaying} state=${JSON.stringify(after.state)} playingAt=${after.playingAt} decision=${after.diag?.decision}`);
    check('B4 解锁遮罩已消失', after.overlayPresent === false, `overlayPresent=${after.overlayPresent}`);
    check('B5 已建立音频元素', (after.audioCreated ?? 0) > 0, `Audio 创建数=${after.audioCreated}`);
    await s.shot('unlock-B-button.png');
  }
  s.close();
}

// ── 场景 C：点页面任意处（armAnyGesture 兜底）
{
  console.log('\n[C] 点页面任意处（兜底手势）');
  const s = await startBrowser();
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_PROBE }, s.sessionId);
  await s.goto(`${BASE}/index.html`);

  let appeared = true;
  try {
    await waitFor(s, `Boolean(document.getElementById('start-overlay'))`, { timeoutMs: 12000, label: '解锁遮罩出现' });
  } catch { appeared = false; }
  check('C1 出现解锁态', appeared);

  if (appeared) {
    // 点画面正中央（不是按钮），走 armAnyGesture 兜底
    const box = await s.ev(`(() => {
      const r = document.getElementById('app').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.9) };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, s.sessionId);
    }
    await sleep(2500);
    const after = await s.ev(READ_STATE);
    check('C2 点页面任意处也能开播（不要求用户找到按钮）',
      after.isPlaying === true && after.state?.playing === true && after.playingAt > 0,
      `isPlaying=${after.isPlaying} state=${JSON.stringify(after.state)} playingAt=${after.playingAt} decision=${after.diag?.decision}`);
    check('C3 已建立音频元素', (after.audioCreated ?? 0) > 0, `Audio 创建数=${after.audioCreated}`);
    await s.shot('unlock-C-gesture.png');
  }
  s.close();
}

// ─────────────────────────────────────────────────────────── 汇总
console.log('\n' + '─'.repeat(64));
const failed = results.filter((r) => !r.ok);
console.log(`结果：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
if (failed.length) {
  console.log('\n失败明细：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
}
if (!KEEP_SHOTS && failed.length === 0) {
  for (const s of shots) { try { rmSync(s, { force: true }); } catch { /* 忽略 */ } }
}
process.exit(failed.length ? 1 : 0);
