// 一次「浏览」的城市挑选与卡片构造。
// 需求：每次打开网页都重新随机 —— 城市随机、顺序随机、每城随机挑一天。
import { CARDS_PER_CITY, FORECAST_DAYS, FORECAST_DAYS_OUT, CN_QUOTA, INTL_QUOTA } from './constants.js';
import { shuffled, randInt } from './utils.js';
import { dailyToDays } from './weather.js';

export function isDomestic(city) {
  return city.country === '中国';
}

/**
 * 组成一次浏览的城市队列：国内优先保证「家乡感」，再掺入国际城市。
 * 当某一边不够时，用另一边补足，保证总数稳定。
 */
export function pickCities(cities, { cnQuota = CN_QUOTA, intlQuota = INTL_QUOTA } = {}) {
  const cn = shuffled(cities.filter(isDomestic));
  const intl = shuffled(cities.filter((c) => !isDomestic(c)));
  const target = Math.min(cities.length, cnQuota + intlQuota);

  const takeCn = Math.min(cn.length, cnQuota);
  const takeIntl = Math.min(intl.length, intlQuota);
  const picked = [...cn.slice(0, takeCn), ...intl.slice(0, takeIntl)];

  // 数量不足目标时，从剩余城市补齐
  if (picked.length < target) {
    const rest = shuffled([...cn.slice(takeCn), ...intl.slice(takeIntl)]);
    picked.push(...rest.slice(0, target - picked.length));
  }
  return shuffled(picked); // 打乱国内/国外的先后次序
}

/**
 * 把城市列表展开成待播报的卡片队列。
 *
 * 默认固定播「今天」（randomDay=false）：卡片上的日期标签与温度必须来自同一天，
 * 否则会出现「标签写着 明天，主温度却是今天的最高温」这种自相矛盾，4~6 岁的孩子会困惑，
 * 也偏离央视《天气预报》「播报当天」的口径。
 * randomDay=true 时才会每城随机挑一天（大屏版用作可选玩法）。
 *
 * 每张卡片额外带 `forecast`：主日之后的**两天**（老板要求界面拆成两块 ——
 * 上面是当前天气/气温，下面是未来两天）。注意 `forecast` **只用于显示**，
 * 不参与 describeCard() 的播报片段，所以语音仍然只念当前那天。
 * @param {Array} cities 选中的城市
 * @param {Object} byCity 城市 id -> Open-Meteo daily 数据
 * @param {Object} opts { days, perCity, randomDay, forecastDays }
 */
export function buildCards(cities, byCity, opts = {}) {
  const {
    days = FORECAST_DAYS, perCity = CARDS_PER_CITY,
    randomDay = false, forecastDays = FORECAST_DAYS_OUT,
  } = opts;
  const cards = [];
  for (const city of cities) {
    const list = dailyToDays(byCity[city.id], days);
    if (!list.length) {
      // 完全拿不到数据时不跳过城市，用占位天气，界面照常展示
      for (let d = 0; d < perCity; d++) {
        cards.push({
          city,
          day: { code: 2, tMax: 24, tMin: 16, date: null },
          dayIndex: d % days,
          forecast: [],
        });
      }
      continue;
    }
    const start = randomDay ? randInt(list.length) : 0;
    for (let k = 0; k < perCity; k++) {
      const dayIndex = (start + k) % list.length;
      // 主日之后的连续 forecastDays 天（循环回卷，寒暑假长也能取满）
      const forecast = [];
      for (let f = 1; f <= forecastDays; f++) {
        const item = list[(dayIndex + f) % list.length];
        if (item) forecast.push({ ...item, dayIndex: (dayIndex + f) % list.length });
      }
      cards.push({ city, day: list[dayIndex], dayIndex, forecast });
    }
  }
  return cards;
}

/** 把卡片队列按城市去重（用于预加载图片/音频时不重复请求） */
export function uniqueCities(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    if (seen.has(c.city.id)) continue;
    seen.add(c.city.id);
    out.push(c.city);
  }
  return out;
}
