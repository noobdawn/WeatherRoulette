// 主流程：加载数据 → 随机选城 → 取实时天气 → 预加载音频 → 用户点击后开始播报。
// 每次打开页面的城市、顺序、壁纸、当天天气都不同；一轮播完自动重新随机，无限循环。
import { domReady, fetchJSON, registerServiceWorker, installErrorOverlay } from './core/boot.js';
import { AUDIO, WEATHER_TTL } from './core/constants.js';
import { describeCard, dayLabel, dayLabelEn } from './core/format.js';
import { loadWeather, dailyToDays } from './core/weather.js';
import { pickCities, buildCards, uniqueCities } from './core/cards.js';
import { shuffled } from './core/utils.js';
import { loadAudioManifest, audioUrlFor, manifestHas } from './audio/manifest.js';
import { ClipLoader } from './audio/loader.js';
import { AudioPreloader } from './audio/preload.js';
import { MusicPlayer } from './audio/music.js';
import { Broadcaster } from './audio/player.js';
import { Screen } from './ui/screen.js';
import { LoadingScreen } from './ui/loading.js';
import { loadImageManifest, resolveCityImage } from './ui/assets.js';

const $ = (sel) => document.querySelector(sel);

// 极简版：界面上唯一的控件是右上角的音乐开关（老板要求：进去就自动播报，不要「开始播报」界面）。
// index.html 里已经完全没有 #start-overlay；只有在浏览器拦截自动播放时，
// 才会由 ensureAutoplay() 动态创建一个同 id 的兜底遮罩（样式复用 style.css 里现成的规则）。
const ui = {
  music: $('#btn-music'),
};

/** 移除「点击解锁」兜底遮罩（正常自动播放时页面上根本没有它） */
function dropUnlockOverlay() {
  const box = document.getElementById('start-overlay');
  if (!box) return;
  box.classList.add('is-hidden');
  setTimeout(() => box.remove(), 450);
}

/**
 * 把语音清单里的每一个片段都变成 {kind,key}，用于整包预下载。
 * 清单键形如 zh/city/beijing.mp3、zh/temp/t24.mp3、zh/num/n5.mp3、zh/word/dao.mp3。
 */
function everyClipSegments(audioManifest) {
  const out = [];
  for (const rel of Object.keys(audioManifest.files ?? {})) {
    const m = rel.match(/^zh\/([a-z]+)\/(.+)\.mp3$/);
    if (m) out.push({ kind: m[1], key: m[2] });
  }
  return out;
}

/**
 * 预下载语音包，并把进度画到毛玻璃加载界面上。
 *
 * 刻意**不设等待上限**：语音包完整就绪是体验的前提（老板要求「该等多久等多久」），
 * 提前放行只会让用户在第一句播报时再等一次，反而更差。
 * 唯一的例外是片段彻底下载失败（重试后仍失败）——那属于错误而非"慢"，
 * 不能让用户无限期等下去，此时记一笔告警后正常开播。
 */
async function runPreload(preloader, loading, segments) {
  const startedAt = Date.now();
  const result = await preloader.load(segments, {
    onProgress: (p) => {
      loading.setProgress({ done: p.done, total: p.total, bytes: p.bytes });
    },
    onStall: () => {
      // 只是提示，绝不中断下载：网慢也照样等下去
      loading.setHint('网络有点慢，仍在下载语音包，请稍候…');
    },
  });
  const ms = Date.now() - startedAt;
  if (result.failed > 0) {
    console.warn(`[WeatherRoulette] 有 ${result.failed} 个语音片段重试后仍下载失败，仍继续开播`);
  }
  loading.setProgress({ done: result.total, total: result.total, bytes: result.bytes });
  return { ...result, ms };
}

/**
 * 自动播放。
 * 浏览器（尤其移动端 Safari/Chrome）在没有用户手势时会拦截有声音的播放，
 * 所以这里先直接试一次：成功就什么都不显示、直接开始播报；
 * 只有被拦截时才生成一个极简遮罩请用户点一下——这是浏览器策略决定的，无法用代码绕过。
 */
function ensureAutoplay(music, onReady, loading = null) {
  return new Promise((resolve) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      dropUnlockOverlay();
      loading?.hide();
      document.body.classList.add('is-started');
      console.info('[WeatherRoulette] 自动播放已解锁，直接开始播报');
      onReady();
      resolve(true);
    };
    const showUnlock = () => {
      if (settled) return;
      settled = true;
      console.warn('[WeatherRoulette] 浏览器拦截了自动播放，显示一次性解锁按钮');
      const box = showUnlockOverlay(() => {
        loading?.hide();
        document.body.classList.add('is-started');
        onReady();
        resolve(true);
      });
      void box;
    };

    // 先试着真的播一下（这同时会把音乐解锁）。
    // 注意：music.fadeIn() 被浏览器拦截时**不会 reject**，而是 resolve(false)，
    // 所以必须看返回值 + 复查 audio.paused，否则会误判成"自动播放成功"，
    // 结果既不显示解锁按钮、也没有声音（真实浏览器上就是这个表现）。
    let attempt;
    try {
      attempt = music?.fadeIn?.();
    } catch {
      attempt = null;
    }
    Promise.resolve(attempt).then(
      (ok) => {
        const audio = music?.audio;
        const actuallyPlaying = !audio || audio.paused === false;
        if (ok !== false && actuallyPlaying) succeed();
        else showUnlock();
      },
      showUnlock,
    );

    // 更靠得住的一道：用静音缓冲区探一下浏览器准不准我们出声（不产生任何可听声音）
    probeSilentAudio().then((allowed) => { if (allowed) succeed(); else showUnlock(); });
    // 兜底：探针和音乐都没结论时，就当被拦截处理
    setTimeout(() => { if (!settled) showUnlock(); }, 2500);
  });
}

/**
 * 静音探针：用 Web Audio 播一个全零缓冲区。
 * 万一它没被挂起，说明浏览器允许我们自动出声；若被挂起，也顺手 resume 一下
 * （对已经与本站有过交互的用户往往就解锁了）。全程不产生任何可听声音。
 */
async function probeSilentAudio() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return false;
  try {
    const ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume();
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    const ok = ctx.state === 'running';
    setTimeout(() => { try { ctx.close(); } catch { /* 忽略 */ } }, 100);
    return ok;
  } catch {
    return false;
  }
}

/** 动态生成「点一下开始」兜底遮罩，复用 style.css 里 #start-overlay 的样式 */
function showUnlockOverlay(onClick) {
  if (document.getElementById('start-overlay')) return document.getElementById('start-overlay');
  const doc = document;
  const box = doc.createElement('div');
  box.id = 'start-overlay';
  const panel = doc.createElement('div');
  panel.className = 'start-panel';
  const title = doc.createElement('div');
  title.className = 'start-title';
  title.textContent = '天气播报';
  const btn = doc.createElement('button');
  btn.id = 'btn-start';
  btn.type = 'button';
  btn.textContent = '▶ 点一下开始';
  const hint = doc.createElement('p');
  hint.id = 'start-hint';
  hint.textContent = '浏览器需要你点一下才允许播放声音';
  panel.append(title, btn, hint);
  box.append(panel);
  const app = document.getElementById('app') || doc.body;
  app.append(box);

  const fire = () => {
    box.classList.add('is-hidden');
    setTimeout(() => box.remove(), 450);
    document.removeEventListener('keydown', onKey);
    onClick();
  };
  const onKey = (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); fire(); }
  };
  btn.addEventListener('click', fire, { once: true });
  box.addEventListener('click', fire, { once: true });
  document.addEventListener('keydown', onKey);
  return box;
}

async function boot() {
  await domReady();
  installErrorOverlay();

  // 0. 立刻在后台注册 Service Worker 并让它预缓存页面骨架。
  //    必须放在最前面：原来的写法把注册挂在「开始播报」的点击里，而点击前还有音频预加载，
  //    用户若在那之前关掉页面就什么也没缓存上，离线可用性无从谈起。
  //    这里只做后台任务，不 await，绝不拖慢首屏。
  const swReady = registerServiceWorker().catch(() => null);
  swReady.then((reg) => {
    if (reg) console.info('[WeatherRoulette] 离线缓存已就绪');
  });

  const screen = new Screen(document);
  screen.setStatus('正在准备……');

  // 1. 静态数据（并行）
  const [citiesFile, wmoMap, imageManifest, audioManifest] = await Promise.all([
    fetchJSON('data/cities.json'),
    fetchJSON('data/wmo-map.json').catch(() => ({ codes: {}, fallback: {} })),
    loadImageManifest(),
    loadAudioManifest(),
  ]);
  const cities = citiesFile.cities;
  const audioSizeMB = totalAudioSizeMB(audioManifest);
  screen.setStatus(`城市 ${cities.length} 座 · 语音包 ${audioSizeMB.toFixed(1)} MB`);

  // 2. 随机挑选本次要播报的城市
  let passIndex = 0;
  let currentCities = pickCities(cities);
  let currentCards = [];

  // 3. 实时天气
  const weather = await loadWeather(cities, { force: false });
  if (weather.source === 'demo') {
    screen.setStatus('未联网：正在使用演示天气数据');
  } else if (weather.source === 'cache') {
    const mins = Math.round((Date.now() - weather.updatedAt) / 60000);
    screen.setStatus(`天气缓存 ${mins} 分钟前更新`);
  } else {
    screen.setStatus('天气数据已更新');
  }

  const loader = new ClipLoader();
  const musicUrl = await pickMusicUrl(audioManifest);
  const music = new MusicPlayer(musicUrl, { volume: AUDIO.musicVolume });

  /** 生成下一轮卡片（每次都是新的随机结果） */
  function nextCards() {
    currentCities = passIndex === 0 ? currentCities : pickCities(cities);
    currentCards = buildCards(currentCities, weather.byCity);
    return currentCards;
  }

  const broadcaster = new Broadcaster({
    cardsProvider: nextCards,
    loader,
    music,
    hooks: {
      onCardStart(index, card, total) {
        renderCard(screen, card, index, total, imageManifest);
      },
      onPassEnd(index, total) {
        passIndex++;
        screen.setStatus(`已播报 ${passIndex} 轮，继续随机播放`);
      },
      onProgress(info) {
        // 只认城市级进度；顺带把「暂停/恢复」的界面状态同步过去
        // （Broadcaster.pause() 会发 phase:'pause' 的进度事件，但 index 还是旧值，所以这里只取 phase）
        if (info.phase === 'pause') screen.setPaused(true);
        else if (info.phase === 'resume') screen.setPaused(false);
      },
      onFinish() {
        screen.setStatus('全部播报完成');
      },
      onError(err) {
        console.warn('[WeatherRoulette] 播报异常：', err);
        screen.setStatus(`小问题：${err?.message ?? err}`);
      },
    },
  });

  // 4. 进页面先盖一层毛玻璃加载界面，然后并行做两件事：
  //    ① 渲染第一张卡片（挂壁纸，透过磨砂玻璃能看到城市轮廓）
  //    ② 预下载整轮播报要用的全部语音片段
  //    两者都好了才淡出并开播 —— 这样开播后换城、念句子都不用再等网络。
  const first = nextCards();
  const preloader = new AudioPreloader();
  const loading = new LoadingScreen(document);
  loading.show({ hint: '正在把语音包下载到本地，全部准备好后自动开始' });
  // 计时埋点：给自动化测试与现场排查用（也能回答「为什么等了这么久」）
  const timings = { loadingShownAt: Date.now(), preloadDoneAt: 0, playingAt: 0, preload: null };
  window.__wrTimings = timings;

  const allSegments = first
    .flatMap((c) => describeCard(c).segments)
    .filter((s) => manifestHas(audioManifest, s));

  // 预下载范围：整个语音包（不只是这一轮用到的片段）。
  // 理由：整包才 141 个片段 / 约 0.9 MB，缓存命中时几乎是瞬间完成；
  // 一次性全下完，之后无论切到哪个城市、哪种天气、哪段温度都不可能再等网络，
  // 而且这些片段也会被 Service Worker 缓存下来，离线可用。
  const everyClip = everyClipSegments(audioManifest);

  const [, preloadResult] = await Promise.all([
    first.length
      ? renderCard(screen, first[0], 0, first.length, imageManifest, { preload: true })
      : Promise.resolve(null),
    runPreload(preloader, loading, everyClip.length ? everyClip : allSegments),
  ]);
  timings.preloadDoneAt = Date.now();
  timings.preload = preloadResult;

  // 顺手把前几张卡片的 Audio 元素预热（已经命中的缓存，几乎瞬间完成）
  if (first.length) {
    loader.preloadAll(
      first.slice(0, 3).flatMap((c) => describeCard(c).segments)
        .filter((s) => manifestHas(audioManifest, s))
        .map(audioUrlFor),
    );
  }
  console.info(
    `[WeatherRoulette] 语音包预下载完成：${preloadResult.done}/${preloadResult.total} 个片段，`
    + `${(preloadResult.bytes / 1024).toFixed(0)} KB，用时 ${preloadResult.ms}ms，失败 ${preloadResult.failed} 个`,
  );

  // 5. 状态写进隐藏状态位（界面上不显示任何提示文案：进去就该直接播报）
  {
    const voices = audioManifest.counts
      ? `${audioManifest.counts.city} 个城市、${audioManifest.counts.weather} 种天气`
      : `${cities.length} 个城市`;
    screen.setStatus(`共 ${voices}，准备自动播报`);
  }

  // 6. 交互：极简版只保留两个 —— 右上角音乐开关、点画面暂停/继续
  let musicOn = true;
  try {
    musicOn = localStorage.getItem('wr.musicOn') !== 'off';
  } catch { /* 忽略 */ }

  ui.music?.addEventListener('click', (e) => {
    e.stopPropagation(); // 别触发「点画面暂停」
    musicOn = !musicOn;
    if (musicOn) music.resume();
    else music.pause();
    ui.music?.classList.toggle('is-off', !musicOn);
    ui.music?.setAttribute('aria-pressed', String(musicOn));
    try { localStorage.setItem('wr.musicOn', musicOn ? 'on' : 'off'); } catch { /* 忽略 */ }
  });
  if (ui.music && !musicOn) ui.music.classList.add('is-off');

  /** 点一下画面 = 暂停/继续（没有任何按钮，但孩子和家长都需要这个能力） */
  const togglePause = () => {
    const st = broadcaster.state;
    if (!st.playing && !st.paused) return; // 还没开始播报
    if (st.paused) {
      broadcaster.resume();
      screen.setPaused(false);
    } else {
      broadcaster.pause();
      // Broadcaster.pause() 只更新自己的状态并发 onProgress，不会碰界面；
      // 暂停的视觉反馈（左上角小指示）必须在这里显式同步，否则点了没任何反应。
      screen.setPaused(true);
    }
  };
  const appEl = $('#app');
  appEl?.addEventListener('click', togglePause);
  // 调试钩子：自动化测试与现场排查都靠它读播放状态，避免"点了没反应"无从定位
  window.__wr = {
    get state() { return broadcaster.state; },
    get contrast() { return screen.lastAnalysis ?? null; },
    get textOn() { return screen.textOn; },
    togglePause,
    next: () => broadcaster.next(),
    prev: () => broadcaster.prev(),
    reshuffle: () => broadcaster.reshuffle(),
    hasAppListener: Boolean(appEl),
  };

  // 键盘也能操作，方便家长
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    else if (e.key === 'ArrowRight') broadcaster.next();
    else if (e.key === 'ArrowLeft') broadcaster.prev();
    else if (e.key === 'm' || e.key === 'M') ui.music?.click();
  });

  // 7. 开始播报：默认自动开始，不需要用户点任何东西。
  //    只有浏览器拦截自动播放时，才会弹出一次性的极简解锁按钮。
  let broadcastStarted = false;
  const beginBroadcast = async () => {
    if (broadcastStarted) return;
    broadcastStarted = true;
    if (window.__wrTimings) window.__wrTimings.playingAt = Date.now();
    // Service Worker 已经在 boot() 开头注册过，这里只等它就绪并补缓存音乐与壁纸
    swReady.then((reg) => {
      const worker = reg?.active || navigator.serviceWorker?.controller;
      worker?.postMessage({ type: 'cache-music', url: new URL(musicUrl, location.href).href });
      const urls = currentCards
        .map((c) => resolveCityImage(c.city, imageManifest)[0]?.url)
        .filter(Boolean)
        .slice(0, 8);
      worker?.postMessage({ type: 'cache-images', urls });
    });
    if (!musicOn) music.pause();
    document.body.classList.add('is-playing');
    await broadcaster.start();
  };
  window.__wr.begin = beginBroadcast;
  await ensureAutoplay(music, beginBroadcast, loading);

  // 每 30 分钟自动刷新一次天气数据
  setInterval(() => {
    loadWeather(cities, { force: true }).then((fresh) => {
      if (fresh.byCity) Object.assign(weather.byCity, fresh.byCity);
    }).catch(() => {});
  }, WEATHER_TTL);
}

/** 渲染一张卡片：居中大字 + 天气图标 + 满屏壁纸（文字颜色由 screen.js 按壁纸亮度自动适配） */
async function renderCard(screen, card, index, total, imageManifest, { preload = false } = {}) {
  const desc = describeCard(card);
  const candidates = resolveCityImage(card.city, imageManifest);
  const urls = candidates.map((c) => c.url);
  screen.renderCard(desc, {
    city: card.city,
    imageUrls: urls,
    dayIndex: card.dayIndex,
    cardIndex: index,
    total,
  });
  if (!preload) return desc;

  // 开场前把第一张的背景图真正加载好，避免开场白屏
  if (urls.length) {
    // renderCard 已把候选队列交给 screen 内部处理；这里等它稳定即可
    // （applyCityBackground 可能同步返回 true，包一层 Promise 避免 .catch 报错）
    await Promise.resolve(screen.applyCityBackground?.(urls)).catch(() => {});
  } else {
    screen.setBackgroundFallback(card.city);
  }
  return desc;
}

/** 背景音乐：优先用用户自备的 music.mp3，找不到就用内置合成的《渔舟唱晚》 */
async function pickMusicUrl(audioManifest) {
  const custom = 'assets/audio/music/music.mp3';
  try {
    const res = await fetch(custom, { method: 'HEAD' });
    if (res.ok) return custom;
  } catch {
    /* 忽略 */
  }
  const name = audioManifest.music?.[0] ?? 'yuzhouchangwan.mp3';
  return `assets/audio/music/${name}`;
}

function totalAudioSizeMB(audioManifest) {
  // 只统计语音片段：音乐是单独流式加载的，算进来会把「语音包」这个数字虚报好几倍
  const files = Object.values(audioManifest.files ?? {}).filter((f) => f?.kind !== 'music');
  const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  return bytes / 1024 / 1024;
}

boot().catch((err) => {
  console.error(err);
  const hint = document.getElementById('start-hint');
  if (hint) hint.textContent = `启动失败：${err.message}。请检查网络后刷新。`;
});
