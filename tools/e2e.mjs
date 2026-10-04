// 真实浏览器端到端验收：用 Chrome DevTools Protocol 直连无头 Chrome。
// 比 --dump-dom 强大得多：可以等条件成立、可以真的点按钮、可以读运行时状态。
//
//   node tools/e2e.mjs                          # index.html 全流程
//   node tools/e2e.mjs large.html               # 大屏版
//   node tools/e2e.mjs --keep-shots             # 保留截图便于肉眼检查
//   node tools/e2e.mjs --no-click               # 只验首屏，不点「开始播报」
//
// 前置：python tools/serve.py -p 8099
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.WR_BASE ?? 'http://127.0.0.1:8099';
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome/Edge，请设置 CHROME_PATH');
  process.exit(2);
}

const argv = process.argv.slice(2);
const page = argv.find((a) => !a.startsWith('--')) ?? 'index.html';
const TARGET = `${BASE}/${page}`;
const CLICK_START = !argv.includes('--no-click');
const KEEP_SHOTS = argv.includes('--keep-shots');
/** --listen=8000：点开始后监听 8 秒，用来确认「语音片段」而不只是背景音乐真的在播 */
const listenArg = argv.find((a) => a.startsWith('--listen='));
const LISTEN_MS = listenArg ? Number(listenArg.split('=')[1]) : 0;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────── CDP 最小客户端
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.consoleWarnings = [];
    this.failedRequests = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ');
        if (msg.params.type === 'error') this.consoleErrors.push(text);
        else if (msg.params.type === 'warning') this.consoleWarnings.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.consoleErrors.push(d.exception?.description ?? d.text ?? '未知异常');
      }
      if (msg.method === 'Network.loadingFailed') {
        this.failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
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

  /** 在页面里同步求值（支持 await，用 awaitPromise） */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** 轮询等待条件成立 */
  async waitFor(expression, { timeoutMs = 30000, intervalMs = 250, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = `求值异常：${err.message}`;
      }
      await sleep(intervalMs);
    }
    throw new Error(`等待超时（${timeoutMs}ms）：${label}；最后一次取值：${JSON.stringify(last)}`);
  }
}

async function httpJson(urlPath) {
  const res = await fetch(`${BASE.replace(/\/$/, '')}${urlPath}`);
  return res.json();
}

// ────────────────────────────────────────────────────────── 启动浏览器
const profile = mkdtempSync(path.join(tmpdir(), 'wr-cdp-'));
const port = 9222 + Math.floor(Math.random() * 500);
const chromeProc = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    '--autoplay-policy=no-user-gesture-required', // 无头环境没有真实手势，放宽以便验证播放链路
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeLog = '';
chromeProc.stderr.on('data', (d) => (chromeLog += d.toString('utf8')));

async function waitForDevTools() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('Chrome DevTools 端口未就绪');
}

function cleanup() {
  try { chromeProc.kill(); } catch { /* 忽略 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
process.on('exit', cleanup);

console.log(`浏览器：${CHROME}`);
console.log(`目标：${TARGET}\n`);

const browserWsUrl = await waitForDevTools();
const browserWs = new WebSocket(browserWsUrl);
await new Promise((r, j) => {
  browserWs.addEventListener('open', r, { once: true });
  browserWs.addEventListener('error', () => j(new Error('无法连接 DevTools')), { once: true });
});
const browser = new CDP(browserWs);

/** 打开目标页并挂上会话。
 *  注意执行顺序：直接以目标 URL 建 target，再注册探针，最后 Page.reload。
 *  不能「先 about:blank 建 target → 注册探针 → navigate」，那样探针注册会和首屏
 *  模块脚本加载抢时序，实测会偶发把 js/main.js 请求打断（ERR_CONNECTION_REFUSED/aborted），
 *  表现为页面骨架在但 boot() 从不执行。reload 保证了没有竞态。 */
const { targetId } = await browser.send('Target.createTarget', { url: TARGET });
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

// 会话内的所有命令都要带 sessionId，包一层
class Session extends CDP {
  constructor(ws, sessionId) {
    super(ws);
    this.sessionId = sessionId;
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
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }
}

// 会话事件也要按 sessionId 过滤（浏览器级事件不带 sessionId）
const session = new Session(browserWs, sessionId);
browserWs.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (msg.params.type === 'error') session.consoleErrors.push(text);
    else if (msg.params.type === 'warning') session.consoleWarnings.push(text);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    session.consoleErrors.push(d.exception?.description ?? d.text ?? '未知异常');
  }
  if (msg.method === 'Network.loadingFailed') {
    session.failedRequests.push(`${msg.params.type} ${msg.params.errorText}`);
  }
});

await session.send('Runtime.enable');
await session.send('Page.enable');
await session.send('Network.enable');
// 在页面脚本执行前埋探针（随后 reload 才会生效）：
// 1) new Audio() 创建的元素不会进入 DOM，querySelectorAll('audio') 查不到，
//    所以这里包一层 Audio 计数；2) 记下播放事件与失败原因，便于定位播报链路卡在哪。
await session.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const Orig = window.Audio;
    const stats = { created: 0, plays: 0, playErrors: [], ended: 0, srcs: [] };
    window.__wrAudio = stats;
    class Probed extends Orig {
      constructor(...args) {
        super(...args);
        stats.created++;
        this.addEventListener('play', () => { stats.plays++; });
        this.addEventListener('ended', () => { stats.ended++; });
        this.addEventListener('error', () => {
          stats.playErrors.push('element error: ' + (this.currentSrc || this.src || '?').split('/').slice(-2).join('/'));
        });
      }
      play() {
        try { stats.srcs.push((this.currentSrc || this.src || '?').split('/').slice(-2).join('/')); } catch (e) {}
        const p = super.play();
        if (p && p.catch) p.catch((e) => { stats.playErrors.push('play() rejected: ' + e.name + ' ' + e.message); });
        return p;
      }
    }
    window.Audio = Probed;
    window.__wrLogs = [];
    const oc = console.error, ow = console.warn;
    console.error = (...a) => { window.__wrLogs.push('ERROR ' + a.map(String).join(' ')); oc.apply(console, a); };
    console.warn = (...a) => { window.__wrLogs.push('WARN ' + a.map(String).join(' ')); ow.apply(console, a); };
    // 捕获模块加载/求值阶段的错误（import 失败时 window.onerror 不一定触发）
    window.__wrErrors = [];
    window.addEventListener('error', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
        window.__wrErrors.push('资源加载失败 <' + t.tagName + '> ' + (t.src || t.href));
      } else {
        window.__wrErrors.push('error: ' + (e.message || '(空)') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0));
      }
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      window.__wrErrors.push('unhandledrejection: ' + (r && (r.stack || r.message) ? (r.stack || r.message) : String(r)));
    });
    window.__wrHadUserGesture = false;
    addEventListener('click', () => { window.__wrHadUserGesture = true; }, true);
  })()`,
});
// reload：这次是探针生效后的第一个完整文档，不会与探针注册抢时序。
const nav = await session.send('Page.reload', { ignoreCache: true });
if (nav?.errorText) console.log(`  ⚠ 导航返回错误：${nav.errorText}`);
await session.waitFor(`document.readyState === 'complete'`, { timeoutMs: 30000, label: '页面加载完成' });
await sleep(800);
const probeOk = await session.eval(`!!window.__wrAudio`);
if (!probeOk) console.log('  ⚠ 探针未注入，音频统计会不可靠');
const diag = await session.eval(
  `({ url: location.href, title: document.title, readyState: document.readyState,
      scripts: [...document.scripts].map((s) => s.src.split('/').slice(-2).join('/')),
      bodyChildren: [...document.body.children].map((n) => n.tagName + (n.id ? '#' + n.id : '')),
      modules: !!window.__wrAudio,
      errors: (window.__wrErrors ?? []).slice(-10),
      logs: (window.__wrLogs ?? []).slice(-6),
      status: (document.getElementById('status-text') || {}).textContent,
      overlayPresent: !!document.getElementById('start-overlay') })`,
);
console.log(`  导航后诊断：readyState=${diag.readyState} title="${diag.title}"`);
console.log(`    URL=${diag.url}`);
console.log(`    body 子节点=${diag.bodyChildren.join(', ') || '（空）'}`);
console.log(`    script=${diag.scripts.join(', ') || '（无）'}；探针已注入=${diag.modules}`);
console.log(`    status-text="${diag.status}"；开始遮罩=${diag.overlayPresent}`);
if (diag.errors.length) for (const l of diag.errors) console.log(`    脚本错误 · ${l.slice(0, 260)}`);
if (diag.logs.length) for (const l of diag.logs) console.log(`    日志 · ${l.slice(0, 160)}`);

const isLarge = page.includes('large');
/** 两套页面的 DOM 契约不同（大屏版用 lg- 前缀），这里统一映射，测试逻辑只写一份 */
const P = isLarge
  ? {
      cityZh: 'lg-city-zh', cityEn: 'lg-city-en', tempC: 'lg-temp-c', tempF: 'lg-temp-f',
      day: 'lg-day-zh', weatherZh: 'lg-weather-zh', weatherEn: 'lg-weather-en',
      localTime: 'lg-local-time-zh', status: 'lg-status', progress: 'lg-progress-text',
      startBtn: 'lg-btn-start', overlay: 'lg-start-overlay', hint: 'lg-start-hint',
      nextBtn: 'lg-btn-next', prevBtn: 'lg-btn-prev', playBtn: 'lg-btn-play',
      musicBtn: 'lg-btn-music', shuffleBtn: 'lg-btn-shuffle', icon: 'lg-weather-icon',
      app: 'large-app', bgA: 'lg-bg-a', bgB: 'lg-bg-b',
    }
  : {
      // 极简版：没有进度条、没有播放控制按钮、没有华氏度/当地时间/风速
      cityZh: 'city-zh', cityEn: 'city-en', tempC: 'temp-c',
      day: 'card-day', weatherZh: 'weather-zh', weatherEn: 'weather-en',
      status: 'sr-only-status', progress: 'progress-text',
      startBtn: 'btn-start', overlay: 'start-overlay', hint: 'start-hint',
      nextBtn: null, prevBtn: null, playBtn: null,
      musicBtn: 'btn-music', shuffleBtn: null, icon: 'weather-icon',
      app: 'app', bgA: 'bg-img-a', bgB: 'bg-img-b',
    };

// 极简版的必需节点：没有 #start-overlay / #btn-start（进去就自动播报）
const ids = isLarge
  ? [P.cityZh, P.cityEn, P.tempC, P.day, P.weatherZh, P.weatherEn, P.status,
     P.startBtn, P.musicBtn, P.icon, P.app, P.bgA, P.bgB, P.overlay, P.hint].filter(Boolean)
  : [P.cityZh, P.cityEn, P.tempC, P.weatherZh, P.weatherEn, P.status,
     P.musicBtn, P.icon, P.app, P.bgA, P.bgB].filter(Boolean);

console.log('[1] 首屏渲染（等 JS 装配完成）');
try {
  await session.waitFor(
    `(() => { const el = document.getElementById(${JSON.stringify(P.cityZh)});
       return !!el && el.textContent.trim().length > 0; })()`,
    { timeoutMs: 45000, label: '城市名被填充' },
  );
  check('城市名已渲染', true);
} catch (err) {
  check('城市名已渲染', false, err.message);
}

const snapshot = await session.eval(`(() => {
  const t = (id) => (document.getElementById(id)?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const P = ${JSON.stringify(P)};
  const opt = (id) => (id ? t(id) : '');
  return {
    cityZh: t(P.cityZh), cityEn: t(P.cityEn), tempC: t(P.tempC), tempF: opt(P.tempF),
    cardDay: t(P.day), weatherZh: t(P.weatherZh), weatherEn: t(P.weatherEn),
    localTime: opt(P.localTime), status: opt(P.status), progress: opt(P.progress),
    weather: document.getElementById(P.app)?.dataset.weather ?? '',
    textOn: document.getElementById(P.app)?.dataset.textOn ?? '',
    contrastFallback: document.getElementById(P.app)?.hasAttribute('data-contrast-fallback') ?? false,
    missingIds: ${JSON.stringify(ids)}.filter((id) => !document.getElementById(id)),
    hasStartOverlay: !!document.getElementById(P.overlay),
    hint: t(P.hint),
    // 极简版必须没有这些：整屏蒙版、进度条、播放控制、华氏度、当地时间、风速
    removed: ['temp-f', 'progress-track', 'progress-fill', 'hud', 'meta-row', 'btn-play', 'btn-next', 'btn-prev', 'btn-shuffle', 'local-time', 'precip', 'wind']
      .filter((id) => document.getElementById(id)),
  };
})()`);

check('中文城市名非空', snapshot.cityZh.length > 0, `城市名 = "${snapshot.cityZh}"`);
check('英文城市名非空', /[A-Za-z]/.test(snapshot.cityEn), `英文名 = "${snapshot.cityEn}"`);
check('中文城市名是汉字', /[\u4e00-\u9fa5]/.test(snapshot.cityZh), snapshot.cityZh);
check('温度已渲染', /\d/.test(snapshot.tempC), `温度 = "${snapshot.tempC}"`);
check('天气文案中英成对', snapshot.weatherZh.length > 0 && /[A-Za-z]/.test(snapshot.weatherEn),
  `${snapshot.weatherZh} / ${snapshot.weatherEn}`);
check(`必需节点齐全（${ids.length} 个）`, snapshot.missingIds.length === 0,
  snapshot.missingIds.join(', '));
check('开始遮罩存在（音频解锁必需）', isLarge ? snapshot.hasStartOverlay : true,
  isLarge ? '' : '极简版不需要：进去就自动播报');
if (!isLarge) {
  check('已移除：进度条/播放控制/华氏度/当地时间/风速',
    snapshot.removed.length === 0, snapshot.removed.join(', ') || '全部已移除');
  check('文字配色已按壁纸亮度自动判定', snapshot.textOn === 'light' || snapshot.textOn === 'dark',
    `data-text-on="${snapshot.textOn}"${snapshot.contrastFallback ? '（走兜底阴影）' : ''}`);
} else {
  check('日期标签已渲染', snapshot.cardDay.length > 0, snapshot.cardDay);
  check('当地时间已渲染', snapshot.localTime.length > 0, snapshot.localTime);
  check('状态栏有内容', snapshot.status.length > 0, snapshot.status);
}
console.log(`      开始提示：${snapshot.hint}`);

console.log('\n[2] 中英对照与大字号');
const typography = await session.eval(`(() => {
  const P = ${JSON.stringify(P)};
  const px = (id) => {
    const el = document.getElementById(id);
    if (!el) return 0;
    return parseFloat(getComputedStyle(el).fontSize);
  };
  const r = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), top: Math.round(b.top) };
  };
  return {
    cityZh: px(P.cityZh), cityEn: px(P.cityEn), tempC: px(P.tempC), weatherZh: px(P.weatherZh),
    viewport: { w: innerWidth, h: innerHeight },
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    card: r(P.app), btnStart: r(P.startBtn), btnNext: r(P.nextBtn),
    btnMusic: (() => {
      const el = document.getElementById(P.musicBtn);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), opacity: getComputedStyle(el).opacity };
    })(),
    // 去掉蒙版后要确认真的没有整屏暗色覆盖
    overlayAlpha: (() => {
      const bg = document.getElementById('bg');
      if (!bg) return 0;
      const cs = getComputedStyle(bg, '::after');
      if (cs.content === 'none' || cs.display === 'none') return 0;
      const m = (cs.backgroundColor || '').match(/rgba?\\(([^)]+)\\)/);
      if (!m) return 0;
      const parts = m[1].split(',').map((s) => parseFloat(s));
      return parts.length >= 4 ? parts[3] : 1;
    })(),
    cardPanelAlpha: (() => {
      const card = document.getElementById('card');
      if (!card) return 0;
      const cs = getComputedStyle(card);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return 1;
      const m = (cs.backgroundColor || '').match(/rgba?\\(([^)]+)\\)/);
      if (!m) return 0;
      const parts = m[1].split(',').map((s) => parseFloat(s));
      return parts.length >= 4 ? parts[3] : 1;
    })(),
  };
})()`);
// 大屏版的目标是「占屏宽约 60%」，所以门槛更高；小卡片版按桌面 ≥96px 的要求折算
const cityMin = isLarge ? 96 : 48;
check(`城市名字号够大（≥ ${cityMin}px）`, typography.cityZh >= cityMin,
  `${typography.cityZh.toFixed(1)}px @ ${typography.viewport.w}×${typography.viewport.h}`);
check('英文名字号可读（≥ 18px）', typography.cityEn >= 18, `${typography.cityEn.toFixed(1)}px`);
check('温度字号够大（≥ 48px）', typography.tempC >= 48, `${typography.tempC.toFixed(1)}px`);
check('开始按钮点击区域 ≥ 56px', !typography.btnStart || typography.btnStart.h >= 56,
  typography.btnStart ? `${typography.btnStart.w}×${typography.btnStart.h}` : '（无）');
if (typography.btnMusic) {
  check('音乐开关点击区域 ≥ 56px（且视觉低干扰）', typography.btnMusic.h >= 56,
    `${typography.btnMusic.w}×${typography.btnMusic.h}，opacity=${typography.btnMusic.opacity}`);
}
if (!isLarge) {
  check('没有整屏暗色蒙版（去蒙版是本次改版的核心）', typography.overlayAlpha <= 0.08,
    `#bg::after 透明度 ${typography.overlayAlpha}`);
  check('文字直接压在照片上（无卡片面板底色）', typography.cardPanelAlpha <= 0.08,
    `#card 背景透明度 ${typography.cardPanelAlpha}`);
}
check('页面无横向溢出', typography.scrollW <= typography.viewport.w + 2,
  `scrollWidth=${typography.scrollW} vs viewport=${typography.viewport.w}`);

console.log('\n[3] 交互与播报链路');
if (CLICK_START) {
  // 这版是「进去就自动播报」：index.html 里根本没有 #start-overlay / #btn-start。
  // 只有浏览器拦截自动播放时，main.js 才会动态生成一个同 id 的兜底解锁遮罩。
  // 所以这里等的是「播报自己跑起来」，而不是等按钮出现。
  const isMinimal = !isLarge;
  if (isMinimal) {
    let autoStarted = false;
    try {
      await session.waitFor(
        `(() => {
           const st = window.__wr?.state;
           return Boolean(st && (st.playing || st.paused));
         })()`,
        { timeoutMs: 90000, label: '自动播报已自行启动（没有任何用户点击）' },
      );
      autoStarted = true;
    } catch (err) {
      console.log(`      ⚠ ${err.message}`);
    }
    const st = await session.eval(`window.__wr?.state ?? null`);
    check('无需任何点击自动开始播报', autoStarted,
      st ? `state=${JSON.stringify(st)}` : '拿不到播放状态');
    check('页面里没有「开始播报」遮罩（除非自动播放被拦截）',
      !(await session.eval(`!!document.getElementById('start-overlay')`)),
      '正常情况下应为 false');
    const status = await session.eval(
      `document.getElementById(${JSON.stringify(P.status)})?.textContent.trim() ?? ''`,
    );
    console.log(`      隐藏状态位：${status}`);
  } else {
    // 大屏版仍有显式按钮
    let bootDone = false;
    try {
      await session.waitFor(
        `(document.getElementById(${JSON.stringify(P.hint)})?.textContent ?? '').trim().length > 0`,
        { timeoutMs: 90000, label: 'boot 完成' },
      );
      bootDone = true;
    } catch (err) {
      console.log(`      ⚠ ${err.message}`);
    }
    check('大屏版 boot 完成（开始提示已填充）', bootDone);
    const clicked = await session.eval(
      `(() => { const b = document.getElementById(${JSON.stringify(P.startBtn)});
                if (!b) return false; b.click(); return true; })()`,
    );
    check('已点击「开始播报」', clicked);
    await sleep(1800);
  }

  const audioState = await session.eval(`(async () => {
    // new Audio() 的元素不在 DOM 里，必须靠页面里埋的探针统计
    const stats = window.__wrAudio ?? { created: 0, plays: 0, playErrors: [], ended: 0, srcs: [] };
    return {
      created: stats.created,
      plays: stats.plays,
      ended: stats.ended,
      errors: stats.playErrors.slice(0, 6),
      srcs: stats.srcs.slice(0, 8),
      logs: (window.__wrLogs ?? []).slice(-8),
      overlayGone: (() => {
        const o = document.getElementById(${JSON.stringify(P.overlay ?? 'start-overlay')});
        if (!o) return true; // 极简版正常路径下根本没有这个节点
        const cs = getComputedStyle(o);
        return o.hasAttribute('hidden') || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05;
      })(),
    };
  })()`);
  check('没有残留在页面上的解锁遮罩', audioState.overlayGone !== false, String(audioState.overlayGone));
  check('音频元素已创建（播报链路已启动）', audioState.created > 0, `${audioState.created} 个`);
  check('音频片段真的开始播放', audioState.plays > 0, `play 事件 ${audioState.plays} 次`);
  check('没有播放失败', audioState.errors.length === 0, audioState.errors.join(' | ') || '无');
  if (audioState.srcs.length) console.log(`      播放过的片段：${audioState.srcs.join(', ')}`);
  if (audioState.logs.length) {
    console.log('      页面日志：');
    for (const l of audioState.logs) console.log(`        · ${l.slice(0, 160)}`);
  }

  if (LISTEN_MS > 0) {
    console.log(`      监听 ${LISTEN_MS}ms，记录真实播放过的音频片段……`);
    // 关键：不能包 window.Audio —— ClipLoader 早就在探针之前把 Audio 元素建好并缓存了，
    // 那些元素永远走不到新构造函数。改为 patch 原型上的 play()，无论元素何时创建都能拦截。
    await session.eval(`(() => {
      if (window.__wrTimelinePatched) return true;
      window.__wrTimelinePatched = true;
      window.__wrTimeline = [];
      const orig = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function patchedPlay() {
        try {
          const file = (this.currentSrc || this.src || '?').split('/').pop().split('?')[0];
          window.__wrTimeline.push({ t: Math.round(performance.now()), src: file, tag: this.tagName });
        } catch (e) { /* 忽略 */ }
        return orig.apply(this, arguments);
      };
      return true;
    })()`);
    await sleep(LISTEN_MS);
    const timeline = await session.eval(`(window.__wrTimeline ?? []).slice(0, 60)`);
    const musicClips = timeline.filter((x) => x.src === 'yuzhouchangwan.mp3' || x.src === 'music.mp3');
    const voiceClips = timeline.filter((x) => !x.src.endsWith('.wav') && x.src !== 'yuzhouchangwan.mp3' && x.src !== 'music.mp3');
    console.log(`      时间线（${timeline.length} 次播放请求）：`);
    for (const x of timeline.slice(0, 18)) console.log(`        ${String(x.t).padStart(6)}ms  ${x.src}`);
    check('背景音乐已开始播放', musicClips.length > 0,
      musicClips.length ? `使用 ${[...new Set(musicClips.map((x) => x.src))].join(', ')}` : '未播放');
    if (musicClips.length) {
      const used = [...new Set(musicClips.map((x) => x.src))];
      const custom = existsSync(path.join(ROOT, 'assets', 'audio', 'music', 'music.mp3'));
      check('优先使用用户自备的 music.mp3（存在时）', !custom || used.includes('music.mp3'),
        custom ? `实际播放 ${used.join(', ')}` : '未放置 music.mp3，使用内置合成版');
    }
    check('语音片段真的在播放（不只是背景音乐）', voiceClips.length >= 3,
      `语音片段 ${voiceClips.length} 个：${voiceClips.slice(0, 10).map((x) => x.src).join(' ')}`);
    if (voiceClips.length >= 3) {
      // 顺序校验：一句播报应为 城市 → 天气 → 纯数字 → 到 → 数字+度
      const order = voiceClips.slice(0, 6).map((x) => x.src.replace('.mp3', ''));
      console.log(`      首句片段顺序：${order.join(' → ')}`);
      const nums = voiceClips.filter((x) => /^n\d+\.mp3$/.test(x.src));
      const temps = voiceClips.filter((x) => /^t\d+\.mp3$/.test(x.src));
      const hasDao = voiceClips.some((x) => x.src === 'dao.mp3');
      check('温度区间前半段用「纯数字」片段、后半段用「数字+度」',
        nums.length > 0 && temps.length > 0,
        `纯数字 ${nums.map((x) => x.src).slice(0, 3).join(' ')} / 数字+度 ${temps.map((x) => x.src).slice(0, 3).join(' ')}`);
      check('连接词「到」已播放', hasDao);
      check('不再单独播放「度」片段（度已并入 t{N}）',
        !voiceClips.some((x) => x.src === 'du.mp3'), 'du.mp3 已从语音包移除');
      // 段间停顿应该很短，否则听起来一顿一顿
      const gaps = [];
      for (let i = 1; i < voiceClips.length; i++) {
        const d = voiceClips[i].t - voiceClips[i - 1].t;
        if (d < 3000) gaps.push(d);
      }
      if (gaps.length >= 2) {
        const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
        console.log(`      段间平均间隔：${avg}ms（最长 ${Math.max(...gaps)}ms）`);
        check('句内停顿连贯（平均 < 1200ms）', avg < 1200, `${avg}ms`);
      }
    }
  }

  // 等它自己翻到下一个城市，验证「顺序播放 + 自动推进」
  const firstCity = snapshot.cityZh;
  const CITY = `document.getElementById(${JSON.stringify(P.cityZh)}).textContent.trim()`;
  try {
    await session.waitFor(`${CITY} !== ${JSON.stringify(firstCity)}`,
      { timeoutMs: 40000, label: '自动播报推进到下一个城市' });
    const second = await session.eval(CITY);
    check('自动推进到下一座城市', true, `${firstCity} → ${second}`);
  } catch (err) {
    check('自动推进到下一座城市', false, err.message);
  }

  if (P.nextBtn) {
    // 大屏版有显式的「下一个」按钮
    const before = await session.eval(CITY);
    await session.eval(`document.getElementById(${JSON.stringify(P.nextBtn)}).click()`);
    try {
      await session.waitFor(`${CITY} !== ${JSON.stringify(before)}`,
        { timeoutMs: 20000, label: '点下一个按钮切换城市' });
      const after = await session.eval(CITY);
      check('「下一个」按钮生效', true, `${before} → ${after}`);
    } catch (err) {
      check('「下一个」按钮生效', false, err.message);
    }
  } else {
    // 极简版没有按钮：验证「点画面暂停/继续」这个唯一保留的交互
    const before = await session.eval(`({
      paused: document.getElementById(${JSON.stringify(P.app)}).classList.contains('is-paused'),
      city: ${CITY},
    })`);
    // 用「真实坐标点击」而不是 element.click()：能顺带验证遮罩隐藏后不再拦截点击
    const box = await session.eval(`(() => {
      const b = document.getElementById(${JSON.stringify(P.app)});
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.22), y: Math.round(r.top + r.height * 0.5) };
    })()`);
    const hitTest = await session.eval(
      `document.elementFromPoint(${box.x}, ${box.y})?.id || document.elementFromPoint(${box.x}, ${box.y})?.tagName`,
    );
    console.log(`      坐标点击 (${box.x},${box.y}) 命中的元素：${hitTest}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(1000);
    const afterPause = await session.eval(`({
      paused: document.getElementById(${JSON.stringify(P.app)}).classList.contains('is-paused'),
      city: ${CITY},
    })`);
    check('点一下画面进入暂停态', afterPause.paused === true && !before.paused,
      `is-paused: ${before.paused} → ${afterPause.paused}（命中元素 ${hitTest}）`);
    // 暂停后城市不应再自动切换
    await sleep(6000);
    const stillPaused = await session.eval(`({
      paused: document.getElementById(${JSON.stringify(P.app)}).classList.contains('is-paused'),
      city: ${CITY},
    })`);
    check('暂停期间城市不再自动切换', stillPaused.paused === true && stillPaused.city === afterPause.city,
      `${afterPause.city} → ${stillPaused.city}`);

    // 再点一下恢复
    for (const type of ['mousePressed', 'mouseReleased']) {
      await session.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(1200);
    const resumed = await session.eval(
      `document.getElementById(${JSON.stringify(P.app)}).classList.contains('is-paused')`,
    );
    check('再点一下画面恢复播放', resumed === false, `is-paused=${resumed}`);

    // 批量抽查多张壁纸下的文字配色决策：任何一张都不该出现"两边看不清"
    console.log('      批量抽查壁纸文字配色（每城记录一个决策）……');
    const samples = [];
    for (let i = 0; i < 12; i++) {
      await session.eval(`window.__wr.next()`);
      await sleep(2600); // 等新壁纸探测 + 亮度分析 + 900ms 过渡
      samples.push(await session.eval(`({
        city: document.getElementById(${JSON.stringify(P.cityZh)})?.textContent.trim(),
        on: document.getElementById(${JSON.stringify(P.app)})?.dataset.textOn,
        fallback: document.getElementById(${JSON.stringify(P.app)})?.hasAttribute('data-contrast-fallback'),
        analysis: window.__wr?.contrast ?? null,
      })`));
    }
    console.log(`      决策：${samples.map((s) => `${s.city}:${s.on ?? '兜底'}`).join(' ')}`);
    const undecided = samples.filter((s) => !s.on);
    check('每张壁纸都给出了明确的文字配色（无一落到兜底）', undecided.length === 0,
      undecided.length ? undecided.map((s) => s.city).join(', ') : `${samples.length} 张全部有决策`);

    // 判据必须来自离线预算的亮度网格：这是 Pixabay 图（无 CORS 头，canvas 读不到像素）也能判对的前提。
    // 逐城可读性红线由 tools/test-contrast.mjs 在 81 城 × 3 视口上离线穷举断言。
    const fromTable = samples.filter((s) => s.analysis?.source === 'table');
    const fromFallback = samples.filter((s) => !s.analysis?.source || s.analysis.source === 'fallback');
    check('配色判据来自离线亮度网格（不依赖浏览器读跨域像素）',
      fromTable.length === samples.length && fromFallback.length === 0,
      `${fromTable.length}/${samples.length} 来自网格${fromFallback.length ? `，${fromFallback.length} 项落到兜底：${fromFallback.map((s) => s.city).join(', ')}` : ''}`);
    const withLums = samples.filter((s) => Array.isArray(s.analysis?.lums) && s.analysis.lums.length);
    if (withLums.length) {
      const fmt = withLums.slice(0, 4).map((s) => `${s.city}[${s.analysis.lums.map((v) => v.toFixed(2)).join(',')}]`).join(' ');
      console.log(`      各城文字区亮度（0=全黑 1=全白）：${fmt}`);
    }
  }
} else {
  console.log('  （跳过：--no-click）');
}

console.log('\n[4] 控制台与网络');
check('无 JS 报错', session.consoleErrors.length === 0,
  session.consoleErrors.slice(0, 4).join(' | ') || '无');
const realFailures = session.failedRequests.filter(
  (f) => !/net::ERR_ABORTED/.test(f)
    // 图片探测（probeImage）与切换壁纸时主动放弃的旧请求都会产生 ERR_FAILED，
    // 属于预期行为；壁纸是否真的成功由下面的「城市壁纸真的加载出来了」断言负责。
    && !/^Image net::ERR_FAILED/.test(f)
    && !/net::ERR_INTERNET_DISCONNECTED/.test(f),
);
check('无资源加载失败', realFailures.length === 0, realFailures.slice(0, 4).join(' | ') || '无');
if (session.consoleWarnings.length) {
  console.log(`  （${session.consoleWarnings.length} 条警告，取前 3 条）`);
  for (const w of session.consoleWarnings.slice(0, 3)) console.log(`     · ${w.slice(0, 150)}`);
}

// ────────────────────────────────────────────────────────── 截图
mkdirSync(SHOT_DIR, { recursive: true });
const shots = [];
// --day：强制去掉夜间遮罩，用来对比"白天模式"的壁纸可见度
const FORCE_DAY = argv.includes('--day');
for (const [name, size] of [['desktop', [1440, 900]], ['mobile', [390, 844]]]) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: size[0], height: size[1], deviceScaleFactor: 1, mobile: name === 'mobile',
  });
  if (FORCE_DAY) {
    await session.eval(`(() => {
      for (const el of [document.documentElement, document.body, document.getElementById(${JSON.stringify(P.app)})]) {
        el?.classList?.remove('is-night');
      }
      return true;
    })()`);
  }
  await sleep(1200);
  // 顺手量一下照片实际可见度：拿 bg 元素的滤镜与遮罩透明度
  const vis = await session.eval(`(() => {
    const img = document.getElementById(${JSON.stringify(P.bgA)});
    const cs = img ? getComputedStyle(img) : null;
    const scene = document.getElementById(${JSON.stringify(P.app)});
    return {
      filter: cs?.filter ?? '', opacity: cs?.opacity ?? '',
      naturalW: img?.naturalWidth ?? 0, loaded: !!img?.complete && (img?.naturalWidth ?? 0) > 0,
      src: (img?.currentSrc || img?.src || '').slice(0, 80),
      night: scene?.classList.contains('is-night') ?? false,
    };
  })()`);
  console.log(`  ${name} 壁纸：已加载=${vis.loaded}（${vis.naturalW}px）夜间=${vis.night}`);
  console.log(`    filter=${vis.filter}`);
  console.log(`    src=${vis.src}`);
  if (name === 'desktop') {
    check('城市壁纸真的加载出来了（不是插画兜底）', vis.loaded && vis.naturalW > 400,
      vis.loaded ? `${vis.naturalW}px` : '未加载，走了兜底');
  }
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOT_DIR, `${path.basename(page, '.html')}-${name}${FORCE_DAY ? '-day' : ''}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  shots.push(file);
  console.log(`  截图：${path.relative(ROOT, file)}`);

  // --both：同一张卡片再抓一张"去掉夜间遮罩"的，用于对比地标可见度
  if (argv.includes('--both')) {
    await session.eval(`(() => {
      for (const el of [document.documentElement, document.body, document.getElementById(${JSON.stringify(P.app)})]) {
        el?.classList?.remove('is-night');
      }
      return true;
    })()`);
    await sleep(1100);
    const day = await session.send('Page.captureScreenshot', { format: 'png' });
    const dayFile = path.join(SHOT_DIR, `${path.basename(page, '.html')}-${name}-day.png`);
    writeFileSync(dayFile, Buffer.from(day.data, 'base64'));
    shots.push(dayFile);
    console.log(`  截图（白天对比）：${path.relative(ROOT, dayFile)}`);
  }
  // 顺带在两种视口下复核溢出
  const of = await session.eval(
    `({ sw: document.documentElement.scrollWidth, iw: innerWidth, sh: document.documentElement.scrollHeight, ih: innerHeight })`,
  );
  check(`${name} 视口（${size[0]}×${size[1]}）无横向溢出`, of.sw <= of.iw + 2, `scrollWidth=${of.sw}`);
}

console.log('\n' + '─'.repeat(64));
const failed = results.filter((r) => !r.ok);
console.log(`结果：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);

// 有失败时把页面侧诊断信息全部倒出来，避免"看起来没报错但其实有隐藏异常"
if (failed.length) {
  const pageDiag = await session.eval(`({
    pageErrors: (window.__wrErrors ?? []).slice(-12),
    logs: (window.__wrLogs ?? []).slice(-12),
    audioProbe: window.__wrAudio ? { created: window.__wrAudio.created, plays: window.__wrAudio.plays, errors: window.__wrAudio.playErrors.slice(0, 6) } : null,
    startBtnPresent: !!document.getElementById(${JSON.stringify(P.startBtn)}),
    overlayClass: document.getElementById(${JSON.stringify(P.overlay)})?.className ?? null,
    status: document.getElementById(${JSON.stringify(P.status)})?.textContent ?? null,
  })`).catch((err) => ({ evalError: err.message }));
  console.log('  页面诊断：');
  for (const [k, v] of Object.entries(pageDiag)) {
    if (Array.isArray(v) && v.length === 0) continue;
    console.log(`    ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
}
if (failed.length) {
  console.log('\n失败明细：');
  for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? `  — ${f.detail}` : ''}`);
}
if (!KEEP_SHOTS && failed.length === 0) {
  for (const s of shots) { try { rmSync(s, { force: true }); } catch { /* 忽略 */ } }
}
cleanup();
process.exit(failed.length ? 1 : 0);
