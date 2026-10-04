# 天气播报 · Weather Roulette

给 4~6 岁孩子玩的环球天气播报站：每次打开都随机挑选城市、随机顺序、随机壁纸，
用**端正的女播音员腔**播报「城市 天气 温度」，背景持续播放《渔舟唱晚》——
把央视《天气预报》的体验做成了一个可以点着玩的网页。

界面上**没有任何工具栏**：整屏就是一张城市地标照片 + 居中大字，自动轮播。
没有蒙版、没有进度条、没有播放按钮、没有华氏度/当地时间/风速。

纯静态站点（HTML + CSS + 原生 ES Module），**无构建步骤**，直接托管在 GitHub Pages 上。

## 怎么玩

| 操作 | 效果 |
|------|------|
| 点一下屏幕 | 暂停 / 继续（左上角出现小暂停指示） |
| 右上角 🎵 | 背景音乐开关（平时很淡，鼠标移上去才明显） |
| `空格` | 暂停 / 继续 |
| `←` `→` | 上一个 / 下一个城市 |
| `M` | 背景音乐开关 |

第一次打开必须点一下「开始播报」——浏览器规定音频要由用户手势解锁，这是硬限制。

---

## 快速开始（本地预览）

```bash
python tools/serve.py            # http://127.0.0.1:8080
python tools/serve.py --lan      # 允许手机用局域网 IP 访问，方便真机试
```

> 必须通过 HTTP 打开，不要直接双击 `index.html`（`file://` 下浏览器会禁用 ES Module 与 Service Worker）。
> 页面第一次加载后即可离线使用：Service Worker 会把页面、语音包和听过的城市壁纸都缓存到本地。

## 部署到 GitHub Pages

仓库已经配好 GitHub Actions，推送即自动部署：

```bash
git add -A
git commit -m "天气播报站：城市随机轮播 + 女声播报 + 渔舟唱晚"
git push -u origin main
```

然后在 GitHub 仓库页面 **Settings → Pages → Build and deployment → Source** 选择
**GitHub Actions**（只需设置一次）。稍等 1~2 分钟，站点地址为：

```
https://noobdawn.github.io/WeatherRoulette/
```

---

## 需求是怎么实现的

| # | 需求 | 实现方式 |
|---|------|----------|
| 1 | 城市范围：国内一二线 + 世界发达国家著名城市 | `data/cities.json`，**81 座城市**（国内 43 + 国外 38），中英对照、含经纬度与时区 |
| 2 | 每次打开随机打乱播放顺序 | `crypto.getRandomValues` 驱动的 Fisher–Yates 洗牌（`js/core/utils.js`）；每轮播完自动重新随机，无限循环 |
| 3 | 背景是城市地标壁纸，且随机 | 每城一张免费授权地标实景图（`assets/images/manifest.json`），`primary + fallbacks` 依次降级；全部失败则用「城市首字」卡通插画兜底。图片经 Service Worker 离线缓存 |
| 4 | 贴近央视《天气预报》的音效 | 背景音乐《渔舟唱晚》持续循环；播报前有留白、句间有停顿，全部节奏参数集中在 `js/core/constants.js` 的 `AUDIO` |
| 5 | 女播音员腔诵读「济南 多云转晴 十二到二十四度」 | **离线预生成 + 播放时拼接**：把 81 个城市名、14 个天气词、0~42 度的 43 个温度词、3 个连接词分别合成独立 mp3，网页按顺序拼接成整句 |
| 6 | 面向 4~6 岁：字大、中英对照 | 城市名 1440 端 **128px** / 375 端 **54px**，温度 168px / 84px；城市、天气、温度全部中英成对 |
| 7 | 极简视觉：一张背景 + 前景，自动轮播 | 满屏壁纸铺底，**零蒙版**（`#bg::after` 中线透明度实测 0），居中大字直接压在照片上；所有控制条移除，只留「点一下暂停」与一个很淡的音乐开关 |

### 文字在照片上怎么保证看得清（去掉蒙版的代价）

去掉黑色蒙版后，可读性只能靠文字自己。这里用了三层保障，缺一层都会出现「某些城市看不清」：

1. **离线预计算壁纸亮度**（`tools/precompute-luminance.py` → `assets/images/luminance.json`）。
   每张图切成 16×12 网格，每格记一个 8bit 相对亮度；前端拿到文字包围盒后按面积加权投票，决定用深墨字还是白字。
   > 为什么必须离线算：`cdn.pixabay.com` **不返回 CORS 头**，浏览器端 canvas 读像素会直接失败。
   > 早期版本因此把 Pixabay 那批图（银川、福州、武汉、东京…）误判成白字压在亮壁纸上，实测只有 **1.46:1**，几乎看不清。
2. **内嵌光晕描边**（`style.css` 的 `--fg-shadow`）。第一层是**紧贴字形的实心描边**（`0 0 1px` + alpha ≈0.96），
   再向外逐层变虚。这一层才是真正的兜底：单色文字压在明暗混合的壁纸上，纯色对比天生不可能处处达标。
   > 注意：早期用的「拉稀光晕」（`0 0 3px` + 0.55）是失败的——模糊半径一大，光晕就和背景混色，等于没有垫层。
3. **逐城穷举验收**（`tools/test-contrast.mjs`）。用真实字号与排版在 81 城 × 3 视口上离线跑 243 项判定：
   要求每张图都有明确配色、两套配色都被真正用上、且带描边后所有区域 ≥4.5:1。

### 需求 5 的详细说明（为什么这么做）

在线 TTS 有网络延迟、可能断服、还可能被浏览器策略拦住。央视的播报句式是高度模板化的：

```
<城市名> <天气> <最低温> 到 <最高温> 度
```

所有可变部分都是**有限集合**，于是把每个片段离线合成为一个小 mp3：

| 类别 | 数量 | 示例文件 |
|------|------|----------|
| 城市名 | 81 | `assets/audio/zh/city/jinan.mp3`（济南） |
| 天气词 | 14 | `assets/audio/zh/weather/duoyun.mp3`（多云） |
| 温度词 | 43 | `assets/audio/zh/temp/t12.mp3`（十二度） |
| 连接词 | 3 | `assets/audio/zh/word/dao.mp3`（到） |

播放时 `js/audio/speech.js` 依次播放 `jinan → duoyun → t12 → dao → t24 → du`，
中间按 `AUDIO.gapCityToWeather` / `gapWeatherToTemperature` 插入停顿，
就得到完整的一句「济南 多云 十二到二十四度」。

好处：**完全离线可用、零延迟、音色全程一致、无须任何在线 TTS 服务**；语音包总共只有约 1.2 MB。

---

## 目录结构

```
index.html                极简主页面（满屏壁纸 + 居中大字）
style.css
large.html / large.css    大屏版：自带播放控制，适合投屏/电视
sw.js                     Service Worker：离线缓存（页面/语音/壁纸分区缓存）
data/
  cities.json             81 座城市：中英名、国家、经纬度、时区、地标关键词
  wmo-map.json            WMO 天气码 → 中文词/英文词/图标/音频键
js/
  main.js                 主流程装配
  core/                   常量、路径、工具、启动、天气数据、文案、卡片构造
  audio/                  音频清单、并发加载器、语音拼接、背景音乐、播报调度
  ui/                     卡片渲染与壁纸亮度适配、天气图标、图片候选与探测
assets/
  audio/zh/{city,weather,temp,word}/*.mp3   语音片段（141 个）
  audio/music/music.mp3                     背景音乐（自备版本，优先级最高）
  audio/music/yuzhouchangwan.mp3            兜底：程序合成的古筝版（90 秒）
  audio/manifest.json                       片段清单（生成物）
  images/manifest.json                      城市壁纸清单（生成物）
  images/luminance.json                     壁纸亮度网格（生成物，供文字配色用）
tools/
  serve.py                本地静态服务器（多线程，必须用它，见下方说明）
  gen-audio.py            生成语音片段（调用 edge-tts）
  gen-music.py            合成《渔舟唱晚》（numpy 加法合成 + pyav 编码 mp3）
  precompute-luminance.py 预计算每张壁纸的亮度网格（文字配色用）
  check-images.py         独立校验壁纸清单：覆盖度 + URL 真实可用性
  verify-images.ps1       批量验证壁纸 URL（队友实现，PowerShell 版）
  inspect-audio.py        音频体检：时长/峰值/静音比/主频
  test-core.mjs           核心逻辑测试
  test-contrast.mjs       81 城 × 3 视口的文字可读性穷举验收
  lint-site.mjs           静态一致性：模块依赖/DOM 契约/CSS/预缓存清单
  e2e.mjs                 真实浏览器端到端（CDP 直连 Chrome）
  e2e-offline.mjs         断网可用性验收
```

> ⚠️ 本地预览**务必用 `python tools/serve.py`**。自己写 `python -m http.server` 时如果是单线程
> `TCPServer`（不是 Python 3.7+ 的 `ThreadingHTTPServer`），ES Module 的并行请求会把它堵死，
> 浏览器报 `net::ERR_CONNECTION_REFUSED`，表现为页面骨架在但脚本从不执行——很容易误判成代码 bug。

---

## 换素材

### 换背景音乐

当前仓库里的背景音乐是 **`assets/audio/music/music.mp3`**（用户自备的《渔舟唱晚》演奏版）。

网页的选用顺序是：

1. `assets/audio/music/music.mp3` —— 自备版本，存在就用它（**优先级最高**）
2. `assets/audio/music/yuzhouchangwan.mp3` —— 仓库内置的**程序合成**古筝版（90 秒，1.38 MB），
   由 `tools/gen-music.py` 生成，曲调属公有领域、可自由分发，作为兜底

想换音乐，直接替换 `music.mp3` 即可（也可以删掉它，就会自动回退到内置合成版）。
音量改 `js/core/constants.js` 里 `AUDIO.musicVolume`（默认 0.30）。

> ⚠️ 版权提醒：自备的**录音版本**（如某位演奏家的商业录音）通常受版权保护。
> 本仓库可以私有使用，但若要公开分发，建议只保留内置的合成版，或换成明确可自由使用的录音。

### 换成你自己的城市壁纸

按 `<城市id>.jpg` 命名放进 `assets/images/city/`，并在 `assets/images/manifest.json`
里把该城市的 `primary` 指向这张图即可（城市 id 见 `data/cities.json`）。

### 增加城市

1. 在 `data/cities.json` 的 `cities` 数组里加一项（`id` 只能用小写字母和数字）；
2. 运行 `python tools/gen-audio.py` 生成这座城市名的语音片段（已存在的会自动跳过）；
3. 在 `assets/images/manifest.json` 里补上它的壁纸。

### 改播音语速／停顿

全部在 `js/core/constants.js` 的 `AUDIO` 里：

```js
rate: '-8%',              // 语速，负值更慢更庄重
gapCityToWeather: 120,    // 城市名 → 天气 的停顿（毫秒）
gapWeatherToTemp: 160,    // 天气 → 温度
gapBetweenCities: 1100,   // 两个城市之间
musicVolume: 0.30,        // 背景音乐音量
```

改完语速后需要重新生成语音包：`python tools/gen-audio.py --force`。

---

## 重新生成资源

```bash
# 1. 语音包（需要联网调用微软 TTS；约 3~8 分钟，可中断后续跑）
python -m pip install edge-tts
python tools/gen-audio.py

# 2. 兜底用的《渔舟唱晚》（纯本地合成，不需要联网；有 music.mp3 时其实用不到）
python -m pip install numpy av
python tools/gen-music.py --rounds 2

# 3. 壁纸亮度网格（换过壁纸后必须重跑，否则新图没有配色判据）
python -m pip install pillow numpy
python tools/precompute-luminance.py --force
```

## 自检（全部可离线跑）

```bash
node tools/test-core.mjs        # 核心逻辑 + 6810 种文案组合的音频配套检查
node tools/test-contrast.mjs    # 81 城 × 3 视口的文字可读性穷举（需要先跑亮度网格）
node tools/lint-site.mjs        # 模块依赖 / DOM 契约 / CSS / 预缓存清单一致性
python tools/check-images.py --all -j 10   # 逐条验证全部 218 个壁纸 URL 真能下载
python tools/gen-audio.py --verify         # 语音片段是否齐全
python tools/inspect-audio.py              # 音频体检：时长/峰值/静音比/主频

# 真实浏览器端到端（本机装了 Chrome 即可，不需要 playwright）
python tools/serve.py -p 8099 &
node tools/e2e.mjs index.html --keep-shots   # 渲染/字号/零蒙版/暂停/自动推进/双视口
node tools/e2e.mjs large.html                # 大屏版
node tools/e2e-offline.mjs                   # 断网后仍能打开并继续播报
```

---

## 技术要点

- **随机性**：一律走 `crypto.getRandomValues`，避免孩子狂按刷新时出现固定序列。
- **天气数据**：[Open-Meteo](https://open-meteo.com/)（免 API Key、免费）。81 座城市用一次批量请求取回未来 3 天预报；本地缓存 30 分钟；断网时回退到上次缓存，无缓存才用演示数据（写进隐藏状态位）。
- **播报当天的天气**：日期标签与温度取自同一天（`buildCards` 默认 `randomDay: false`）。早期版本每城随机挑一天，会出现「标签写明天、主温度却是今天的最高温」这种自相矛盾，对孩子是理解障碍。
- **音频策略**：片段按需加载、并发上限 6、永不重复请求；单个片段失败会被跳过而不是卡死整句；切换城市用 `AbortSignal` 立即打断，不会出现两个声音重叠。
- **离线**：Service Worker 分区缓存（页面 stale-while-revalidate、语音与壁纸 cache-first），在 `boot()` 一开始就注册，不等用户点「开始播报」。首次访问后断网也能完整播报。
- **无障碍**：`aria-live` 播报、隐藏状态位给屏幕阅读器、键盘 `空格`/`←`/`→`/`M` 可操作。
- **浏览器要求**：支持 ES Module、`import ... with { type: 'json' }`、`text-shadow`、Service Worker 的现代浏览器（Chrome/Edge 123+、Safari 17.2+、Firefox 128+）。

## 已知取舍

- 温度语音片段覆盖 **0~42°C**，超出范围会被夹紧到区间端点（避免出现没有配套音频的数字）。中国与绝大多数发达国家城市都在这个区间内。
- 天气文案按央视口径做了归并：`1` 与 `0` 都读「晴」、`51/53/61` 都读「小雨」等，详见 `data/wmo-map.json`。
- 壁纸来自 Pexels / Pixabay 的 CDN，**首次访问需要联网**；之后由 Service Worker 离线缓存。若某张图被图库下架，会自动降级到 `fallbacks`，再不行就用内置插画。
- 81 个城市里有 4 个（石家庄、银川、佛山、长春）找不到本市地标的免费授权实景图，用了同省/同区域地标并在 `credit` 字段写明。
- 极简版没有可见的进度条与播放控制，这是刻意的；需要这些功能请用 `large.html` 大屏版。

## 许可

代码可自由使用。语音由微软 Edge TTS 合成，请遵守其服务条款；壁纸版权归各图库摄影师所有，署名与授权见 `assets/images/manifest.json`。
背景音乐：`assets/audio/music/music.mp3` 为自备录音版本（注意录音版权，公开分发前请确认）；
`assets/audio/music/yuzhouchangwan.mp3` 是程序合成的演奏版，曲调公有领域，可自由分发。

