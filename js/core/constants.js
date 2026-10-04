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

/** 城市壁纸图源清单（由 assets/images/manifest.json 提供） */
export const IMAGES_DIR = 'assets/images';

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
  'js/audio/speech.js',
  'js/audio/music.js',
  'js/audio/player.js',
  'js/ui/screen.js',
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
