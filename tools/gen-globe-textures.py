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

# 国家蒙版：低饱和度色循环
TINT_COUNT = 64
TINT_SAT = 0.30
TINT_VAL = 0.86


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


def make_country_id_map(geoms, size: tuple[int, int]) -> tuple[Image.Image, dict]:
    """栅格化国家编号图。

    ⚠ 曾经写错过一次：当时按「每国画一张图层再 paste(layer, mask=layer)」叠加。
    那样后画国家的 0 值像素不会覆盖先画的，导致版图互相串色，看起来一团碎斑。
    正确做法是**直接在编号图上以编号为填充值绘制**，并且先画大到小、小国覆盖大国。

    另外编号不能按面积顺序递增——那样序号越大越亮，看起来像噪点。
    这里按国名排序取稳定编号，亮度变化就与地理无关了。
    """
    w, h = size
    id_map = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(id_map)
    names: dict[str, str] = {}

    def to_px(x, y):
        return ((x + 180.0) / 360.0 * w, (90.0 - y) / 180.0 * h)

    # 稳定编号：按国名排序，编号与面积无关
    ordered = sorted(geoms, key=lambda t: (t[1] or t[0] or ""))
    indexed = []
    for i, (code, name, geom) in enumerate(ordered, start=1):
        idx = ((i - 1) % 255) + 1
        names[str(idx)] = name or code
        indexed.append((idx, geom))

    # 绘制顺序：面积从大到小，让小块国家后画、覆盖大国，避免飞地被吞
    for idx, geom in sorted(indexed, key=lambda t: -t[1].area):
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

    return id_map, {"count": len(ordered), "names": names}


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
    """低饱和度国家调色板（256×1），供着色器把编号映射成淡色。"""
    img = Image.new("RGB", (n, 1))
    px = img.load()
    for i in range(n):
        if i == 0:
            px[i, 0] = (0, 0, 0)
            continue
        # 黄金角散开色相，避免相邻编号颜色太近
        hue = (i * 0.618033988749895) % 1.0
        r, g, b = colorsys.hsv_to_rgb(hue, TINT_SAT, TINT_VAL)
        px[i, 0] = (int(r * 255), int(g * 255), int(b * 255))
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
    return 0


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
