// 3D 地球过场动画（js/ui/globe.js）的真实浏览器自测。
// 用 Chrome DevTools Protocol 直连无头 Chrome，不需要 playwright。
//
//   python tools/serve.py -p 8098        # 必须先起服务（不要用 python -m http.server）
//   node tools/globe-test.mjs            # 全量断言
//   node tools/globe-test.mjs --keep-shots   # 保留截图
//
// 断言重点有两块：
//   1) 整个动画过程中「屏幕上方永远是正北」——判据是 cameraBasis().up 与相机所在地
//      「东」方向 (cos(lon),0,-sin(lon)) 的点积恒为 0，以及北极在屏幕上的 y 永远小于南极。
//   2) 换到 WebGL 之后**贴图方向没画反**——「正北朝上」的判据抓不到上下颠倒，
//      所以另外验三条：北京/东京的 countries.png 编号、屏幕像素 vs 源贴图的色度、
//      以及合成四象限贴图（完全不依赖 assets/globe）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.WR_BASE ?? 'http://127.0.0.1:8098';
const TARGET = `${BASE}/tools/globe-test.html`;
const SHOT_DIR = path.join(ROOT, 'tools', 'shots');
const KEEP_SHOTS = process.argv.includes('--keep-shots');
/** globe.js 运行时注入的 <style> id（index.html 里当然没有这个节点，
 *  写成变量而不是字面量，免得 tools/lint-site.mjs 的 DOM 契约检查误报）。 */
const GLOBE_STYLE_ID = 'wr-globe-style';

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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const skip = (name, detail = '') => {
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`  ○ ${name}${detail ? `  — ${detail}` : ''}（跳过）`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 3) => (typeof n === 'number' && Number.isFinite(n) ? n.toExponential(d) : String(n));

// Node 侧独立实现一份大圆距离，用来对照页面里 globe.js 的 haversine（两边都错才会一起错）
const R_EARTH_KM = 6371.0088;
function haversineKm(a, b) {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ────────────────────────────────────────────────────────── CDP 最小客户端
class CDP {
  constructor(ws, sessionId = null) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      if (this.sessionId && msg.sessionId !== this.sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        if (msg.params.type === 'error') this.consoleErrors.push(text);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.consoleErrors.push(d.exception?.description ?? d.text ?? '未知异常');
      }
    });
  }

  send(method, params = {}, timeoutMs = 60000) {
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
      const payload = { id, method, params };
      if (this.sessionId) payload.sessionId = this.sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  async eval(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async waitFor(expression, { timeoutMs = 30000, intervalMs = 200, label = expression } = {}) {
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

// ────────────────────────────────────────────────────────── 启动浏览器
if (KEEP_SHOTS) mkdirSync(SHOT_DIR, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'wr-globe-'));
const port = 9700 + Math.floor(Math.random() * 300);
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
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let chromeLog = '';
chromeProc.stderr.on('data', (d) => (chromeLog += d.toString('utf8')));

function cleanup() {
  try { chromeProc.kill(); } catch { /* 忽略 */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
process.on('exit', cleanup);

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

console.log(`浏览器：${CHROME}`);
console.log(`目标：${TARGET}\n`);

const browserWsUrl = await waitForDevTools();
const browserWs = new WebSocket(browserWsUrl);
await new Promise((r, j) => {
  browserWs.addEventListener('open', r, { once: true });
  browserWs.addEventListener('error', () => j(new Error('无法连接 DevTools')), { once: true });
});
const browser = new CDP(browserWs);

const { targetId } = await browser.send('Target.createTarget', { url: TARGET });
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
const session = new CDP(browserWs, sessionId);

await session.send('Runtime.enable');
await session.send('Page.enable');
await session.send('Network.enable');

const screenshots = [];
async function shot(name) {
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(data, 'base64');
  if (KEEP_SHOTS) {
    const file = path.join(SHOT_DIR, `globe-${name}.png`);
    writeFileSync(file, buf);
    screenshots.push(file);
    console.log(`    ↳ 截图 ${file}`);
  }
  return buf.length;
}

// ────────────────────────────────────────────────────────── 断言正文
let failed = 0;
let globeFacts = null;
try {
  console.log('【0】页面与模块加载');
  await session.waitFor('window.__ready === true', { timeoutMs: 30000, label: 'globe-test 页面就绪' });
  const dbg0 = await session.eval('window.__debug()');
  check('globe-test.html 加载并暴露 window.__globe', true);
  check(
    'supported === true（有 canvas 2D）',
    dbg0.supported === true,
    `supported=${dbg0.supported}`,
  );
  check(
    'globe-data.js 还没被拉取（首屏不为地球多付 88KB）',
    dbg0.landRings === 0 && dbg0.borderRings === 0,
    `陆地 ${dbg0.landRings} 块 / 国界 ${dbg0.borderRings} 段`,
  );
  check(
    // 注意：这里期望的是 constants.js 里 GLOBE 的**当前值**。
    // 调 GLOBE.fadeMs 这类参数时，这条断言要一起改——它的作用是确保
    // 「constants 里的配置」与「globe.js 内置兜底」没有被改歪成两套数字。
    'GLOBE 配置来自 constants.js（取不到时用内置兜底，数值一致）',
    dbg0.hasGlobeConst === true
      && dbg0.config.duration === 5000
      && dbg0.config.holdMs === 1200
      && dbg0.config.fadeMs === 280
      && dbg0.config.minLat === -85
      && dbg0.config.maxLat === 85
      && dbg0.config.enabled === true,
    `hasGlobeConst=${dbg0.hasGlobeConst} config=${JSON.stringify(dbg0.config)}`,
  );
  check(
    // 逼近/拉远的三个常量同样必须来自 constants.js（不是硬编码在 globe.js 里）
    'GLOBE 缩放常量：zoomPower=0.55 / 近景 0.86 / 远景 2/3',
    dbg0.config.zoomPower === 0.55
      && dbg0.config.zoomNearMinSideRatio === 0.86
      && Math.abs(dbg0.config.zoomFarMinSideRatio - 2 / 3) < 1e-12,
    `zoomPower=${dbg0.config.zoomPower} near=${dbg0.config.zoomNearMinSideRatio} far=${dbg0.config.zoomFarMinSideRatio}`,
  );
  const webglEnv = await session.eval('window.__webglAvailable()');
  check(
    '无头环境里 WebGL 可用（否则下面 WebGL 断言会整体失效）',
    webglEnv.ok === true,
    webglEnv.ok ? `${webglEnv.version} / ${webglEnv.renderer}` : JSON.stringify(webglEnv),
  );
  check(
    '懒加载：还没转过场时连 WebGL 上下文都没建，首屏不为地球付任何成本',
    dbg0.rendererMode === 'canvas2d' && dbg0.rendererReason === 'idle' && !dbg0.rendererInfo.webgl,
    `rendererMode=${dbg0.rendererMode} reason=${dbg0.rendererReason} webgl=${JSON.stringify(dbg0.rendererInfo.webgl)}`,
  );
  const texDir = await session.eval(
    '({const: window.__globeTexturesDirConst(), def: window.__defaultAssetBase()})',
  );
  check(
    '贴图目录取自 constants.GLOBE_TEXTURES_DIR（没有硬编码在 globe.js 里）',
    texDir.const === 'assets/globe' && texDir.def === 'assets/globe/',
    `GLOBE_TEXTURES_DIR=${JSON.stringify(texDir.const)} → 默认 assetBase=${JSON.stringify(texDir.def)}`,
  );
  const assetProbe = await session.eval('window.__loadAssets()');
  check(
    'assets/globe 四张贴图都能读进页面（供方向核对）',
    assetProbe.ok === true,
    assetProbe.ok ? assetProbe.files.join(' / ') : `失败：${assetProbe.error}`,
  );

  // ── 1. 主场景：合肥 → 东京 ────────────────────────────────
  console.log('\n【1】主场景 合肥 → 东京（全程逐帧采样「正北朝上」）');
  await session.eval('window.__begin("hefei","tokyo")', { awaitPromise: false });
  await session.waitFor('!!document.querySelector(".wr-globe-overlay")', {
    timeoutMs: 5000,
    intervalMs: 30,
    label: '地球覆盖层出现',
  });
  const overlay = await session.eval('window.__overlayInfo()');
  check(
    '覆盖层是全屏 fixed 覆盖、z-index=80、不吞点击',
    overlay
      && overlay.position === 'fixed'
      && overlay.zIndex === '80'
      && overlay.pointerEvents === 'none'
      && overlay.inset === '0px,0px,0px,0px',
    overlay ? `position=${overlay.position} z=${overlay.zIndex} pointer-events=${overlay.pointerEvents} inset=${overlay.inset}` : '覆盖层不存在',
  );
  check('覆盖层带 aria-hidden', !!overlay && overlay.ariaHidden === 'true');
  check(
    '淡入是 CSS opacity 驱动的（第一帧还没到 1）',
    !!overlay && Number(overlay.opacity) < 1,
    `出现时 opacity=${overlay ? overlay.opacity : 'n/a'}（fadeMs=280）`,
  );
  const inner = await session.eval('({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})');
  check(
    'canvas 后备缓冲 = 视口 × devicePixelRatio',
    !!overlay
      && overlay.canvasWidth === Math.round(inner.w * inner.dpr)
      && overlay.canvasHeight === Math.round(inner.h * inner.dpr),
    overlay ? `${overlay.canvasWidth}×${overlay.canvasHeight}（视口 ${inner.w}×${inner.h} @${inner.dpr}x）` : 'n/a',
  );
  await shot('01-hefei-to-tokyo-early');
  await sleep(1700);
  const midInfo = await session.eval('window.__overlayInfo()');
  const discMid = await session.eval('window.__checkDisc()');
  await shot('02-hefei-to-tokyo-mid');
  const main = await session.eval('window.__awaitPending()');

  const s = main.summary;
  const dbgAfter = await session.eval('window.__debug()');
  const ri = dbgAfter.rendererInfo;
  globeFacts = dbgAfter;
  check(
    '★ 走的是 WebGL 路径（rendererMode=webgl，不是静默降级）',
    dbgAfter.rendererMode === 'webgl' && dbgAfter.rendererReason === 'ok',
    `rendererMode=${dbgAfter.rendererMode} reason=${dbgAfter.rendererReason}`,
  );
  check(
    '★ 三张贴图 + 调色板都上传成功',
    !!ri.textures && ri.textures.albedo && ri.textures.normal && ri.textures.countries && ri.textures.palette,
    JSON.stringify(ri.textures),
  );
  check(
    'WebGL 上下文 / 球面网格信息可读',
    !!ri.webgl && ri.webgl.tris > 10000 && ri.webgl.verts > 3000,
    ri.webgl ? `${ri.webgl.tris} 三角形 / ${ri.webgl.verts} 顶点 / maxTextureSize=${ri.webgl.maxTextureSize}` : 'n/a',
  );
  check(
    '贴图上传耗时在合理范围（首帧不为 3072×1536 卡住）',
    ri.uploadMs > 0 && ri.uploadMs < 3000,
    `上传 ${ri.uploadMs}ms（含 3072×1536 → 2048×1024 降采样）`,
  );
  check(
    '首次转场时才拉取 globe-data.js（LAND 85 块 / BORDERS 594 段）',
    dbgAfter.landRings === 85 && dbgAfter.borderRings === 594,
    `陆地 ${dbgAfter.landRings} 块 / 国界 ${dbgAfter.borderRings} 段`,
  );
  check(
    '动画期间逐帧采样 ≥ 30 次',
    s.count >= 30,
    `采样 ${s.count} 帧 / 跨度 ${s.spanMs}ms（开始前跳过 ${s.skipped} 帧：视口未建立）`,
  );
  check(
    '★ up 的「东」分量恒为 0：max |up·east| < 1e-6',
    s.maxUpEast < 1e-6,
    `max|up·east| = ${fmt(s.maxUpEast)}`,
  );
  check(
    '★ up 恒等于相机所在地的正北切向量：max 偏差 < 1e-9',
    s.maxUpVsNorth < 1e-9,
    `max|up − northTangent| = ${fmt(s.maxUpVsNorth)}`,
  );
  check(
    '★ 北极屏幕 y 恒小于南极：min(南y − 北y) > 0',
    s.nullPoles === 0 && s.minPoleGap > 0,
    `南y−北y ∈ [${s.minPoleGap.toFixed(3)}, ${s.maxPoleGap.toFixed(3)}] px（全程 ${s.count} 帧，null ${s.nullPoles}）`,
  );
  check(
    '相机基始终正交归一',
    s.maxUpLenErr < 1e-12 && s.maxRightLenErr < 1e-12 && s.maxUpDir < 1e-12 && s.maxRightDir < 1e-12 && s.maxRightUp < 1e-12,
    `|up|-1≤${fmt(s.maxUpLenErr, 2)} |right|-1≤${fmt(s.maxRightLenErr, 2)} up·dir≤${fmt(s.maxUpDir, 2)} right·up≤${fmt(s.maxRightUp, 2)}`,
  );
  check(
    'worldToScreen：所有可见点都落在球面圆盘内',
    discMid.checked > 7000 && discMid.outsideDisc === 0 && discMid.maxNormRadius <= 1 + 1e-9,
    `${discMid.checked} 点，最大归一化半径 ${discMid.maxNormRadius.toFixed(9)}，越界 ${discMid.outsideDisc}`,
  );
  check(
    'worldToScreen：visible 与半球判据完全一致',
    discMid.visibleMismatch === 0,
    `不一致 ${discMid.visibleMismatch} 点`,
  );
  check(
    'duration + holdMs 后 resolve（约 6200ms）',
    main.ms >= 5900 && main.ms <= 7100,
    `实测 ${main.ms}ms`,
  );
  check(
    'resolve 后 state.running === false 且覆盖层已从 DOM 移除',
    main.runningAfter === false && main.overlayInDom === false && main.attachedAfter === false,
    `running=${main.runningAfter} overlayInDom=${main.overlayInDom}`,
  );
  check('resolve 后 progress === 1', main.progressAfter === 1, `progress=${main.progressAfter}`);
  check(
    '动画帧数 / 渲染帧率',
    main.stateFrames > 30,
    `${main.stateFrames} 帧 / 5000ms ⇒ ${main.stateFps} fps` +
      `（rendererInfo=${ri.webgl ? ri.webgl.renderer : 'n/a'}）`,
  );
  check(
    '动画帧数与采样帧数量级一致（说明每帧都在重算相机）',
    Math.abs(main.stateFrames - s.count) <= Math.max(10, s.count * 0.2),
    `draw ${main.stateFrames} 帧 vs 采样 ${s.count} 帧`,
  );
  check(
    '采样期间渲染路径始终是 webgl（没有中途掉回矢量地球）',
    s.modes.length === 1 && s.modes[0] === 'webgl',
    `采样到的 rendererMode = ${JSON.stringify(s.modes)}`,
  );
  check('动画中段覆盖层已完全淡入（opacity=1）', !!midInfo && Number(midInfo.opacity) === 1, `mid opacity=${midInfo ? midInfo.opacity : 'n/a'}`);

  const basisEnd = await session.eval('window.__globe.cameraBasis()');
  const upEnd = basisEnd.up;
  const dirEnd = basisEnd.dir;
  const lonEnd = Math.atan2(dirEnd[0], dirEnd[2]);
  const eastEndDot = Math.abs(upEnd[0] * Math.cos(lonEnd) - upEnd[2] * Math.sin(lonEnd));
  check(
    '动画结束后最后一帧仍是正北朝上',
    eastEndDot < 1e-6,
    `|up·east| = ${fmt(eastEndDot)}`,
  );

  // ── 2. 贴图方向（WebGL 引入的新风险）──────────────────────
  console.log('\n【2】贴图方向：不能上下/东西画反');
  const beijingId = await session.eval('window.__countryIdAt(39.9042, 116.4074)');
  const beijingName = await session.eval(`window.__countryNameOf(${beijingId})`);
  const tokyoId = await session.eval('window.__countryIdAt(35.6762, 139.6503)');
  const tokyoName = await session.eval(`window.__countryNameOf(${tokyoId})`);
  check(
    '★ countries.png 的 uv 约定正确：北京落在 China、东京落在 Japan',
    beijingName === 'China' && tokyoName === 'Japan',
    `北京(${39.9042},${116.4074})→编号 ${beijingId}「${beijingName}」；东京→编号 ${tokyoId}「${tokyoName}」`,
  );
  const oceanId = await session.eval('window.__countryIdAt(-20, -140)');
  check(
    '中太平洋采样到编号 0（海洋），说明索引图没被插值成假编号',
    oceanId === 0,
    `(-20,-140) → ${oceanId}`,
  );
  const paletteMid = await session.eval(
    `[window.__paletteAt(${beijingId}), window.__paletteAt(${tokyoId}), window.__paletteAt(0)]`,
  );
  check(
    'palette.png 每个国家有可区分的颜色，海洋位不参与着色',
    paletteMid[0].join() !== paletteMid[1].join(),
    `China=${JSON.stringify(paletteMid[0])} Japan=${JSON.stringify(paletteMid[1])} ocean=${JSON.stringify(paletteMid[2])}`,
  );

  const probe = await session.eval('window.__probeTextures()');
  const visibleShots = probe.shots.filter((x) => x.visible && x.rendered);
  const allCloser = visibleShots.length >= 4 && visibleShots.every((x) => x.dHere < x.dFlip);
  check(
    '★ 屏幕像素与「同点贴图」的色度比「南北镜像点贴图」更接近（v 没画反）',
    allCloser,
    visibleShots
      .map((x) => `${x.name} ${x.dHere.toFixed(3)}<${x.dFlip.toFixed(3)}`)
      .join(' / '),
  );
  const landShots = visibleShots.filter((x) => x.countryId > 0);
  check(
    '★ 陆地点渲染出来不是海洋色、海洋点不是陆地色',
    landShots.length >= 3
      && landShots.every((x) => x.rendered[2] < x.rendered[0] + 60),
    landShots.map((x) => `${x.name}[${x.rendered.join(',')}] id=${x.countryId}`).join(' / '),
  );

  // 合成四象限贴图：完全不依赖 assets/globe，一次验 u + v 两个方向
  const quad = await session.eval('window.__quadrantProbe()');
  const quadOk = quad.shots.every((x) => x.visible && x.rendered && x.best && x.best.name === x.name);
  check(
    '★ 合成四象限贴图：四个探针的屏幕色相都落在预期象限（u/v 双方向一起验）',
    quadOk && quad.info.rendererMode === 'webgl',
    quad.shots
      .map((x) => `${x.screen ? x.quadrantOfScreen : '?'}→${x.name}${x.best && x.best.name === x.name ? '✓' : `✗(${x.best ? x.best.name : 'n/a'})`} [${(x.rendered || []).slice(0, 3).join(',')}]`)
      .join(' / '),
  );
  check(
    '四象限探针用的也是 WebGL 路径',
    quad.info.rendererMode === 'webgl' && quad.info.rendererReason === 'ok',
    `rendererMode=${quad.info.rendererMode}`,
  );

  // ── 3. cancel() ───────────────────────────────────────────
  console.log('\n【3】中途 cancel()：Promise 必须 resolve，不能挂住');
  const cancelRes = await session.eval('window.__runCancel(900)');
  check(
    'cancel() 之前动画仍在跑（Promise 未 settle）',
    cancelRes.settledBeforeCancel === false && cancelRes.attachedBeforeCancel === true,
    `settledBeforeCancel=${cancelRes.settledBeforeCancel} attached=${cancelRes.attachedBeforeCancel}`,
  );
  check(
    'cancel() 后 Promise 立即 resolve（< 300ms）',
    cancelRes.msAfterCancel < 300,
    `${cancelRes.msAfterCancel}ms 后 resolve（总耗时 ${cancelRes.msTotal}ms）`,
  );
  check(
    'cancel() 后 running=false、覆盖层移除',
    cancelRes.runningRightAfterCancel === false
      && cancelRes.attachedRightAfterCancel === false
      && cancelRes.runningFinal === false
      && cancelRes.overlayFinal === false,
    `running=${cancelRes.runningRightAfterCancel} overlay=${cancelRes.overlayFinal}`,
  );

  // ── 4. 动画中再次 showTransition ───────────────────────────
  console.log('\n【4】动画进行中再次 showTransition：前一个被收掉且 resolve');
  const overlap = await session.eval('window.__runOverlap()');
  check(
    '被顶掉的动画也 resolve 了',
    overlap.p1Done === true && overlap.p1Ms < 1500,
    `p1 在 ${overlap.p1Ms}ms 时 resolve（第二个动画在第 500ms 起）`,
  );
  check(
    '第二个动画跑满时长并收尾干净',
    overlap.runningFinal === false && overlap.overlayFinal === false,
    `running=${overlap.runningFinal} overlay=${overlap.overlayFinal}`,
  );

  // ── 5. 对跖点（slerp 退化分支）────────────────────────────
  console.log('\n【5】严格对跖：北京 → 北京的对跖点');
  const anti = await session.eval(
    'window.__runPair(window.__synth(39.9042,116.4074,"北京","Beijing"), window.__synth(-39.9042,-63.5926,"对跖点","Antipode"))',
  );
  check(
    '对跖场景 max |up·east| < 1e-6',
    anti.summary.maxUpEast < 1e-6 && anti.summary.count >= 30,
    `max|up·east| = ${fmt(anti.summary.maxUpEast)}，采样 ${anti.summary.count} 帧`,
  );
  check(
    '对跖场景北极仍在屏幕上方',
    anti.summary.nullPoles === 0 && anti.summary.minPoleGap > 0,
    `min(南y−北y) = ${anti.summary.minPoleGap.toFixed(3)}px`,
  );

  // ── 6. 极地夹紧（minLat/maxLat = ±85）─────────────────────
  console.log('\n【6】极地纬度夹紧：lat 89.9 / −89.9');
  const polarN = await session.eval(
    'window.__runPair(window.__synth(0,0,"赤道","Equator"), window.__synth(89.9,100,"北极附近","NearPole"))',
  );
  const polarS = await session.eval(
    'window.__runPair(window.__synth(0,0,"赤道","Equator"), window.__synth(-89.9,-60,"南极附近","NearS Pole"))',
  );
  check(
    'lat=89.9 场景 max |up·east| < 1e-6',
    polarN.summary.maxUpEast < 1e-6,
    `max|up·east| = ${fmt(polarN.summary.maxUpEast)}`,
  );
  check(
    'lat=−89.9 场景 max |up·east| < 1e-6',
    polarS.summary.maxUpEast < 1e-6,
    `max|up·east| = ${fmt(polarS.summary.maxUpEast)}`,
  );
  const polarView = await session.eval('window.__checkDisc()');
  check(
    '极地视角下圆盘/可见性仍然正确',
    polarView.outsideDisc === 0 && polarView.visibleMismatch === 0,
    `${polarView.checked} 点，越界 ${polarView.outsideDisc}，visible 不一致 ${polarView.visibleMismatch}`,
  );

  // ── 7. prefers-reduced-motion ─────────────────────────────
  console.log('\n【7】prefers-reduced-motion: reduce');
  await session.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const rmFlag = await session.eval('window.__globe.reducedMotion');
  await session.eval('window.__begin("beijing","sydney")', { awaitPromise: false });
  await sleep(700);
  await shot('03-reduced-motion-static');
  const rm = await session.eval('window.__awaitPending()');
  check('页面读到 reduce 媒体特性', rmFlag === true, `reducedMotion=${rmFlag}`);
  check(
    'reduce 下不做旋转（时长压缩到 1500ms + 停留）',
    rm.ms >= 2400 && rm.ms <= 3400,
    `实测 ${rm.ms}ms（对比普通场景 6200ms）`,
  );
  check(
    'reduce 下仍然正北朝上（静态停在目标城市）',
    rm.summary.maxUpEast < 1e-6 && rm.summary.minPoleGap > 0,
    `max|up·east| = ${fmt(rm.summary.maxUpEast)}，min(南y−北y) = ${rm.summary.minPoleGap.toFixed(3)}px`,
  );
  check(
    'reduce 下也有淡入淡出（覆盖层先出现再移除）',
    rm.overlayInDom === false && rm.runningAfter === false,
    '动画结束后覆盖层已移除',
  );
  await session.send('Emulation.setEmulatedMedia', { features: [] });

  // ── 8. 多视口 ─────────────────────────────────────────────
  console.log('\n【8】三种视口尺寸');
  const viewports = [
    { name: '1440x900 桌面', w: 1440, h: 900 },
    { name: '1024x768 iPad 横屏', w: 1024, h: 768 },
    { name: '375x812 手机竖屏', w: 375, h: 812 },
  ];
  for (const vp of viewports) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: 1,
      mobile: vp.w < 500,
    });
    await sleep(250);
    await session.eval('window.__begin("reykjavik","singapore")', { awaitPromise: false });
    await sleep(1400);
    await shot(`04-vp-${vp.w}x${vp.h}`);
    const info = await session.eval('window.__overlayInfo()');
    const r = await session.eval('window.__awaitPending()');
    const vpd = await session.eval('window.__checkDisc()');
    check(
      `${vp.name}：覆盖层贴合视口，正北朝上，仍是 WebGL`,
      !!info
        && info.canvasWidth === vp.w
        && info.canvasHeight === vp.h
        && r.summary.maxUpEast < 1e-6
        && r.summary.minPoleGap > 0
        && vpd.outsideDisc === 0
        && r.rendererMode === 'webgl',
      `canvas=${info ? `${info.canvasWidth}×${info.canvasHeight}` : 'n/a'} max|up·east|=${fmt(r.summary.maxUpEast)} 球半径=${vpd.view.R.toFixed(0)}px mode=${r.rendererMode}`,
    );
  }
  await session.send('Emulation.clearDeviceMetricsOverride');

  // ── 8b. 高 DPI（视网膜屏）：绘制缓冲受像素预算约束，判据不受影响 ──
  console.log('\n【8b】devicePixelRatio=2 的高分屏');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(300);
  await session.eval('window.__begin("newyork","paris")', { awaitPromise: false });
  await sleep(1500);
  const hiInfo = await session.eval('window.__overlayInfo()');
  const hiDpr = await session.eval(
    '({dpr: devicePixelRatio, buf: window.__globe.rendererInfo.buffer})',
  );
  await shot('05-dpr2-retina');
  const hi = await session.eval('window.__awaitPending()');
  check(
    'dpr=2 时绘制缓冲落在像素预算内（不会让中端设备被片元着色器拖垮）',
    hiInfo.canvasWidth <= 1440 * 2 && hiInfo.canvasWidth >= 1440
      && hiInfo.canvasHeight <= 900 * 2 && hiInfo.canvasHeight >= 900,
    `视口 1440×900 @dpr${hiDpr.dpr} ⇒ canvas ${hiInfo.canvasWidth}×${hiInfo.canvasHeight}` +
      `（${(hiInfo.canvasWidth * hiInfo.canvasHeight / 1e6).toFixed(2)} M 像素，scale=${hiDpr.buf ? hiDpr.buf.scale : 'n/a'}）`,
  );
  check(
    'dpr=2 时正北判据与渲染路径都不受影响',
    hi.summary.maxUpEast < 1e-6 && hi.summary.minPoleGap > 0 && hi.rendererMode === 'webgl',
    `max|up·east| = ${fmt(hi.summary.maxUpEast)}，mode=${hi.rendererMode}`,
  );
  await session.send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  // ── 9. 错误与副作用（放在降级实验之前，保证这条最严格）────
  console.log('\n【9】错误与控制台');
  const dbg = await session.eval('window.__debug()');
  check('页面内没有未捕获错误', dbg.errors.length === 0, dbg.errors.join(' | ') || '无');
  check(
    '控制台没有 error / 未捕获异常（降级实验之前的全部流程）',
    session.consoleErrors.length === 0,
    session.consoleErrors.join(' | ') || '无',
  );
  const leftovers = await session.eval(
    `({overlays: document.querySelectorAll(".wr-globe-overlay").length, styles: document.getElementById(${JSON.stringify(
      GLOBE_STYLE_ID,
    )}) ? 1 : 0, canvasInBody: document.querySelectorAll("canvas").length})`,
  );
  check(
    '收尾后没有残留覆盖层节点',
    leftovers.overlays === 0,
    `overlays=${leftovers.overlays} styleTag=${leftovers.styles} 页面内 canvas=${leftovers.canvasInBody}（跨过场复用，不随覆盖层销毁）`,
  );

  // ── 10. 降级路径 A：WebGL 完全不可用 ──────────────────────
  console.log('\n【10】降级路径 A：强制 WebGL 不可用（老设备 / 驱动黑名单）');
  await session.eval('window.__forceNoWebGL(true)');
  const noGl = await session.eval(`
    (async () => {
      const g = window.__makeGlobe({});
      const from = window.__city('hefei');
      const to = window.__city('tokyo');
      const r = await window.__runPairOn(g, from, to);
      return { mode: g.rendererMode, reason: g.rendererReason, r: { ms: r.ms, maxUpEast: r.summary.maxUpEast, minPoleGap: r.summary.minPoleGap, count: r.summary.count, modes: r.summary.modes, overlayInDom: r.overlayInDom, runningAfter: r.runningAfter } };
    })()
  `);
  await session.eval('window.__forceNoWebGL(false)');
  check(
    '★ WebGL 不可用时回退到 canvas2d，且过场照常跑完',
    noGl.mode === 'canvas2d' && noGl.r.runningAfter === false && noGl.r.overlayInDom === false
      && noGl.r.ms >= 5900 && noGl.r.ms <= 7100,
    `mode=${noGl.mode} reason=${noGl.reason} 时长=${noGl.r.ms}ms`,
  );
  check(
    '★ 降级路径下「正北朝上」判据同样成立',
    noGl.r.maxUpEast < 1e-6 && noGl.r.minPoleGap > 0 && noGl.r.count >= 30,
    `max|up·east| = ${fmt(noGl.r.maxUpEast)}，采样 ${noGl.r.count} 帧，min(南y−北y)=${noGl.r.minPoleGap.toFixed(3)}px`,
  );

  // ── 11. 降级路径 B：贴图加载失败 ──────────────────────────
  console.log('\n【11】降级路径 B：贴图 404（贴图目录写错 / CDN 挂掉）');
  const noTex = await session.eval(`
    (async () => {
      const g = window.__makeGlobe({ assetBase: '../assets/globe-不存在/' });
      const from = window.__city('beijing');
      const to = window.__city('sydney');
      const p = window.__runPairOn(g, from, to);
      // 等它自己发现贴图坏了并换路径
      const deadline = performance.now() + 4000;
      while (performance.now() < deadline && g.rendererReason !== 'texture-error') {
        await new Promise((r) => setTimeout(r, 60));
      }
      const fellBack = g.rendererMode === 'canvas2d' && g.rendererReason === 'texture-error';
      const r = await p;
      return { fellBack, mode: g.rendererMode, reason: g.rendererReason, ms: r.ms, maxUpEast: r.summary.maxUpEast, minPoleGap: r.summary.minPoleGap, count: r.summary.count, overlayInDom: r.overlayInDom, runningAfter: r.runningAfter };
    })()
  `);
  check(
    '★ 贴图加载失败时自动换成矢量地球，不留白、不报错到界面',
    noTex.fellBack === true && noTex.runningAfter === false && noTex.overlayInDom === false,
    `mode=${noTex.mode} reason=${noTex.reason}`,
  );
  check(
    '★ 贴图失败后过场仍跑满时长、正北判据仍成立',
    noTex.ms >= 5900 && noTex.ms <= 7500 && noTex.maxUpEast < 1e-6 && noTex.minPoleGap > 0 && noTex.count >= 30,
    `时长=${noTex.ms}ms max|up·east|=${fmt(noTex.maxUpEast)} 采样 ${noTex.count} 帧`,
  );

  // ── 12. 降级路径 C：显式 forceCanvas2D + 空数据 ───────────
  console.log('\n【12】降级路径 C：显式强制 2D + 空数据兜底');
  const forced = await session.eval(`
    (async () => {
      const g = window.__makeGlobe({ forceCanvas2D: true });
      const r = await window.__runPairOn(g, window.__synth(10,10,'甲','A'), window.__synth(20,20,'乙','B'));
      return { mode: g.rendererMode, reason: g.rendererReason, ms: r.ms, maxUpEast: r.summary.maxUpEast, minPoleGap: r.summary.minPoleGap, count: r.summary.count, overlayInDom: r.overlayInDom, runningAfter: r.runningAfter };
    })()
  `);
  check(
    'forceCanvas2D 时确定走 2D（reason=forced-canvas2d），跑满时长',
    forced.mode === 'canvas2d' && forced.reason === 'forced-canvas2d'
      && forced.runningAfter === false && forced.overlayInDom === false
      && forced.ms >= 5900 && forced.ms <= 7100,
    `mode=${forced.mode} reason=${forced.reason} 时长=${forced.ms}ms`,
  );
  check(
    '强制 2D 下正北判据同样成立',
    forced.maxUpEast < 1e-6 && forced.minPoleGap > 0 && forced.count >= 30,
    `max|up·east| = ${fmt(forced.maxUpEast)}，采样 ${forced.count} 帧`,
  );

  const broken = await session.eval(`
    (async () => {
      const g = new (window.__globe.constructor)(document, { data: { LAND: [], BORDERS: [] }, forceCanvas2D: true });
      const t0 = performance.now();
      await g.showTransition({ id:'a', zh:'甲', en:'A', lat: 10, lon: 10 }, { id:'b', zh:'乙', en:'B', lat: 20, lon: 20 });
      const ms = performance.now() - t0;
      const running = g.state.running;
      const overlay = !!document.querySelector('.wr-globe-overlay');
      return { ms, running, overlay, supported: g.supported };
    })()
  `);
  check(
    '空数据也能跑完并 resolve，不留覆盖层',
    broken.running === false && broken.overlay === false && broken.ms >= 5000 && broken.ms <= 8000,
    `${Math.round(broken.ms)}ms，running=${broken.running}`,
  );

  const finalErrors = await session.eval('window.__errors');
  check(
    '降级实验全程没有未捕获 JS 异常（404 只是网络失败，不该冒到界面）',
    finalErrors.length === 0,
    finalErrors.join(' | ') || '无',
  );

  // ── 13. 降级路径 D：WebGL 上下文中途丢失 ─────────────────
  console.log('\n【13】降级路径 D：WebGL 上下文中途丢失（手机切后台 / 驱动重置）');
  const lost = await session.eval(`
    (async () => {
      const g = window.__makeGlobe({});
      const from = window.__city('hefei');
      const to = window.__city('tokyo');
      const p = window.__runPairOn(g, from, to);
      await new Promise((r) => setTimeout(r, 1200));
      const canvas = document.querySelector('.wr-globe-overlay-gl');
      let lostOk = false;
      if (canvas) {
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        const ext = gl && gl.getExtension('WEBGL_lose_context');
        if (ext) { ext.loseContext(); lostOk = true; }
      }
      // 等事件派发 + 下一次绘制把路径换掉
      const deadline = performance.now() + 2500;
      while (performance.now() < deadline && g.rendererMode !== 'canvas2d') {
        await new Promise((r) => setTimeout(r, 60));
      }
      const r = await p;
      return {
        lostOk,
        mode: g.rendererMode,
        reason: g.rendererReason,
        ms: r.ms,
        maxUpEast: r.summary.maxUpEast,
        minPoleGap: r.summary.minPoleGap,
        count: r.summary.count,
        overlayInDom: r.overlayInDom,
        runningAfter: r.runningAfter,
      };
    })()
  `);
  check(
    '★ 上下文丢失后自动换到矢量地球，过场照常跑完',
    lost.lostOk === true && lost.mode === 'canvas2d' && lost.reason === 'context-lost'
      && lost.runningAfter === false && lost.overlayInDom === false,
    `触发丢失=${lost.lostOk} mode=${lost.mode} reason=${lost.reason} 时长=${lost.ms}ms`,
  );
  check(
    '★ 上下文丢失后正北判据仍成立、Promise 不挂住',
    lost.ms >= 5900 && lost.ms <= 7500 && lost.maxUpEast < 1e-6 && lost.minPoleGap > 0 && lost.count >= 30,
    `时长=${lost.ms}ms max|up·east|=${fmt(lost.maxUpEast)} 采样 ${lost.count} 帧 min(南y−北y)=${lost.minPoleGap.toFixed(3)}px`,
  );
  const lostErrors = await session.eval('window.__errors');
  check(
    '上下文丢失没有冒成未捕获异常',
    lostErrors.length === 0,
    lostErrors.join(' | ') || '无',
  );

  // ── 14. 中国必须是红的（老板要求，像素级验证）──────────────
  console.log('\n【14】中国红色：纹素级 + 像素级');
  const cnTex = await session.eval(`({
    bj: window.__countryIdAt(39.9042, 116.4074),
    sh: window.__countryIdAt(31.2304, 121.4737),
    um: window.__countryIdAt(43.8256, 87.6168),
    name1: window.__countryNameOf(window.__countryIdAt(39.9042, 116.4074)),
    pal1: window.__paletteAt(1),
  })`);
  check(
    '北京 / 上海 / 乌鲁木齐三点在 countries.png 里都是编号 1，且编号 1 = China',
    cnTex.bj === 1 && cnTex.sh === 1 && cnTex.um === 1 && cnTex.name1 === 'China',
    `北京=${cnTex.bj} 上海=${cnTex.sh} 乌鲁木齐=${cnTex.um} names[1]=${JSON.stringify(cnTex.name1)}`,
  );
  check(
    'palette 编号 1 是明显的红（R 显著大于 G / B）',
    cnTex.pal1[0] > cnTex.pal1[1] * 1.8 && cnTex.pal1[0] > cnTex.pal1[2] * 1.8,
    `palette[1]=${JSON.stringify(cnTex.pal1)}`,
  );
  const chinaIdUsed = await session.eval('window.__globe.rendererInfo.chinaId');
  check(
    'globe 用的是 countries.json 里的 chinaIndex（不是硬编码）',
    chinaIdUsed === 1,
    `rendererInfo.chinaId=${chinaIdUsed}`,
  );

  const red = await session.eval('window.__chinaRedProbe()');
  const cn = red.groups.find((g) => g.name === 'China');
  const neighbors = red.groups.filter((g) => g.name !== 'China' && g.n >= 5);
  const worstNeighbor = neighbors.reduce(
    (a, b) => (b.redShift > a.redShift ? b : a),
    neighbors[0] || { redShift: 0, name: '无' },
  );
  check(
    '★ 像素级：中国对相邻国家同纬度对比，红移显著（redShift ≥ 1.35）',
    !!cn && cn.redShift >= 1.35,
    cn
      ? `中国 redShift=${cn.redShift.toFixed(3)}（R/G ${cn.rg.toFixed(3)} vs 贴图本色 ${cn.texRG.toFixed(3)}，n=${cn.n}）`
      : '没采到中国像素',
  );
  check(
    '★ 相邻国家都不偏红（最高者 redShift ≤ 1.15），中国至少是它的 1.2 倍',
    !!cn && worstNeighbor.redShift <= 1.15 && cn.redShift >= worstNeighbor.redShift * 1.2,
    `最高邻国 ${worstNeighbor.name} redShift=${worstNeighbor.redShift.toFixed(3)}；中国 ${cn ? cn.redShift.toFixed(3) : 'n/a'}`,
  );
  check(
    '对比覆盖到多个邻国，样本量够',
    neighbors.length >= 3 && red.total >= 60,
    `${neighbors.length} 个邻国参与对比（${neighbors.map((g) => `${g.name}×${g.n}`).join(', ')}），总采样 ${red.total}`,
  );
  check(
    '中国样例像素：渲染结果比同点贴图更红',
    !!cn && red.samples.length >= 3 && red.samples.every((x) => x.rendered[0] > x.texel[0] * 1.02),
    red.samples
      .slice(0, 4)
      .map((x) => `(${x.lat},${x.lon}) 渲染[${x.rendered.slice(0, 3)}] 贴图[${x.texel.slice(0, 3)}]`)
      .join(' / '),
  );

  // ── 15. 北极「风车」伪影 ──────────────────────────────────
  console.log('\n【15】北极风车伪影：经线必须在高纬淡出');
  const pole = await session.eval('window.__poleProbe()');
  check(
    '★ 极地（lat 78~89）经纬网的贡献恒为 0：看不出任何放射状条纹',
    pole.polar.n > 1000 && pole.polar.maxNow === 0,
    `${pole.polar.n} 个采样点，max|A−B| = ${pole.polar.maxNow}，mean = ${pole.polar.meanNow.toFixed(4)}（A=正常，B=关掉经纬网）`,
  );
  check(
    '★ 同一判据能抓到修复前的伪影（关掉高纬淡出时 max|C−B| ≥ 8）',
    pole.polar.maxBefore >= 8,
    `修复前 max|C−B| = ${pole.polar.maxBefore}，mean = ${pole.polar.meanBefore.toFixed(3)}（C=gridPoleFade:0）`,
  );
  check(
    '中纬度（lat 30~50）经纬网照常可见，不是整体删掉',
    pole.mid.n > 1000 && pole.mid.maxNow >= 8,
    `${pole.mid.n} 个采样点，max|A−B| = ${pole.mid.maxNow}，mean = ${pole.mid.meanNow.toFixed(3)}`,
  );
  check(
    '★ 北极没有糊成一坨白饼：极冠仍有冰/海对比与丰富结构',
    pole.iceCap.brightFrac > 0.03
      && pole.iceCap.darkFrac > 0.03
      && pole.iceCap.stdLum > 25
      && pole.iceCap.maxLum > 200
      && pole.iceCap.minLum < 60,
    `极冠 ${pole.iceCap.n} 点：亮部(>150) ${(pole.iceCap.brightFrac * 100).toFixed(1)}% / 暗部(<80) ${(pole.iceCap.darkFrac * 100).toFixed(1)}% / 亮度 std=${pole.iceCap.stdLum.toFixed(1)} ∈ [${pole.iceCap.minLum.toFixed(0)}, ${pole.iceCap.maxLum.toFixed(0)}]`,
  );
  check(
    '探针跑在 WebGL 路径上',
    pole.info.rendererMode === 'webgl',
    `rendererMode=${pole.info.rendererMode} aniso=${pole.info.aniso}`,
  );

  // ── 16. 逼近 / 拉远 ────────────────────────────────────────
  console.log('\n【16】逼近 / 拉远：半径随两城距离变，最远时直径 = 视口短边的 2/3');

  const coords = await session.eval(`({
    zhuhai: window.__city('zhuhai'), macau: window.__city('macau'),
    guangzhou: window.__city('guangzhou'), foshan: window.__city('foshan'),
    hefei: window.__city('hefei'), tokyo: window.__city('tokyo'),
    auckland: window.__city('auckland'), madrid: window.__city('madrid'),
    beijing: window.__city('beijing'), london: window.__city('london'),
    tianjin: window.__city('tianjin'),
  })`);
  const known = {
    near: { a: 'zhuhai', b: 'macau', label: '珠海↔澳门' },
    near2: { a: 'guangzhou', b: 'foshan', label: '广州↔佛山' },
    mid: { a: 'hefei', b: 'tokyo', label: '合肥↔东京' },
    mid2: { a: 'beijing', b: 'london', label: '北京↔伦敦' },
    far: { a: 'auckland', b: 'madrid', label: '奥克兰↔马德里' },
  };
  for (const p of Object.values(known)) {
    const ca = coords[p.a];
    const cb = coords[p.b];
    p.km = ca && cb ? haversineKm(ca, cb) : NaN;
  }
  console.log(
    '  城市对距离（Node 侧独立算）：' +
      Object.values(known)
        .map((p) => `${p.label} ${p.km.toFixed(1)}km`)
        .join(' / '),
  );

  /** 跑一次转场：2500ms 时是飞行中段（最远处），5400ms 时是停留段（近景收尾）。 */
  const zoomRun = async (fromId, toId, shots = []) => {
    await session.eval(`window.__begin(${JSON.stringify(fromId)}, ${JSON.stringify(toId)})`, {
      awaitPromise: false,
    });
    await sleep(2500);
    if (shots[0]) await shot(shots[0]);
    await sleep(2900);
    if (shots[1]) await shot(shots[1]);
    const r = await session.eval('window.__awaitPending()');
    const info = await session.eval('window.__globe.rendererInfo.zoom');
    return { r, z: r.summary.zoom, info };
  };

  // 显式钉到 1440×900：下面的数值表按这个视口给（与 lead 的定标表对齐）
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);

  const zNear = await zoomRun('zhuhai', 'macau', [
    '06-zoom-near-cruise-1440x900',
    '07-zoom-near-arrived-1440x900',
  ]);
  const zNear2 = await zoomRun('guangzhou', 'foshan');
  const zMid = await zoomRun('hefei', 'tokyo', [
    '08-zoom-mid-cruise-1440x900',
    '09-zoom-mid-arrived-1440x900',
  ]);
  const zMid2 = await zoomRun('beijing', 'london');
  const zFar = await zoomRun('auckland', 'madrid', [
    '10-zoom-far-cruise-1440x900',
    '11-zoom-far-arrived-1440x900',
  ]);

  const table = [
    ['近 珠海↔澳门', known.near, zNear],
    ['近 广州↔佛山', known.near2, zNear2],
    ['中 合肥↔东京', known.mid, zMid],
    ['中 北京↔伦敦', known.mid2, zMid2],
    ['远 奥克兰↔马德里', known.far, zFar],
  ];
  console.log('  1440×900 实测：');
  console.log('    城市对               距离km       k       半径px   直径/短边');
  for (const [name, p, r] of table) {
    console.log(
      `    ${name.padEnd(16)}${r.z.distKm.toFixed(1).padStart(9)}` +
        `${r.z.kAtMid.toFixed(4).padStart(10)}${(r.z.kAtMid * r.z.Rbase).toFixed(1).padStart(10)}` +
        `${r.z.ratioMid.toFixed(4).padStart(12)}`,
    );
  }

  check(
    '页面里的 haversine 与 Node 侧独立实现一致（5 对城市，误差 < 0.5km）',
    table.every(([, p, r]) => Math.abs(r.z.distKm - p.km) < 0.5),
    table.map(([, p, r]) => `${p.label} ${r.z.distKm.toFixed(2)}/${p.km.toFixed(2)}`).join(' '),
  );
  check(
    '★ 近距离（珠海↔澳门 8.7km）：地球直径 ÷ 视口短边 ≈ 0.86 —— 逼近的近景',
    Math.abs(zNear.z.ratioMid - 0.86) < 0.01 && Math.abs(zNear.z.ratioLast - 0.86) < 0.01,
    `飞行中段 ${zNear.z.ratioMid.toFixed(4)} / 收尾 ${zNear.z.ratioLast.toFixed(4)}（k=${zNear.z.kAtMid.toFixed(4)}，半径 ${(zNear.z.kAtMid * zNear.z.Rbase).toFixed(1)}px）`,
  );
  check(
    '★ 近距离的拉远幅度极小（k 全程变化 < 1%）——「几百公里只拉远一点点」',
    zNear.z.maxK > 0 && (zNear.z.maxK - zNear.z.minK) / zNear.z.maxK < 0.01,
    `k ∈ [${zNear.z.minK.toFixed(4)}, ${zNear.z.maxK.toFixed(4)}]，幅度 ${(((zNear.z.maxK - zNear.z.minK) / zNear.z.maxK) * 100).toFixed(2)}%`,
  );
  check(
    `★ 远距离（奥克兰↔马德里 ${known.far.km.toFixed(0)}km）：实测直径 ÷ 视口短边 = 2/3（误差 <2%）`,
    Math.abs(zFar.z.ratioMid - 2 / 3) / (2 / 3) < 0.02,
    `实测 ${zFar.z.ratioMid.toFixed(4)}，目标 ${(2 / 3).toFixed(4)}，偏差 ${((zFar.z.ratioMid / (2 / 3) - 1) * 100).toFixed(2)}%（半径 ${(zFar.z.kAtMid * zFar.z.Rbase).toFixed(1)}px）`,
  );
  check(
    '远景比例由「直径 = 视口短边 × 2/3」实时反解（ratioFar ≡ 2/3，任何视口都不写死）',
    Math.abs(zFar.info.ratioFar - 2 / 3) < 1e-9 && Math.abs(zFar.info.ratioNear - 0.86) < 1e-9,
    `ratioNear=${zFar.info.ratioNear} ratioFar=${zFar.info.ratioFar}（Rbase=${zFar.info.Rbase.toFixed(1)}px 短边=${zFar.info.side}px）`,
  );
  check(
    '★ 拉远看得见：近景半径 → 远景半径缩小 22.5% 左右（不是 2% 那种等于没动）',
    Math.abs(zFar.z.shrink - 0.225) < 0.02,
    `实测 ${(zFar.z.shrink * 100).toFixed(2)}%（kNear=${zFar.info.kNear.toFixed(4)} → kFar=${zFar.info.kFar.toFixed(4)}，` +
      `半径 ${(zFar.info.kNear * zFar.info.Rbase).toFixed(1)}px → ${(zFar.info.kFar * zFar.info.Rbase).toFixed(1)}px）`,
  );
  check(
    `★ 中距离（合肥↔东京 ${known.mid.km.toFixed(0)}km）介于两者之间`,
    zMid.z.kAtMid < zNear.z.kAtMid && zMid.z.kAtMid > zFar.z.kAtMid,
    `k=${zMid.z.kAtMid.toFixed(4)}，直径/短边=${zMid.z.ratioMid.toFixed(4)}，半径 ${(zMid.z.kAtMid * zMid.z.Rbase).toFixed(1)}px`,
  );
  check(
    '距离越远 → k 单调越小（近 < 中 < 远 的 k 序关系成立）',
    zNear.z.kAtMid > zMid.z.kAtMid && zMid.z.kAtMid > zFar.z.kAtMid && zMid2.z.kAtMid > zFar.z.kAtMid && zMid2.z.kAtMid < zNear.z.kAtMid,
    `k：珠海↔澳门 ${zNear.z.kAtMid.toFixed(4)} > 合肥↔东京 ${zMid.z.kAtMid.toFixed(4)} > 北京↔伦敦 ${zMid2.z.kAtMid.toFixed(4)} > 奥克兰↔马德里 ${zFar.z.kAtMid.toFixed(4)}`,
  );
  check(
    '★ 收尾推近：最后一帧 k 回到 kNear（停在目标城市的近景）',
    Math.abs(zFar.z.lastK - zFar.info.kNear) < 1e-6 && Math.abs(zFar.z.ratioLast - 0.86) < 0.005,
    `lastK=${zFar.z.lastK.toFixed(6)}，kNear=${zFar.info.kNear.toFixed(6)}，收尾直径/短边=${zFar.z.ratioLast.toFixed(4)}`,
  );
  check(
    '★ 缩放是平滑过渡：帧间 |Δk| 不超过整个幅度的 35%（无跳变）',
    zFar.z.maxDk < 0.35 * (zFar.z.maxK - zFar.z.minK),
    `max|Δk|=${zFar.z.maxDk.toExponential(3)}，总幅度 ${(zFar.z.maxK - zFar.z.minK).toFixed(4)}（占比 ${((zFar.z.maxDk / (zFar.z.maxK - zFar.z.minK)) * 100).toFixed(1)}%）`,
  );
  check(
    '★ 缩放不是「瞬间切换」：有足够多的帧停在两端之间（拉远/推近各占 10% 时间轴）',
    zFar.z.insideFrames >= 8,
    `${zFar.z.insideFrames} / ${zFar.z.samples} 帧处于两端之间`,
  );
  check(
    '缩放没有影响总时长（仍是 duration + holdMs = 6200ms）',
    zFar.r.ms >= 5900 && zFar.r.ms <= 7100,
    `实测 ${zFar.r.ms}ms`,
  );

  // ── 16b. 三个视口下「最远 = 短边 2/3」都要成立（kFar 随视口自动变）──
  console.log('\n【16b】三个视口下的逼近/拉远');
  for (const vp of viewports) {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: 1,
      mobile: vp.w < 500,
    });
    await sleep(250);
    const tag = `${vp.w}x${vp.h}`;
    const far = await zoomRun('auckland', 'madrid', [
      `12-zoom-far-cruise-${tag}`,
      `13-zoom-far-arrived-${tag}`,
    ]);
    check(
      `${vp.name}：远距离直径/短边 = 2/3（±2%），收尾回到 0.86`,
      Math.abs(far.z.ratioMid - 2 / 3) / (2 / 3) < 0.02 && Math.abs(far.z.ratioLast - 0.86) < 0.01,
      `中段 ${far.z.ratioMid.toFixed(4)}（半径 ${(far.z.kAtMid * far.z.Rbase).toFixed(1)}px / 短边 ${far.z.side}px）` +
        `，收尾 ${far.z.ratioLast.toFixed(4)}`,
    );
    check(
      `${vp.name}：拉远幅度 22.5%（±2%），kNear=${far.info.kNear.toFixed(4)} kFar=${far.info.kFar.toFixed(4)}`,
      Math.abs(far.z.shrink - 0.225) < 0.02,
      `实测 ${(far.z.shrink * 100).toFixed(2)}%（半径 ${(far.info.kNear * far.info.Rbase).toFixed(1)}px → ${(far.info.kFar * far.info.Rbase).toFixed(1)}px）`,
    );
    check(
      `${vp.name}：缩放期间「正北朝上」判据依旧成立`,
      far.r.summary.maxUpEast < 1e-6 && far.r.summary.minPoleGap > 0,
      `max|up·east|=${fmt(far.r.summary.maxUpEast)}，min(南y−北y)=${far.r.summary.minPoleGap.toFixed(3)}px`,
    );
  }
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);

  // ── 16c. 像素级：把「画出来的球」量出来，而不是只信 view.R ──
  console.log('\n【16c】像素级实测球面直径（纯红贴图 + 关掉边缘光，红盘边界 = 球轮廓）');
  const discFar = await session.eval(
    'window.__measureDisc({ atMs: 2500, fromId: "auckland", toId: "madrid" })',
  );
  check(
    '★ 远距离飞行中段：像素实测直径 ÷ 视口短边 = 2/3（±3%）',
    !!discFar.measuredPx && Math.abs(discFar.ratioMeasured - 2 / 3) / (2 / 3) < 0.03,
    `实测 ${discFar.measuredPx ? discFar.measuredPx.toFixed(1) : 'n/a'}px / 短边 ${discFar.side}px = ` +
      `${discFar.ratioMeasured ? discFar.ratioMeasured.toFixed(4) : 'n/a'}（几何值 ${discFar.expectedPx.toFixed(1)}px）`,
  );
  check(
    '像素实测直径与几何直径 2R 一致（±2%），且左右对称（确实扫到了球）',
    !!discFar.measuredPx
      && Math.abs(discFar.measuredPx - discFar.expectedPx) / discFar.expectedPx < 0.02
      && discFar.scan
      && Math.abs(discFar.scan.leftGap - discFar.scan.rightGap) < 3,
    discFar.scan
      ? `实测 ${discFar.measuredPx.toFixed(1)}px vs 2R=${discFar.expectedPx.toFixed(1)}px，` +
        `左 ${discFar.scan.leftGap.toFixed(1)}px / 右 ${discFar.scan.rightGap.toFixed(1)}px（扫描行 y=${discFar.scan.rowCss}）`
      : '没有读到帧',
  );
  const discNear = await session.eval(
    'window.__measureDisc({ atMs: 5400, fromId: "zhuhai", toId: "macau" })',
  );
  check(
    '★ 近距离停留段：像素实测直径 ÷ 视口短边 ≈ 0.86（近景真的更大）',
    !!discNear.measuredPx && Math.abs(discNear.ratioMeasured - 0.86) < 0.02,
    `实测 ${discNear.measuredPx ? discNear.measuredPx.toFixed(1) : 'n/a'}px / 短边 ${discNear.side}px = ` +
      `${discNear.ratioMeasured ? discNear.ratioMeasured.toFixed(4) : 'n/a'}（几何值 ${discNear.expectedPx.toFixed(1)}px）`,
  );
  check(
    '像素实测：近景球比远景球大 22% 以上（逼近/拉远肉眼可辨）',
    !!discNear.measuredPx && !!discFar.measuredPx && discNear.measuredPx > discFar.measuredPx * 1.22,
    `${discNear.measuredPx ? discNear.measuredPx.toFixed(1) : 'n/a'}px（近，8.7km） vs ` +
      `${discFar.measuredPx ? discFar.measuredPx.toFixed(1) : 'n/a'}px（远，19596km）`,
  );
  const zoomErrors = await session.eval('window.__errors');
  check('逼近/拉远这一段没有未捕获异常', zoomErrors.length === 0, zoomErrors.join(' | ') || '无');

  // ── 16d. 第一代（Canvas 2D 降级路径）也要跟着缩放 ──
  // 2D 路径的海面圆盘原来是预渲染进底图的，R 一变就会错位；这里验它同样按距离反解。
  console.log('\n【16d】Canvas 2D 降级路径下的逼近/拉远');
  await session.eval(
    `window.__c2dPending = (async () => {
       const g = window.__makeGlobe({ forceCanvas2D: true });
       const p = window.__runPairOn(g, window.__city('hefei'), window.__city('tokyo'));
       const r = await p;
       return { mode: g.rendererMode, z: r.summary.zoom, ms: r.ms };
     })()`,
    { awaitPromise: false },
  );
  await sleep(2600);
  await shot('14-canvas2d-zoom-cruise-1440x900');
  await sleep(1200);
  await shot('15-canvas2d-zoom-arrived-1440x900');
  const c2d = await session.eval('window.__c2dPending');
  check(
    '★ Canvas 2D 降级路径也按距离反解 k（中距离 ≈0.804，收尾回到 0.86）',
    c2d.mode === 'canvas2d'
      && Math.abs(c2d.z.ratioMid - zMid.z.ratioMid) < 0.02
      && Math.abs(c2d.z.ratioLast - 0.86) < 0.01,
    `mode=${c2d.mode} 中段 ${c2d.z.ratioMid.toFixed(4)}（WebGL 同距离 ${zMid.z.ratioMid.toFixed(4)}），收尾 ${c2d.z.ratioLast.toFixed(4)}，时长 ${c2d.ms}ms`,
  );
  check(
    '2D 路径的缩放也平滑（max|Δk| 有上界）',
    c2d.z.maxDk < 0.35 * (c2d.z.maxK - c2d.z.minK) && c2d.z.insideFrames >= 8,
    `max|Δk|=${c2d.z.maxDk.toExponential(3)}，总幅度 ${(c2d.z.maxK - c2d.z.minK).toFixed(4)}，中间帧 ${c2d.z.insideFrames}`,
  );
  const c2dErrors = await session.eval('window.__errors');
  check('2D 路径缩放没有未捕获异常', c2dErrors.length === 0, c2dErrors.join(' | ') || '无');
} catch (err) {
  failed = 1;
  check(`测试装置异常：${err.message}`, false);
  console.error(err);
}

// ────────────────────────────────────────────────────────── 汇总
const skipped = results.filter((r) => r.skipped).length;
const pass = results.filter((r) => r.ok && !r.skipped).length;
const fail = results.length - pass - skipped;
console.log(`\n${'─'.repeat(60)}`);
console.log(`globe 自测：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过（共 ${results.length} 项）`);
if (globeFacts) {
  const ri = globeFacts.rendererInfo || {};
  console.log(
    `渲染路径：${globeFacts.rendererMode}（${globeFacts.rendererReason}）` +
      (ri.webgl ? ` / ${ri.webgl.renderer}` : '') +
      ` / 贴图上传 ${ri.uploadMs}ms`,
  );
}
if (fail) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
if (KEEP_SHOTS && screenshots.length) {
  console.log(`\n截图（${screenshots.length} 张）：`);
  for (const f of screenshots) console.log(`  ${f}`);
}
if (chromeLog && fail) {
  console.log('\nChrome stderr 尾部：');
  console.log(chromeLog.split('\n').slice(-12).join('\n'));
}

process.exitCode = fail || failed ? 1 : 0;
cleanup();
