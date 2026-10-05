# AGENTS.md —— 给后续接手的 AI / 开发者的说明书

> 这份文档记录 **WeatherRoulette（天气播报）** 做到现在这一步的完整脉络：
> 需求意图、架构决策、踩过的坑、以及**必须遵守的红线**。
> 请先通读再动手；尤其是第 2 节「红线」和第 6 节「Windows 中文编码」，那些是用返工换来的。

---

## 0. 项目是什么

一个给 **4~6 岁孩子**看的天气播报站：整屏一张城市地标照片 + 居中大字，
用**端正的女播音员腔**播报「城市 天气 温度」，背景循环播放《渔舟唱晚》——
把央视《天气预报》的体验做成一个点开就能看的静态网页。孩子通过它认识各个城市。

- 仓库：`noobdawn/WeatherRoulette`，线上地址 **https://noobdawn.github.io/WeatherRoulette/**
- 纯静态（HTML + CSS + 原生 ES Module），**无构建步骤**，GitHub Actions 直接发布仓库根目录
- 总量约 **5.2 MB**：81 城壁纸清单 + 183 个语音片段（866 KB）+ 2 个音乐文件

### 两条产品红线（老板明确要求，不要自作主张改）

1. **界面上不要任何工具栏。** 没有蒙版、没有卡片面板、没有进度条、没有播放控制、
   没有华氏度、没有当地时间、没有风速。就是「一张背景 + 前景文字，自动轮播」。
   进去**直接自动播报**，不要「开始播报」界面。
2. **音频效果由真人验收，不靠自动测试下结论。** 见第 5 节。

---

## 1. 架构一览

```
index.html                极简主页面（满屏壁纸 + 居中大字）
style.css
large.html / large.css    大屏版：整屏单城 + 自带播放控制，适合投屏/电视
sw.js                     Service Worker：分区离线缓存（当前 CACHE_VERSION = v5）
data/
  cities.json             81 座城市（国内 43 + 国外 38）：中英名、国家、经纬度、时区、地标关键词
  wmo-map.json            WMO 天气码 → 中文词/英文词/图标键/音频键
js/
  main.js                 主流程装配（预加载 → 自动播放 → 交互）
  core/
    constants.js          所有节奏参数（AUDIO）、配额、CORE_ASSETS 清单
    paths.js              资源路径拼装（唯一出处）
    utils.js              随机/洗牌/并发/当地时间等
    boot.js               DOM 就绪、SW 注册、JSON 抓取、错误浮层
    weather.js            Open-Meteo 批量查询 + 缓存 + 离线演示数据
    format.js             describeCard()：界面文案与音频片段的**唯一真相来源**
    cards.js              选城（国内配额 + 国际配额）与卡片构造
  audio/
    manifest.js           读音频清单 + 片段 → URL 解析
    loader.js             ClipLoader：按需加载 + 并发限流
    preload.js            AudioPreloader：整包预下载（只灌 HTTP 缓存）
    speech.js             SpeechSequencer：把片段拼成一句话 + 句间停顿 + AbortSignal 打断
    music.js              MusicPlayer：淡入淡出、循环、autoplay 被拒时静默降级
    player.js             Broadcaster：卡片队列调度、暂停/继续、下一城、无限循环
  ui/
    screen.js             渲染卡片 + **壁纸亮度适配**（文字配色）
    loading.js            毛玻璃加载页（细进度条 + 强制进入）
    globe.js              3D 地球过场（WebGL 写实地貌 + Canvas 2D 降级路径）
    globe-data.js         海陆矢量数据（第一代地球用；生成物）
    weather-icon.js       13 个纯代码 SVG 天气图标
    assets.js             图片清单 + 候选图探测
    large.js              大屏版渲染
assets/
  audio/zh/{city,weather,temp,num,word}/*.mp3   183 个语音片段
  audio/music/music.mp3                        背景音乐（自备版，优先级最高）
  audio/music/yuzhouchangwan.mp3               兜底：程序合成的古筝版（90s）
  audio/manifest.json                          音频清单（生成物）
  images/manifest.json                         81 城壁纸（218 条 URL，生成物）
  images/luminance.json                        壁纸亮度网格（生成物，文字配色用）
  globe/{albedo.jpg,normal.jpg,countries.png,palette.png}  地球贴图（生成物，见 3.5 节）
tools/                   生成脚本与验收脚本，见第 5 节
tests/self-test.html     浏览器端自测页（不参与线上发布）
```

### 数据流（一句话版）

`cities.json` + `wmo-map.json` → `cards.js` 随机选城 → `weather.js` 取实时天气
→ `format.js` 产出 `{zhText, enText, segments}` → `screen.js` 渲染文字与壁纸
+ `speech.js` 按 `segments` 拼语音 → `player.js` 串起整轮并无限循环。

**关键约束**：`format.js` 是界面文字与音频片段的唯一真相来源。
改播报文案必须同时改它，不要在 UI 或音频层各写一份，否则会出现「看到的和听到的不一致」。

---

## 2. 红线：这些坑不要再踩

### 2.1 音频拼接：温度区间不能前后都带「度」

播报格式是「**五到十五度**」，不是「五度到十五度」。所以：

- 前半段用**纯数字**片段 `zh/num/n5.mp3`（读「五」）
- 后半段用**自带「度」**的片段 `zh/temp/t15.mp3`（读「十五度」）
- `zh/word/du.mp3`（单独的「度」）**已废弃并删除**，不要再生成或引用

`format.js` 里温度区间的 segments 是：
```js
{ kind: 'num',  key: `n${min}` },
{ kind: 'word', key: 'dao' },
{ kind: 'temp', key: `t${max}` },
```

### 2.2 音频片段必须先裁掉首尾静音

edge-tts 生成的每个片段头尾带 **约 780ms** 静音。不裁的话拼出来的句子一顿一顿
（「五 ⟨长停⟩ 到 ⟨长停⟩ 十五度」）。

**任何重新生成的语音片段，都必须跑一遍** `python tools/trim-audio.py`。
它会把原片段备份到 `assets/audio/.orig/`（已 gitignore），可据此回滚。

对应地，`constants.js` 里的停顿要小：`gapWeatherToTemp: 70`、`gapNumber: 50`。

### 2.3 路径解析曾经有个「双 t」bug

`format.js` 产出的温度键是 `t12`，而 `tempAudioPath(n)` 又会加一层 `t`，
早期会解析出不存在的 `tt12.mp3`，导致**每句播报的温度被静默丢掉**（只剩「北京 晴」）。
现在 `tempAudioPath` / `numAudioPath` 都会容错去掉前缀。改动这两处前先看 `tools/test-core.mjs` 的断言。

### 2.4 进度条不能被「片段级进度」污染

`player.js` 在 `phase === 'speak'` 时会透传 `speech.js` 的**片段级** `index/total`
（例如 `1/6`，表示第 1 个语音片段 / 共 6 个）。如果直接喂给界面，
城市进度会瞬间变成 `x/6` 再回弹。

- `player.js` 里展开顺序必须是 `{ ...p, index: i, total, phase: 'speak' }`（城市级在后，覆盖片段级）
- `main.js` 的 `onProgress` 再兜一层判断
- 极简版已经删掉进度条，但 `setProgress()` 仍是空实现，别以为可以随便删这段逻辑

### 2.5 Service Worker 必须在 boot() 一开始就注册

早期把 `registerServiceWorker()` 挂在「开始播报」的点击里，
结果用户在那之前关掉页面 → **什么都没缓存上**，离线可用性形同虚设。
现在注册在 `boot()` 第一行、不 await、绝不拖慢首屏。

另外：**改了任何资源都要把 `sw.js` 的 `CACHE_VERSION` 加一**，
否则老用户会一直拿到旧缓存（排查「改了没生效」时先怀疑这个）。

### 2.6 自动播放：浏览器策略无法绕过，但绝不能「卡住」

去掉了「开始播报」界面，改为进去就自动播报。但浏览器（尤其 iOS Safari）会拦截无手势的出声，
所以真实流程是：**先直接试 → 成功就静默开播；被拦才请用户点一下**。

⚠️ **踩过的大坑**：`AudioContext.resume()` 在 iOS 上可能**既不 resolve 也不 reject**。
早期代码 `await` 它，导致「成功」和「显示解锁按钮」两条路都不走，
界面永远停在加载页的 183/183。现在：

- 探针 `resume()` 带 600ms 超时
- 被挂起的 AudioContext 留着，等第一次用户手势时 `resumePendingAudio()`
- 任何 `pointerdown / touchstart / click / keydown` 都会立刻开播（不必找按钮）
- 所有分支都有兜底（音乐 play 结果、探针结果、2.5 秒超时），必定收敛到「开播」

**诊断入口**：`window.__wrDiag`（记录走的是 `auto:music` / `auto:silent-probe` / `unlock` / `skip`，
以及被拦原因和 UA）。手机上出问题先看它。

### 2.7 去掉蒙版后，文字可读性只能靠「离线亮度网格 + 内嵌描边」

这条最容易被低估，细节见第 3 节。

### 2.8 3D 地球：屏幕上方必须永远是正北（见第 3.5 节）

相机 `up` 必须每帧由 `up = normalize(north − (north·dir)·dir)` 重算，
**绝不能插值 up 向量本身**，也不能让相机俯仰角跟着城市纬度走。
换渲染方式（2D → WebGL）时这条也要原样保留。细节见第 3.5 节。

---

## 3. 最花功夫的一处：满屏壁纸上的文字可读性

老板要求去掉黑色蒙版（壁纸必须原样全可见），于是可读性只能靠文字自己。
这件事来回折腾了三轮，下面是最终方案与**为什么前面几版都不行**。

### 最终方案（三层，缺一层就会出现某些城市看不清）

1. **离线预计算亮度网格**
   `tools/precompute-luminance.py` → `assets/images/luminance.json`
   每张图切成 **16×12** 网格，每格一个 8bit 相对亮度；前端按文字包围盒取覆盖格子、
   **按区域面积加权**投票，决定用白字还是深墨字（判据：看不清的加权占比更少者胜）。

2. **内嵌光晕描边**（`style.css` 的 `--fg-shadow`）
   第一层是**紧贴字形的实心描边**（`0 0 1px` + alpha ≈0.96），再向外逐层变虚。
   **这一层才是真正的兜底**：单色文字压在明暗混合的照片上，纯色对比天生不可能处处达标
   （实测最差的城市有 50% 区域达不到 3:1，无论选白字还是黑字）。

3. **离线穷举验收** `tools/test-contrast.mjs`
   用真实字号与排版在 **81 城 × 3 视口**上跑 243 项判定，要求：
   每张图都有明确配色、两套配色都被真正用上、**带描边后所有区域 ≥4.5:1**。

### 走过的弯路（务必别再走）

| 弯路 | 现象 | 结论 |
|---|---|---|
| 用「平均亮度」判断亮暗 | 阿姆斯特丹平均偏亮 → 选深色字，但文字实际压在深色窗格上，几乎看不清 | 平均会掩盖最坏区域，必须用分布 |
| 浏览器端 canvas 读像素 | `cdn.pixabay.com` **不返回 CORS 头**，`crossOrigin` 的 Image 直接 ERR_FAILED、canvas 抛 SecurityError → 那批图（银川/福州/武汉/东京…）误判成白字压亮底，实测只有 **1.46:1** | 必须**服务端离线**预计算亮度，前端只读 JSON |
| 8×6 网格 | 每格约 180×150px，比一行字还大，把亮暗抹平 → 个别城市判不出最优配色（沈阳最差区域 25%） | 网格要细，最终用 16×12 |
| 「拉稀光晕」兜底 | `0 0 3px` + alpha 0.55：模糊半径一大，光晕与背景混色，等于没有垫层 | 第一层必须紧贴字形且接近不透明 |

### 壁纸来源

- 全部来自 **Pexels（66 条）/ Pixabay（152 条）** 的免费授权 CDN，署名与授权记在 `assets/images/manifest.json`
- **Unsplash 用不了**：`unsplash.com/s/photos` 与 napi 被 Anubis 反爬返回 401，
  `source.unsplash.com` 已下线（503），Lite 数据集下载速率 ~2KB/s。*不要凭记忆编造 Unsplash 图片 URL*
- 81 城里 4 城找不到本市地标的免费实景图，用了同省/同区域地标并在 `credit` 里写明：
  石家庄（河北长城）、银川（宁夏沙丘）、佛山（广东陈家祠）、长春（吉林雪景）
- 图片链接是否真能下载，用 `python tools/check-images.py --all -j 10` 全量验证（当前 218/218 通过）

---

## 3.5 3D 地球过场：屏幕上方必须是正北

城市之间插一段约 5 秒的地球动画：播完合肥要播东京时，镜头从俯瞰合肥转到俯瞰日本。
目的是**地理认知**——让孩子看见"地球是圆的、城市分布在地球上"。

### ★ 硬约束：整个动画期间正北朝上

朴素做法（相机俯仰角跟着城市纬度走）会让屏幕在两侧歪掉，不满足要求。正确解法：

```
north = (0,1,0)                                       // 世界坐标里 y 就是极轴
dir   = p(clamp(lat,-85,85), lon)                     // 相机方向，球心指向相机
up    = normalize(north − dot(north, dir) · dir)      // 每帧按当前 dir 重算
right = normalize(cross(up, dir))
```

三个不许犯的错：
- **不要插值 `up` 向量本身** —— 那会让画面在两侧歪掉。只插值 `dir`（球面插值 slerp），`up` 每帧重算。
- **不要用 `up` 的 x/z 分量做「正北朝上」的判据** —— 那是世界坐标，不是屏幕坐标。
  正确判据是 **`up · 当地东方向 == 0`**，其中 `east = normalize(cross(north, dir))`。
- **不要让相机纬度超过 ±85°** —— 极地附近 `up` 与 `dir` 共线会退化，必须夹紧。

实测：合肥→东京逐帧采样 371 帧，`max |up · east| = 2.22e-16`（浮点极限，即恒等于 0）；
`up` 与北极夹角恰等于相机所在纬度；北极/南极屏幕 y 差全程在 444~547 px 之间、一次没翻号。

> ⚠️ **"正北朝上"的断言抓不到 `v` 方向画反**。如果纹理上下颠倒（南极在上），
> 相机判据**依然全绿**。所以贴图接入后必须额外验一条：
> 把北京(lat 39.9, lon 116.4) 投到纹理上，采样 `countries.png` 应落在陆地编号而非 0（海洋）。

### 渲染演进（两代）

| | 第一代（Canvas 2D） | 第二代（WebGL，当前） |
|---|---|---|
| 地表 | 用海岸线数据画的**矢量卡通地球**——形状对，但没有地表质感，看着像地图 | **NASA Blue Marble 真实卫星影像** |
| 光影 | 明暗烘死在矢量填充里，地球转动时山脉明暗不变 | **法线贴图 + 实时漫反射**，光影随转动变化 |
| 海洋 | 平涂 | 降饱和的真实海深 + 轻微高光 |
| 国家 | 只有国界线 | **淡色块蒙版 + 烘进贴图的清晰国界** |
| 弱设备 | 通吃 | WebGL 不可用时**自动回退到第一代**（第一代实现必须保留，别删） |

第一代不只是历史——它是**降级路径**，WebGL 不可用或贴图加载失败时必须能顶上。

### 贴图管线（`tools/gen-globe-textures.py` → `assets/globe/`）

| 文件 | 尺寸 | 体积 | 说明 |
|---|---|---|---|
| `albedo.jpg` | 3072×1536 | 733 KB | 真实卫星影像，国界已烘进贴图（深色细线） |
| `normal.jpg` | 2048×1024 | 103 KB | 从影像起伏导出的法线贴图，**海洋已压平**（否则海面会出现假山） |
| `countries.png` | 2048×1024 | 35 KB | 8bit 灰度索引图，值 = 国家编号，0 = 海洋 |
| `palette.png` | 256×1 | 1 KB | 低饱和调色板，**必须 NEAREST 采样**（插值会出脏色） |

来源都是**公有领域**：NASA Blue Marble（影像）+ Natural Earth 110m（国界）。
配套 `tools/preview-globe-textures.py` 把它们拼成一张 PNG 供肉眼核对。

纹理约定（**容易画反，务必核对**）：等距圆柱，`u = (lon+180)/360`（西→东），
`v = (90−lat)/180`（北→南），即**第一行是北极**。

#### 踩过的坑

| 坑 | 现象 | 结论 |
|---|---|---|
| 用 `paste(layer, mask=layer)` 叠加各国图层 | 后画国家的 0 值像素不覆盖先画的 → 版图互相串色，`countries.png` 呈一团碎斑 | 必须**直接以编号为填充值绘制**到同一张图上 |
| 国家编号按面积顺序递增 | 序号越大越亮，看起来像噪点，与地理无关 | 编号按**国名排序**取稳定值；绘制顺序才用面积（大到小，小国覆盖大国，避免飞地被吞） |
| Natural Earth 110m 多边形自交 | GEOS 抛 `TopologyException: side location conflict` | 逐个 `shapely.validation.make_valid` 修复，失败退回 `buffer(0)` |
| 加 `crossOrigin` 后 canvas 读像素 | `cdn.pixabay.com` 不返回 CORS 头 → 直接 ERR_FAILED（见第 3 节） | 涉及读像素的处理一律**离线做**，浏览器只读结果 |

---

## 4. 音频方案：为什么是「离线预生成 + 播放时拼接」

央视播报句式高度模板化：`<城市> <天气> <最低温> 到 <最高温> 度`，所有可变部分都是有限集合，
所以离线把每个片段单独合成，播放时按顺序拼起来：

| 类别 | 数量 | 示例 |
|---|---|---|
| 城市名 | 81 | `zh/city/jinan.mp3`（济南） |
| 天气词 | 14 | `zh/weather/duoyun.mp3`（多云） |
| 温度（自带「度」） | 43 | `zh/temp/t15.mp3`（十五度） |
| 纯数字 | 43 | `zh/num/n5.mp3`（五） |
| 连接词 | 2 | `zh/word/dao.mp3`（到） |

**合计 183 个片段 / 866 KB**，语音 `zh-CN-XiaoxiaoNeural`（女声·新闻腔），语速 `-8%`。

好处：完全离线可用、零延迟、音色全程一致、不依赖任何在线 TTS 服务。

### 加载体验

进页面立刻盖**毛玻璃加载页**（`js/ui/loading.js`），并行做两件事：
渲染第一张卡片（透过磨砂玻璃能看到壁纸）+ 用 `AudioPreloader` **整包预下载 183 个片段**。
都好之后才淡出并开播 —— 这样开播后换城、念句子都不用再等网络。

- **不设等待上限**（老板要求「该等多久等多久」）。只对**单个片段**重试（最多 3 次、退避），
  全程失败才继续开播并打 console 告警（那属于错误而非「慢」）
- 加载页是**极简**的：只有一根 3px 细进度条 + 一个「强制进入」按钮，没有任何文字标题
- 「强制进入」（或点屏幕任意位置）跳过剩余下载立即开播，没下完的片段播放时按需加载
- 离线时也能开门见山：Service Worker 把音频放 `wr-audio-*` 缓存（cache-first）

### 背景音乐

- 优先用 `assets/audio/music/music.mp3`（老板自备的《渔舟唱晚》演奏版）
- 找不到才回退到 `yuzhouchangwan.mp3`（`tools/gen-music.py` 程序合成的古筝版，90 秒，
  曲调公有领域、可自由分发）
- ⚠️ 自备的**录音版本**通常有版权，公开分发前要确认

---

## 5. 验收：哪些能自动测，哪些**必须真人**

### 自动测试（可随时跑，全部离线）

```bash
node tools/test-core.mjs        # 核心逻辑 + 文案组合的音频配套（33 项）
node tools/test-contrast.mjs    # 81 城 × 3 视口文字可读性穷举（15 项，需先跑亮度网格）
node tools/lint-site.mjs        # 模块依赖 / DOM 契约 / CSS / 预缓存清单一致性
python tools/check-images.py --all -j 10   # 218 条壁纸 URL 逐条实测可下载
python tools/gen-audio.py --verify         # 语音片段是否齐全
python tools/inspect-audio.py              # 音频体检：时长/峰值/静音比/主频

# 真实浏览器端到端（本机装了 Chrome 即可，不需要 playwright；用 CDP 直连）
python tools/serve.py -p 8099 &
node tools/e2e.mjs index.html --keep-shots   # 渲染/字号/零蒙版/加载页/预下载/暂停/自动推进/双视口
node tools/e2e.mjs large.html                # 大屏版
node tools/e2e-offline.mjs                   # 断网后仍能打开并继续播报
```

### 🎧 音频效果**不纳入自动验收**，由老板真人试听

工具能验的只是「文件存在、有声音、时长合理、主频正确」（`inspect-audio.py`），
**验不了**这些只能靠耳朵的事：

- 拼接出来的句子是否自然连贯（停顿是不是太长/太短、有没有一顿一顿）
- 女声腔调是否够「端正」，像不像央视播报
- 温度读法对不对（「五到十五度」而不是「五度到十五度」）
- 背景音乐音量与语速的主观感受

**这是明确要求**：不要用自动化手段去「证明」音效过关，也不要把音频主观判断写成断言。
相关参数集中在 `js/core/constants.js` 的 `AUDIO`，老板反馈后照着改即可。

### 已知的环境陷阱

- **本地预览必须用 `python tools/serve.py`**。自己写 `python -m http.server` 时如果是单线程
  `TCPServer`（不是 3.7+ 的 `ThreadingHTTPServer`），ES Module 的并行请求会把它堵死，
  浏览器报 `net::ERR_CONNECTION_REFUSED`，表现为**页面骨架在但脚本从不执行**——
  极易误判成代码 bug。`serve.py` 用的是 `ThreadingTCPServer` + HTTP/1.1
- 本机是 **Windows PowerShell 5.1**，不支持 `??`（空合并运算符），写脚本时注意

---

## 6. ⚠️ Windows 中文编码：本项目已经被它坑掉两次

**事故经过**：用 PowerShell 的 `Get-Content -Raw` 读中文文件、正则替换后用 `Set-Content` 写回，
文件里的中文全部变成乱码（`核心逻辑自测` → `鏍稿績閫昏緫鑷祴`），
`tools/test-core.mjs` 这样被毁掉一次，并且**同一个错误犯了两次**。

**根因**：Windows PowerShell 5.1 的 `Get-Content` / `Set-Content` 在**没有显式 `-Encoding`**
时，默认按系统 ANSI 代码页（中文环境是 GBK/936）编解码，而项目文件是 **UTF-8**。
于是「读进来就已经乱了」，写回去自然全毁。加 `-Encoding UTF8` 仍会写入 **BOM**（额外副作用）。

### 规则（请严格遵守）

1. **改文件一律用 `read` / `edit` / `write` 工具**，不要用 PowerShell 做文本替换。
   这些工具内部按 UTF-8 处理，不会踩这个坑。
2. 只有在必须用脚本时，才按下面两种安全方式之一：

   ```powershell
   # 安全写法 A（推荐）：.NET 显式 UTF-8，无 BOM
   $p = 'F:\Github\WeatherRoulette\tools\foo.mjs'
   $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($p))
   $text = $text -replace 'old', 'new'
   [System.IO.File]::WriteAllBytes($p, (New-Object System.Text.UTF8Encoding($false)).GetBytes($text))

   # 安全写法 B：改用 Python 处理文本（本项目已有 Python 3.12）
   python -c "import pathlib; p=pathlib.Path(r'...'); s=p.read_text(encoding='utf-8'); ..."
   ```

3. **只用 `git checkout -- <file>` 从提交里恢复乱码文件**（git 内部存的是原始字节，可靠）；
   恢复后**不要**再用 PowerShell 读它验证，改用 `read` 工具。
4. 创建文件（`New-Item` / `Set-Content`）时若用 PowerShell，注意它会带 BOM；
   提交前可这样检查并去掉：

   ```powershell
   $b = [System.IO.File]::ReadAllBytes($p)
   if ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
     [System.IO.File]::WriteAllBytes($p, $b[3..($b.Length-1)])
   }
   ```

5. 交付前抽检是否被污染。这里有**两个已经踩过的坑**，务必注意：

   - **不要用「码点范围」当判据**。试过 `[\u95ff-\u9fff]{3,}`，结果把
     「音频预」「雷阵雨」「静默降」「页面骨」这些**正常汉字**全判成乱码（误报 11 个文件）。
     GBK 误读 UTF-8 的产物大量落在与正常汉字相同的区段，范围判别根本不可用。
   - **不要在被检文件里写检测正则**（自指）。正则的字符类会匹配到自己——
     本文档一度因此报了 6 处「乱码」，其实全是检测命令本身。

   正确做法：**用精确乱码字符集，且脚本放在被检文件之外**：

   ```powershell
   # 存成 check-encoding.ps1 再执行（不要写进被检文件）：
   #   pwsh -File check-encoding.ps1 -Path F:\Github\WeatherRoulette
   param([Parameter(Mandatory)][string]$Path)
   # GBK 误读 UTF-8 后最常出现的字符（「核心逻辑自测」→「鏍稿績閫昏緫鑷祴」这类产物）
   $mojibake = '锟閿鐗鍓閲鈥鎾姤澶╂皵鐨勪簡鏄笉鍦ㄦ湁缂撳瓨鍔犺浇棰勮'
   $bad = 0
   Get-ChildItem $Path -Recurse -File -Include *.md,*.js,*.mjs,*.json,*.html,*.css,*.py,*.ps1,*.yml |
     Where-Object { $_.FullName -notmatch '\\\.git\\' } | ForEach-Object {
       $t = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($_.FullName))
       $hits = 0
       foreach ($c in $mojibake.ToCharArray()) { if ($t.Contains($c)) { $hits++ } }
       $fffd = ([regex]::Matches($t, [char]0xFFFD)).Count
       if ($hits -gt 0 -or $fffd -gt 0) { Write-Host "? $($_.Name) 乱码字符 $hits  替换字符 $fffd"; $bad++ }
     }
   Write-Host "可疑文件 $bad 个"
   ```

   实测这套判据在当前仓库扫描 46 个文本文件结果为 **0**，且不会误报正常中文。

   最省事的办法仍然是：直接用 `read` 工具打开文件看中文是否正常。
   经验：**只要改动是通过 `read`/`edit`/`write` 工具做的，就不会有编码问题**。

6. `.gitattributes` 里已设 `* text=auto eol=lf` 并对二进制资源声明 `binary`，
   避免跨平台换行与二进制被改写。

---

## 7. 部署（GitHub Pages）

- 地址规则：**项目站点 = `https://<owner>.github.io/<仓库名>`**，仓库名大小写敏感。
  所以 `WeatherRoulette` 对应 `/WeatherRoulette`；想要 `/weather` 必须把仓库改名。
- 代码全部使用**相对路径**（`js/main.js`、`assets/...`、`fetch('data/cities.json')`、
  `register('sw.js', { scope: './' })`），因此放在任意子路径下都能跑。
  **不要引入以 `/` 开头的绝对路径**（`tools/lint-site.mjs` 会检查）
- `Settings → Pages → Build and deployment → Source` 必须选 **`GitHub Actions`**
  （不要选 `Deploy from a branch`，否则下面的工作流不会被使用）
- 工作流 `.github/workflows/deploy-pages.yml`，版本按官方文档：
  `checkout@v4` / `configure-pages@v5` / `upload-pages-artifact@v4` / `deploy-pages@v4`。
  **`upload-pages-artifact@v3` 已被弃用，会直接导致构建失败**（踩过）
- 推送受阻时（本机实测 `git-receive-pack` 端点会被网络重置，而 `upload-pack` 正常）：
  可用 GitHub Desktop、SSH（`ssh.github.com` 的 22/443 都通）或配置代理

---

## 8. 改动清单（改什么、连带改什么）

| 想改的东西 | 要动的地方 |
|---|---|
| 播报语速 / 停顿 / 音量 | `js/core/constants.js` 的 `AUDIO`；改语速后要 `python tools/gen-audio.py --force` 并重跑 `trim-audio.py` |
| 播报文案格式 | `js/core/format.js`（唯一真相来源），同步检查 `tools/test-core.mjs` 的断言 |
| 增加城市 | `data/cities.json` 加一项（`id` 只能小写字母数字）→ `gen-audio.py` 生成城市名片段 → `trim-audio.py` → 补 `assets/images/manifest.json` 的壁纸 → `precompute-luminance.py` |
| 换壁纸 | 改 `assets/images/manifest.json` → 跑 `check-images.py --all` 验证 → **必须重跑 `precompute-luminance.py`**（否则新图没有亮度判据） |
| 换背景音乐 | 替换 `assets/audio/music/music.mp3` 即可（优先级最高）；想回退合成版就删掉它 |
| 界面样式 | `style.css`（主页面）、`large.css`（大屏版）。**不要**把控制条加回主页面 |
| 地球贴图 | `python tools/gen-globe-textures.py`（可用 `--albedo-width` 调体积）→ `tools/preview-globe-textures.py` 与 `inspect-globe-borders.py` 肉眼核对 |
| 地球过场时长/开关 | `js/core/constants.js` 的 `GLOBE`（`enabled` / `duration` / `holdMs` / `fadeMs`） |
| 加载页 | `js/ui/loading.js`（自包含样式，不依赖 style.css）；保持「细进度条 + 强制进入」的极简形态 |
| 任何资源改动后 | **把 `sw.js` 的 `CACHE_VERSION` 加一** |

---

## 9. 设计取舍（有意为之，不是遗漏）

- **播报当天**：日期标签与温度取自同一天（`buildCards` 默认 `randomDay: false`）。
  早期每城随机挑一天，会出现「标签写明天、主温度却是今天的最高温」的自相矛盾，对孩子是理解障碍。
- **温度片段覆盖 0~42°C**，超范围夹紧到端点（避免出现没有配套音频的数字）。
- **天气文案按央视口径归并**：`0/1` 都读「晴」、`51/53/61` 都读「小雨」等，见 `data/wmo-map.json`。
- **一拍浏览 20 城**（国内 12 + 国际 8），一轮播完自动重新随机，无限循环。
- **大字与中英对照优先于信息量**：城市名 1440 端 128px、375 端 54px，温度 168px；
  宁可少显示信息，也不能让 4~6 岁的孩子看不清。
- **大屏版保留了自己的控制条**（投屏/电视场景需要），主页面保持极简，两者刻意不同。
- **暂停只走专用按钮**：点画面空白或文字都不暂停。早期版本在 `#app` 上挂了 click 监听，
  孩子随手一点就停了——这是被明确否掉的设计，不要再加回去。
- **地球光照用相机系固定光**，不是世界系。世界系固定光在接近对跖的转场（如纽约→东京）里
  会让目标城市整片背光，孩子看到半颗黑球，违背"地理认知"这个目的。
  代价是看不到稳定的晨昏线——如果以后要做真实的昼夜教学，需要改成世界系光并给暗面加下限光。
- **中国固定红色且 `chinaBoost` 单独加权**（有效强度约 0.45，其他国家 0.17）。
  这是唯一一个国家被特殊对待，因为"让孩子一眼找到自己的国家"是明确的产品需求；
  编号从 `countries.json` 的 `chinaIndex` 读取，不硬编码。
