// 全局常量：播放器 / Service Worker / 资源生成脚本共享的唯一真相来源。
// 修改此文件时务必同步更新 sw.js 的 CACHE_VERSION。

export const VERSION = '1.0.0';

/**
 * 一轮播报的城市数量。
 *
 * ★ 老板决定：「不要搞什么一轮配额，直接全额随机」——
 *   所以**不再区分国内/国外**（原来的 CN_QUOTA=12 + INTL_QUOTA=8 已废弃）。
 *   国内城市已扩充到 143 座（含 100 个新增地级市），再按配额分国内外反而让
 *   "随机"变成"每轮固定 12 个国内"，与老板要的全额随机相悖。
 *   现在就是：从全部城市里洗牌，取前 CARDS_PER_PASS 个。
 */
export const CARDS_PER_PASS = 20;
export const CARDS_PER_CITY = 1;

/** 天气取未来第几天：0=今天, 1=明天, 2=后天 */
export const FORECAST_DAYS = 3;

/**
 * 界面下方「未来两天」那一块显示几天。
 * 老板要求把天气界面拆成两块：上面是当前天气/气温（字号不变），下面是未来两天（字号小）。
 * 注意这块**只显示**，不参与语音播报 —— 播报仍然只念当前那天。
 */
export const FORECAST_DAYS_OUT = 2;

/** 音频参数 */
export const AUDIO = {
  /** 生成音频时使用的 edge-tts 语音 */
  voice: 'zh-CN-XiaoxiaoNeural',
  /** 播音语速（edge-tts rate 参数） */
  rate: '-8%',
  /** 句内停顿（毫秒）：城市名 → 天气 */
  gapCityToWeather: 120,
  /** 句内停顿（毫秒）：天气 → 数字。
   *  取值偏小是因为片段首尾的空白已被 tools/trim-audio.py 裁掉，
   *  再给大停顿会变成一顿一顿的。 */
  gapWeatherToTemp: 70,
  /** 句内停顿（毫秒）：数字 → 「到」→ 数字度。
   *  这一处要更短，「五…到…十五度」才连贯。 */
  gapNumber: 50,
  /** 句间停顿（毫秒）：一句播报结束 → 下一城市 */
  gapBetweenCities: 900,
  /** 开始播报前留白（毫秒），等背景音乐起拍 */
  introDelay: 1200,
  /** 背景音乐音量 */
  musicVolume: 0.30,
  /** 人声音量 */
  voiceVolume: 1.0,
  /** 天气图标显示后延迟多久开始读城市名，让孩子先看图 */
  cardLeadIn: 700,
};

/** 音频资产目录约定 */
export const AUDIO_DIR = 'assets/audio';

/**
 * 城市之间的 3D 地球过场动画。
 * 目的：让孩子建立地理认知——从上一城的视角转到下一城（例如合肥 → 东京）。
 *
 * 硬约束：整个动画过程中**地球始终保持正北朝上**（相机 up 锁定在真北方向，
 * 详见 js/ui/globe.js 的相机数学）。不要改成"俯仰角跟着城市纬度走"的做法。
 */
export const GLOBE = {
  /** 总开关：关掉就完全不过场，直接切卡片（排查问题时很方便） */
  enabled: true,
  /** 从上一城转到下一城的动画时长（毫秒） */
  duration: 5000,
  /** 转到位之后停留多久再交回卡片（让孩子看清目标城市） */
  holdMs: 1200,
  /** 覆盖层淡入/淡出时长（毫秒）。
   *  400ms 时地球半透明叠在城市照片上的时间偏长、看着发糊，收到 280ms 更利落；
   *  淡入淡出与动画时间轴重叠，所以不增加过场总时长。 */
  fadeMs: 280,
  /** 相机纬度夹紧：避免在极地附近相机基退化（up 与 dir 共线） */
  minLat: -85,
  maxLat: 85,

  // ── 相机抛物线轨迹（逼近/拉远）──────────────────────────────────────
  // 老板要求：**相机运动的轨迹类似抛物线** —— 从起点城市"抛"向终点城市，
  // 中途升到最高点，两端贴地；抛高与两城距离成正比
  // （几百公里只是轻轻一跳，几千公里则是明显的大抛）。
  //
  // ⚠ 注意这跟"缩放到某个距离再缩回来"不是一回事：那是把缩放当成纯数值的来回，
  //   没有"相机在空间里走了一条弧线"的含义。抛物线轨迹里
  //   **球的大小是相机距离的函数**（离得远就小），相机距离由弹道曲线决定。
  //
  // 相机模型（世界坐标，地球半径取 1）：
  //   A = p(from)，B = p(to)                 两城的单位向量
  //   u(t)   = normalize(slerp(A, B, t))     视线方向（始终指向两城之间的球面点）
  //   h(t)   = hMax · 4·t·(1-t)              弹道高度，标准抛物线，峰值在 t=0.5
  //   C(t)   = u(t) · (1 + baseAlt + h(t))   相机位置
  //   球占比 = nearMinSideRatio · (1+baseAlt) / (1+baseAlt+h(t))   ← 半径 ∝ 1/相机距离
  //
  // `up = normalize(north − (north·dir)·dir)` 这条「正北朝上」的红线**完全不受影响**：
  //   变的只是 R 与相机距离，up 仍由当前 dir 每帧重算。
  //
  // 定标依据（tools/city-distances.py 实测 81 城全部 3240 个城对）：
  //   最近 8.7 km（珠海↔澳门）、P25 1558 km、P50 7202 km、最远 19597 km（奥克兰↔马德里）；
  //   一轮 20 城随机打乱后，相邻两城距离的**中位数是 7177 km**。
  //
  // 实测（tools/calibrate-globe-arc.py，1440×900）：
  //   珠海↔澳门   8.7km  hMax=0.001  最高点球占比 0.859（几乎不收，轻轻一跳）
  //   合肥↔东京  2112km  hMax=0.056  0.816
  //   北京↔伦敦  8141km  hMax=0.153  0.750
  //   奥克兰↔马德里 19597km hMax=0.295 0.670（≈2/3）
  //   对跖       20015km  hMax=0.300  0.6675 ← 恰为「短边的三分之二」，是自然推出的，不是硬钉的
  //
  // ⚠ 曾经踩过的两个坑：
  //   1. **把"最高点球占比"永远钉在 2/3** —— 于是珠海↔澳门 9 公里的转场也要求相机
  //      抛出约 0.6 个地球半径，与"距离成正比"完全相悖。正确做法是由 1/(1+hMax) 自动得出。
  //   2. **把球占比绑在"相机距离落在 [distNear, distFar] 的百分比"上** ——
  //      短途 hMax≈0.001 相对 baseAlt 太小，导致完全没有缩放（实测抛高 0.0%）。
  //      必须用 半径 ∝ 1/相机距离。
  /** 对跖（sep=π）时的弹道最高点，单位 = 地球半径 */
  arcHeightFull: 0.30,
  /** 弹道高度随距离增长的幂次：<1 让中距离也有明显抛高 */
  arcHeightPower: 0.75,
  /** 贴地时的基础高度：避免两城重合时球无限大，也留一点空间感 */
  cameraBaseAlt: 0.04,
  /**
   * 贴地（两端）时地球**直径** = 视口短边 × 此比例 —— 即"逼近"的近景。
   *
   * ★ 老板要求「调整动画开始和末端的距离，要比现在近 80% 以上」，
   *   追问后明确为「**很大！非常大！地球要填满整个视野还要多得多！**」
   *   即：两端是贴地特写（球明显溢出画面），中途退后看全景（2/3）——
   *   两者相差约 3.9× 就是这条抛物线的观感来源。
   *
   * ⚠ 这里**只管"球多大/相机多近"，不要再去动中途的 2/3**：
   *   中途的 2/3 是老板前一轮定的（"拉到地球恰好填满画面的三分之二"），仍然生效。
   *   两端大于中途，正是「先退后看全景、再俯冲贴近目标城市」的观感。
   *
   * 相机距离换算（地球半径=1）：dist = (1+cameraBaseAlt)/ratio
   *   ratio 0.172（上一版）→ dist 6.05，球只占短边 17%
   *   ratio 0.86 （本版）  → dist 1.209，球占短边 86%
   *   → 相机贴近了约 80%，正是老板要的那个量级
   */
  nearMinSideRatio: 0.86,
};

/** 城市壁纸图源清单（由 assets/images/manifest.json 提供） */
export const IMAGES_DIR = 'assets/images';

/**
 * WebGL 地球的贴图目录（由 tools/gen-globe-textures.py 生成）。
 *   albedo.jpg    真实卫星影像（国界已烘进贴图）
 *   normal.jpg    从地形起伏导出的法线贴图，供实时山体光影
 *   countries.png 8bit 国家编号图，供淡色蒙版
 *   palette.png   256×1 调色板，把编号映射成低饱和颜色
 *   countries.json 编号 → 国名，以及 chinaIndex（中国的编号，着色器据此保证中国是红色）
 */
export const GLOBE_TEXTURES_DIR = 'assets/globe';

/** 天气数据接口：Open-Meteo，免 API Key */
export const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';

/** 单城请求的天气字段 */
export const WEATHER_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'apparent_temperature_max',
  'precipitation_probability_max',
  'wind_speed_10m_max',
];

/** localStorage 键名 */
export const STORAGE_KEYS = {
  prefs: 'wr.prefs.v1',
  weatherCache: 'wr.weather.v1',
};

/** 天气数据缓存有效期（毫秒）：30 分钟 */
export const WEATHER_TTL = 30 * 60 * 1000;

/** Service Worker 预缓存的静态资源（与 sw.js 的 CORE_ASSETS 保持一致） */
export const CORE_ASSETS = [
  './',
  'index.html',
  'style.css',
  'large.html',
  'large.css',
  'data/cities.json',
  'data/wmo-map.json',
  'assets/images/manifest.json',
  'assets/images/luminance.json',
  'assets/audio/manifest.json',
  'js/main.js',
  'js/core/constants.js',
  'js/core/paths.js',
  'js/core/utils.js',
  'js/core/boot.js',
  'js/core/weather.js',
  'js/core/format.js',
  'js/core/cards.js',
  'js/audio/manifest.js',
  'js/audio/loader.js',
  'js/audio/preload.js',
  'js/audio/speech.js',
  'js/audio/music.js',
  'js/audio/player.js',
  'js/ui/screen.js',
  'js/ui/loading.js',
  'js/ui/globe.js',
  'js/ui/globe-data.js',
  'js/ui/weather-icon.js',
  'js/ui/assets.js',
  'js/ui/large.js',
  'js/large-main.js',
];

/** 图标：SVG 名称 → 中文说明，供无障碍朗读 */
export const ICON_LABELS = {
  sun: '晴',
  'cloud-sun': '多云',
  cloud: '阴',
  fog: '有雾',
  'rain-light': '小雨',
  rain: '中雨',
  'rain-heavy': '大雨',
  shower: '阵雨',
  thunder: '雷阵雨',
  sleet: '雨夹雪',
  'snow-light': '小雪',
  snow: '中雪',
  'snow-heavy': '大雪',
};
