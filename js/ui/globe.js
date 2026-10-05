// 城市之间的 3D 地球过场动画：从上一座城市「转」到下一座城市。
//
// ─────────────────────────── 为什么屏幕上方永远是正北 ───────────────────────────
// 世界坐标是单位球（y 轴即地轴）：
//     p(lat, lon) = ( cos(lat)·sin(lon),  sin(lat),  cos(lat)·cos(lon) )
// 相机放在球外的 dir 方向上、用正交投影看球心，屏幕坐标 = (v·right, v·up)。
//
// 关键在于 up **不是插值出来的**，而是每帧由「北」重新投影得到：
//     up = normalize( north − (north·dir)·dir )        north = (0,1,0)
// 几何上 up 就是相机所在地的**正北切向量**，可以证明 up·east(lon(dir)) ≡ 0，
// 也就是 up 不含任何东/西分量 —— 屏幕上方永远指向真北。
// dir 在起止城市之间用 slerp 插值，up/right 每个采样点重算，
// 所以动画中间任何一帧、以及被 cancel() 打断的那一帧，画面都不会歪。
//
// 反过来，如果去插值 up 向量本身（或者让相机俯仰角跟着城市纬度走），
// 两侧就会倾斜、北不再朝上 —— 这正是本模块要避免的朴素做法。
//
// ─────────────────────────── 两代渲染，一套相机 ───────────────────────────
// 第二代（WebGL，优先）：NASA Blue Marble 真实卫星影像 + 法线贴图实时漫反射
//                        + 国家淡色蒙版 + 大气边缘光 + 海洋高光。
// 第一代（Canvas 2D，兜底）：用海岸线数据画的矢量卡通地球。
//   WebGL 不可用、贴图加载失败、上下文丢失时自动回退到第一代，**绝不留白、绝不报错到界面**。
// 两条路径共用下面同一套相机基与 slerp，所以「正北朝上」在哪种渲染下都成立。
//
// ─────────────────────────── 相机抛物线弹道 ───────────────────────────
// 老板要求「相机运动的轨迹类似抛物线」：从起点城市"抛"向终点城市，中途升到最高点，两端贴地。
// 球的大小是**相机距离的函数**（半径 ∝ 1/相机距离），而相机距离由弹道曲线决定：
//   出发 → 上升 → 最高点（球最小，能看见整颗地球与前后两城）→ 下落 → 贴地（近景）。
// 抛高与两城距离成正比（hMax ∝ (夹角/π)^0.75），所以几百公里只是轻轻一跳、
// 几千公里才是明显的大抛；`up` 仍由当前 dir 每帧重算，正北朝上的判据一个数字都不变。
//
// 依赖：js/core/constants.js 的 GLOBE / GLOBE_TEXTURES_DIR（都做了完整兜底）、
//       js/ui/globe-data.js 的 LAND / BORDERS（降级路径用，动态 import，不拖慢首屏）。

import * as constants from '../core/constants.js';

// ───────────────────────────────────────────────────────────── 兜底配置
/** GLOBE 还没写进 constants.js 时使用的默认值（数值与任务契约一致）。 */
const GLOBE_FALLBACK = {
  enabled: true,
  duration: 5000,
  holdMs: 1200,
  fadeMs: 400,
  minLat: -85,
  maxLat: 85,
  // 相机抛物线弹道：对跖时的最高点（单位=地球半径）/ 高度幂次 / 贴地基础高度 / 贴地球占比
  arcHeightFull: 0.3,
  arcHeightPower: 0.75,
  cameraBaseAlt: 0.04,
  nearMinSideRatio: 0.86,
};

/** 贴图目录兜底（constants.js 里是 GLOBE_TEXTURES_DIR） */
const TEXTURES_DIR_FALLBACK = 'assets/globe';

function readGlobeConfig() {
  const raw = constants && typeof constants === 'object' ? constants.GLOBE : null;
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (key, lo, hi) => {
    const v = Number(src[key]);
    const d = GLOBE_FALLBACK[key];
    if (!Number.isFinite(v)) return d;
    return clamp(v, lo, hi);
  };
  const minLat = clamp(num('minLat', -89.5, 0), -89.5, 0);
  const maxLat = clamp(num('maxLat', 0, 89.5), 0, 89.5);
  return {
    enabled: src.enabled === undefined ? GLOBE_FALLBACK.enabled : src.enabled !== false,
    duration: Math.round(num('duration', 200, 60000)),
    holdMs: Math.round(num('holdMs', 0, 60000)),
    fadeMs: Math.round(num('fadeMs', 0, 5000)),
    minLat: Math.min(minLat, maxLat - 1),
    maxLat,
    // 抛物线弹道：四条参数都从 constants.js 的 GLOBE 读，绝不硬编码
    arcHeightFull: num('arcHeightFull', 0, 3),
    arcHeightPower: num('arcHeightPower', 0.05, 4),
    cameraBaseAlt: num('cameraBaseAlt', 0, 3),
    nearMinSideRatio: num('nearMinSideRatio', 0.05, 3),
  };
}

function readTexturesDir() {
  const v = constants && typeof constants === 'object' ? constants.GLOBE_TEXTURES_DIR : null;
  if (typeof v === 'string' && v) return v.replace(/\/+$/, '') + '/';
  return TEXTURES_DIR_FALLBACK + '/';
}

// ───────────────────────────────────────────────────────────── 小工具
const DEG = Math.PI / 180;
const FONT_STACK =
  "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',sans-serif";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return undefined;
    called = true;
    return fn(...args);
  };
}

function wrapLon(lon) {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

/** 度 → 单位球上的世界坐标。 */
function sphereVec(lat, lon, out = [0, 0, 0]) {
  const la = lat * DEG;
  const lo = lon * DEG;
  const cl = Math.cos(la);
  out[0] = cl * Math.sin(lo);
  out[1] = Math.sin(la);
  out[2] = cl * Math.cos(lo);
  return out;
}

/** 等距圆柱贴图坐标（与 assets/globe 的约定一致：第一行是北极）。 */
function geoUv(lat, lon) {
  return [(wrapLon(lon) + 180) / 360, (90 - clamp(lat, -90, 90)) / 180];
}

/**
 * 相机基：up 由「北」投影得到（见文件头）。
 * out = { dir, up, right, forward }，全部是单位向量。
 * 几何结果：up = 当地正北切向量，right = 当地正东，forward = 视线方向（指向球心）。
 * 右手系关系：right × up = dir = −forward（即 (right, up, dir) 构成右手系）。
 */
function computeBasis(dir, out) {
  const dx = dir[0];
  const dy = dir[1];
  const dz = dir[2];

  // up = normalize(north − (north·dir)·dir)，north = (0,1,0) ⇒ north·dir = dy
  let ux = -dy * dx;
  let uy = 1 - dy * dy;
  let uz = -dy * dz;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-9) {
    // 退化：dir 与地轴平行（城市纬度已被 minLat/maxLat 夹紧，正常不会走到这里）
    ux = dz;
    uy = 0;
    uz = -dx;
    ul = Math.hypot(ux, uy, uz);
    if (ul < 1e-9) {
      ux = 1;
      uy = 0;
      uz = 0;
      ul = 1;
    }
  }
  ux /= ul;
  uy /= ul;
  uz /= ul;

  // right = normalize(cross(up, dir))，几何上恰为该经度处的「东」
  let rx = uy * dz - uz * dy;
  let ry = uz * dx - ux * dz;
  let rz = ux * dy - uy * dx;
  const rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-9) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rl;
    ry /= rl;
    rz /= rl;
  }

  out.dir[0] = dx;
  out.dir[1] = dy;
  out.dir[2] = dz;
  out.up[0] = ux;
  out.up[1] = uy;
  out.up[2] = uz;
  out.right[0] = rx;
  out.right[1] = ry;
  out.right[2] = rz;
  out.forward[0] = -dx;
  out.forward[1] = -dy;
  out.forward[2] = -dz;
  return out;
}

/** 两个单位向量之间的球面插值；对跖/重合都有兜底。 */
function slerpDir(a, b, t, out) {
  if (t <= 0) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
  }
  if (t >= 1) {
    out[0] = b[0];
    out[1] = b[1];
    out[2] = b[2];
    return out;
  }
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);

  if (d > 0.9999999) {
    out[0] = b[0];
    out[1] = b[1];
    out[2] = b[2];
    return out;
  }
  if (d < -0.9999999) {
    // 近似对跖：绕一条与 a 垂直的轴匀速转过去
    const kx = Math.abs(a[0]) < 0.9 ? 1 : 0;
    const ky = kx === 0 && Math.abs(a[1]) < 0.9 ? 1 : 0;
    const kz = kx === 0 && ky === 0 ? 1 : 0;
    let ax = a[1] * kz - a[2] * ky;
    let ay = a[2] * kx - a[0] * kz;
    let az = a[0] * ky - a[1] * kx;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al;
    ay /= al;
    az /= al;
    // b2 = axis × a，与 a 垂直
    const bx = ay * a[2] - az * a[1];
    const by = az * a[0] - ax * a[2];
    const bz = ax * a[1] - ay * a[0];
    const th = Math.PI * t;
    const c = Math.cos(th);
    const s = Math.sin(th);
    out[0] = a[0] * c + bx * s;
    out[1] = a[1] * c + by * s;
    out[2] = a[2] * c + bz * s;
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l;
    out[1] /= l;
    out[2] /= l;
    return out;
  }

  const om = Math.acos(d);
  const so = Math.sin(om);
  const wa = Math.sin((1 - t) * om) / so;
  const wb = Math.sin(t * om) / so;
  out[0] = a[0] * wa + b[0] * wb;
  out[1] = a[1] * wa + b[1] * wb;
  out[2] = a[2] * wa + b[2] * wb;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l;
  out[1] /= l;
  out[2] /= l;
  return out;
}

/** 起止两端各留 10% 静止感的 ease-in-out。 */
function easePlateau(p) {
  const H = 0.1;
  const s = clamp((p - H) / (1 - 2 * H), 0, 1);
  return s * s * (3 - 2 * s);
}

// ─────────────────────────── 相机抛物线弹道（逼近 / 拉远）───────────────────────────
// 老板要求「相机运动的轨迹类似抛物线」：从起点城市"抛"向终点城市，中途升到最高点，
// 两端贴地；抛得越高球越小（半径 ∝ 1/相机距离），而抛高与两城距离成正比 ——
// 几百公里只是轻轻一跳，几千公里才是明显的大抛。
//
// 这跟"缩放到某个距离再缩回来"不是一回事：那是把缩放当成纯数值的来回，
// 没有"相机在空间里走了一条弧线"的含义。这里相机位置由弹道曲线决定，
// 球的大小只是相机距离的函数 —— 两者是同一件事的两种表现。
//
// 世界坐标（地球半径 = 1）：
//     A = p(from), B = p(to)                两城单位向量
//     span  = 夹角(A,B) / π                 0 = 同城，1 = 严格对跖
//     hMax  = arcHeightFull · span^arcHeightPower
//     u(t)  = normalize(slerp(A,B,t))       视线方向（指两城之间的球面点，即现有的 dir）
//     h(t)  = hMax · 4t(1-t)                标准抛物线：峰值 t=0.5，两端 h=0
//     dist  = 1 + cameraBaseAlt + h(t)      相机到球心距离
//     ratio = nearMinSideRatio · (1+cameraBaseAlt) / dist     ← 半径 ∝ 1/相机距离
//     R     = ratio · 0.5 · min(w,h)        屏幕半径（像素）
//
// ★ 两个「成正比」分别落在两处：hMax 随距离增长（抛得多高），最高点的球占比
//   由 1/(1+hMax) 自然得出（对跖时 0.86·1.04/1.34 = 0.6675，恰好是短边的 2/3）。
//   别把最高点占比硬钉在 2/3，也别把 ratio 绑在"相机距离的百分比"上 —— 那两条错法
//   见 constants.js 的 GLOBE 注释（前者让 9km 的转场也要抛出 0.6 个地球半径，
//   后者让短途完全没有缩放）。
//
// t 直接取 easePlateau 缓动后的进度（两端各留 10% 静止的时间轴不变），
// 所以抛物线在镜头方向静止的那两段里就已经在上升 / 下落，观感是"先退后 → 再飞 → 再推近"。
//
// ──────────────── 与「正北朝上」完全解耦 ────────────────
// 变的只是 R 与相机距离（正交投影下距离只影响大小），
// `up = normalize(north − (north·dir)·dir)` 仍由当前 dir 每帧重算，一个数字都不变。
const R_EARTH_KM = 6371.0088;

/**
 * 两座城市之间的大圆距离（km）。
 * 公式与 tools/city-distances.py 完全一致（否则定标对不上）；
 * lon 差值用 sin(dl/2)² 表达，天然处理跨 ±180°，不要改成线性差。
 */
function haversineKm(a, b) {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dp = p2 - p1;
  const dl = (b.lon - a.lon) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 本次转场的弹道参数（纯函数，方便自测直接核对）。
 *   span = 两城夹角 / π；hMax = arcHeightFull · span^arcHeightPower
 * 注意用的是城市**真实**经纬度（不做极地夹紧）——夹紧只用于相机方向。
 * @returns {{span:number, spanDeg:number, hMax:number}}
 */
function arcFor(a, b, cfg) {
  const va = sphereVec(a.lat, a.lon, [0, 0, 0]);
  const vb = sphereVec(b.lat, b.lon, [0, 0, 0]);
  const sep = Math.acos(clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1));
  const span = clamp(sep / Math.PI, 0, 1);
  return {
    span,
    spanDeg: sep / DEG,
    hMax: cfg.arcHeightFull * span ** cfg.arcHeightPower,
  };
}

/**
 * t 时刻的弹道状态（纯函数）：高度 / 相机距离 / 球占比。
 * 两端 h=0 → ratio = nearMinSideRatio；t=0.5 时 h=hMax → 本趟最小（最高点）。
 * @returns {{t:number, h:number, dist:number, ratio:number}}
 */
function arcAt(t, hMax, cfg) {
  const p = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  const h = hMax * 4 * p * (1 - p);
  const dist = 1 + cfg.cameraBaseAlt + h;
  const ratio = (cfg.nearMinSideRatio * (1 + cfg.cameraBaseAlt)) / dist;
  return { t: p, h, dist, ratio };
}

// ───────────────────────────────────────────────────────────── 2D 几何缓存
// （第一代渲染路径与前景图层的公共部件：把经纬坐标预转成世界坐标，逐帧只做投影）
const _scratch = {
  s: new Float64Array(2048), // 每个顶点的半球判据
  out: new Float64Array(3 * 4096), // 裁剪后的 3D 顶点
};

function ensureScratch(n) {
  if (_scratch.s.length < n) _scratch.s = new Float64Array(n * 2);
  if (_scratch.out.length < 3 * (2 * n + 8)) {
    _scratch.out = new Float64Array(3 * (2 * n + 8) * 2);
  }
}

/** [lon,lat] 数组 → 扁平 Float64Array，只在开始一次（省掉每帧的 sin/cos）。 */
function ringsToVec(rings) {
  const out = [];
  for (const ring of rings) {
    const n = ring.length;
    const v = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const lon = ring[i][0];
      const lat = ring[i][1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const la = lat * DEG;
      const lo = lon * DEG;
      const cl = Math.cos(la);
      v[i * 3] = cl * Math.sin(lo);
      v[i * 3 + 1] = Math.sin(la);
      v[i * 3 + 2] = cl * Math.cos(lo);
    }
    if (n >= 3) out.push(v);
  }
  return out;
}

/** 经纬网（每 30°），只在首次使用时构建。 */
let _gratCache = null;
/** 经线在极点会汇聚成「风车」，两条渲染路径都只画到 ±76°。 */
const GRAT_MERIDIAN_MAX_LAT = 76;
function graticuleVec() {
  if (_gratCache) return _gratCache;
  const meridians = [];
  const parallels = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const pts = [];
    for (let lat = -GRAT_MERIDIAN_MAX_LAT; lat <= GRAT_MERIDIAN_MAX_LAT; lat += 5) pts.push([lon, lat]);
    meridians.push(ringsToVec([pts])[0]);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 5) pts.push([lon, lat]);
    parallels.push(ringsToVec([pts])[0]);
  }
  _gratCache = { meridians, parallels };
  return _gratCache;
}

/** 整条折线当前是否完全落在可见半球之外（可以整块跳过）。 */
function ringHidden(vec, dir) {
  const n = vec.length / 3;
  const dx = dir[0];
  const dy = dir[1];
  const dz = dir[2];
  for (let i = 0; i < n; i++) {
    if (vec[i * 3] * dx + vec[i * 3 + 1] * dy + vec[i * 3 + 2] * dz >= 0) return false;
  }
  return true;
}

/**
 * 用 Sutherland–Hodgman 把闭合多边形裁剪到可见半球（dot(v,dir) ≥ 0），
 * 返回裁剪后的顶点数，结果写进 _scratch.out。
 */
function clipRing(vec, dir) {
  const n = vec.length / 3;
  if (n < 3) return 0;
  ensureScratch(n);
  const sd = _scratch.s;
  const dx = dir[0];
  const dy = dir[1];
  const dz = dir[2];
  for (let i = 0; i < n; i++) {
    sd[i] = vec[i * 3] * dx + vec[i * 3 + 1] * dy + vec[i * 3 + 2] * dz;
  }
  const out = _scratch.out;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const si = sd[i];
    const sj = sd[j];
    const bi = si >= 0;
    const bj = sj >= 0;
    if (bi) {
      out[m * 3] = vec[i * 3];
      out[m * 3 + 1] = vec[i * 3 + 1];
      out[m * 3 + 2] = vec[i * 3 + 2];
      m++;
    }
    if (bi !== bj) {
      const f = si / (si - sj);
      out[m * 3] = vec[i * 3] + (vec[j * 3] - vec[i * 3]) * f;
      out[m * 3 + 1] = vec[i * 3 + 1] + (vec[j * 3 + 1] - vec[i * 3 + 1]) * f;
      out[m * 3 + 2] = vec[i * 3 + 2] + (vec[j * 3 + 2] - vec[i * 3 + 2]) * f;
      m++;
    }
  }
  return m;
}

/** 把裁剪后的顶点投影成 canvas 子路径（moveTo 起点 + lineTo 其余）。 */
function pathFromScratch(ctx, count, basis, view) {
  if (count < 3) return false;
  const r = basis.right;
  const u = basis.up;
  const R = view.R;
  const cx = view.cx;
  const cy = view.cy;
  const out = _scratch.out;
  for (let i = 0; i < count; i++) {
    const x = out[i * 3];
    const y = out[i * 3 + 1];
    const z = out[i * 3 + 2];
    const px = cx + (x * r[0] + y * r[1] + z * r[2]) * R;
    const py = cy - (x * u[0] + y * u[1] + z * u[2]) * R;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  return true;
}

/** 折线（国界 / 大圆弧 / 经纬网）：只画可见半球内的连续段。逐帧调用，刻意零分配。 */
function strokeVecLine(ctx, vec, basis, view) {
  const n = vec.length / 3;
  if (n < 2) return;
  const dx = basis.dir[0];
  const dy = basis.dir[1];
  const dz = basis.dir[2];
  const rx = basis.right[0];
  const ry = basis.right[1];
  const rz = basis.right[2];
  const ux = basis.up[0];
  const uy = basis.up[1];
  const uz = basis.up[2];
  const R = view.R;
  const cx = view.cx;
  const cy = view.cy;

  let run = false;
  let px = 0;
  let py = 0;
  let pz = 0;
  let ps = 0;

  for (let i = 0; i < n; i++) {
    const x = vec[i * 3];
    const y = vec[i * 3 + 1];
    const z = vec[i * 3 + 2];
    const s = x * dx + y * dy + z * dz;

    if (s >= 0) {
      const sx = cx + (x * rx + y * ry + z * rz) * R;
      const sy = cy - (x * ux + y * uy + z * uz) * R;
      if (run) {
        ctx.lineTo(sx, sy);
      } else {
        if (i > 0) {
          const f = ps / (ps - s);
          const ix = px + (x - px) * f;
          const iy = py + (y - py) * f;
          const iz = pz + (z - pz) * f;
          ctx.moveTo(cx + (ix * rx + iy * ry + iz * rz) * R, cy - (ix * ux + iy * uy + iz * uz) * R);
        } else {
          ctx.moveTo(sx, sy);
        }
        ctx.lineTo(sx, sy);
        run = true;
      }
    } else if (run) {
      const f = ps / (ps - s);
      const ix = px + (x - px) * f;
      const iy = py + (y - py) * f;
      const iz = pz + (z - pz) * f;
      ctx.lineTo(cx + (ix * rx + iy * ry + iz * rz) * R, cy - (ix * ux + iy * uy + iz * uz) * R);
      run = false;
    }

    px = x;
    py = y;
    pz = z;
    ps = s;
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y + rr, x + rr, y, rr);
  ctx.closePath();
}

function normalizeCity(c) {
  if (!c || typeof c !== 'object') return null;
  const lat = Number(c.lat);
  const lon = Number(c.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: c.id == null ? '' : String(c.id),
    zh: c.zh == null ? '' : String(c.zh),
    en: c.en == null ? '' : String(c.en),
    lat: clamp(lat, -90, 90),
    lon: wrapLon(lon),
  };
}

// 配色：前景图层（弧线 / 标记 / 标签），第一代地球也用它
const COLORS = {
  land: '#4aa96c',
  landEdge: '#2f7d4d',
  border: 'rgba(255,255,255,0.30)',
  graticule: 'rgba(186,224,255,0.10)',
  silhouette: 'rgba(190,232,255,0.80)',
  arc: 'rgba(255,226,130,0.80)',
  arcGlow: 'rgba(255,226,130,0.18)',
  origin: '#ffcf5c',
  dest: '#ff5f8f',
};

const ARC_SAMPLES = 96;
const STAR_COUNT = 220;

const OVERLAY_CLASS = 'wr-globe-overlay';
const STYLE_ID = 'wr-globe-style';

// ═══════════════════════════════════════════════════════════════
// 第二代渲染：WebGL
// ═══════════════════════════════════════════════════════════════

/** 视觉调参集中在这里，改风格只动这一块。 */
const TUNE = {
  // 光照方向按**相机系**给：世界系固定光会让某些城市对转过去后整片背光。
  // 相机系的光一样满足「地球在转、山脉明暗在变」，但整颗球永远是亮的。
  lightCam: [-0.46, 0.52, 0.72], // right / up / dir 三个分量
  diffuse: 0.72,
  ambient: 0.42, // 环境光下限（暗面也留可读性，别做成冷峻军事地图）
  rim: 0.62, // 大气边缘光强度
  rimPower: 2.6,
  spec: 0.42, // 海洋高光
  specPower: 34.0,
  bump: 2.6, // 法线扰动强度（法线贴图本身很平，放大后山体才有立体感）
  oceanBump: 0.06, // 海洋压平（贴图里海洋已经是 (0,0,1)，这里再兜一层）
  country: 0.17, // 国家淡色蒙版强度（「淡淡的」由它决定）
  chinaBoost: 3.6, // 中国单独的蒙版倍率：0.17 × 3.6 ≈ 0.45，肉眼一眼能看出红
  poleBumpFade: 1.0, // 极地法线扰动淡出（1 = 极点完全淡出）
  grid: 0.10, // 经纬网
  gridPx: 1.15, // 经纬网线宽（CSS 像素）
  exposure: 0.98,
  saturation: 0.05, // 往灰度拉多少（贴图本身已降饱和，这里只补一点点）
};

// ── 着色器 ────────────────────────────────────────────────────
// 用 GLSL ES 1.00 写，WebGL1 / WebGL2 都能直接跑（WebGL2 兼容 ES 1.00 着色器）。
const VS_QUAD = `
attribute vec2 aPos;
varying vec2 vPos;
void main(){ vPos = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FS_SKY = `
precision mediump float;
varying vec2 vPos;
uniform vec2 uRes;      // CSS 像素
uniform vec2 uCenter;   // 球心（CSS 像素，y 向下）
uniform float uR;       // 球半径（CSS 像素）

float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// 一层星点：格子哈希出星的位置与亮度
float starLayer(vec2 uv, float density, float size, float seed){
  vec2 g = uv * density;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash21(id + seed);
  vec2 off = vec2(hash21(id + seed + 1.7), hash21(id + seed + 5.3)) - 0.5;
  float d = length(f - off * 0.66);
  float b = smoothstep(size, 0.0, d);
  return b * step(0.80, h) * (0.35 + 0.65 * hash21(id + seed + 9.1));
}

void main(){
  // CSS 像素坐标，y 向下（与 worldToScreen 同一套约定）
  vec2 px = vec2(vPos.x * 0.5 + 0.5, 0.5 - vPos.y * 0.5) * uRes;
  float t = px.y / uRes.y;

  vec3 sky = mix(vec3(0.020, 0.043, 0.118), vec3(0.043, 0.094, 0.204), smoothstep(0.0, 0.55, t));
  sky = mix(sky, vec3(0.016, 0.043, 0.110), smoothstep(0.55, 1.0, t));

  vec2 rel = (px - uCenter) / max(uR, 1.0);
  float rr = length(rel);
  float halo = exp(-max(rr - 0.85, 0.0) * 2.1) * 0.55 + exp(-pow((rr - 1.0) * 3.6, 2.0)) * 0.45;
  vec3 col = sky + vec3(0.10, 0.24, 0.50) * halo;

  vec2 suv = px / uRes.y;                       // 方形格子，星星不会是椭圆
  float st = starLayer(suv, 26.0, 0.055, 11.0) + starLayer(suv, 15.0, 0.090, 37.0) * 1.25;
  col += vec3(0.86, 0.92, 1.0) * min(st, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

const VS_GLOBE = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uR;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uDir;
varying vec3 vN;
varying vec2 vUv;
void main(){
  vec3 p = aPos;
  // 与 worldToScreen() 完全一致：x = cx + v·right·R，y = cy − v·up·R
  vec2 px = uCenter + vec2(dot(p, uRight), -dot(p, uUp)) * uR;
  vec2 ndc = vec2(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0);
  gl_Position = vec4(ndc, -dot(p, uDir), 1.0);   // 正交投影，z 直接当深度用
  vN = p;
  vUv = aUv;
}
`;

const FS_GLOBE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vN;
varying vec2 vUv;

uniform sampler2D uAlbedo;
uniform sampler2D uNormalMap;
uniform sampler2D uCountryMap;
uniform sampler2D uPalette;
uniform float uHasNormal;
uniform float uHasCountry;
uniform vec3 uLight;
uniform vec3 uViewDir;
uniform float uDiffuse;
uniform float uAmbient;
uniform float uRim;
uniform float uRimPower;
uniform float uSpec;
uniform float uSpecPower;
uniform float uBump;
uniform float uOceanBump;
uniform float uCountry;
uniform float uGrid;
uniform float uGridPx;
uniform float uR;          // 球半径（CSS 像素），用来把经纬网线宽固定成屏幕像素
uniform float uExposure;
uniform float uSaturation;
uniform float uPoleBumpFade;   // 极地法线扰动淡出强度
uniform float uGridPoleFade;   // 经线在高纬淡出（0 = 关，用来复现修复前的北极「风车」）
uniform float uChinaId;        // 中国在 countries.png 里的编号（取自 countries.json 的 chinaIndex）
uniform float uChinaBoost;     // 中国的蒙版强度倍率（别的国家仍保持「淡淡」）

const float PI = 3.14159265359;

void main(){
  vec3 nGeo = normalize(vN);
  vec3 albedo = texture2D(uAlbedo, vUv).rgb;
  float sinAbs = abs(nGeo.y);

  // ── 国家编号 + 陆地遮罩（countries.png 是 8bit 索引图，必须 NEAREST 采样）──
  float id8 = 0.0;
  float land = 1.0;
  if (uHasCountry > 0.5) {
    id8 = texture2D(uCountryMap, vUv).r * 255.0;
    land = clamp(id8, 0.0, 1.0);           // 0 = 海洋，≥1 = 陆地
  }
  float ocean = 1.0 - land;

  // ── 法线扰动 ──
  // normal.jpg 由工具的 numpy 实现生成：nx = −∂h/∂col（+x 朝东）、ny = −∂h/∂row
  // （+y 朝**南**，即贴图 v 增大的方向）。两条独立证据都指向这个约定：
  //   1) 全球回归 corr(dLum/dRow, −ny)=+0.59、corr(dLum/dCol, −nx)=+0.44；
  //   2) 沿经线积分 印度洋(8°N)→西藏(32°N) 在 −ny 约定下为正（西藏更高），
  //      反过来恒为负，与真实地形相反。
  // 若以后重新生成贴图改成了「+y 朝北」，把下面 south 那行的负号去掉
  // （或者干脆把 lightCam 的 up 分量取反）即可。
  vec3 n = nGeo;
  if (uHasNormal > 0.5) {
    vec3 nt = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
    float k = mix(uOceanBump, 1.0, land);   // 海洋压平，不出现假山
    // 极地附近等距圆柱的横向拉伸会把法线放大成「风车」条纹，这里把扰动淡出。
    // 只淡出、不整体抹平：低纬山体的立体感一点不动。
    k *= 1.0 - uPoleBumpFade * smoothstep(0.78, 0.985, abs(nGeo.y));
    nt.xy *= uBump * k;
    vec3 east = normalize(vec3(nGeo.z, 0.0, -nGeo.x) + vec3(1e-6, 0.0, 0.0));
    vec3 northT = normalize(cross(nGeo, east));
    vec3 south = -northT;
    n = normalize(east * nt.x + south * nt.y + nGeo * max(nt.z, 0.25));
  }

  // ── 光照 ──
  // 半兰伯特（wrap）而非硬朗伯：明暗交界柔一点，暗面也留得住地形，
  // 给 4~6 岁孩子看的地球不能有半颗黑球。
  vec3 L = normalize(uLight);
  vec3 V = uViewDir;
  float wrap = clamp((dot(n, L) + 0.30) / 1.30, 0.0, 1.0);
  float lam = uAmbient + uDiffuse * wrap;
  // 背光面给一点冷色补光，免得整块死黑
  lam += 0.05 * max(dot(nGeo, -L), 0.0);

  float fres = pow(1.0 - clamp(dot(nGeo, V), 0.0, 1.0), uRimPower);
  vec3 col = albedo * lam;
  // 深海贴图本身接近全黑，托一点蓝底，免得太平洋看着像个洞
  col += ocean * lam * vec3(0.020, 0.052, 0.105);
  col += albedo * fres * vec3(0.20, 0.40, 0.72) * 0.55;   // 大气散射（贴着球面）

  // ── 海洋高光 ──
  vec3 H = normalize(L + V);
  float sp = pow(max(dot(n, H), 0.0), uSpecPower) * ocean * uSpec;
  col += vec3(0.88, 0.94, 1.0) * sp;

  // ── 国家淡色蒙版 ──
  // palette 用 NEAREST 采样（编号之间插值会出脏色）；这里把调色板归一化到
  // 单位亮度再乘上去，所以「淡」的程度只由 uCountry 决定，不会顺带压暗地表。
  // 中国额外给一个倍率：老板要「中国是红的」，但别的国家仍要保持淡淡的色差，
  // 所以不动全局强度、只给中国单独加权（编号取自 countries.json 的 chinaIndex）。
  if (uHasCountry > 0.5) {
    vec3 tint = texture2D(uPalette, vec2((id8 + 0.5) / 256.0, 0.5)).rgb;
    float tl = max(dot(tint, vec3(0.2126, 0.7152, 0.0722)), 0.12);
    tint /= tl;
    float isChina = 1.0 - step(0.5, abs(id8 - uChinaId));
    float amt = uCountry * land * mix(1.0, uChinaBoost, isChina);
    col = mix(col, col * tint, amt);
    // 国界：索引发生跳变的地方描一道深色细线（贴图里也烘了国界，这里只做加强）
    col *= mix(1.0, 0.94, amt);
  }

  // ── 经纬网（解析式，不用导数扩展）──
  // ⚠️ 经线必须在高纬淡出：12 条经线全都汇聚到极点，屏幕上就是一个「风车」，
  //    这正是之前北极那圈放射状条纹的来源（不是贴图被挤，贴图本身是干净的）。
  //    纬线不汇聚，照常画。
  if (uGrid > 0.001) {
    float latDeg = degrees(asin(clamp(nGeo.y, -1.0, 1.0)));
    float lonDeg = degrees(atan(nGeo.x, nGeo.z));
    float w = uGridPx * (180.0 / (PI * max(uR, 1.0)));
    float m1 = mod(latDeg, 30.0);
    float d1 = min(m1, 30.0 - m1);
    float m2 = mod(lonDeg, 30.0);
    float d2 = min(m2, 30.0 - m2) * max(cos(radians(latDeg)), 0.06);
    float gLat = 1.0 - smoothstep(0.0, max(w, 0.05), d1);
    float gLon = 1.0 - smoothstep(0.0, max(w, 0.05), d2);
    gLon *= 1.0 - uGridPoleFade * smoothstep(0.90, 0.972, sinAbs);   // lat 64° → 76° 淡出经线
    col = mix(col, vec3(0.78, 0.88, 1.0), max(gLat, gLon) * uGrid);
  }

  // ── 边缘光 + 一点边缘减光，免得看着像贴纸 ──
  col += vec3(0.30, 0.56, 0.98) * pow(fres, 1.6) * uRim;
  col *= mix(1.0, 0.90, fres * 0.7);

  // ── 轻微降饱和 + 曝光（贴近真实影像的调子，但别过曝）──
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, vec3(luma), uSaturation) * uExposure;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/** 球面网格：索引三角形，索引数 < 65536 所以 Uint16 够用。 */
function buildSphereMesh(lonSeg, latSeg) {
  const cols = lonSeg + 1;
  const rows = latSeg + 1;
  const verts = new Float32Array(cols * rows * 5);
  let p = 0;
  for (let iy = 0; iy < rows; iy++) {
    const v = iy / latSeg;
    const la = (90 - v * 180) * DEG;
    const cl = Math.cos(la);
    const sl = Math.sin(la);
    for (let ix = 0; ix < cols; ix++) {
      const u = ix / lonSeg;
      const lo = (-180 + u * 360) * DEG;
      verts[p++] = cl * Math.sin(lo);
      verts[p++] = sl;
      verts[p++] = cl * Math.cos(lo);
      verts[p++] = u;
      verts[p++] = v;
    }
  }
  // 绕序：开背面剔除后必须只剩朝向相机的那个半球，绕错就会看到「里子」（镜像的地球）。
  // 这里不靠手推，直接拿赤道上一格按着色器同款投影算一次有向面积，反了就整体翻过来。
  const px = (i) => verts[i * 5];
  const py = (i) => verts[i * 5 + 1];
  const qy = latSeg >> 1;
  const qx = lonSeg >> 1;
  const ia = qy * cols + qx;
  const ic = ia + cols + 1;
  const ib = ia + 1;
  const cross =
    (px(ic) - px(ia)) * (py(ib) - py(ia)) - (py(ic) - py(ia)) * (px(ib) - px(ia));
  const ccw = cross >= 0;

  const idx = new Uint16Array(lonSeg * latSeg * 6);
  let k = 0;
  for (let iy = 0; iy < latSeg; iy++) {
    for (let ix = 0; ix < lonSeg; ix++) {
      const a = iy * cols + ix;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      if (ccw) {
        idx[k++] = a; idx[k++] = c; idx[k++] = b;
        idx[k++] = a; idx[k++] = d; idx[k++] = c;
      } else {
        idx[k++] = a; idx[k++] = b; idx[k++] = c;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
      }
    }
  }
  return { verts, idx, tris: idx.length / 3, vertCount: cols * rows };
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败：${log || '未知原因'}`);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`着色器链接失败：${log || '未知原因'}`);
  }
  return prog;
}

/** 收集 program 的 uniform / attribute 位置。 */
function introspect(gl, prog, uniforms, attribs) {
  const u = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
  const a = {};
  for (const name of attribs) a[name] = gl.getAttribLocation(prog, name);
  return { u, a };
}

const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

/**
 * WebGL 渲染器。一个 Globe 实例只建**一个**上下文，跨多次过场复用
 * （贴图只上传一次；过场结束时只把 canvas 从 DOM 上摘下来，上下文留着）。
 */
class GLRenderer {
  constructor(doc, opts = {}) {
    this.ok = false;
    this.reason = 'no-webgl';
    this.doc = doc;
    this.opts = opts;
    this.gl = null;
    this.canvas = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.scale = 1; // 实际用于绘制缓冲的「设备像素 / CSS 像素」倍率（受像素预算限制）
    this.textures = null; // { albedo, normal, countries, palette, hasNormal, hasCountry }
    this.info = null;
    this._frame = null;
    this._lost = false;
    this.tuning = {}; // 调试覆盖项（极地平滑半径、中国倍率…），生产路径走 TUNE
    this.aniso = 0; // 实际启用的各向异性过滤倍率（0 = 扩展不可用）
    this._flat = new Uint8Array(256 * 4); // 纯白兜底贴图（Uint8Array：WebGL1 的 texImage2D 不接受 Float32Array）
    this._flat.fill(255);
    this._init();
  }

  _init() {
    let canvas = null;
    let gl = null;
    try {
      canvas = this.doc.createElement('canvas');
      const attrs = {
        alpha: false,
        antialias: true,
        depth: true,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
      };
      gl =
        canvas.getContext('webgl', attrs) ||
        canvas.getContext('experimental-webgl', attrs) ||
        canvas.getContext('webgl2', attrs);
    } catch {
      gl = null;
    }
    if (!gl) {
      this.canvas = canvas;
      this.reason = 'no-webgl';
      return;
    }

    try {
      this.gl = gl;
      this.canvas = canvas;
      canvas.addEventListener('webglcontextlost', (ev) => {
        try {
          ev.preventDefault();
        } catch { /* 忽略 */ }
        this._lost = true;
        this.ok = false;
        this.reason = 'context-lost';
      });

      const sky = createProgram(gl, VS_QUAD, FS_SKY);
      const globe = createProgram(gl, VS_GLOBE, FS_GLOBE);
      this.sky = introspect(gl, sky, [
        'uRes', 'uCenter', 'uR',
      ], ['aPos']);
      this.sky.prog = sky;
      this.globe = introspect(gl, globe, [
        'uRes', 'uCenter', 'uR', 'uRight', 'uUp', 'uDir',
        'uAlbedo', 'uNormalMap', 'uCountryMap', 'uPalette',
        'uHasNormal', 'uHasCountry', 'uLight', 'uViewDir',
        'uDiffuse', 'uAmbient', 'uRim', 'uRimPower', 'uSpec', 'uSpecPower',
        'uBump', 'uOceanBump', 'uCountry', 'uGrid', 'uGridPx',
        'uExposure', 'uSaturation',
        'uPoleBumpFade', 'uChinaId', 'uChinaBoost', 'uGridPoleFade',
      ], ['aPos', 'aUv']);
      this.globe.prog = globe;

      // 全屏四边形
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      // 球面网格
      const mesh = buildSphereMesh(this.opts.lonSeg || 192, this.opts.latSeg || 96);
      this.mesh = mesh;
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);

      // 兜底纯白贴图（贴图没到位时也不至于采到未定义数据）
      this.white = this._makeTexture(this._flat, 256, 1, { nearest: true, mipmap: false });

      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.info = {
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        tris: mesh.tris,
        verts: mesh.vertCount,
      };

      gl.disable(gl.BLEND);
      gl.clearColor(0.02, 0.043, 0.118, 1);
      this.ok = true;
      this.reason = 'ok';
    } catch (err) {
      this.ok = false;
      this.reason = 'webgl-init-failed';
      this.error = err;
    }
  }

  /** 上传一张 256×1 / 图像纹理。 */
  _makeTexture(source, w, h, { nearest = false, mipmap = true } = {}) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // ★ 关键：不翻转 Y。约定的 v = (90−lat)/180 且贴图第一行是北极，
    //   正好对上 WebGL 默认的 UNPACK_FLIP_Y_WEBGL = false（首行对应 v=0）。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // 注意：6 参数重载只吃 TexImageSource（Image/Canvas/ImageData），
    // 裸像素数组必须走 9 参数重载，否则 WebGL 直接报 Overload resolution failed。
    if (ArrayBuffer.isView(source)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    const pot = isPow2(w) && isPow2(h);
    if (nearest) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else if (mipmap && pot) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // 各向异性过滤：球面掠射角（尤其两极附近）像素覆盖的纹素区域被拉得很长，
    // 只按 max(du,dv) 选 mip 会把整片糊掉、还会让相邻三角形的 mip 选择跳变出条纹。
    if (mipmap && !nearest) {
      const ext =
        gl.getExtension('EXT_texture_filter_anisotropic') ||
        gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic') ||
        gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
      if (ext) {
        const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
        const level = Math.min(8, max);
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, level);
        this.aniso = Math.max(this.aniso, level);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /**
   * 上传一张等距圆柱贴图。默认会把超大图缩到 ≤2048 宽再上传
   * （3072×1536 的 albedo 直接上传是 18MB 显存 + 明显的首帧卡顿）。
   */
  uploadImage(img, { maxW = 2048, maxH = 1024, nearest = false, mipmap = true } = {}) {
    const gl = this.gl;
    let src = img;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const down = (v, cap) => {
      let n = 1;
      while (n * 2 <= v) n *= 2;
      return Math.min(n, cap);
    };
    const tw = Math.min(w, down(w, maxW));
    const th = Math.min(h, down(h, maxH));
    if (tw !== w || th !== h) {
      const c = this.doc.createElement('canvas');
      c.width = tw;
      c.height = th;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, tw, th);
      src = c;
      w = tw;
      h = th;
    }
    return { tex: this._makeTexture(src, w, h, { nearest, mipmap }), w, h };
  }

  setTextures(t) {
    this.textures = t;
  }

  resize(w, h, dpr) {
    if (!this.ok) return;
    // 4K/视网膜屏上 w·h·dpr² 能到 800 万像素，片元着色器会直接压垮中端设备。
    // 给绘制缓冲设一个像素预算：超了就等比降到预算内，CSS 尺寸不变（浏览器负责放大），
    // 但至少保留 1 CSS 像素 = 1 设备像素，保证不会糊成马赛克。
    const budget = 2.2e6;
    const wanted = w * h * dpr * dpr;
    let scale = dpr;
    if (wanted > budget) scale = Math.max(1, dpr * Math.sqrt(budget / wanted));
    const pw = Math.max(1, Math.round(w * scale));
    const ph = Math.max(1, Math.round(h * scale));
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.scale = scale;
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /**
   * 画一帧。frame = { dir, up, right, cx, cy, R, w, h, bump, country }
   * 返回 'globe'（贴图已就绪，整颗球画出来了）或 'sky'（贴图还在路上，先给星空）。
   */
  draw(frame) {
    if (!this.ok) return false;
    this._frame = frame;
    const gl = this.gl;
    const { w, h } = this;
    const pw = this.canvas.width;
    const ph = this.canvas.height;
    if (!(pw > 0) || !(ph > 0)) return false;
    gl.viewport(0, 0, pw, ph);

    // ── 1. 星空背景（不透明，顺带免掉一次 clear）──
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    gl.useProgram(this.sky.prog);
    gl.uniform2f(this.sky.u.uRes, w, h);
    gl.uniform2f(this.sky.u.uCenter, frame.cx, frame.cy);
    gl.uniform1f(this.sky.u.uR, frame.R);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.sky.a.aPos);
    gl.vertexAttribPointer(this.sky.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const tex = this.textures;
    if (!tex || !tex.albedo) return 'sky';

    // ── 2. 地球 ──
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);

    const P = this.globe;
    gl.useProgram(P.prog);
    gl.uniform2f(P.u.uRes, w, h);
    gl.uniform2f(P.u.uCenter, frame.cx, frame.cy);
    gl.uniform1f(P.u.uR, frame.R);
    gl.uniform3f(P.u.uRight, frame.right[0], frame.right[1], frame.right[2]);
    gl.uniform3f(P.u.uUp, frame.up[0], frame.up[1], frame.up[2]);
    gl.uniform3f(P.u.uDir, frame.dir[0], frame.dir[1], frame.dir[2]);

    // 光照：相机系左上偏前 → 换算回世界系（着色器里就是世界向量）
    const L = frame.light || [0, 0, 1];
    gl.uniform3f(P.u.uLight, L[0], L[1], L[2]);
    gl.uniform3f(P.u.uViewDir, frame.dir[0], frame.dir[1], frame.dir[2]);

    gl.uniform1f(P.u.uDiffuse, TUNE.diffuse);
    gl.uniform1f(P.u.uAmbient, TUNE.ambient);
    gl.uniform1f(P.u.uRim, TUNE.rim);
    gl.uniform1f(P.u.uRimPower, TUNE.rimPower);
    gl.uniform1f(P.u.uSpec, TUNE.spec);
    gl.uniform1f(P.u.uSpecPower, TUNE.specPower);
    gl.uniform1f(P.u.uBump, frame.bump == null ? TUNE.bump : frame.bump);
    gl.uniform1f(P.u.uOceanBump, TUNE.oceanBump);
    gl.uniform1f(P.u.uCountry, frame.country == null ? TUNE.country : frame.country);
    gl.uniform1f(P.u.uGrid, TUNE.grid);
    gl.uniform1f(P.u.uGridPx, TUNE.gridPx);
    gl.uniform1f(P.u.uExposure, TUNE.exposure);
    gl.uniform1f(P.u.uSaturation, TUNE.saturation);
    // 极地法线淡出 / 经线淡出 / 中国蒙版倍率：可由调试接口临时覆盖（自动化测试做前后对比用）
    const tune = this.tuning || {};
    gl.uniform1f(P.u.uPoleBumpFade, tune.poleBumpFade == null ? TUNE.poleBumpFade : tune.poleBumpFade);
    gl.uniform1f(P.u.uChinaId, tune.chinaId == null ? 1 : tune.chinaId);
    gl.uniform1f(P.u.uChinaBoost, tune.chinaBoost == null ? TUNE.chinaBoost : tune.chinaBoost);
    gl.uniform1f(P.u.uGridPoleFade, tune.gridPoleFade == null ? 1 : tune.gridPoleFade);
    if (tune.spec != null) gl.uniform1f(P.u.uSpec, tune.spec);
    if (tune.rim != null) gl.uniform1f(P.u.uRim, tune.rim);
    if (tune.bump != null) gl.uniform1f(P.u.uBump, tune.bump);
    if (tune.grid != null) gl.uniform1f(P.u.uGrid, tune.grid);
    if (tune.noNormal) gl.uniform1f(P.u.uHasNormal, 0);

    const bind = (loc, texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture || this.white);
      gl.uniform1i(loc, unit);
    };
    bind(P.u.uAlbedo, tex.albedo, 0);
    bind(P.u.uNormalMap, tex.normal, 1);
    bind(P.u.uCountryMap, tex.countries, 2);
    bind(P.u.uPalette, tex.palette || this.white, 3);
    gl.uniform1f(P.u.uHasNormal, tex.normal ? 1 : 0);
    gl.uniform1f(P.u.uHasCountry, tex.countries ? 1 : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(P.a.aPos);
    gl.vertexAttribPointer(P.a.aPos, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(P.a.aUv);
    gl.vertexAttribPointer(P.a.aUv, 2, gl.FLOAT, false, 20, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.drawElements(gl.TRIANGLES, this.mesh.idx.length, gl.UNSIGNED_SHORT, 0);
    return 'globe';
  }

  /** 重画最后一帧并读回一块像素（测试用；不做 preserveDrawingBuffer 也不会读到空）。 */
  readPixel(x, y, size = 1) {
    if (!this.ok || !this._frame) return null;
    try {
      this.draw(this._frame);
      const s = Math.max(1, Math.round(size));
      const half = Math.floor(s / 2);
      const scale = this.scale || 1;
      const px = Math.max(0, Math.min(this.canvas.width - s, Math.round(x * scale) - half));
      const py = Math.max(0, Math.min(this.canvas.height - s, Math.round(y * scale) - half));
      const buf = new Uint8Array(s * s * 4);
      this.gl.readPixels(
        px,
        this.canvas.height - py - s,
        s,
        s,
        this.gl.RGBA,
        this.gl.UNSIGNED_BYTE,
        buf,
      );
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < buf.length; i += 4) {
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
        a += buf[i + 3];
      }
      const n = s * s;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
    } catch {
      return null;
    }
  }

  /**
   * 整帧读回（自动化测试用）：重画最后一帧，一次 readPixels 把整张图拿回来，
   * 之后在 JS 里想取多少点就取多少点 —— 逐点调用 readPixel 会逐点重画，慢得没法用。
   * 返回的 rgba 是**自下而上**的行序（WebGL 约定），flipY=true 标出来。
   */
  capture() {
    if (!this.ok || !this._frame) return null;
    try {
      this.draw(this._frame);
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (!(w > 0) || !(h > 0)) return null;
      const rgba = new Uint8Array(w * h * 4);
      this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, rgba);
      return { width: w, height: h, scale: this.scale || 1, rgba, flipY: true };
    } catch {
      return null;
    }
  }

  dispose() {
    try {
      const lose = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (lose && !this._lost) lose.loseContext();
    } catch { /* 忽略 */ }
    this.ok = false;
  }
}

// ───────────────────────────────────────────────────────────── 主体
export class Globe {
  /**
   * @param {Document|Element} root 覆盖层挂载位置（默认 document）
   * @param {{data?: {LAND?: any[], BORDERS?: any[]},
   *          assetBase?: string, assets?: object, forceCanvas2D?: boolean,
   *          lonSeg?: number, latSeg?: number}} [opts]
   */
  constructor(root = typeof document !== 'undefined' ? document : null, { data, assetBase, assets, forceCanvas2D, lonSeg, latSeg } = {}) {
    this._root = root || (typeof document !== 'undefined' ? document : null);
    this._doc =
      (this._root && (this._root.nodeType === 9 ? this._root : this._root.ownerDocument)) ||
      (typeof document !== 'undefined' ? document : null);
    this._cfg = readGlobeConfig();
    this._data = normalizeData(data);
    this._dataPromise = null;
    this._geo = null;

    this._run = null;
    this._seq = 0;
    this._last = { from: null, to: null, progress: 0, frames: 0, fps: 0 };
    this._basis = { dir: [0, 0, 1], up: [0, 1, 0], right: [1, 0, 0], forward: [0, 0, -1] };
    // 注意：相机高度用 alt 表示，**不要**叫 h —— view.h 是视口高度，撞名会把 clearRect/drawImage 的高度变成 0.2px
    this._view = { w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0, side: 0, ratio: 0, alt: 0, hMax: 0, dist: 0, t: 0, span: 0, distKm: 0 };
    // 相机抛物线弹道的诊断快照（rendererInfo.zoom / viewport 都读它）
    this._zoom = {
      active: false,
      phase: 'idle', // idle | ground | ascend | apex | descend | arrived
      t: 0, // easePlateau 缓动后的进度（0 = 起点贴地，1 = 终点贴地）
      hMax: 0, // 本趟弹道最高点（单位 = 地球半径）
      h: 0, // 当前高度
      dist: 0, // 当前相机到球心距离（地球半径 = 1）
      ratio: 0, // 当前「球直径 ÷ 视口短边」
      ratioNear: 0, // 贴地时的比例（应等于 nearMinSideRatio）
      span: 0, // 两城夹角 / π（0 = 同城，1 = 对跖）
      spanDeg: 0, // 两城夹角（度）
      distKm: 0, // 两城大圆距离（km）
      side: 0, // 视口短边（CSS 像素）
      R: 0, // 当前屏幕半径（CSS 像素）
    };
    this._supported = null;

    // ── 渲染路径状态 ──
    this._renderer = 'canvas2d';
    this._reason = 'idle';
    this._gl = null;
    this._glTried = false;
    this._tex = null; // { albedo, normal, countries, palette, hasNormal, hasCountry }
    this._texPromise = null;
    this._texState = 'idle'; // idle | loading | ready | failed
    this._assetBase = typeof assetBase === 'string' && assetBase ? assetBase : readTexturesDir();
    this._assets = assets && typeof assets === 'object' ? assets : null;
    this._force2D = forceCanvas2D === true;
    this._glOpts = { lonSeg, latSeg };
    this._texUploadMs = 0;
    this._chinaId = 1; // 兜底：真实值从 countries.json 的 chinaIndex 读（见 _loadChinaIndex）
    this._chinaIdPromise = null;
  }

  // ── 环境能力 ────────────────────────────────────────────────
  /**
   * 是否有 canvas 2D 且 GLOBE.enabled 没被关掉。
   * 注意：prefers-reduced-motion 不影响 supported —— 那种情况下仍然要
   * 「不做旋转动画、直接显示目标城市的静态地球并淡入淡出」，只是把时长压短。
   */
  get supported() {
    if (this._supported !== null) return this._supported;
    let ok = false;
    try {
      ok = !!(this._cfg.enabled && this._doc && typeof this._doc.createElement === 'function');
      if (ok) {
        const probe = this._doc.createElement('canvas');
        ok = !!(probe && typeof probe.getContext === 'function' && probe.getContext('2d'));
      }
    } catch {
      ok = false;
    }
    this._supported = ok;
    return ok;
  }

  /** 用户是否要求减少动效。 */
  get reducedMotion() {
    return prefersReducedMotion(this._win());
  }

  get config() {
    return { ...this._cfg };
  }

  /** 当前实际走的渲染路径：'webgl'（第二代）或 'canvas2d'（第一代降级）。 */
  get rendererMode() {
    return this._renderer;
  }

  /** 为什么走这条路径：idle / ok / no-webgl / texture-error / context-lost / disabled … */
  get rendererReason() {
    return this._reason;
  }

  /** 渲染侧的诊断信息（自动化测试与真机排查用）。 */
  get rendererInfo() {
    return {
      mode: this._renderer,
      reason: this._reason,
      textureState: this._texState,
      assets: this._assetBase,
      uploadMs: Math.round(this._texUploadMs),
      chinaId: this._chinaId,
      aniso: this._gl ? this._gl.aniso : 0,
      tuning: this._gl ? { ...this._gl.tuning } : {},
      // 逼近/拉远：k 是当前半径倍率，distKm 是本次转场的两城距离
      zoom: { ...this._zoom },
      webgl: this._gl && this._gl.info ? { ...this._gl.info } : null,
      buffer: this._gl && this._gl.ok
        ? { w: this._gl.canvas.width, h: this._gl.canvas.height, scale: Number((this._gl.scale || 1).toFixed(3)) }
        : null,
      textures: this._gl && this._gl.textures
        ? {
            albedo: !!this._gl.textures.albedo,
            normal: !!this._gl.textures.normal,
            countries: !!this._gl.textures.countries,
            palette: !!this._gl.textures.palette,
          }
        : null,
    };
  }

  // ── 调试用只读入口 ──────────────────────────────────────────
  /** 世界（单位球）→ 屏幕 CSS 像素坐标，y 轴向下（canvas 约定）。 */
  worldToScreen(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const view = this._view;
    if (!(view.R > 0)) return null;
    const v = sphereVec(lat, lon, [0, 0, 0]);
    const b = this._basis;
    const sx = v[0] * b.right[0] + v[1] * b.right[1] + v[2] * b.right[2];
    const sy = v[0] * b.up[0] + v[1] * b.up[1] + v[2] * b.up[2];
    const depth = v[0] * b.dir[0] + v[1] * b.dir[1] + v[2] * b.dir[2];
    return {
      x: view.cx + sx * view.R,
      y: view.cy - sy * view.R,
      visible: depth >= 0,
      // 归一化到单位圆盘（球面半径 = 1），y 同样向下
      nx: sx,
      ny: -sy,
    };
  }

  /** 当前相机基（世界坐标系单位向量）。 */
  cameraBasis() {
    const b = this._basis;
    return {
      right: [b.right[0], b.right[1], b.right[2]],
      up: [b.up[0], b.up[1], b.up[2]],
      forward: [b.forward[0], b.forward[1], b.forward[2]],
      dir: [b.dir[0], b.dir[1], b.dir[2]],
    };
  }

  get state() {
    const run = this._run;
    if (!run) {
      return {
        running: false,
        from: this._last.from,
        to: this._last.to,
        progress: this._last.progress,
        frames: this._last.frames,
        fps: this._last.fps,
      };
    }
    return {
      running: true,
      from: run.from,
      to: run.to,
      progress: run.progress,
      frames: run.frames,
      fps: run.fps,
    };
  }

  /**
   * 当前画布视口（CSS 像素）：球心 (cx,cy)、球面半径 R、视口宽高 w/h。
   * 另附弹道量：side 视口短边、ratio 球直径/短边、alt 相机高度（地球半径=1）、
   * hMax 本趟最高点、dist 相机到球心距离、t 弹道进度、span 两城夹角/π、distKm 两城距离。
   * 注意 alt 不叫 h —— h 已经被视口高度占用了。
   */
  get viewport() {
    const v = this._view;
    return {
      w: v.w,
      h: v.h,
      dpr: v.dpr,
      cx: v.cx,
      cy: v.cy,
      R: v.R,
      side: v.side || Math.min(v.w, v.h),
      ratio: v.ratio || 0,
      alt: v.alt || 0,
      hMax: v.hMax || 0,
      dist: v.dist || 0,
      t: v.t || 0,
      span: v.span || 0,
      distKm: v.distKm || 0,
    };
  }

  /** 覆盖层当前是否挂在 DOM 上（自动化测试用）。 */
  get attached() {
    const run = this._run;
    return !!(run && run.el && run.el.parentNode);
  }

  /**
   * 读屏幕上一点的颜色（自动化测试用，验证贴图方向）。
   * WebGL 路径下会重画最后一帧再 readPixels；2D 路径直接 getImageData。
   * @param {number} [size] 取 size×size 的方块取平均，抗锯齿/边缘噪点更稳
   * @returns {number[]|null} [r,g,b,a]
   */
  sampleScreen(x, y, size = 1) {
    const run = this._run;
    if (!run || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (this._renderer === 'webgl' && this._gl && this._gl.ok) {
      return this._gl.readPixel(x, y, size);
    }
    try {
      const canvas = run.baseCanvas;
      const ctx = run.baseCtx;
      if (!canvas || !ctx) return null;
      const dpr = run.view ? run.view.dpr : 1;
      const s = Math.max(1, Math.round(size));
      const half = Math.floor(s / 2);
      const px = Math.max(0, Math.round(x * dpr) - half);
      const py = Math.max(0, Math.round(y * dpr) - half);
      const data = ctx.getImageData(px, py, s, s).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        a += data[i + 3];
        n++;
      }
      if (!n) return null;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
    } catch {
      return null;
    }
  }

  /**
   * 整帧读回（自动化测试用）。返回 { width, height, scale, rgba, flipY }，
   * 供测试在一次绘制里取成百上千个点做统计（中国红色对比、北极伪影扫描都要这个）。
   */
  captureFrame() {
    const run = this._run;
    if (!run) return null;
    if (this._renderer === 'webgl' && this._gl && this._gl.ok) return this._gl.capture();
    try {
      const canvas = run.baseCanvas;
      const ctx = run.baseCtx;
      if (!canvas || !ctx) return null;
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height: canvas.height,
        scale: run.view ? run.view.dpr : 1,
        rgba: d.data,
        flipY: false, // getImageData 是自上而下的行序
      };
    } catch {
      return null;
    }
  }

  /** 调试覆盖：临时改渲染调参（自动化测试做「修复前 / 修复后」对比用）。 */
  setTuning(patch) {
    // 上下文还没建出来时先存着，等 _ensureGL 建好后合并进去（否则静默失效）
    this._pendingTuning = { ...(this._pendingTuning || {}), ...(patch || {}) };
    if (this._gl) this._gl.tuning = { ...this._gl.tuning, ...this._pendingTuning };
  }

  /**
   * 调试：丢掉已上传的贴图并允许换上传选项（例如关掉 mipmap），
   * 用来定位「过滤相关」的渲染伪影。下次 showTransition 会重新上传。
   */
  debugReloadTextures(opts = {}) {
    this._texOpts = { ...(this._texOpts || {}), ...opts };
    const gl = this._gl;
    if (gl && gl.gl && gl.textures) {
      for (const k of ['albedo', 'normal', 'countries', 'palette']) {
        const t = gl.textures[k];
        if (t) {
          try { gl.gl.deleteTexture(t); } catch { /* 忽略 */ }
        }
      }
      gl.setTextures({});
    }
    this._tex = null;
    this._texPromise = null;
    this._texState = 'idle';
    return this._texOpts;
  }

  /** 屏幕坐标 → 该点的纹理 uv（调试用，配合 sampleScreen 核对贴图方向）。 */
  geoUv(lat, lon) {
    return geoUv(lat, lon);
  }

  // ── 主流程 ─────────────────────────────────────────────────
  /**
   * 从 from 转到 to，动画 + 停留结束后 resolve。
   * 永不 reject：任何异常都吞掉并 resolve，保证播报流程不会因为地球卡死。
   * @returns {Promise<void>}
   */
  async showTransition(from, to) {
    // 先收掉上一个（若有），避免两个动画叠加
    this.cancel();

    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });

    const toCity = normalizeCity(to);
    const fromCity = normalizeCity(from) || toCity;
    const run = {
      id: ++this._seq,
      from: fromCity,
      to: toCity,
      resolve: once(release),
      done: false,
      started: false,
      progress: 0,
      frames: 0,
      fps: 0,
      raf: 0,
      el: null,
      canvas: null,
      ctx: null,
      baseCanvas: null,
      baseCtx: null,
      fxCanvas: null,
      fxCtx: null,
      onResize: null,
      startTime: 0,
      dur: this._cfg.duration,
      hold: this._cfg.holdMs,
      fade: this._cfg.fadeMs,
      total: this._cfg.duration + this._cfg.holdMs,
      view: null,
      t: 0, // easePlateau 缓动后的弹道进度（每帧由 _applyArc 写入）
      // 相机抛物线弹道：两城夹角决定本趟的抛高（arc 在 _begin 里算，屏幕半径每帧由 _applyArc 写）
      distKm: fromCity && toCity ? haversineKm(fromCity, toCity) : 0,
      arc: null,
      countryRef: 1,
      bg: null,
      geo: null,
      dirFrom: [0, 0, 1],
      dirTo: [0, 0, 1],
      dirNow: [0, 0, 1],
      arcVec: null,
      pulse: 0,
    };
    this._run = run;

    if (!this.supported || !run.from || !run.to) {
      this._last = { from: run.from, to: run.to, progress: 1, frames: 0, fps: 0 };
      this._finishRun(run);
      return promise;
    }

    let data;
    try {
      data = await this._loadData();
    } catch (err) {
      warn('地理数据加载失败，已跳过地球过场：', err);
      this._finishRun(run);
      return promise;
    }
    // 加载期间可能已经被 cancel() 或被新的 showTransition 接管
    if (this._run !== run || run.done) return promise;

    try {
      this._begin(run, data);
    } catch (err) {
      warn('地球过场初始化失败，已跳过：', err);
      this._finishRun(run);
    }
    return promise;
  }

  /** 立刻中止动画、移除覆盖层；对应的 Promise 也会 resolve。 */
  cancel() {
    const run = this._run;
    if (!run) return;
    this._run = null;
    this._finishRun(run);
  }

  /** 主动销毁：不再需要这个实例时调用（幂等）。 */
  destroy() {
    this.cancel();
    if (this._gl) {
      try {
        this._gl.dispose();
      } catch { /* 忽略 */ }
    }
  }

  // ── 内部：数据 ─────────────────────────────────────────────
  _loadData() {
    if (this._data) return Promise.resolve(this._data);
    if (!this._dataPromise) {
      this._dataPromise = import('./globe-data.js')
        .then((mod) => {
          const d = normalizeData(mod) || { LAND: [], BORDERS: [] };
          this._data = d;
          return d;
        })
        .catch((err) => {
          this._dataPromise = null;
          throw err;
        });
    }
    return this._dataPromise;
  }

  _prepareGeo(data) {
    if (this._geo && this._geo.src === data) return this._geo;
    const geo = {
      src: data,
      land: ringsToVec(data.LAND),
      borders: ringsToVec(data.BORDERS),
    };
    this._geo = geo;
    return geo;
  }

  // ── 内部：贴图 ─────────────────────────────────────────────
  _assetUrl(name, override) {
    if (override) return override;
    if (this._assets && typeof this._assets[name] === 'string') return this._assets[name];
    return `${this._assetBase}${name}`;
  }

  /**
   * 读 countries.json 里的 chinaIndex（3KB，后台异步，失败就退回默认值 1）。
   * 不把编号硬编码死在代码里：贴图是生成物，编号分配算法已经换过一次，
   * 写死迟早对不上；读到了就以后者为准。
   */
  _loadChinaIndex() {
    if (this._chinaIdPromise) return;
    if (typeof fetch !== 'function') return;
    const url = `${this._assetBase}countries.json`;
    this._chinaIdPromise = fetch(url)
      .then((r) => (r && r.ok ? r.json() : null))
      .then((json) => {
        const idx = json ? Number(json.chinaIndex) : NaN;
        if (Number.isFinite(idx) && idx >= 1 && idx <= 255) {
          this._chinaId = idx;
          if (this._gl) this._gl.tuning = { ...this._gl.tuning, chinaId: idx };
        }
        return this._chinaId;
      })
      .catch(() => this._chinaId);
  }

  /** 载入一张图片（带超时，绝不无限挂住）。 */
  _loadImage(url) {
    return new Promise((resolve, reject) => {
      if (!url || typeof url !== 'string') {
        reject(new Error('空的贴图地址'));
        return;
      }
      const img = new Image();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`贴图加载超时：${url}`));
      }, 9000);
      img.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`贴图加载失败：${url}`));
      };
      try {
        img.decoding = 'async';
      } catch { /* 忽略 */ }
      img.src = url;
    });
  }

  /** 走到这里说明 WebGL 上下文可用：异步拉贴图，**不阻塞**动画时间轴。 */
  _startTextures(run) {
    this._loadChinaIndex();
    // 贴图已经备好（第二次及以后的过场）：直接挂上，不必等一个微任务
    if (this._tex) {
      if (this._gl) this._gl.setTextures(this._tex);
      return;
    }
    if (this._texPromise) {
      // 已经有结果/正在加载：好了就直接挂上，没好就等它
      this._texPromise.then((t) => {
        if (this._run !== run || run.done) return;
        if (t) this._applyTextures(run, t);
      });
      return;
    }
    this._texState = 'loading';
    const t0 = now(this._win());
    const urls = {
      albedo: this._assetUrl('albedo.jpg', this._assets && this._assets.albedo),
      normal: this._assetUrl('normal.jpg', this._assets && this._assets.normal),
      countries: this._assetUrl('countries.png', this._assets && this._assets.countries),
      palette: this._assetUrl('palette.png', this._assets && this._assets.palette),
    };
    const optional = (u) => this._loadImage(u).catch(() => null);
    this._texPromise = Promise.all([
      this._loadImage(urls.albedo),
      optional(urls.normal),
      optional(urls.countries),
      optional(urls.palette),
    ])
      .then(([albedo, normal, countries, palette]) => {
        const gl = this._gl;
        if (!gl || !gl.ok) return null;
        const tex = {};
        const mip = !(this._texOpts && this._texOpts.noMipmap);
        const up = gl.uploadImage(albedo, { maxW: 2048, maxH: 1024, mipmap: mip });
        tex.albedo = up.tex;
        tex.albedoSize = [up.w, up.h];
        if (normal) {
          const n = gl.uploadImage(normal, { maxW: 2048, maxH: 1024, mipmap: mip });
          tex.normal = n.tex;
        }
        if (countries) {
          // 索引图必须 NEAREST + 不缩不放（插值会造出根本不存在的国家编号）
          const c = gl.uploadImage(countries, { maxW: 8192, maxH: 8192, nearest: true, mipmap: false });
          tex.countries = c.tex;
        }
        if (palette) {
          const p = gl.uploadImage(palette, { maxW: 256, maxH: 1, nearest: true, mipmap: false });
          tex.palette = p.tex;
        }
        if (!tex.palette) tex.palette = this._buildFallbackPalette();
        tex.hasNormal = !!tex.normal;
        tex.hasCountry = !!tex.countries;
        this._texUploadMs = now(this._win()) - t0;
        this._texState = 'ready';
        return tex;
      })
      .catch((err) => {
        this._texState = 'failed';
        this._texPromise = null;
        warn('地球贴图不可用，回退到矢量地球：', err && err.message ? err.message : err);
        return null;
      });
    this._texPromise.then((t) => {
      if (this._run !== run || run.done) return;
      this._applyTextures(run, t);
    });
  }

  _applyTextures(run, t) {
    if (!t) {
      // 贴图挂了 → 当场换成第一代渲染，**绝不留白**
      this._fallbackToCanvas2D(run, 'texture-error');
      return;
    }
    this._tex = t;
    if (this._gl) this._gl.setTextures(t);
  }

  /** 造一张 256×1 的兜底调色板（HSV 黄金角散色相，低饱和）。 */
  _buildFallbackPalette() {
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      if (i === 0) {
        data[i * 4] = 255;
        data[i * 4 + 1] = 255;
        data[i * 4 + 2] = 255;
        data[i * 4 + 3] = 255;
        continue;
      }
      const h = (i * 137.508) % 360;
      const [r, g, b] = hsvToRgb(h / 360, 0.30, 0.88);
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
    return this._gl._makeTexture(data, 256, 1, { nearest: true, mipmap: false });
  }

  // ── 内部：启动与收尾 ───────────────────────────────────────
  _begin(run, data) {
    const doc = this._doc;
    const win = this._win();
    if (!doc || !win) throw new Error('没有可用的 document/window');

    const host =
      this._root && this._root.nodeType === 1 && typeof this._root.appendChild === 'function'
        ? this._root
        : doc.body || doc.documentElement;
    if (!host) throw new Error('找不到挂载节点');

    run.geo = this._prepareGeo(data);
    // 弹道参数：用两城**真实**经纬度算夹角（极地夹紧只作用于相机方向，不作用于这里）
    run.arc = arcFor(run.from, run.to, this._cfg);
    run.dirFrom = sphereVec(clamp(run.from.lat, this._cfg.minLat, this._cfg.maxLat), run.from.lon, [0, 0, 0]);
    run.dirTo = sphereVec(clamp(run.to.lat, this._cfg.minLat, this._cfg.maxLat), run.to.lon, [0, 0, 0]);
    run.dirNow = [run.dirFrom[0], run.dirFrom[1], run.dirFrom[2]];

    // 大圆弧：世界空间里一次性算好，每帧只做投影
    run.arcVec = new Float64Array(ARC_SAMPLES * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < ARC_SAMPLES; i++) {
      slerpDir(run.dirFrom, run.dirTo, i / (ARC_SAMPLES - 1), tmp);
      run.arcVec[i * 3] = tmp[0];
      run.arcVec[i * 3 + 1] = tmp[1];
      run.arcVec[i * 3 + 2] = tmp[2];
    }

    // reduced-motion：不做旋转，直接给目标城市的静态地球
    const reduced = prefersReducedMotion(win);
    run.reduced = reduced;
    run.dur = reduced ? Math.max(1, Math.min(1500, this._cfg.duration)) : this._cfg.duration;
    run.hold = this._cfg.holdMs;
    run.fade = this._cfg.fadeMs;
    run.total = run.dur + run.hold;

    injectStyle(doc);

    const el = doc.createElement('div');
    el.className = OVERLAY_CLASS;
    el.setAttribute('aria-hidden', 'true');
    run.el = el;

    // ★ 渲染路径：能上 WebGL 就上，上不了（或强制）就用第一代
    const gl = this._ensureGL();
    if (gl && gl.ok) {
      this._renderer = 'webgl';
      this._reason = 'ok';
      // 上下文是跨过场复用的，canvas 节点随本次覆盖层挂上去、结束时摘下来
      gl.canvas.className = `${OVERLAY_CLASS}-gl`;
      el.appendChild(gl.canvas);
      run.baseCanvas = gl.canvas;
      run.canvas = gl.canvas;
      this._startTextures(run);
    } else {
      this._renderer = 'canvas2d';
      this._reason = this._glFailReason || 'no-webgl';
      const base = doc.createElement('canvas');
      base.className = `${OVERLAY_CLASS}-base`;
      el.appendChild(base);
      run.baseCanvas = base;
      run.canvas = base;
      run.baseCtx = base.getContext('2d');
      if (!run.baseCtx) {
        try { host.removeChild(el); } catch { /* 忽略 */ }
        throw new Error('canvas 2d 不可用');
      }
    }

    // 前景图层（弧线 / 标记 / 中英标签）：文字必须用 2D 画，两层各自独立
    const fx = doc.createElement('canvas');
    fx.className = `${OVERLAY_CLASS}-fx`;
    el.appendChild(fx);
    run.fxCanvas = fx;
    run.fxCtx = fx.getContext('2d');

    host.appendChild(el);

    this._layout(run);

    run.onResize = () => {
      if (run.done || this._run !== run) return;
      try {
        this._layout(run);
      } catch (err) {
        warn('地球过场重排失败：', err);
      }
    };
    win.addEventListener('resize', run.onResize);

    run.started = true;
    run.startTime = now(win);

    const raf =
      typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : null;
    if (!raf) {
      // 没有 rAF（极老环境）：画一帧目标状态直接收工
      this._draw(run, run.total);
      this._finishRun(run);
      return;
    }
    run.raf = raf((t) => this._tick(run, t));
  }

  /** 懒创建一个跨过场复用的 WebGL 渲染器。 */
  _ensureGL() {
    if (this._force2D) {
      this._glFailReason = 'forced-canvas2d';
      return null;
    }
    if (this._glTried) return this._gl;
    this._glTried = true;
    if (!this._doc || typeof this._doc.createElement !== 'function') return null;
    try {
      const gl = new GLRenderer(this._doc, this._glOpts);
      if (!gl.ok) {
        this._gl = null;
        this._glFailReason = gl.reason || 'no-webgl';
        if (gl.error) warn('WebGL 初始化失败，改用矢量地球：', gl.error.message || gl.error);
        return null;
      }
      this._gl = gl;
      if (this._pendingTuning) gl.tuning = { ...gl.tuning, ...this._pendingTuning };
      return gl;
    } catch (err) {
      warn('WebGL 初始化异常，改用矢量地球：', err && err.message ? err.message : err);
      this._glFailReason = 'webgl-init-threw';
      this._gl = null;
      return null;
    }
  }

  /** 中途从 WebGL 掉回第一代：换一块 2D canvas，画面立刻接上，不留白。 */
  _fallbackToCanvas2D(run, reason) {
    if (this._renderer === 'canvas2d') return;
    this._renderer = 'canvas2d';
    this._reason = reason;
    const doc = this._doc;
    if (!doc || !run || run.done || this._run !== run || !run.el) return;
    try {
      const base = doc.createElement('canvas');
      base.className = `${OVERLAY_CLASS}-base`;
      run.el.insertBefore(base, run.fxCanvas || null);
      if (run.canvas && run.canvas.parentNode === run.el) run.el.removeChild(run.canvas);
      run.canvas = base;
      run.baseCanvas = base;
      run.baseCtx = base.getContext('2d');
      this._layout(run);
    } catch (err) {
      warn('回退到矢量地球失败：', err && err.message ? err.message : err);
    }
  }

  _tick(run, t) {
    run.raf = 0;
    if (run.done || this._run !== run) return;
    const dt = Math.max(0, Number(t) - run.startTime);
    run.frames++;
    if (run.frames === 1) run.zero = Number(t);
    const span = Number(t) - run.zero;
    run.fps = span > 250 ? Math.round((run.frames * 1000) / span) : 0;
    try {
      this._draw(run, dt);
    } catch (err) {
      warn('地球过场绘制失败：', err && err.message ? err.message : err);
      this._finishRun(run);
      return;
    }
    if (dt >= run.total) {
      this._finishRun(run);
      return;
    }
    const win = this._win();
    if (!win || typeof win.requestAnimationFrame !== 'function') {
      this._finishRun(run);
      return;
    }
    run.raf = win.requestAnimationFrame((n) => this._tick(run, n));
  }

  _finishRun(run) {
    if (!run || run.done) return;
    run.done = true;
    run.progress = 1;
    const win = this._win();
    if (run.raf && win && typeof win.cancelAnimationFrame === 'function') {
      try { win.cancelAnimationFrame(run.raf); } catch { /* 忽略 */ }
    }
    run.raf = 0;
    if (run.onResize && win && typeof win.removeEventListener === 'function') {
      try { win.removeEventListener('resize', run.onResize); } catch { /* 忽略 */ }
    }
    run.onResize = null;
    if (run.el && run.el.parentNode) {
      try { run.el.parentNode.removeChild(run.el); } catch { /* 忽略 */ }
    }
    if (this._run === run) this._run = null;
    this._last = { from: run.from, to: run.to, progress: 1, frames: run.frames, fps: run.fps };
    // 缩放快照留着（收尾后 rendererInfo.zoom 仍能读到本次转场的 k / 距离），只标记不再动画
    this._zoom.active = false;
    run.el = null;
    run.canvas = null;
    run.ctx = null;
    run.baseCanvas = null;
    run.baseCtx = null;
    run.fxCanvas = null;
    run.fxCtx = null;
    run.bg = null;
    run.geo = null;
    run.arcVec = null;
    const release = run.resolve;
    run.resolve = null;
    if (release) release();
  }

  _win() {
    if (this._doc && this._doc.defaultView) return this._doc.defaultView;
    return typeof window !== 'undefined' ? window : null;
  }

  // ── 内部：相机抛物线弹道 ───────────────────────────────────
  /** 把本次转场的弹道参数（与视口无关的部分）写进诊断快照。 */
  _syncArcInfo(run, view) {
    const info = this._zoom;
    const arc = run.arc;
    info.ratioNear = this._cfg.nearMinSideRatio;
    info.side = view.side;
    info.distKm = run.distKm;
    if (!arc) return;
    info.span = arc.span;
    info.spanDeg = arc.spanDeg;
    info.hMax = arc.hMax;
    info.t = view.t || 0;
    const a = arcAt(view.t || 0, arc.hMax, this._cfg);
    info.h = a.h;
    info.dist = a.dist;
    info.ratio = a.ratio;
    info.R = view.R;
  }

  /**
   * 每帧按弹道曲线把「相机高度 → 球占比 → 屏幕半径」写进 run.view（所有绘制都从 view.R 取半径，
   * 所以一处生效、两条渲染路径都跟上）。
   *   t 传 easePlateau 缓动后的进度：两端各留 10% 静止的时间轴不变，
   *   抛物线在镜头方向静止的那两段里就已经在上升 / 下落。
   * 两端 h=0 → ratio = nearMinSideRatio（贴地近景）；t=0.5 时最大抛高 → 本趟最小。
   * reduced-motion 下 t=1（不做旋转），于是自动停在目标城市的贴地近景上。
   */
  _applyArc(run, t) {
    const view = run.view;
    const arc = run.arc;
    if (!view || !arc) return;
    const a = arcAt(t, arc.hMax, this._cfg);
    const R = a.ratio * 0.5 * view.side;

    run.t = a.t;
    view.t = a.t;
    view.alt = a.h; // 相机高度（地球半径 = 1）；字段名避开 h（= 视口高度）
    view.hMax = arc.hMax;
    view.dist = a.dist;
    view.ratio = a.ratio;
    view.R = R;

    const info = this._zoom;
    info.active = true;
    info.phase = a.t <= 0 ? 'ground' : a.t >= 1 ? 'arrived' : Math.abs(a.t - 0.5) <= 0.02 ? 'apex' : a.t < 0.5 ? 'ascend' : 'descend';
    info.t = a.t;
    info.h = a.h;
    info.dist = a.dist;
    info.ratio = a.ratio;
    info.R = R;
  }

  // ── 内部：布局与预渲染 ─────────────────────────────────────
  _layout(run) {
    const win = this._win();
    const doc = this._doc;
    if (!win || !doc) return;

    const de = doc.documentElement || {};
    const w = Math.max(1, Math.round(win.innerWidth || de.clientWidth || 1280));
    const h = Math.max(1, Math.round(win.innerHeight || de.clientHeight || 720));
    const dpr = clamp(Number(win.devicePixelRatio) || 1, 1, 2);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);

    // ── 弹道：球占比只跟相机距离有关（与视口无关），屏幕半径 = 占比 × 短边的一半 ──
    const side = Math.min(w, h);
    // 重排（窗口 resize）时保留当前弹道进度对应的比例，不要弹回贴地
    const t0 = clamp(Number(run.t) || 0, 0, 1);
    const a0 = arcAt(t0, run.arc ? run.arc.hMax : 0, this._cfg);
    // 国家蒙版强度按「贴地半径」定，转场全程不跟着缩放抖（否则像在呼吸）
    run.countryRef = clamp((a0.ratio * 0.5 * side) / 420, 0.45, 1);

    const view = {
      w,
      h,
      dpr,
      cx: w / 2,
      cy: h / 2,
      R: a0.ratio * 0.5 * side,
      side,
      ratio: a0.ratio,
      alt: a0.h, // 相机高度（不要用 h 这个名字：h 是视口高度）
      hMax: run.arc ? run.arc.hMax : 0,
      dist: a0.dist,
      t: t0,
      span: run.arc ? run.arc.span : 0,
      distKm: run.distKm,
    };
    run.view = view;
    this._view = view;
    this._syncArcInfo(run, view);

    const sizeCanvas = (c) => {
      if (!c) return;
      c.width = pw;
      c.height = ph;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    };

    if (this._renderer === 'webgl' && this._gl && this._gl.ok) {
      this._gl.resize(w, h, dpr);
      run.baseCanvas = this._gl.canvas;
      run.canvas = this._gl.canvas;
    } else {
      sizeCanvas(run.baseCanvas);
    }
    sizeCanvas(run.fxCanvas);

    // 第一代渲染需要一张预渲染底图（夜空 + 星星 + 海洋）。
    // WebGL 路径不需要它，只有真的回退时才构建，省掉一次全屏预渲染。
    if (this._renderer === 'canvas2d') this._prerender(run);
  }

  _prerender(run) {
    const doc = this._doc;
    const view = run.view;
    if (!doc || !view) return;
    // 尺寸变了必须重画（画布不能被拉伸复用）
    if (run.bg && (run.bgW !== view.w || run.bgH !== view.h || run.bgDpr !== view.dpr)) {
      run.bg = null;
    }
    if (run.bg) return;
    const pw = Math.max(1, Math.round(view.w * view.dpr));
    const ph = Math.max(1, Math.round(view.h * view.dpr));

    const base = doc.createElement('canvas');
    base.width = pw;
    base.height = ph;
    const bx = base.getContext('2d');
    if (!bx) return;
    bx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const sky = bx.createLinearGradient(0, 0, 0, view.h);
    sky.addColorStop(0, '#050b1e');
    sky.addColorStop(0.55, '#0a1734');
    sky.addColorStop(1, '#050c1c');
    bx.fillStyle = sky;
    bx.fillRect(0, 0, view.w, view.h);

    // 星星（固定种子，换城时星空不跳）
    const rnd = mulberry32(20240921);
    bx.save();
    for (let i = 0; i < STAR_COUNT; i++) {
      const x = rnd() * view.w;
      const y = rnd() * view.h * 0.98;
      const rr = 0.35 + rnd() * 1.35;
      const a = 0.18 + rnd() * 0.72;
      bx.globalAlpha = a;
      bx.fillStyle = rnd() < 0.22 ? '#cfe4ff' : '#ffffff';
      bx.beginPath();
      bx.arc(x, y, rr, 0, Math.PI * 2);
      bx.fill();
    }
    bx.restore();

    // 注意：球体柔光 / 海面圆盘 / 边缘减光 / 受光高光都与 R 有关，
    // 逼近-拉远时 R 每帧都在变，所以那几层不能烘在这里，见 _drawBackdrop2D()。
    run.bg = base;
    run.bgW = view.w;
    run.bgH = view.h;
    run.bgDpr = view.dpr;
  }

  /**
   * 球体背后的柔光 + 海面圆盘 + 边缘减光 + 受光高光（第一代路径）。
   * 这几层全部按**当前** view.R 画，所以拉远/推近时每帧重画 —— 被烘进预渲染底图就会错位。
   */
  _drawBackdrop2D(ctx, run) {
    const view = run.view;
    const R = view.R;
    const cx = view.cx;
    const cy = view.cy;
    if (!(R > 0)) return;

    // 球体背后的柔光（只填该渐变实际覆盖的方框，别每帧刷满整屏）
    ctx.save();
    const haloR = R * 1.75;
    const halo = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, haloR);
    halo.addColorStop(0, 'rgba(58,124,214,0.42)');
    halo.addColorStop(0.55, 'rgba(40,92,176,0.16)');
    halo.addColorStop(1, 'rgba(10,25,60,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(cx - haloR, cy - haloR, haloR * 2, haloR * 2);

    // 海洋：球面圆盘（正交投影下轮廓永远是圆心固定的圆）
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const sea = ctx.createRadialGradient(
      cx - R * 0.3,
      cy - R * 0.34,
      R * 0.05,
      cx,
      cy,
      R * 1.35,
    );
    sea.addColorStop(0, '#4e9be6');
    sea.addColorStop(0.45, '#2b73c8');
    sea.addColorStop(0.8, '#174e94');
    sea.addColorStop(1, '#0b2d5e');
    ctx.fillStyle = sea;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // 边缘减光，让球看起来是球而不是贴纸
    const limb = ctx.createRadialGradient(cx, cy, R * 0.62, cx, cy, R);
    limb.addColorStop(0, 'rgba(4,14,34,0)');
    limb.addColorStop(0.82, 'rgba(4,14,34,0.10)');
    limb.addColorStop(1, 'rgba(3,10,26,0.52)');
    ctx.fillStyle = limb;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // 左上角的一点高光，卡通感的「受光面」
    const glow = ctx.createRadialGradient(
      cx - R * 0.42,
      cy - R * 0.46,
      0,
      cx - R * 0.42,
      cy - R * 0.46,
      R * 1.1,
    );
    glow.addColorStop(0, 'rgba(190,228,255,0.20)');
    glow.addColorStop(0.5, 'rgba(150,205,255,0.05)');
    glow.addColorStop(1, 'rgba(150,205,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();
  }

  // ── 内部：逐帧绘制 ─────────────────────────────────────────
  _draw(run, t) {
    const view = run.view;
    if (!view) return;

    const fade = run.fade > 0 ? run.fade : 1;
    const fadeIn = clamp(t / fade, 0, 1);
    const fadeOut = clamp((run.total - t) / fade, 0, 1);
    const alpha = Math.max(0, Math.min(fadeIn, fadeOut));

    const animP = clamp(t / (run.dur || 1), 0, 1);
    run.progress = animP;

    // 弹道进度 t 直接用 easePlateau 缓动后的进度（与 slerp 的 s 是同一个数）
    const s = run.reduced ? 1 : easePlateau(animP);
    // ★ 抛物线弹道：先由 t 定相机高度 → 球占比 → 屏幕半径 R。
    //   相机基与 up 完全不受影响（up 仍是下一行按当前 dir 重算出来的）
    this._applyArc(run, s);

    const dir = slerpDir(run.dirFrom, run.dirTo, s, run.dirNow);
    // ★ 每一帧都用「北」重新投影出 up —— 不插值 up 本身，所以画面永远不歪
    computeBasis(dir, this._basis);

    const holding = t > run.dur;
    const holdP = run.hold > 0 ? clamp((t - run.dur) / run.hold, 0, 1) : 1;
    run.pulse = holding ? 0.5 + 0.5 * Math.sin(holdP * Math.PI * 3) : 0;
    run.easeS = s;
    run.holding = holding;

    // 淡入淡出交给 CSS opacity：两层 canvas 一起淡，比每层各自 globalAlpha 更干净，
    // 也顺手修掉了旧实现里标签被叠乘三次 alpha 的问题。
    if (run.el) {
      const a = alpha >= 0.999 ? '1' : alpha <= 0.001 ? '0' : alpha.toFixed(3);
      if (run.el.style.opacity !== a) run.el.style.opacity = a;
    }

    if (this._renderer === 'webgl' && this._gl && this._gl.ok) {
      // 贴图还在路上时只画星空，标记/弧线也先不画（免得浮在空星空上）
      if (this._drawBaseGL(run) === 'globe') this._drawFx(run);
      return;
    }
    // WebGL 上下文丢了（手机后台切回、驱动重置）：当场换成矢量地球，别留一块死画布
    if (this._renderer === 'webgl') {
      this._fallbackToCanvas2D(run, (this._gl && this._gl.reason) || 'context-lost');
    }
    if (this._drawBase2D(run)) this._drawFx(run);
  }

  /** 第二代：WebGL。贴图没到位时只画星空（别让 Promise 挂住，也别留白）。 */
  _drawBaseGL(run) {
    const gl = this._gl;
    const view = run.view;
    const b = this._basis;
    // 光照方向：相机系左上偏前 → 世界系（相机系里 right=东、up=北、dir=朝相机）
    const lc = TUNE.lightCam;
    const light = [
      lc[0] * b.right[0] + lc[1] * b.up[0] + lc[2] * b.dir[0],
      lc[0] * b.right[1] + lc[1] * b.up[1] + lc[2] * b.dir[1],
      lc[0] * b.right[2] + lc[1] * b.up[2] + lc[2] * b.dir[2],
    ];
    const frame = {
      dir: b.dir,
      up: b.up,
      right: b.right,
      cx: view.cx,
      cy: view.cy,
      R: view.R,
      light,
      // 小屏（手机）上球很小，国家索引图用 NEAREST 会闪，蒙版相应收一点。
      // 用本次转场的「近景半径」定标：缩放过程中蒙版强度保持恒定，不会一呼一吸。
      country: TUNE.country * (run.countryRef || clamp(view.R / 420, 0.45, 1)),
    };
    try {
      return gl.draw(frame);
    } catch (err) {
      warn('WebGL 绘制失败，回退到矢量地球：', err && err.message ? err.message : err);
      this._fallbackToCanvas2D(run, 'draw-error');
      return false;
    }
  }

  /** 第一代：Canvas 2D 矢量地球（夜空 + 海洋 + 大陆 + 国界 + 经纬网）。 */
  _drawBase2D(run) {
    const ctx = run.baseCtx;
    const view = run.view;
    if (!ctx || !view) return false;
    if (!run.bg) this._prerender(run);
    if (!run.bg) return false;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(run.bg, 0, 0, view.w, view.h);
    this._drawBackdrop2D(ctx, run);
    this._drawGraticule(ctx, run);
    this._drawLand(ctx, run);
    this._drawBorders(ctx, run);
    return true;
  }

  /** 前景图层：大圆弧 + 起点/终点标记 + 中英标签（两条渲染路径共用）。 */
  _drawFx(run) {
    const ctx = run.fxCtx;
    const view = run.view;
    if (!ctx || !view) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.w, view.h);
    ctx.globalAlpha = 1;
    // 诊断：本帧实际画出来的标签矩形与标记位置（每帧重置，只反映当前帧）
    run.labelRects = [];
    run.markerDots = [];
    this._drawSilhouette(ctx, run);
    this._drawArc(ctx, run, run.easeS == null ? 1 : run.easeS);
    this._drawMarkers(ctx, run, run.progress, run.holding === true, 1);
  }

  _drawGraticule(ctx, run) {
    const view = run.view;
    const b = this._basis;
    const grat = graticuleVec();
    ctx.lineWidth = Math.max(0.6, view.R * 0.004);
    ctx.strokeStyle = COLORS.graticule;
    ctx.beginPath();
    for (const m of grat.meridians) strokeVecLine(ctx, m, b, view);
    for (const p of grat.parallels) strokeVecLine(ctx, p, b, view);
    ctx.stroke();
  }

  _drawLand(ctx, run) {
    const view = run.view;
    const b = this._basis;
    const geo = run.geo;
    if (!geo) return;
    const rings = geo.land;

    ctx.beginPath();
    let any = false;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      if (ringHidden(ring, b.dir)) continue;
      const n = clipRing(ring, b.dir);
      if (pathFromScratch(ctx, n, b, view)) any = true;
    }
    if (!any) return;
    ctx.fillStyle = COLORS.land;
    ctx.fill('nonzero');
    ctx.lineWidth = Math.max(0.7, view.R * 0.005);
    ctx.strokeStyle = COLORS.landEdge;
    ctx.stroke();
  }

  _drawBorders(ctx, run) {
    const view = run.view;
    const b = this._basis;
    const geo = run.geo;
    if (!geo) return;
    ctx.beginPath();
    for (const line of geo.borders) {
      if (ringHidden(line, b.dir)) continue;
      strokeVecLine(ctx, line, b, view);
    }
    ctx.lineWidth = Math.max(0.5, view.R * 0.0035);
    ctx.strokeStyle = COLORS.border;
    ctx.stroke();
  }

  _drawArc(ctx, run, s) {
    if (!run.arcVec) return;
    const view = run.view;
    const b = this._basis;

    // 路径只构建一次，用两种宽度描两遍（外发光 + 亮线）
    ctx.beginPath();
    strokeVecLine(ctx, run.arcVec, b, view);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.6, view.R * 0.016);
    ctx.strokeStyle = COLORS.arcGlow;
    ctx.stroke();
    ctx.lineWidth = Math.max(0.9, view.R * 0.007);
    ctx.strokeStyle = COLORS.arc;
    ctx.stroke();

    // 沿着弧线跑的小亮点，给 4~6 岁孩子一个「飞过去」的方向感
    if (run.reduced) return;
    const p = slerpDir(run.dirFrom, run.dirTo, s, [0, 0, 0]);
    const depth = p[0] * b.dir[0] + p[1] * b.dir[1] + p[2] * b.dir[2];
    if (depth < 0) return;
    const px = view.cx + (p[0] * b.right[0] + p[1] * b.right[1] + p[2] * b.right[2]) * view.R;
    const py = view.cy - (p[0] * b.up[0] + p[1] * b.up[1] + p[2] * b.up[2]) * view.R;
    const rr = Math.max(2, view.R * 0.018) * (0.9 + 0.25 * run.pulse);
    ctx.beginPath();
    ctx.arc(px, py, rr * 2.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,236,170,0.20)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, rr, 0, Math.PI * 2);
    ctx.fillStyle = '#fff3c4';
    ctx.fill();
  }

  _drawSilhouette(ctx, run) {
    const view = run.view;
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, view.R, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1, view.R * 0.006);
    ctx.strokeStyle = COLORS.silhouette;
    ctx.stroke();
  }

  _drawMarkers(ctx, run, animP, holding, alpha) {
    // 起点：动画前半段淡出
    const originA = clamp(1 - (animP - 0.04) / 0.46, 0, 1);
    // 终点：接近时淡入，到位后脉冲高亮
    const destA = clamp((animP - 0.25) / 0.5, 0, 1);

    if (originA > 0.01 && run.from) {
      this._drawMarker(ctx, run, run.from, COLORS.origin, originA * alpha, {
        which: 'from',
        label: true,
        labelAbove: true,
        pulse: 0,
        big: false,
      });
    }
    if (destA > 0.01 && run.to) {
      this._drawMarker(ctx, run, run.to, COLORS.dest, destA * alpha, {
        which: 'to',
        label: true,
        labelAbove: false,
        pulse: run.pulse,
        big: holding,
      });
    }
  }

  _drawMarker(ctx, run, city, color, alpha, opts) {
    const b = this._basis;
    const view = run.view;
    const lat = clamp(city.lat, this._cfg.minLat, this._cfg.maxLat);
    const v = sphereVec(lat, city.lon, [0, 0, 0]);
    const depth = v[0] * b.dir[0] + v[1] * b.dir[1] + v[2] * b.dir[2];
    if (depth < -0.02) return;
    // 球体边缘要平滑地藏起来，不要突然冒出来
    const a = alpha * clamp((depth + 0.02) / 0.16, 0, 1);
    if (a <= 0.01) return;

    const x = view.cx + (v[0] * b.right[0] + v[1] * b.right[1] + v[2] * b.right[2]) * view.R;
    const y = view.cy - (v[0] * b.up[0] + v[1] * b.up[1] + v[2] * b.up[2]) * view.R;
    const baseR = Math.max(4, view.R * (opts.big ? 0.036 : 0.03));

    ctx.save();
    ctx.globalAlpha = a;

    if (opts.pulse > 0) {
      const pr = baseR * (1.6 + opts.pulse * 2.4);
      ctx.beginPath();
      ctx.arc(x, y, pr, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.5, baseR * 0.45);
      ctx.strokeStyle = hexToRgba(color, 0.75 * (1 - opts.pulse));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, pr * 0.62, 0, Math.PI * 2);
      ctx.strokeStyle = hexToRgba(color, 0.45 * (1 - opts.pulse));
      ctx.stroke();
    }

    // 白色外圈 + 光晕 + 实心点 + 白芯：压在任何底色上都能看清
    ctx.beginPath();
    ctx.arc(x, y, baseR * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.26);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, baseR * 1.32, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, baseR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (opts.label) {
      const size = clamp(view.R * 0.095, 16, 36);
      const rect = drawCityLabel(ctx, view, x, y, baseR, city.zh, city.en, size, a, color, opts.labelAbove);
      // 诊断：把标签矩形记下来，供自测断言「球很大时标签有没有被挤出画面/叠成一团」
      if (rect && run.labelRects) run.labelRects.push(rect);
    }
    // 诊断：标记（针脚）实际画在哪里，供自测用像素核对「针脚是否指向城市」
    if (run.markerDots) {
      run.markerDots.push({ which: opts.which || '', x, y, r: baseR, color, alpha: a, depth });
    }
    ctx.restore();
  }
}

// ───────────────────────────────────────────────────────────── 标签
/** 圆角深色底 + 城市色描边，保证在任何底色上都读得清。 */
function drawCityLabel(ctx, view, x, markerY, markerR, zh, en, size, alpha, accent, preferAbove) {
  const enSize = Math.max(10, Math.round(size * 0.58));
  ctx.font = `700 ${size}px ${FONT_STACK}`;
  const wZh = zh ? ctx.measureText(zh).width : 0;
  ctx.font = `500 ${enSize}px ${FONT_STACK}`;
  const wEn = en ? ctx.measureText(en).width : 0;

  const padX = size * 0.6;
  const padY = size * 0.32;
  const w = Math.max(wZh, wEn, size * 1.4) + padX * 2;
  const h = (zh ? size * 1.16 : 0) + (en ? enSize * 1.3 : 0) + padY * 2;

  const gap = markerR + Math.max(7, size * 0.42);
  // 起点标签默认在上、终点默认在下，两座城市挨得近时就不会叠在一起
  let top = preferAbove !== false ? markerY - gap - h : markerY + gap;
  if (top < 6) top = markerY + gap;
  else if (top + h > view.h - 6) top = markerY - gap - h;
  top = clamp(top, 6, Math.max(6, view.h - h - 6));

  const left = clamp(x - w / 2, 8, Math.max(8, view.w - w - 8));

  ctx.save();
  ctx.globalAlpha = alpha;

  roundRectPath(ctx, left, top, w, h, Math.min(15, h * 0.36));
  ctx.fillStyle = 'rgba(8,18,40,0.82)';
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.strokeStyle = hexToRgba(accent, 0.9);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let cursor = top + padY;
  if (zh) {
    ctx.font = `700 ${size}px ${FONT_STACK}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(zh, left + w / 2, cursor + size * 0.58);
    cursor += size * 1.16;
  }
  if (en) {
    ctx.font = `500 ${enSize}px ${FONT_STACK}`;
    ctx.fillStyle = 'rgba(214,232,255,0.94)';
    ctx.fillText(en, left + w / 2, cursor + enSize * 0.65);
  }
  ctx.restore();
  // 返回实际画出来的矩形（已经过边界钳制），供自测断言用
  return { left, top, w, h, zh, en, size };
}

function hexToRgba(hex, a) {
  if (typeof hex !== 'string') return `rgba(255,255,255,${a})`;
  if (hex.startsWith('rgb')) return hex;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const num = parseInt(full, 16);
  if (!Number.isFinite(num)) return `rgba(255,255,255,${a})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r},${g},${b},${a})`;
}

// ───────────────────────────────────────────────────────────── 杂项
function normalizeData(d) {
  if (!d || typeof d !== 'object') return null;
  const land = Array.isArray(d.LAND) ? d.LAND : Array.isArray(d.land) ? d.land : null;
  const borders = Array.isArray(d.BORDERS) ? d.BORDERS : Array.isArray(d.borders) ? d.borders : null;
  if (!land && !borders) return null;
  return { LAND: land || [], BORDERS: borders || [] };
}

function prefersReducedMotion(win) {
  try {
    return !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

function now(win) {
  if (win && win.performance && typeof win.performance.now === 'function') return win.performance.now();
  return Date.now();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r;
  let g;
  let b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function injectStyle(doc) {
  if (!doc || !doc.head) return;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${OVERLAY_CLASS}{position:fixed;inset:0;z-index:80;pointer-events:none;overflow:hidden;background:transparent;}
.${OVERLAY_CLASS} canvas{position:absolute;left:0;top:0;display:block;width:100%;height:100%;}
.${OVERLAY_CLASS}-base{z-index:0;}
.${OVERLAY_CLASS}-gl{z-index:1;}
.${OVERLAY_CLASS}-fx{z-index:2;}
`;
  doc.head.appendChild(style);
}

function warn(...args) {
  try {
    if (typeof console !== 'undefined' && console.warn) console.warn('[globe]', ...args);
  } catch { /* 忽略 */ }
}

export default Globe;
