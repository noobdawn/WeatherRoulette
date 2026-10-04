// 天气数据层：Open-Meteo 批量查询 + 本地缓存 + 离线降级到演示数据。
// 所有城市用一次请求取回（经纬度逗号分隔），避免 75 次往返。
import { WEATHER_API, WEATHER_FIELDS, FORECAST_DAYS, STORAGE_KEYS, WEATHER_TTL } from './constants.js';

function readCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.weatherCache);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.savedAt || !obj.data) return null;
    return obj;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(
      STORAGE_KEYS.weatherCache,
      JSON.stringify({ savedAt: Date.now(), data }),
    );
  } catch {
    /* 隐私模式或配额不足时忽略 */
  }
}

function buildUrl(cities) {
  const lat = cities.map((c) => c.lat.toFixed(4)).join(',');
  const lon = cities.map((c) => c.lon.toFixed(4)).join(',');
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: WEATHER_FIELDS.join(','),
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
  });
  return `${WEATHER_API}?${params.toString()}`;
}

/**
 * 拉取所有城市的每日预报。
 * @returns {Promise<{source:'live'|'cache'|'demo', updatedAt:number, byCity:Object}>}
 */
export async function loadWeather(cities, { force = false } = {}) {
  const cached = readCache();
  const fresh = cached && Date.now() - cached.savedAt < WEATHER_TTL;
  if (cached && fresh && !force) {
    return { source: 'cache', updatedAt: cached.savedAt, byCity: cached.data };
  }

  try {
    const res = await fetch(buildUrl(cities));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : [json];
    const byCity = {};
    cities.forEach((city, i) => {
      const item = list[i];
      if (item && item.daily) byCity[city.id] = item.daily;
    });
    writeCache(byCity);
    return { source: 'live', updatedAt: Date.now(), byCity };
  } catch (err) {
    console.warn('[WeatherRoulette] 实时天气获取失败，尝试缓存：', err);
    if (cached) return { source: 'cache', updatedAt: cached.savedAt, byCity: cached.data };
    return { source: 'demo', updatedAt: Date.now(), byCity: demoWeather(cities) };
  }
}

/** 把 daily 数组转成按天索引的卡片数据 */
export function dailyToDays(daily, count = FORECAST_DAYS) {
  if (!daily) return [];
  const days = [];
  const n = daily.time?.length ?? 0;
  for (let d = 0; d < Math.min(count, n); d++) {
    days.push({
      date: daily.time[d],
      code: daily.weather_code?.[d],
      tMax: daily.temperature_2m_max?.[d],
      tMin: daily.temperature_2m_min?.[d],
      feelsMax: daily.apparent_temperature_max?.[d],
      precip: daily.precipitation_probability_max?.[d],
      wind: daily.wind_speed_10m_max?.[d],
    });
  }
  return days;
}

/** 完全离线且无缓存时的兜底：生成看起来正常的演示数据，界面会标注「演示数据」 */
export function demoWeather(cities) {
  const out = {};
  const today = new Date();
  for (const c of cities) {
    const time = [];
    const weather_code = [];
    const temperature_2m_max = [];
    const temperature_2m_min = [];
    const apparent_temperature_max = [];
    const precipitation_probability_max = [];
    const wind_speed_10m_max = [];
    for (let d = 0; d < FORECAST_DAYS; d++) {
      const day = new Date(today.getTime() + d * 86400000);
      time.push(day.toISOString().slice(0, 10));
      weather_code.push((c.id.charCodeAt(0) + d * 7) % 4 === 0 ? 61 : 2);
      const base = 24 - Math.abs(c.lat - 23) * 0.35;
      temperature_2m_max.push(Math.round(base + 3 + d));
      temperature_2m_min.push(Math.round(base - 5 + d));
      apparent_temperature_max.push(Math.round(base + 2));
      precipitation_probability_max.push(10 + ((c.id.length * 7 + d * 11) % 60));
      wind_speed_10m_max.push(8 + ((c.id.length * 3 + d * 5) % 14));
    }
    out[c.id] = {
      time, weather_code, temperature_2m_max, temperature_2m_min,
      apparent_temperature_max, precipitation_probability_max, wind_speed_10m_max,
    };
  }
  return out;
}
