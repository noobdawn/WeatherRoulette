// 播报文案的唯一真相来源：界面显示与音频拼接都从这里取值，保证「听到的」和「看到的」完全一致。
// 参考央视《天气预报》口径： 城市名 + 天气 + 温度区间 + 摄氏度。
import wmoMap from '../../data/wmo-map.json' with { type: 'json' };

const NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 中文数字写法（覆盖 -20 ~ 60，够用且读法自然） */
export function numToZh(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '零';
  if (v < 0) return `零下${numToZh(-v)}`;
  if (v < 10) return NUM[v];
  if (v === 10) return '十';
  if (v < 20) return `十${NUM[v - 10]}`;
  if (v % 10 === 0) return `${NUM[Math.floor(v / 10)]}十`;
  return `${NUM[Math.floor(v / 10)]}十${NUM[v % 10]}`;
}

/** 温度读作整数：摄氏 24.3 度 → 24。音频片段只生成 0~42，超范围夹紧以免配套音频缺失。 */
export const TEMP_MIN = 0;
export const TEMP_MAX = 42;

export function tempC(value) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return 20;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, v));
}

/** 华氏度，供国外城市对照（取整） */
export function toF(celsius) {
  return Math.round((Number(celsius) * 9) / 5 + 32);
}

/** WMO 天气码 → { zh, en, icon, audio } */
export function weatherOf(code) {
  const key = String(code ?? '');
  return wmoMap.codes[key] || wmoMap.fallback;
}

/**
 * 把一张城市卡片整理成「显示用 + 播报用」的统一结构。
 * @param {object} card { city, day:{code,tMax,tMin,date}, dayIndex }
 */
export function describeCard(card) {
  const w = weatherOf(card.day?.code);
  const hi = tempC(card.day?.tMax);
  const lo = tempC(card.day?.tMin);
  const [min, max] = lo <= hi ? [lo, hi] : [hi, lo];

  const zhText = `${card.city.zh} ${w.zh} ${numToZh(min)}到${numToZh(max)}度`;
  const enText = `${card.city.en} · ${w.en} · ${toF(min)}–${toF(max)}°F`;

  // 音频拼接脚本：每项是 assets/audio/zh 下的相对路径，按顺序播放。
  // 注意温度区间的读法：前半段用「纯数字」（五），后半段用「数字+度」（十五度），
  // 拼出来才是「五到十五度」；前半段若用 t{N} 会读成「五度到十五度」。
  const segments = [
    { kind: 'city', key: card.city.id },
    ...w.audio.map((key) => ({ kind: 'weather', key })),
    { kind: 'num', key: `n${min}` },
    { kind: 'word', key: 'dao' },
    { kind: 'temp', key: `t${max}` },
  ];

  return {
    city: card.city,
    day: card.day,
    dayIndex: card.dayIndex ?? 0,
    weather: w,
    hi: max,
    lo: min,
    zhText,
    enText,
    segments,
  };
}

/** 日期标签：今天 / 明天 / 后天 */
export function dayLabel(index) {
  return ['今天', '明天', '后天'][index] ?? `第${index + 1}天`;
}

export function dayLabelEn(index) {
  return ['Today', 'Tomorrow', 'Day After'][index] ?? `Day ${index + 1}`;
}

export { wmoMap };
