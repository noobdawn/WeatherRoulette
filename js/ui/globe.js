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
// 依赖：js/core/constants.js 的 GLOBE（可能还没加上，所以有完整兜底）、
//       js/ui/globe-data.js 的 LAND / BORDERS（动态 import，避免拖慢首屏）。

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
};

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
  };
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

// ───────────────────────────────────────────────────────────── 几何缓存
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
function graticuleVec() {
  if (_gratCache) return _gratCache;
  const meridians = [];
  const parallels = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 5) pts.push([lon, lat]);
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

/** 整颗球当前是否完全落在可见半球之外（可以整块跳过）。 */
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
  ctx.arcTo(x, y, x + rr, y, rr);
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

// 配色：扁平卡通，面向 4~6 岁，保证大陆轮廓一眼可辨
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

// ───────────────────────────────────────────────────────────── 主体
export class Globe {
  /**
   * @param {Document|Element} root 覆盖层挂载位置（默认 document）
   * @param {{data?: {LAND?: any[], BORDERS?: any[]}}} [opts]
   */
  constructor(root = typeof document !== 'undefined' ? document : null, { data } = {}) {
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
    this._view = { w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0 };
    this._supported = null;
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

  /** 当前画布视口（CSS 像素）：球心 (cx,cy) 与球面半径 R。 */
  get viewport() {
    const v = this._view;
    return { w: v.w, h: v.h, dpr: v.dpr, cx: v.cx, cy: v.cy, R: v.R };
  }

  /** 覆盖层当前是否挂在 DOM 上（自动化测试用）。 */
  get attached() {
    const run = this._run;
    return !!(run && run.el && run.el.parentNode);
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
      onResize: null,
      startTime: 0,
      dur: this._cfg.duration,
      hold: this._cfg.holdMs,
      fade: this._cfg.fadeMs,
      total: this._cfg.duration + this._cfg.holdMs,
      view: null,
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
    const canvas = doc.createElement('canvas');
    canvas.className = `${OVERLAY_CLASS}-canvas`;
    el.appendChild(canvas);
    host.appendChild(el);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      try { host.removeChild(el); } catch { /* 忽略 */ }
      throw new Error('canvas 2d 不可用');
    }

    run.el = el;
    run.canvas = canvas;
    run.ctx = ctx;

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
    run.startTime = typeof win.performance?.now === 'function' ? win.performance.now() : Date.now();

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
    run.raf = raf((now) => this._tick(run, now));
  }

  _tick(run, now) {
    run.raf = 0;
    if (run.done || this._run !== run) return;
    const t = Math.max(0, Number(now) - run.startTime);
    run.frames++;
    if (run.frames === 1) run.zero = Number(now);
    const span = Number(now) - run.zero;
    run.fps = span > 250 ? Math.round((run.frames * 1000) / span) : 0;
    try {
      this._draw(run, t);
    } catch (err) {
      warn('地球过场绘制失败：', err);
      this._finishRun(run);
      return;
    }
    if (t >= run.total) {
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
    run.el = null;
    run.canvas = null;
    run.ctx = null;
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

  // ── 内部：布局与预渲染 ─────────────────────────────────────
  _layout(run) {
    const win = this._win();
    const doc = this._doc;
    const canvas = run.canvas;
    if (!win || !doc || !canvas) return;

    const de = doc.documentElement || {};
    const w = Math.max(1, Math.round(win.innerWidth || de.clientWidth || 1280));
    const h = Math.max(1, Math.round(win.innerHeight || de.clientHeight || 720));
    const dpr = clamp(Number(win.devicePixelRatio) || 1, 1, 2);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const view = { w, h, dpr, cx: w / 2, cy: h / 2, R: Math.min(w * 0.44, h * 0.34) };
    run.view = view;
    this._view = view;

    this._prerender(run);
  }

  _prerender(run) {
    const doc = this._doc;
    const view = run.view;
    const pw = Math.max(1, Math.round(view.w * view.dpr));
    const ph = Math.max(1, Math.round(view.h * view.dpr));
    const cx = view.cx;
    const cy = view.cy;
    const R = view.R;

    const mk = () => {
      const c = doc.createElement('canvas');
      c.width = pw;
      c.height = ph;
      return c;
    };

    // ── 底色（夜空 + 星星 + 海洋 + 边缘明暗），每帧一次 drawImage ──
    const base = mk();
    const bx = base.getContext('2d');
    bx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    const sky = bx.createLinearGradient(0, 0, 0, view.h);
    sky.addColorStop(0, '#050b1e');
    sky.addColorStop(0.55, '#0a1734');
    sky.addColorStop(1, '#050c1c');
    bx.fillStyle = sky;
    bx.fillRect(0, 0, view.w, view.h);

    // 球体背后的柔光
    const halo = bx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.75);
    halo.addColorStop(0, 'rgba(58,124,214,0.42)');
    halo.addColorStop(0.55, 'rgba(40,92,176,0.16)');
    halo.addColorStop(1, 'rgba(10,25,60,0)');
    bx.fillStyle = halo;
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

    // 海洋：球面圆盘（正交投影下轮廓永远是圆心固定的圆）
    bx.save();
    bx.beginPath();
    bx.arc(cx, cy, R, 0, Math.PI * 2);
    bx.clip();
    const sea = bx.createRadialGradient(
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
    bx.fillStyle = sea;
    bx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // 边缘减光，让球看起来是球而不是贴纸
    const limb = bx.createRadialGradient(cx, cy, R * 0.62, cx, cy, R);
    limb.addColorStop(0, 'rgba(4,14,34,0)');
    limb.addColorStop(0.82, 'rgba(4,14,34,0.10)');
    limb.addColorStop(1, 'rgba(3,10,26,0.52)');
    bx.fillStyle = limb;
    bx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // 左上角的一点高光，卡通感的「受光面」
    const glow = bx.createRadialGradient(
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
    bx.fillStyle = glow;
    bx.fillRect(cx - R, cy - R, R * 2, R * 2);
    bx.restore();

    run.bg = base;

    // 覆盖层宽高（第一帧之前就要正确，否则会闪一下左上角）
    if (run.canvas) {
      run.canvas.style.width = `${view.w}px`;
      run.canvas.style.height = `${view.h}px`;
    }
  }

  // ── 内部：逐帧绘制 ─────────────────────────────────────────
  _draw(run, t) {
    const ctx = run.ctx;
    const view = run.view;
    if (!ctx || !view) return;

    const fade = run.fade > 0 ? run.fade : 1;
    const fadeIn = clamp(t / fade, 0, 1);
    const fadeOut = clamp((run.total - t) / fade, 0, 1);
    const alpha = Math.max(0, Math.min(fadeIn, fadeOut));

    const animP = clamp(t / (run.dur || 1), 0, 1);
    run.progress = animP;

    const s = run.reduced ? 1 : easePlateau(animP);
    const dir = slerpDir(run.dirFrom, run.dirTo, s, run.dirNow);
    // ★ 每一帧都用「北」重新投影出 up —— 不插值 up 本身，所以画面永远不歪
    computeBasis(dir, this._basis);

    const holding = t > run.dur;
    const holdP = run.hold > 0 ? clamp((t - run.dur) / run.hold, 0, 1) : 1;
    run.pulse = holding ? 0.5 + 0.5 * Math.sin(holdP * Math.PI * 3) : 0;

    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    // 半透明帧要先擦干净，否则会和上一帧叠影
    if (alpha < 0.999) ctx.clearRect(0, 0, view.w, view.h);
    ctx.globalAlpha = alpha;

    ctx.drawImage(run.bg, 0, 0, view.w, view.h);

    this._drawGraticule(ctx, run);
    this._drawLand(ctx, run);
    this._drawBorders(ctx, run);
    this._drawArc(ctx, run, s);
    this._drawSilhouette(ctx, run);
    this._drawMarkers(ctx, run, animP, holding, alpha);

    ctx.globalAlpha = 1;
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
    const b = this._basis;
    const view = run.view;

    // 起点：动画前半段淡出
    const originA = clamp(1 - (animP - 0.04) / 0.46, 0, 1);
    // 终点：接近时淡入，到位后脉冲高亮
    const destA = clamp((animP - 0.25) / 0.5, 0, 1);

    if (originA > 0.01 && run.from) {
      this._drawMarker(ctx, run, run.from, COLORS.origin, originA * alpha, {
        label: true,
        labelAbove: true,
        pulse: 0,
        big: false,
      });
    }
    if (destA > 0.01 && run.to) {
      this._drawMarker(ctx, run, run.to, COLORS.dest, destA * alpha, {
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
      drawCityLabel(ctx, view, x, y, baseR, city.zh, city.en, size, a, color, opts.labelAbove);
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

function injectStyle(doc) {
  if (!doc || !doc.head) return;
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${OVERLAY_CLASS}{position:fixed;inset:0;z-index:80;pointer-events:none;overflow:hidden;background:transparent;}
.${OVERLAY_CLASS}-canvas{display:block;width:100%;height:100%;}
`;
  doc.head.appendChild(style);
}

function warn(...args) {
  try {
    if (typeof console !== 'undefined' && console.warn) console.warn('[globe]', ...args);
  } catch { /* 忽略 */ }
}

export default Globe;
