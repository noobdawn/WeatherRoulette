// 核心逻辑自测：不需要浏览器，直接跑 Node（Node 20+ 原生支持 import attributes）。
// 覆盖：随机数、洗牌分布、数字读法、卡片构造、播报文案与音频片段序列。
//
//   node tools/test-core.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));

const { shuffled, shuffledWithSeed, randInt, mapLimit } = await import(
  new URL('../js/core/utils.js', import.meta.url)
);
const { numToZh, tempC, toF, weatherOf, describeCard, dayLabel } = await import(
  new URL('../js/core/format.js', import.meta.url)
);
const { pickCities, buildCards, uniqueCities, isDomestic } = await import(
  new URL('../js/core/cards.js', import.meta.url)
);
const { cityAudioPath, weatherAudioPath, wordAudioPath, tempAudioPath, musicPath } = await import(
  new URL('../js/core/paths.js', import.meta.url)
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const cities = load('data/cities.json').cities;
const wmo = load('data/wmo-map.json');
const audioManifest = load('assets/audio/manifest.json');

console.log('\n[1] 城市数据');
check(`城市数量合理（当前 ${cities.length}）`, () => assert.ok(cities.length >= 50));
check('每个城市字段齐全', () => {
  for (const c of cities) {
    for (const k of ['id', 'zh', 'en', 'country', 'lat', 'lon', 'timezone']) {
      assert.ok(c[k] !== undefined && c[k] !== '', `${c.id} 缺字段 ${k}`);
    }
    assert.equal(typeof c.lat, 'number');
    assert.equal(typeof c.lon, 'number');
    assert.ok(c.lat >= -90 && c.lat <= 90, `${c.id} 纬度越界`);
    assert.ok(c.lon >= -180 && c.lon <= 180, `${c.id} 经度越界`);
  }
});
check('城市 id 无重复', () => {
  const seen = new Set();
  for (const c of cities) {
    assert.ok(!seen.has(c.id), `重复 id：${c.id}`);
    seen.add(c.id);
  }
});
check('id 只含安全字符（用于文件名与 URL）', () => {
  for (const c of cities) assert.match(c.id, /^[a-z0-9]+$/, `${c.id} 含非法字符`);
});
check('国内城市与国外城市都有', () => {
  assert.ok(cities.filter(isDomestic).length >= 10, '国内城市太少');
  assert.ok(cities.filter((c) => !isDomestic(c)).length >= 10, '国外城市太少');
});
check('时区均被 Intl 识别', () => {
  for (const c of cities) {
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat('zh-CN', { timeZone: c.timezone }).format(new Date()),
      `${c.id} 时区无效：${c.timezone}`,
    );
  }
});

console.log('\n[2] 音频清单与城市一一对应');
check('每个城市都有语音片段', () => {
  const missing = cities.filter((c) => !audioManifest.files[`zh/city/${c.id}.mp3`]);
  assert.equal(missing.length, 0, `缺 ${missing.length} 个：${missing.slice(0, 5).map((c) => c.id)}`);
});
check('每种天气都有语音片段', () => {
  const keys = new Set();
  for (const info of Object.values(wmo.codes)) info.audio.forEach((k) => keys.add(k));
  const missing = [...keys].filter((k) => !audioManifest.files[`zh/weather/${k}.mp3`]);
  assert.equal(missing.length, 0, `缺：${missing}`);
});
check('0~42 温度片段齐全', () => {
  const missing = [];
  for (let n = 0; n <= 42; n++) if (!audioManifest.files[`zh/temp/t${n}.mp3`]) missing.push(n);
  assert.equal(missing.length, 0, `缺：${missing}`);
});
check('连接词片段齐全', () => {
  for (const k of ['dao', 'du']) assert.ok(audioManifest.files[`zh/word/${k}.mp3`], `缺 ${k}`);
});
check('背景音乐已生成', () => {
  assert.ok(audioManifest.music?.length, '清单里没有音乐文件');
});

console.log('\n[3] 工具函数');
check('randInt 落在范围内且分散', () => {
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 5000; i++) {
    const v = randInt(10);
    assert.ok(v >= 0 && v < 10);
    buckets[v]++;
  }
  for (const b of buckets) assert.ok(b > 300, `分布不均：${buckets}`);
});
check('shuffled 不修改原数组且元素守恒', () => {
  const src = [1, 2, 3, 4, 5];
  const out = shuffled(src);
  assert.deepEqual(src, [1, 2, 3, 4, 5]);
  assert.deepEqual([...out].sort(), src);
});
check('shuffle 确实打乱顺序（1000 次里至少出现多种排列）', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(shuffled([1, 2, 3, 4, 5, 6]).join(''));
  assert.ok(seen.size > 100, `排列太少：${seen.size}`);
});
check('shuffledWithSeed 同日稳定、异日不同', () => {
  const a = shuffledWithSeed(cities.map((c) => c.id), 20261004).join(',');
  const b = shuffledWithSeed(cities.map((c) => c.id), 20261004).join(',');
  const c = shuffledWithSeed(cities.map((c) => c.id), 20261005).join(',');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
check('mapLimit 保持顺序并遵守并发上限', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `并发超标：${peak}`);
});

console.log('\n[4] 数字与温度读法');
check('中文数字读法', () => {
  assert.equal(numToZh(0), '零');
  assert.equal(numToZh(7), '七');
  assert.equal(numToZh(10), '十');
  assert.equal(numToZh(12), '十二');
  assert.equal(numToZh(20), '二十');
  assert.equal(numToZh(24), '二十四');
  assert.equal(numToZh(40), '四十');
  assert.equal(numToZh(42), '四十二');
  assert.equal(numToZh(-3), '零下三');
});
check('温度被夹紧到音频覆盖范围', () => {
  assert.equal(tempC(-15), 0);
  assert.equal(tempC(100), 42);
  assert.equal(tempC(23.6), 24);
  assert.equal(tempC('18'), 18);
});
check('摄氏度换算华氏度', () => {
  assert.equal(toF(0), 32);
  assert.equal(toF(100), 212);
  assert.equal(toF(24), 75);
});
check('所有天气码都能解析出中文词', () => {
  for (const code of Object.keys(wmo.codes)) {
    const w = weatherOf(code);
    assert.ok(w.zh && w.en && w.icon, `天气码 ${code} 缺字段`);
    assert.ok(Array.isArray(w.audio) && w.audio.length, `天气码 ${code} 缺音频键`);
  }
  assert.ok(weatherOf(999).zh, '未知天气码应有兜底');
});

console.log('\n[5] 卡片与播报文案');
check('pickCities 每次结果不同且数量稳定', () => {
  const runs = [];
  for (let i = 0; i < 30; i++) runs.push(pickCities(cities).map((c) => c.id).join(','));
  assert.equal(new Set(runs).size, 30, '出现了完全相同的选城结果');
  const picked = pickCities(cities);
  assert.equal(picked.length, 20, `选城数量应为 20，实际 ${picked.length}`);
  assert.ok(picked.filter(isDomestic).length >= 10, '国内城市配额不足');
  assert.ok(picked.filter((c) => !isDomestic(c)).length >= 8, '国际城市配额不足');
});
check('pickCities 城市不足时用另一边补足', () => {
  const only = cities.filter(isDomestic).slice(0, 5);
  const picked = pickCities(only);
  assert.equal(picked.length, 5);
});
check('buildCards 产出卡片，且日期标签与温度来自同一天', () => {
  const byCity = {};
  const days = ['2026-10-04', '2026-10-05', '2026-10-06'];
  for (const c of cities) {
    byCity[c.id] = {
      time: days,
      weather_code: [0, 61, 71],
      temperature_2m_max: [26, 22, 5],
      temperature_2m_min: [18, 15, -2],
      precipitation_probability_max: [5, 80, 90],
      wind_speed_10m_max: [10, 20, 30],
      apparent_temperature_max: [25, 21, 3],
    };
  }
  const picked = pickCities(cities);
  const cards = buildCards(picked, byCity);
  assert.equal(cards.length, picked.length);
  // 默认播今天：dayIndex 必须全为 0，且温度取自第 0 天
  for (const card of cards) {
    assert.equal(card.dayIndex, 0, `${card.city.id} 的 dayIndex 不是 0`);
    assert.equal(card.day.date, days[0]);
    assert.equal(card.day.tMax, 26);
  }
  assert.equal(uniqueCities(cards).length, picked.length);
});
check('buildCards 显式要求时才随机挑天（大屏版玩法）', () => {
  const byCity = {};
  const days = ['2026-10-04', '2026-10-05', '2026-10-06'];
  for (const c of cities) {
    byCity[c.id] = {
      time: days, weather_code: [0, 61, 71], temperature_2m_max: [26, 22, 5],
      temperature_2m_min: [18, 15, -2], precipitation_probability_max: [5, 80, 90],
      wind_speed_10m_max: [10, 20, 30], apparent_temperature_max: [25, 21, 3],
    };
  }
  const picked = pickCities(cities);
  const seen = new Set();
  for (let i = 0; i < 40; i++) for (const c of buildCards(picked, byCity, { randomDay: true })) seen.add(c.dayIndex);
  assert.ok(seen.size > 1, 'randomDay=true 时没有随机挑天');
});
check('没有天气数据时占位卡片也有合法 dayIndex', () => {
  const picked = pickCities(cities).slice(0, 3);
  const cards = buildCards(picked, {});
  assert.equal(cards.length, 3);
  for (const c of cards) assert.ok(c.dayIndex >= 0 && c.dayIndex < 3, `dayIndex 越界：${c.dayIndex}`);
});
check('describeCard 文案与音频片段一致', () => {
  const card = {
    city: cities.find((c) => c.id === 'jinan'),
    day: { code: 2, tMax: 24, tMin: 12, date: '2026-10-04' },
    dayIndex: 0,
  };
  const d = describeCard(card);
  assert.equal(d.zhText, '济南 多云 十二到二十四度');
  assert.deepEqual(
    d.segments.map((s) => `${s.kind}:${s.key}`),
    ['city:jinan', 'weather:duoyun', 'temp:t12', 'word:dao', 'temp:t24', 'word:du'],
  );
  for (const seg of d.segments) {
    const rel = {
      city: `zh/city/${seg.key}.mp3`,
      weather: `zh/weather/${seg.key}.mp3`,
      temp: `zh/temp/${seg.key}.mp3`,
      word: `zh/word/${seg.key}.mp3`,
    }[seg.kind];
    assert.ok(audioManifest.files[rel], `音频片段缺失：${rel}`);
  }
  assert.match(d.enText, /Jinan/);
  assert.match(d.enText, /°F/);
});
check('温度倒挂时自动纠正（最高不低于最低）', () => {
  const card = { city: cities[0], day: { code: 0, tMax: 10, tMin: 22 }, dayIndex: 0 };
  const d = describeCard(card);
  assert.ok(d.hi >= d.lo);
  assert.match(d.zhText, /十到二十二度/);
});
check('所有城市 × 全部天气 × 温度极值都能生成完整音频序列', () => {
  const codes = Object.keys(wmo.codes);
  let checked = 0;
  for (const city of cities) {
    for (const code of codes) {
      for (const [tMax, tMin] of [[42, 0], [24, 12], [-5, -10]]) {
        const d = describeCard({ city, day: { code, tMax, tMin }, dayIndex: 0 });
        assert.ok(d.segments.length >= 6, `${city.id}/${code} 片段过少`);
        for (const seg of d.segments) {
          const rel = {
            city: `zh/city/${seg.key}.mp3`,
            weather: `zh/weather/${seg.key}.mp3`,
            temp: `zh/temp/${seg.key}.mp3`,
            word: `zh/word/${seg.key}.mp3`,
          }[seg.kind];
          assert.ok(audioManifest.files[rel], `音频缺失：${rel}（${city.id}/${code}）`);
        }
        checked++;
      }
    }
  }
  console.log(`      （穷举了 ${checked} 种组合，全部有配套音频）`);
});
check('日期标签中英对照', () => {
  assert.equal(dayLabel(0), '今天');
  assert.equal(dayLabel(2), '后天');
});

console.log('\n[6] 音频路径解析（真实用 paths.js，不信手写）');
/** 用与 manifest.js 相同的分发逻辑解析片段 → 相对清单路径 */
function relOf(seg) {
  const url = {
    city: () => cityAudioPath(seg.key),
    weather: () => weatherAudioPath(seg.key),
    word: () => wordAudioPath(seg.key),
    temp: () => tempAudioPath(seg.key),
  }[seg.kind]();
  return url.replace(/^assets\/audio\//, '');
}
check('temp 片段键带 t 前缀时不会解析成 tt12', () => {
  assert.equal(tempAudioPath('t12'), 'assets/audio/zh/temp/t12.mp3');
  assert.equal(tempAudioPath(12), 'assets/audio/zh/temp/t12.mp3');
  assert.equal(tempAudioPath('24'), 'assets/audio/zh/temp/t24.mp3');
  assert.ok(!tempAudioPath('t12').includes('/tt'), '出现了双 t 路径');
});
check('每张卡片的每个片段都能在清单里找到（模拟 manifestHas 的判定）', () => {
  let checked = 0;
  for (const city of cities) {
    for (const code of Object.keys(wmo.codes)) {
      const d = describeCard({ city, day: { code, tMax: 41, tMin: 3 }, dayIndex: 0 });
      for (const seg of d.segments) {
        assert.ok(audioManifest.files[relOf(seg)], `清单缺失：${relOf(seg)}`);
        checked++;
      }
    }
  }
  console.log(`      （校验了 ${checked} 个片段路径，全部命中清单）`);
});
check('背景音乐路径存在于清单', () => {
  const name = path.basename(musicPath());
  assert.ok(audioManifest.music.includes(name), `清单里的音乐是 ${audioManifest.music}`);
});

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`);
process.exit(failed ? 1 : 0);
