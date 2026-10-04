// ============================================================================
// 大屏版入口（large.html 专用）
//
// 复用（静态 import，均为已完成契约模块）：
//   js/core/constants.js  FORECAST_DAYS / AUDIO
//   js/core/boot.js       domReady / fetchJSON
//   js/core/weather.js    loadWeather / dailyToDays
//   js/core/utils.js      shuffled / randInt / sleep
//   js/core/format.js     describeCard
//   js/core/paths.js      musicPath
//   js/audio/loader.js    ClipLoader
//   js/audio/manifest.js  loadAudioManifest / audioUrlFor / manifestHas
//   js/ui/large.js        LargeScreen
//
// 自适应（动态 import，队友并行实现中；缺失或接口不符时降级，绝不改他人文件）：
//   js/audio/player.js    Broadcaster  → 不可用时降级为 CardOnlyPlayer（只换卡片不播音）
//   js/audio/music.js     MusicPlayer  → 不可用时音乐按钮显示「不可用」，播报继续
//   js/ui/assets.js       图片清单/候选/probe → 不可用时用 large.js 内置实现
//   js/ui/weather-icon.js 天气图标 → 不可用时用 large.js 内置图标
//
// URL 参数（便于演示与自测，正常访问不需要）：
//   ?city=tokyo     直接从该城市开始播
//   ?day=1          强制使用第 1 天（0 今天 / 1 明天 / 2 后天）
//   ?diag=1         自测模式：暴露 window.__lgScreen/__lgState，并把溢出/字号体检结果
//                   写入 body[data-lg-diag]（不自动开始播报）
//   ?autostart=1    配合 ?diag=1：免手势自动开始（无头浏览器截图用）
// ============================================================================

import { FORECAST_DAYS, AUDIO } from './core/constants.js';
import { domReady, fetchJSON } from './core/boot.js';
import { loadWeather, dailyToDays } from './core/weather.js';
import { shuffled, randInt, sleep } from './core/utils.js';
import { describeCard } from './core/format.js';
import { musicPath } from './core/paths.js';
import { ClipLoader } from './audio/loader.js';
import { loadAudioManifest, audioUrlFor, manifestHas } from './audio/manifest.js';
import { LargeScreen } from './ui/large.js';

const PARAMS = new URLSearchParams(location.search);
const DIAG = PARAMS.has('diag');
const AUTOSTART = PARAMS.has('autostart');
const FORCE_DAY = PARAMS.has('day') ? Number(PARAMS.get('day')) : null;
const START_CITY = PARAMS.get('city');

const CARD_DWELL_MS = 7000;   // 降级模式（无播音）下每城停留时间

const state = {
  cities: [],
  byCity: {},
  source: 'demo',
  cards: [],                  // 原地复用同一个数组引用，Broadcaster / 降级播放器都持有它
  screen: null,
  player: null,
  playerKind: 'none',
  loader: null,
  music: null,                // 适配器（永远存在，方法可能为空操作）
  musicAvailable: false,
  musicOn: false,
  started: false,
  renderToken: 0,
  transientTimer: null,
};

/** 仅在 ?diag=1 时用于自测报告：运行期错误与降级说明 */
const runtimeErrors = [];
const runtimeNotes = [];
window.addEventListener('error', (e) => runtimeErrors.push(String(e.message || e.error || 'error')));
window.addEventListener('unhandledrejection', (e) =>
  runtimeErrors.push(String(e.reason?.message || e.reason || 'unhandledrejection')));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
async function tryImport(loader, label) {
  try {
    return await loader();
  } catch (err) {
    const note = `可选模块不可用，已降级：${label}（${err?.message ?? err}）`;
    console.warn(`[大屏版] ${note}`);
    runtimeNotes.push(note);
    return null;
  }
}

function fallbackDay(city) {
  return {
    date: new Date().toISOString().slice(0, 10),
    code: (city.id.charCodeAt(0) + city.id.length) % 4 === 0 ? 61 : 2,
    tMax: 24,
    tMin: 16,
    precip: 20,
    wind: 10,
  };
}

function buildCards(cities, byCity, firstId = null) {
  let order = shuffled(cities);
  if (firstId) {
    order = [...order.filter((c) => c.id === firstId), ...order.filter((c) => c.id !== firstId)];
  }
  return order.map((city) => {
    const days = dailyToDays(byCity?.[city.id], FORECAST_DAYS);
    const usable = days.length ? days : [fallbackDay(city)];
    const dayIndex = Number.isInteger(FORCE_DAY) && FORCE_DAY >= 0 && FORCE_DAY < usable.length
      ? FORCE_DAY
      : randInt(usable.length);
    return { city, day: usable[dayIndex], dayIndex };
  });
}

/** 原地重建队列：每次加载 / 每次轮播结束都重新洗牌 + 重新随机选天 */
function rebuildQueue(firstId = null) {
  const next = buildCards(state.cities, state.byCity, firstId);
  state.cards.length = 0;
  state.cards.push(...next);
  return state.cards;
}

// ---------------------------------------------------------------------------
// 音乐（MusicPlayer 适配器；实例不可用时给空操作对象，界面永不因此报错）
// ---------------------------------------------------------------------------
function makeNullMusic(reason) {
  return {
    available: false,
    reason,
    start() {}, pause() {}, resume() {}, stop() {}, setVolume() {},
    fadeIn() {}, fadeOut() {},
    get playing() { return false; },
  };
}

function makeMusicAdapter(instance) {
  const call = (name) => (...args) => {
    const fn = instance?.[name];
    if (typeof fn !== 'function') return undefined;
    try {
      const result = fn.apply(instance, args);
      if (result && typeof result.catch === 'function') result.catch(() => {});
      return result;
    } catch (err) {
      console.warn(`[大屏版] 音乐 ${name}() 出错，已忽略：`, err?.message ?? err);
      return undefined;
    }
  };
  return {
    available: true,
    instance,
    start: call('start'), pause: call('pause'), resume: call('resume'),
    stop: call('stop'), setVolume: call('setVolume'),
    fadeIn: call('fadeIn'), fadeOut: call('fadeOut'),
    get playing() {
      try { return Boolean(instance?.playing); } catch { return false; }
    },
  };
}

async function createMusic() {
  const mod = await tryImport(() => import('./audio/music.js'), 'js/audio/music.js');
  const MusicPlayer = mod?.MusicPlayer
    ?? mod?.default?.MusicPlayer
    ?? (typeof mod?.default === 'function' ? mod.default : null);
  if (typeof MusicPlayer !== 'function') return makeNullMusic('js/audio/music.js 尚未提供 MusicPlayer');

  // 构造签名可能微调，按「文档签名 → 只传选项 → 无参」依次尝试
  const attempts = [
    [musicPath(), { volume: AUDIO.musicVolume }],
    [{ volume: AUDIO.musicVolume }],
    [],
  ];
  for (const args of attempts) {
    try {
      const instance = new MusicPlayer(...args);
      if (instance) return makeMusicAdapter(instance);
    } catch (err) {
      console.warn('[大屏版] MusicPlayer 构造失败，尝试下一种签名：', err?.message ?? err);
    }
  }
  return makeNullMusic('MusicPlayer 实例构造失败');
}

// ---------------------------------------------------------------------------
// 降级播放器：Broadcaster 不可用时「只换卡片不播音」
// 对外接口与 Broadcaster 的公开接口保持一致
// ---------------------------------------------------------------------------
class CardOnlyPlayer {
  constructor({ cards, hooks, dwellMs = CARD_DWELL_MS, rebuild = null }) {
    this.cards = cards;
    this.hooks = hooks;
    this.dwellMs = dwellMs;
    this.rebuild = rebuild;
    this.index = -1;
    this.playing = false;
    this.paused = false;
    this.timer = null;
  }

  get state() {
    return { playing: this.playing, paused: this.paused, index: this.index, total: this.cards.length };
  }

  #emit(name, ...args) {
    try { this.hooks?.[name]?.(...args); } catch (err) { console.warn(`[大屏版] hooks.${name} 出错：`, err); }
  }

  #progress() {
    this.#emit('onProgress', {
      index: this.index,
      total: this.cards.length,
      phase: this.paused ? 'paused' : 'playing',
    });
  }

  #clear() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  #schedule() {
    this.#clear();
    if (!this.playing || this.paused || !this.cards.length) return;
    this.timer = setTimeout(() => this.#advance(), this.dwellMs);
  }

  #enter(i) {
    if (this.index >= 0 && this.index !== i) this.#emit('onCardEnd', this.index, this.cards[this.index]);
    this.index = i;
    this.#emit('onCardStart', i, this.cards[i]);
    this.#progress();
    this.#schedule();
  }

  #advance() {
    if (!this.playing || this.paused) return;
    const next = this.index + 1;
    if (next >= this.cards.length) {
      this.playing = false;
      this.paused = false;
      this.#clear();
      this.#emit('onCardEnd', this.index, this.cards[this.index]);
      this.#emit('onFinish');
      return;
    }
    this.#enter(next);
  }

  async start() {
    this.playing = true;
    this.paused = false;
    this.index = -1;
    this.#enter(0);
  }

  pause() {
    if (!this.playing) return;
    this.paused = true;
    this.#clear();
    this.#progress();
  }

  async resume() {
    if (!this.playing || !this.paused) return;
    this.paused = false;
    this.#schedule();
    this.#progress();
  }

  async goto(i) {
    if (!this.cards.length) return;
    const clamped = Math.max(0, Math.min(this.cards.length - 1, Number(i) || 0));
    if (!this.playing) { this.playing = true; this.paused = false; }
    if (this.index === clamped && this.timer) return;
    this.#enter(clamped);
  }

  async next() {
    if (!this.cards.length) return;
    this.playing = true;
    this.paused = false;
    const next = this.index + 1;
    if (next >= this.cards.length) { this.#advance(); return; }
    this.#enter(next);
  }

  async prev() {
    if (!this.cards.length) return;
    this.playing = true;
    this.paused = false;
    this.#enter(Math.max(0, this.index - 1));
  }

  async reshuffle() {
    if (typeof this.rebuild === 'function') this.rebuild();
    this.playing = true;
    this.paused = false;
    this.index = -1;
    if (this.cards.length) this.#enter(0);
  }

  destroy() {
    this.#clear();
    this.playing = false;
  }
}

// ---------------------------------------------------------------------------
// 播放器装配
// ---------------------------------------------------------------------------
function makeLoader() {
  try {
    return new ClipLoader();
  } catch (err) {
    console.warn('[大屏版] ClipLoader 不可用：', err);
    return {
      load: () => Promise.reject(new Error('loader unavailable')),
      preloadAll: async () => ({ ok: 0, failed: [] }),
      has: () => false,
      get: () => null,
    };
  }
}

async function createPlayer(hooks) {
  const mod = await tryImport(() => import('./audio/player.js'), 'js/audio/player.js');
  const Broadcaster = mod?.Broadcaster
    ?? mod?.default?.Broadcaster
    ?? (typeof mod?.default === 'function' ? mod.default : null);

  if (typeof Broadcaster === 'function') {
    try {
      const player = new Broadcaster({
        cards: state.cards,
        // 新版 Broadcaster 支持 cardsProvider：一轮播完自动取新队列接着播（无限循环），
        // 这里每轮都重新洗牌 + 重新随机选天，孩子每次看到的顺序和天气都不一样。
        cardsProvider: () => {
          rebuildQueue();
          return state.cards;
        },
        loader: state.loader,
        music: state.music,
        hooks,
      });
      const missing = ['start', 'pause', 'resume', 'next', 'prev', 'reshuffle']
        .filter((name) => typeof player?.[name] !== 'function');
      if (missing.length) throw new Error(`Broadcaster 接口不完整，缺少 ${missing.join(' / ')}`);
      state.playerKind = 'Broadcaster';
      return player;
    } catch (err) {
      console.warn('[大屏版] Broadcaster 构造失败，降级为仅换卡片：', err?.message ?? err);
    }
  }
  state.playerKind = 'CardOnlyPlayer';
  return new CardOnlyPlayer({
    cards: state.cards,
    hooks,
    dwellMs: CARD_DWELL_MS,
    rebuild: () => rebuildQueue(),
  });
}

// ---------------------------------------------------------------------------
// 状态行
// ---------------------------------------------------------------------------
function baseStatus() {
  const sourceText = { live: '实时天气', cache: '缓存天气', demo: '演示数据（离线）' }[state.source]
    ?? '天气数据';
  const parts = [sourceText];
  if (!manifestHasImages()) parts.push('插画背景');
  if (!state.musicAvailable) parts.push('音乐不可用');
  if (state.playerKind !== 'Broadcaster') parts.push('仅换卡片·无播音');
  return parts.join(' · ');
}

/** 图片清单里到底有没有图；没有的话每城提示一次「暂无照片」就是噪音 */
function manifestHasImages() {
  const images = state.screen?.imageManifest?.images;
  return Boolean(images && typeof images === 'object' && Object.keys(images).length > 0);
}

function setTransientStatus(text, ms = 2600) {
  state.screen?.setStatus(text);
  if (state.transientTimer) clearTimeout(state.transientTimer);
  state.transientTimer = setTimeout(() => state.screen?.setStatus(baseStatus()), ms);
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
let bgSeq = 0;
let bgChain = Promise.resolve();
const noPhotoWarned = new Set();

function queueBackground(city, cardIndex) {
  const seq = ++bgSeq;
  bgChain = bgChain
    .then(async () => {
      if (seq !== bgSeq) return;                 // 期间已切到更新的城市，跳过旧图
      const mode = await state.screen.applyCityBackground(city);
      if (seq !== bgSeq) return;
      // 清单里本来就没有图时，逐城提示纯属噪音（状态行已常驻「插画背景」）；
      // 只有「清单有图但这个城市缺图」才提示，且每个城市只提示一次
      if (mode === 'fallback' && manifestHasImages() && !noPhotoWarned.has(city.id)) {
        noPhotoWarned.add(city.id);
        setTransientStatus('该城市暂无照片 · 使用插画背景', 2200);
      }
    })
    .catch((err) => console.warn('[大屏版] 背景切换失败：', err?.message ?? err));
  return bgChain;
}

/** 当前真正在播的队列：Broadcaster 会把 this.cards 换成自己的数组，优先读它 */
function activeCards() {
  const list = state.player?.cards;
  return Array.isArray(list) && list.length ? list : state.cards;
}

function showCard(index, providedCard = null) {
  const list = activeCards();
  const card = providedCard ?? list[index];
  if (!card) return;
  const token = ++state.renderToken;
  const desc = describeCard(card);
  state.screen.renderCard(desc, {
    city: card.city,
    dayIndex: card.dayIndex ?? 0,
    cardIndex: index,
    total: list.length,
  });
  queueBackground(card.city, index);
  if (token !== state.renderToken) return;
  state.screen.setStatus(baseStatus());
}

function makeHooks() {
  return {
    onCardStart(index, card) {
      const list = activeCards();
      if (!list.length) return;
      showCard(Math.max(0, Math.min(list.length - 1, Number(index) || 0)), card ?? null);
    },
    onCardEnd() { /* 交叉淡入由下一次 onCardStart 驱动 */ },
    onProgress(progress = {}) {
      // 注意：Broadcaster 在 phase==='speak' 时会把语音片段级进度透传上来
      // （index=片段序号、total=片段数，例如 6 个片段），那不是城市序号，
      // 直接忽略，否则底部城市进度点阵会被片段序号带偏。
      if (progress.phase === 'speak') return;
      // 一轮播完时会用 index === total 的 'end' 事件，夹回最后一张，避免点阵全灭
      const n = Number(progress.total);
      const i = Number(progress.index);
      if (!Number.isFinite(i) || !Number.isFinite(n) || n <= 0) return;
      state.screen?.setProgress(Math.max(0, Math.min(n - 1, i)), n);
    },
    onFinish() {
      void handleFinish();
    },
    onError(err) {
      console.warn('[大屏版] 播放器报错：', err);
      setTransientStatus('播放出错，已自动继续');
    },
  };
}

let lastFinishAt = 0;
async function handleFinish() {
  const now = Date.now();
  if (now - lastFinishAt < 800) return;      // 防抖，避免回调重入导致死循环
  lastFinishAt = now;
  if (!state.cards.length) return;
  rebuildQueue();                             // 重新洗牌 + 重新随机选天
  const player = state.player;
  try {
    // 把新队列传进去：Broadcaster 会用它替换内部数组，保证 hooks 里的 card 与这里一致
    if (typeof player?.reshuffle === 'function') await player.reshuffle(state.cards);
    else if (typeof player?.start === 'function') await player.start(0);
  } catch (err) {
    console.warn('[大屏版] 重新开始播报失败：', err?.message ?? err);
  }
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------
function playerState() {
  try {
    const st = state.player?.state;
    if (st && typeof st === 'object') return st;
  } catch { /* 忽略 */ }
  return { playing: state.started, paused: false, index: 0, total: state.cards.length };
}

function syncFromPlayer() {
  const st = playerState();
  state.screen?.setPlaying(Boolean(st.playing ?? state.started));
  state.screen?.setPaused(Boolean(st.paused));
  // 音乐按钮的按下状态跟随真实播放状态（Broadcaster 自己控制音乐，这里只同步显示）
  if (state.musicAvailable) {
    const playing = Boolean(state.music.playing);
    if (playing !== state.musicOn) {
      state.musicOn = playing;
      state.screen?.setMusicPressed(playing);
    }
  }
}

async function playerCall(name, ...args) {
  if (!state.started) { startPlayback(); return; }
  const fn = state.player?.[name];
  if (typeof fn !== 'function') return;
  try {
    await fn.apply(state.player, args);
  } catch (err) {
    console.warn(`[大屏版] player.${name}() 出错：`, err?.message ?? err);
    state.screen?.setStatus('操作失败，已继续');
  }
  syncFromPlayer();
}

function startPlayback() {
  if (state.started) return;
  state.started = true;
  state.screen.hideOverlay();
  state.screen.setPlaying(true);
  state.screen.setPaused(false);

  const player = state.player;
  if (!player) return;

  // 用户手势内同步启动，避免 iOS Safari 丢激活态。
  // Broadcaster 会自己 fadeIn 音乐；降级模式由这里补上。
  if (state.playerKind !== 'Broadcaster' && state.musicAvailable) {
    state.musicOn = true;
    state.screen.setMusicPressed(true);
    Promise.resolve(state.music.start())
      .then(() => state.music.fadeIn?.(1500))
      .catch(() => {});
  }

  Promise.resolve(player.start())
    .then(() => syncFromPlayer())          // 同步播报/音乐的真实状态到按钮
    .catch((err) => {
      console.warn('[大屏版] 播报启动失败：', err?.message ?? err);
      setTransientStatus('音频启动失败 · 仅换卡片');
    });
  state.screen.setStatus(baseStatus());
}

async function togglePause() {
  if (!state.started) { startPlayback(); return; }
  const st = playerState();
  const running = st.playing && !st.paused;
  if (running) {
    await playerCall('pause');
    if (state.playerKind !== 'Broadcaster' && state.musicOn) state.music.stop?.();
  } else {
    await playerCall('resume');
    if (state.playerKind !== 'Broadcaster' && state.musicOn) {
      Promise.resolve(state.music.start()).then(() => state.music.fadeIn?.(900)).catch(() => {});
    }
  }
  syncFromPlayer();
}

async function toggleMusic() {
  if (!state.started) { startPlayback(); return; }
  if (!state.musicAvailable) {
    setTransientStatus('背景音乐不可用（MusicPlayer 未就绪）');
    return;
  }
  state.musicOn = !state.musicOn;
  state.screen?.setMusicPressed(state.musicOn);
  try {
    if (state.musicOn) {
      await state.music.start();
      await state.music.fadeIn?.(1200);
      setTransientStatus('背景音乐：开');
    } else {
      await state.music.fadeOut?.(600);
      await state.music.pause?.();
      setTransientStatus('背景音乐：关');
    }
  } catch (err) {
    console.warn('[大屏版] 音乐开关失败：', err?.message ?? err);
    setTransientStatus('音乐操作失败');
  }
}

async function reshuffleNow() {
  rebuildQueue();
  await playerCall('reshuffle', state.cards);
  setTransientStatus('已重新洗牌');
}

function onHalfScreenClick(event) {
  if (!state.started) return;                 // 遮罩阶段由开始按钮负责
  if (event.defaultPrevented) return;
  const target = event.target;
  if (target?.closest?.('button, a, input, select, textarea, #lg-hud, #lg-start-overlay')) return;
  const width = window.innerWidth || 1;
  const x = Number.isFinite(event.clientX) ? event.clientX : width / 2;
  if (x < width / 2) void playerCall('prev');
  else void playerCall('next');
}

function onKeyDown(event) {
  if (event.key === 'Escape') return;         // 明确：Esc 无动作
  if (event.key === ' ' || event.code === 'Space') {
    // 焦点在按钮/链接上时交给原生行为，避免触发两次
    if (event.target?.closest?.('button, a')) return;
    event.preventDefault();
    void togglePause();
    return;
  }
  if (event.key === 'ArrowLeft') { event.preventDefault(); void playerCall('prev'); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); void playerCall('next'); }
}

function bindControls() {
  const buttons = state.screen.buttons;
  buttons.start?.addEventListener('click', () => startPlayback());
  buttons.prev?.addEventListener('click', () => void playerCall('prev'));
  buttons.play?.addEventListener('click', () => void togglePause());
  buttons.next?.addEventListener('click', () => void playerCall('next'));
  buttons.music?.addEventListener('click', () => void toggleMusic());
  buttons.shuffle?.addEventListener('click', () => void reshuffleNow());
  document.addEventListener('click', onHalfScreenClick);
  document.addEventListener('keydown', onKeyDown);
}

// ---------------------------------------------------------------------------
// 音频预热（只预热最先播的几张卡，失败静默）
// ---------------------------------------------------------------------------
async function prewarm(count = 2) {
  if (state.playerKind !== 'Broadcaster') return;
  try {
    const manifest = await loadAudioManifest();
    const urls = [];
    for (const card of state.cards.slice(0, count)) {
      for (const seg of describeCard(card).segments) {
        if (manifestHas(manifest, seg)) urls.push(audioUrlFor(seg));
      }
    }
    if (urls.length) await state.loader.preloadAll(urls);
  } catch (err) {
    console.warn('[大屏版] 音频预热跳过：', err?.message ?? err);
  }
}

// ---------------------------------------------------------------------------
// 自测钩子（?diag=1）
// ---------------------------------------------------------------------------
function writeDiag(extra = {}) {
  const payload = {
    at: new Date().toISOString(),
    playerKind: state.playerKind,
    musicAvailable: state.musicAvailable,
    source: state.source,
    cities: state.cities.length,
    cards: state.cards.length,
    started: state.started,
    errors: runtimeErrors.slice(),
    notes: runtimeNotes.slice(),
    ...extra,
    screen: state.screen?.measure?.() ?? null,
  };
  document.body.dataset.lgDiag = JSON.stringify(payload);
  window.__lgDiag = payload;
  return payload;
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function main() {
  await domReady();
  const screen = new LargeScreen(document);
  state.screen = screen;
  state.loader = makeLoader();

  screen.setHint('点一下按钮解锁声音；左右半屏点一下换城市，空格暂停。 / Tap to start. Click left/right half to switch city, Space to pause.');
  screen.setStatus('正在载入城市与天气…');
  if (screen.nodes.overlay) screen.nodes.overlay.dataset.loading = '1';

  // 可选模块（图片清单 / 天气图标）与城市数据并行准备
  const preparePromise = screen.prepare();

  let cities = [];
  try {
    const doc = await fetchJSON('data/cities.json');
    cities = Array.isArray(doc) ? doc : (doc?.cities ?? []);
  } catch (err) {
    console.error('[大屏版] 城市清单读取失败：', err);
    screen.setStatus('城市数据读取失败');
    screen.setHint('city list failed to load — 请用本地静态服务器打开本页（不要直接双击文件）。');
    await preparePromise;
    if (DIAG) writeDiag({ fatal: String(err?.message ?? err) });
    return;
  }
  state.cities = cities;

  const weather = await loadWeather(cities);
  state.byCity = weather?.byCity ?? {};
  state.source = weather?.source ?? 'demo';

  rebuildQueue(START_CITY);
  state.music = await createMusic();
  state.musicAvailable = state.music.available;
  screen.setMusicPressed(false);

  await preparePromise;

  const hooks = makeHooks();
  state.player = await createPlayer(hooks);
  bindControls();

  // 遮罩背后先把第一张卡渲染出来，点开始时不用等
  showCard(0);
  if (screen.nodes.overlay) delete screen.nodes.overlay.dataset.loading;
  screen.setStatus(baseStatus());
  syncFromPlayer();
  if (DIAG) writeDiag({ phase: 'first-render' });

  // 预热（不阻塞界面）
  void prewarm();

  if (DIAG) {
    // 自测模式：暴露内部状态与体检数据；?autostart=1 时免手势自动开始（无头截图用）
    window.__lgScreen = screen;
    window.__lgState = state;
    if (AUTOSTART) startPlayback();   // ?autostart=1：免手势自动开始（无头截图用）
    await sleep(3200);
    writeDiag();
    setTimeout(() => writeDiag({ phase: 'late' }), 2500);
  }

  // 页面重新可见时校正进度（例如 iPad 切后台再回来）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.started) syncFromPlayer();
  });

  console.info('[大屏版] 就绪：', {
    cities: state.cities.length,
    cards: state.cards.length,
    播放器: state.playerKind,
    音乐: state.musicAvailable ? '可用' : state.music.reason,
    图片模块: screen.assetsSource,
    图标模块: screen.iconSource,
    天气来源: state.source,
  });
}

main().catch((err) => {
  console.error('[大屏版] 启动失败：', err);
  try { document.body.dataset.lgDiag = JSON.stringify({ fatal: String(err?.stack || err) }); } catch { /* 忽略 */ }
});
