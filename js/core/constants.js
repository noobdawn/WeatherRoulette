// 全局常量：播放器 / Service Worker / 资源生成脚本共享的唯一真相来源。
// 修改此文件时务必同步更新 sw.js 的 CACHE_VERSION。

export const VERSION = '1.0.0';

/** 一次「浏览」连续播报的城市卡片数量（每城一天），国内优先，保证孩子能听到家乡。 */
export const CN_QUOTA = 12;
export const INTL_QUOTA = 8;
export const CARDS_PER_CITY = 1;

/** 天气取未来第几天：0=今天, 1=明天, 2=后天 */
export const FORECAST_DAYS = 3;

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
};

/** 城市壁纸图源清单（由 assets/images/manifest.json 提供） */
export const IMAGES_DIR = 'assets/images';

/**
 * WebGL 地球的贴图目录（由 tools/gen-globe-textures.py 生成）。
 *   albedo.jpg    真实卫星影像（国界已烘进贴图）
 *   normal.jpg    从地形起伏导出的法线贴图，供实时山体光影
 *   countries.png 8bit 国家编号图，供淡色蒙版
 *   palette.png   256×1 调色板，把编号映射成低饱和颜色
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
