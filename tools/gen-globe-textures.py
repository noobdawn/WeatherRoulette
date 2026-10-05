#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 WebGL 地球用的贴图素材（真实地貌 + 国家蒙版 + 国界）。

要解决的观感问题：
    早期版本是从 Natural Earth 的海岸线数据画出来的"矢量卡通地球"——大陆形状对，
    但没有任何地表质感，看起来像地图而不是地貌。老板要求「接近谷歌地球那种地貌感」。

素材来源（都是公有领域，可自由分发）：
    底图影像：NASA Blue Marble（land_shallow_topo / world.topo.bathy）
              https://eoimages.gsfc.nasa.gov/
    国界：    Natural Earth 110m（经 world-atlas 的 TopoJSON 分发）

产出（assets/globe/）：
    albedo.jpg     等距圆柱投影的真实卫星影像，**已把国界烘进去**
    normal.jpg     从影像起伏导出的法线贴图（供着色器做实时山体光影）
    countries.png  8bit 索引图，灰度 = 国家编号（0 = 海洋），供国家淡色蒙版
    countries.json { count, names } 编号 → 国名，供调试与调色板

用法：
    python tools/gen-globe-textures.py                  # 默认质量
    python tools/gen-globe-textures.py --albedo-width 3072   # 更省流量
    python tools/gen-globe-textures.py --check          # 只检查现有产物
"""
from __future__ import annotations

import argparse
import colorsys
import io
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "assets" / "globe"
CACHE = ROOT / ".cache" / "globe"
NE_CACHE = ROOT / ".cache" / "naturalearth"

UA = "WeatherRouletteBot/0.1 (+https://github.com/noobdawn/WeatherRoulette)"

BASE_TILES = {
    "land_2048": "https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg",
    "topo_5400": "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg",
}
COUNTRIES_TOPO = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"

# 海洋/极地的处理
OCEAN_DESATURATE = 0.55   # 海洋降饱和，避免深蓝抢眼
DARKEN_POLES = 0.10       # 极地稍微压暗（等距圆柱在高纬会被拉伸，视觉上过亮）

# 国界
BORDER_RGBA = (28, 38, 56, 150)
BORDER_WIDTH = 1


def fetch(url: str, cache_name: str, timeout: float = 180.0) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / cache_name
    if path.exists() and path.stat().st_size > 1000:
        print(f"  用缓存 {path.name}（{path.stat().st_size / 1024:.0f} KB）")
        return path.read_bytes()
    print(f"  下载 {url}")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
    path.write_bytes(raw)
    print(f"  已缓存 {path.name}（{len(raw) / 1024:.0f} KB）")
    return raw


# --------------------------------------------------------------------- 底图
def build_albedo(width: int) -> Image.Image:
    """拿真实卫星影像做底图，并做一点配色调整（海洋降饱和、极地压暗）。"""
    raw = fetch(BASE_TILES["topo_5400"], "topo_5400.jpg")
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    print(f"  底图原始尺寸 {img.size}")
    height = width // 2
    img = img.resize((width, height), Image.LANCZOS)

    arr = np.asarray(img).astype(np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    mx = np.max(arr, axis=2)
    mn = np.min(arr, axis=2)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)

    # 海洋 = 偏蓝且较暗的区域。按蓝>红判定，避免把湖泊/深色陆地误判
    is_ocean = (b > r * 1.06) & (b > g * 1.02) & (mx > 0.05)

    # 海洋降饱和
    lum = (0.299 * r + 0.587 * g + 0.114 * b)[..., None]
    arr = np.where(is_ocean[..., None], arr * (1 - OCEAN_DESATURATE) + lum * OCEAN_DESATURATE, arr)

    # 稍微提一点陆地对比，让山脊更明显（孩子看的是形状与质感）
    land_mask = ~is_ocean
    arr = np.where(land_mask[..., None], np.clip((arr - 0.5) * 1.06 + 0.5, 0, 1), arr)

    # 极地压暗：等距圆柱投影在高纬被拉得很宽，容易显得发白
    ys = np.linspace(0, 1, height)[:, None]
    polar = np.abs(ys - 0.5) * 2  # 0 赤道 → 1 极点
    factor = 1 - DARKEN_POLES * np.clip((polar - 0.75) / 0.25, 0, 1)
    arr = arr * factor[..., None]

    out = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    print(f"  底图缩放为 {out.size}，海洋已降饱和（sat 判定 {is_ocean.mean() * 100:.1f}% 像素）")
    return out


# ------------------------------------------------------------------- 国界
def load_country_geometries():
    """从 world-atlas 的 TopoJSON 还原各国多边形（用 shapely 做可靠的多边形运算）。"""
    from shapely.geometry import shape
    from shapely.ops import unary_union

    CACHE.mkdir(parents=True, exist_ok=True)
    path = NE_CACHE / "countries-110m.json"
    if not (path.exists() and path.stat().st_size > 1000):
        path.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(COUNTRIES_TOPO, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=90) as resp:
            path.write_bytes(resp.read())
    topo = json.loads(path.read_text(encoding="utf-8"))
    tf = topo.get("transform")
    arcs_raw = topo["arcs"]

    def decode_arc(arc):
        if not tf:
            return [(float(x), float(y)) for x, y in arc]
        sx, sy = tf["scale"]
        tx, ty = tf["translate"]
        x = y = 0.0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        return pts

    arcs = [decode_arc(a) for a in arcs_raw]

    def ring_coords(ring):
        pts: list[tuple[float, float]] = []
        for idx in ring:
            seg = arcs[idx] if idx >= 0 else list(reversed(arcs[~idx]))
            pts.extend(seg[1:] if pts else seg)
        return pts

    def geom_to_shapely(geom) -> object:
        from shapely.geometry import Polygon
        from shapely.validation import make_valid

        polys = []
        if geom["type"] == "Polygon":
            polys = [geom["arcs"]]
        elif geom["type"] == "MultiPolygon":
            polys = geom["arcs"]
        out = []
        for rings in polys:
            if not rings:
                continue
            shell = ring_coords(rings[0])
            if len(shell) < 4:
                continue
            holes = []
            for r in rings[1:]:
                hc = ring_coords(r)
                if len(hc) >= 4:
                    holes.append(hc)
            try:
                poly = Polygon(shell, holes)
            except Exception:  # noqa: BLE001
                continue
            # Natural Earth 110m 里有自交多边形（GEOS 会抛 TopologyException），
            # 统一走 make_valid 修复；失败再退回 buffer(0)。
            if not poly.is_valid:
                try:
                    poly = make_valid(poly)
                except Exception:  # noqa: BLE001
                    try:
                        poly = poly.buffer(0)
                    except Exception:  # noqa: BLE001
                        continue
            if poly is None or poly.is_empty:
                continue
            # make_valid 可能返回 GeometryCollection，只取其中的面
            if poly.geom_type == "GeometryCollection":
                faces = [g for g in poly.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
                if not faces:
                    continue
                poly = unary_union(faces)
            if poly.geom_type not in ("Polygon", "MultiPolygon") or poly.is_empty:
                continue
            out.append(poly)
        if not out:
            return None
        try:
            return unary_union(out) if len(out) > 1 else out[0]
        except Exception:  # noqa: BLE001
            # 合并失败就保留多面体（下游只用到 boundary 与逐面填充，多面体同样可用）
            from shapely.geometry import MultiPolygon
            return MultiPolygon(out) if len(out) > 1 else out[0]

    obj = topo["objects"]["countries"]
    geoms = obj["geometries"] if obj["type"] == "GeometryCollection" else [obj]
    result = []
    for g in geoms:
        s = geom_to_shapely(g)
        if s is not None and not s.is_empty:
            result.append((str(g.get("id") or g.get("properties", {}).get("name") or ""),
                           g.get("properties", {}).get("name", ""), s))
    print(f"  还原出 {len(result)} 个国家/地区几何")
    return result


def draw_borders(albedo: Image.Image, geoms) -> None:
    """把国界画到贴图上（经纬度 → 等距圆柱像素）。"""
    w, h = albedo.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def to_px(lon, lat):
        return ((lon + 180.0) / 360.0 * w, (90.0 - lat) / 180.0 * h)

    count = 0
    for _code, _name, geom in geoms:
        boundary = geom.boundary
        lines = []
        if boundary.geom_type == "LineString":
            lines = [boundary]
        elif boundary.geom_type == "MultiLineString":
            lines = list(boundary.geoms)
        elif boundary.geom_type == "GeometryCollection":
            lines = [g for g in boundary.geoms if g.geom_type in ("LineString", "MultiLineString")]
        for line in lines:
            if line.geom_type == "MultiLineString":
                for sub in line.geoms:
                    pts = [to_px(x, y) for x, y in sub.coords]
                    if len(pts) > 1:
                        draw.line(pts, fill=BORDER_RGBA, width=BORDER_WIDTH)
                        count += 1
            else:
                pts = [to_px(x, y) for x, y in line.coords]
                if len(pts) > 1:
                    draw.line(pts, fill=BORDER_RGBA, width=BORDER_WIDTH)
                    count += 1
    print(f"  国界绘制了 {count} 段")
    # 贴图统一按 RGB 处理：先转 RGBA 合成，再转回 RGB
    base = albedo.convert("RGBA")
    base.alpha_composite(overlay)
    albedo.paste(base.convert("RGB"), (0, 0))


CHINA_INDEX = 1          # 中国固定用这个编号 → 调色板里对应纯红
CHINA_NAME = "China"

# 其他国家的低饱和色生成
TINT_COUNT = 64
TINT_SAT = 0.30
TINT_VAL = 0.86


def _hsv(h: float, s: float, v: float) -> tuple[int, int, int]:
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return int(r * 255), int(g * 255), int(b * 255)


def assign_country_indices(geoms) -> dict[int, int]:
    """给每个国家分配 1..255 的编号。

    两条要求：
      1) **中国必须是红色** —— 固定给 CHINA_INDEX，调色板把它映射成纯红，
         这样孩子在地球上一眼就能找到自己的国家。
      2) **相邻国家不能同色** —— 否则两块同色版图贴在一起，看起来像一个国家。

    做法：先用 shapely 的 STRtree 判出「共享 >0.2° 边界」的邻接关系，
    然后带种子的贪心着色：中国先占 1，其余按面积从大到小取「邻国已用色之外」的编号。
    一旦邻接冲突解决不了（颜色不够），退而求其次只保证「不与邻国编号相同」，
    并把冲突记进 summary —— 实测在本数据集上不需要退让。
    """
    from shapely.strtree import STRtree

    items = []
    for code, name, geom in geoms:
        items.append((name or code or "", geom))
    items.sort(key=lambda t: -t[1].area)   # 面积大的先占色，避免大国被挤到糟糕的编号

    tree = STRtree([g for _, g in items])
    neighbors: dict[int, set[int]] = {i: set() for i in range(len(items))}
    for i, (_, geom) in enumerate(items):
        for j in tree.query(geom):
            j = int(j)
            if j <= i:
                continue
            other = items[j][1]
            if not geom.intersects(other):
                continue
            # 共享边界足够长才算邻国（只碰到一个点不算）
            try:
                shared = geom.boundary.intersection(other.boundary)
            except Exception:  # noqa: BLE001
                continue
            if shared.is_empty or shared.length < 0.2:
                continue
            neighbors[i].add(j)
            neighbors[j].add(i)

    used: dict[int, set[int]] = {}       # 编号 → 用了它的国家下标
    assignment: dict[int, int] = {}      # 国家下标 → 编号
    conflicts = 0

    def pick(i: int, want: int | None = None) -> int:
        """挑一个不与邻国重复的编号；优先挑用的人最少的，让色相尽量分散。"""
        banned = {assignment[n] for n in neighbors[i] if n in assignment}
        if want is not None and want not in banned:
            return want
        best = None
        best_load = 10 ** 9
        for cand in range(1, 256):
            if cand in banned:
                continue
            load = len(used.get(cand, ()))
            if load < best_load:
                best, best_load = cand, load
                if load == 0:
                    break
        if best is None:
            # 极端情况：邻国把 255 个编号占满了，只能容忍一次重色
            for cand in range(1, 256):
                if cand not in {assignment[n] for n in neighbors[i]}:
                    return cand
            return CHINA_INDEX
        return best

    # 中国先占红
    china_at = None
    for i, (name, _) in enumerate(items):
        if name == CHINA_NAME:
            china_at = i
            break
    if china_at is not None:
        assignment[china_at] = CHINA_INDEX
        used.setdefault(CHINA_INDEX, set()).add(china_at)

    for i, (name, _) in enumerate(items):
        if i in assignment:
            continue
        idx = pick(i)
        assignment[i] = idx
        used.setdefault(idx, set()).add(i)

    # 复核：统计有多少条邻接边出现同色
    for i, nbrs in neighbors.items():
        for j in nbrs:
            if j > i and assignment.get(i) == assignment.get(j):
                conflicts += 1
    print(f"  编号分配完成：{len(items)} 个国家，邻接同色冲突 {conflicts} 条"
          + (f"，中国 = #{assignment[china_at]}" if china_at is not None else "，⚠ 没找到 China"))

    return {i: assignment[i] for i in range(len(items))}, items, conflicts


def make_country_id_map(geoms, size: tuple[int, int]) -> tuple[Image.Image, dict]:
    """栅格化国家编号图。

    ⚠ 曾经写错过一次：当时按「每国画一张图层再 paste(layer, mask=layer)」叠加。
    那样后画国家的 0 值像素不会覆盖先画的，导致版图互相串色，看起来一团碎斑。
    正确做法是**直接在编号图上以编号为填充值绘制**，并且先画大到小、小国覆盖大国。
    """
    w, h = size
    id_map = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(id_map)
    names: dict[str, str] = {}

    def to_px(x, y):
        return ((x + 180.0) / 360.0 * w, (90.0 - y) / 180.0 * h)

    indices, items, conflicts = assign_country_indices(geoms)
    for i, (name, _geom) in enumerate(items):
        names[str(indices[i])] = name
    # 绘制顺序：面积从大到小，让小块国家后画、覆盖大国，避免飞地被吞
    for i in sorted(range(len(items)), key=lambda k: -items[k][1].area):
        idx = indices[i]
        geom = items[i][1]
        polys = [geom] if geom.geom_type == "Polygon" else (
            list(geom.geoms) if geom.geom_type == "MultiPolygon" else [])
        for poly in polys:
            if poly.is_empty or poly.area < 0.02:
                continue
            outer = [to_px(x, y) for x, y in poly.exterior.coords]
            if len(outer) < 3:
                continue
            draw.polygon(outer, fill=idx)
            for hole in poly.interiors:
                hc = [to_px(x, y) for x, y in hole.coords]
                if len(hc) >= 3:
                    draw.polygon(hc, fill=0)

    return id_map, {
        "count": len(items),
        "names": names,
        "chinaIndex": CHINA_INDEX,
        "neighborColorConflicts": conflicts,
    }


def build_normal(albedo: Image.Image, width: int, strength: float = 2.6) -> Image.Image:
    """从影像起伏导出法线贴图。

    做法：把影像当作高度代理（对卫星影像来说，山脊的明暗本身就与高程强相关），
    先重模糊得到"平滑高度场"，再对其求梯度得到坡度，最后编码成切线空间法线。
    这样着色器里就能做**随地球转动而变化的实时光影**，而不是烘死的明暗。
    """
    height = width // 2
    src = albedo.convert("L").resize((width, height), Image.LANCZOS)
    luma = np.asarray(src).astype(np.float32) / 255.0

    # 平滑高度场（sigma 越大越只保留大山脊，滤掉纹理噪声）
    smooth = np.asarray(
        src.filter(ImageFilter.GaussianBlur(radius=max(1.5, width / 900)))
    ).astype(np.float32) / 255.0

    # 海洋区域压平：蓝色多的像素不参与起伏，避免海面出现假山
    arr = np.asarray(albedo.resize((width, height), Image.LANCZOS)).astype(np.float32) / 255.0
    is_ocean = (arr[..., 2] > arr[..., 0] * 1.06) & (arr[..., 2] > arr[..., 1] * 1.02)

    # 梯度（像素 → 归一化坐标），纬度方向要按 cos(lat) 修正，否则高纬坡度被夸大
    lats = np.linspace(90, -90, height)[:, None]
    coslat = np.clip(np.cos(np.radians(lats)), 0.15, 1.0)
    gy, gx = np.gradient(smooth)
    gx = gx / coslat * strength
    gy = gy * strength
    # 海洋不起伏
    gx = np.where(is_ocean, 0, gx)
    gy = np.where(is_ocean, 0, gy)

    # 法线 = normalize(-gx, -gy, 1)，编码到 0..255
    nz = np.ones_like(gx)
    norm = np.sqrt(gx * gx + gy * gy + nz * nz)
    nx = (-gx) / norm
    ny = (-gy) / norm
    nzz = nz / norm

    out = np.zeros((height, width, 3), dtype=np.uint8)
    out[..., 0] = np.clip((nx * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    out[..., 1] = np.clip((ny * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    out[..., 2] = np.clip((nzz * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(out)


def make_palette(n: int = 256) -> Image.Image:
    """国家淡色调色板（256×1），供着色器把编号映射成低饱和颜色。

    ★ CHINA_INDEX 固定为**纯红** —— 老板要求「保证中国是红色」，
    这样孩子在地球上一眼就能找到自己的国家。
    其余编号用黄金角散开色相（低饱和），并避开红色相区间（±0.05），
    免得别的国家看起来也像中国。
    """
    img = Image.new("RGB", (n, 1))
    px = img.load()
    for i in range(n):
        if i == 0:
            px[i, 0] = (0, 0, 0)          # 0 = 海洋
            continue
        if i == CHINA_INDEX:
            # 明显但不过分刺眼的红（低饱和版），配合低强度混合后是"淡红"
            px[i, 0] = _hsv(0.0, 0.62, 0.92)
            continue
        hue = (i * 0.618033988749895) % 1.0
        # 避开红色相（0 与 1 附近），否则别的国家也会发红
        if hue < 0.05 or hue > 0.95:
            hue = (hue + 0.5) % 1.0
        px[i, 0] = _hsv(hue, TINT_SAT, TINT_VAL)
    return img


def check() -> int:
    if not OUT_DIR.exists():
        print(f"✗ 目录不存在：{OUT_DIR}")
        return 1
    expect = ["albedo.jpg", "normal.jpg", "countries.png", "countries.json", "palette.png"]
    total = 0
    for name in expect:
        p = OUT_DIR / name
        if not p.exists():
            print(f"  ✗ 缺失 {name}")
            return 1
        size = p.stat().st_size
        total += size
        print(f"  ✓ {name:<18} {size / 1024:>8.0f} KB")
    print(f"  合计 {total / 1024:.0f} KB")

    # 校验两条硬要求：中国必须是红色、邻国不重色
    meta = json.loads((OUT_DIR / "countries.json").read_text(encoding="utf-8"))
    china_idx = str(meta.get("chinaIndex", CHINA_INDEX))
    china_name = meta.get("names", {}).get(china_idx, "")
    pal = Image.open(OUT_DIR / "palette.png").convert("RGB")
    r, g, b = pal.getpixel((int(china_idx), 0))
    is_red = r > 150 and r > g * 1.6 and r > b * 1.6
    ok = True
    if china_name != CHINA_NAME:
        print(f"  ✗ #{china_idx} 对应的不是 China，而是「{china_name}」")
        ok = False
    else:
        print(f"  ✓ 中国 = 编号 {china_idx}，调色板 RGB({r},{g},{b})"
              + ("（红色 ✓）" if is_red else "（不是红色 ✗）"))
    if not is_red:
        ok = False
    conflicts = meta.get("neighborColorConflicts", 0)
    print(f"  {'✓' if conflicts == 0 else '✗'} 邻国同色冲突 {conflicts} 条"
          + ("" if conflicts == 0 else "（相邻国家撞色会看起来像一个国家）"))
    if conflicts:
        ok = False
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--albedo-width", type=int, default=4096, help="albedo 宽度（高度为一半）")
    ap.add_argument("--normal-width", type=int, default=2048, help="法线贴图宽度")
    ap.add_argument("--id-width", type=int, default=2048, help="国家编号图宽度")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--bump", type=float, default=2.6, help="法线强度")
    args = ap.parse_args()

    if args.check:
        return check()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("[1/5] 底图（NASA Blue Marble 真实卫星影像）")
    albedo = build_albedo(args.albedo_width)

    print("[2/5] 国界")
    geoms = load_country_geometries()
    draw_borders(albedo, geoms)

    print("[3/5] 国家编号图（供淡色蒙版）")
    id_map, meta = make_country_id_map(geoms, (args.id_width, args.id_width // 2))

    print("[4/5] 法线贴图（实时山体光影用）")
    normal = build_normal(albedo, args.normal_width, strength=args.bump)

    print("[5/5] 写文件")
    albedo.save(OUT_DIR / "albedo.jpg", quality=86, optimize=True, progressive=True)
    normal.save(OUT_DIR / "normal.jpg", quality=92, optimize=True, progressive=True)
    # 编号图必须无损（JPEG 会把编号糊掉，导致国界出错）
    id_map.save(OUT_DIR / "countries.png", optimize=True)
    make_palette().save(OUT_DIR / "palette.png", optimize=True)
    (OUT_DIR / "countries.json").write_text(
        json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    return check()


if __name__ == "__main__":
    sys.exit(main())
