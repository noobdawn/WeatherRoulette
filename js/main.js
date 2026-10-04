// 主流程：加载数据 → 随机选城 → 取实时天气 → 预加载音频 → 用户点击后开始播报。
// 每次打开页面的城市、顺序、壁纸、当天天气都不同；一轮播完自动重新随机，无限循环。
import { domReady, fetchJSON, registerServiceWorker, installErrorOverlay } from './core/boot.js';
import { AUDIO, WEATHER_TTL } from './core/constants.js';
import { describeCard, dayLabel, dayLabelEn } from './core/format.js';
import { loadWeather, dailyToDays } from './core/weather.js';
import { pickCities, buildCards, uniqueCities } from './core/cards.js';
import { shuffled, sleep } from './core/utils.js';
import { loadAudioManifest, audioUrlFor, manifestHas } from './audio/manifest.js';
import { ClipLoader } from './audio/loader.js';
import { MusicPlayer } from './audio/music.js';
import { Broadcaster } from './audio/player.js';
import { Screen } from './ui/screen.js';
import { loadImageManifest, resolveCityImage } from './ui/assets.js';

const $ = (sel) => document.querySelector(sel);

// 极简版：只有「开始播报」遮罩与右上角音乐开关是可见控件，
// 播放控制/进度条/元信息已全部移除（老板要求：就一张背景+前景，自动轮播）。
// 所有引用一律可选，缺节点不能让页面崩掉。
const ui = {
  start: $('#btn-start'),
  overlay: $('#start-overlay'),
  hint: $('#start-hint'),
  music: $('#btn-music'),
};

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

  // 4. 先给第一张卡片铺好背景和声音，避免开场空白
  const first = nextCards();
  if (first.length) {
    const desc = describeCard(first[0]);
    await renderCard(screen, first[0], 0, first.length, imageManifest, { preload: true });
    const preloads = first
      .slice(0, 3)
      .flatMap((c) => describeCard(c).segments)
      .filter((s) => manifestHas(audioManifest, s))
      .map(audioUrlFor);
    loader.preloadAll(preloads);
  }

  // 5. 更新「开始」提示，让孩子家长知道要点一下才有声音
  if (ui.hint) {
    const voices = audioManifest.counts
      ? `${audioManifest.counts.city} 个城市、${audioManifest.counts.weather} 种天气`
      : `${cities.length} 个城市`;
    ui.hint.textContent = `共 ${voices}，女声播报 + 《渔舟唱晚》背景音乐。点击开始后有声音。`;
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

  // 7. 用户点击开始（浏览器要求用户手势才允许播放声音）
  ui.start?.addEventListener(
    'click',
    async () => {
      ui.overlay?.classList.add('is-hidden');
      await sleep(120);
      ui.overlay?.setAttribute('hidden', '');
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
    },
    { once: true },
  );

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
  const files = Object.values(audioManifest.files ?? {});
  const bytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  return bytes / 1024 / 1024;
}

boot().catch((err) => {
  console.error(err);
  const hint = document.getElementById('start-hint');
  if (hint) hint.textContent = `启动失败：${err.message}。请检查网络后刷新。`;
});
