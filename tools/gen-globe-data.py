#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 3D 地球用的低精度海岸线/国界数据。

为什么不用现成的 geojson：
    项目是纯静态站点，不能引入运行时依赖，也不该放几百 KB 的地图数据。
    这里从 Natural Earth 110m（TopoJSON，world-atlas 包）拉一次原始数据，
    解码 + Douglas-Peucker 简化 + 坐标量化，产出一个几十 KB 的紧凑数组，
    足够让 4~6 岁的孩子认出「这是一块大陆」。

数据源：
    https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json        陆地轮廓
    https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json   国界（用于画出国家分界）

输出：
    js/ui/globe-data.js
      LAND     陆地轮廓：[[ [lon,lat], ... ], ...]
      BORDERS  国界线段：[[ [lon,lat], ... ], ...]
      LAKES    大湖（可选，来自 land 里的内环）

用法：
    python tools/gen-globe-data.py                # 默认容差
    python tools/gen-globe-data.py --tolerance 0.15   # 更精细（文件更大）
    python tools/gen-globe-data.py --check        # 只校验现有文件
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "js" / "ui" / "globe-data.js"
CACHE = ROOT / ".cache" / "naturalearth"

SOURCES = {
    "land": "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json",
    "countries": "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
}
UA = "WeatherRouletteBot/0.1 (+https://github.com/noobdawn/WeatherRoulette)"

DEFAULT_TOLERANCE = 0.22   # 度；110m 数据本身很粗，0.2 左右肉眼无损
MIN_POLYGON_AREA = 1.2     # 平方度；太小的岛直接丢掉（对孩子没意义，省体积）


def fetch(name: str) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}-110m.json"
    if path.exists() and path.stat().st_size > 1000:
        return json.loads(path.read_text(encoding="utf-8"))
    req = urllib.request.Request(SOURCES[name], headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
    path.write_text(raw, encoding="utf-8")
    return json.loads(raw)


# ----------------------------------------------------------------- TopoJSON 解码
def decode_arcs(topology: dict) -> list[list[list[float]]]:
    """把 TopoJSON 的 delta 编码 arc 还原成经纬度坐标串。"""
    transform = topology.get("transform")
    arcs = topology["arcs"]
    out: list[list[list[float]]] = []
    for arc in arcs:
        if transform:
            sx, sy = transform["scale"]
            tx, ty = transform["translate"]
            x = y = 0
            pts = []
            for dx, dy in arc:
                x += dx
                y += dy
                pts.append([x * sx + tx, y * sy + ty])
            out.append(pts)
        else:
            out.append([[p[0], p[1]] for p in arc])
    return out


def ring_coords(ring: list[int], arcs: list[list[list[float]]]) -> list[list[float]]:
    """把一串 arc 索引拼成一个闭环坐标串。"""
    pts: list[list[float]] = []
    for idx in ring:
        if idx >= 0:
            seg = arcs[idx]
        else:
            seg = list(reversed(arcs[~idx]))
        if pts and seg:
            pts.extend(seg[1:])
        else:
            pts.extend(seg)
    return pts


# ----------------------------------------------------------------- 简化与量化
def perpendicular_distance(p, a, b) -> float:
    if a == b:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    dx, dy = b[0] - a[0], b[1] - a[1]
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def rdp(points: list[list[float]], eps: float) -> list[list[float]]:
    """Douglas-Peucker 简化（迭代实现，避免深递归）。"""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax = 0.0
        index = i
        for k in range(i + 1, j):
            d = perpendicular_distance(points[k], points[i], points[j])
            if d > dmax:
                dmax, index = d, k
        if dmax > eps:
            keep[index] = True
            stack.append((i, index))
            stack.append((index, j))
    return [p for p, k in zip(points, keep) if k]


def ring_signed_area(ring: list[list[float]]) -> float:
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def quantize(ring: list[list[float]], step: float = 0.1) -> list[list[float]]:
    """坐标量化到 step 度，并去掉连续重复点。"""
    out: list[list[float]] = []
    for lon, lat in ring:
        q = [round(lon / step) * step, round(lat / step) * step]
        if out and abs(out[-1][0] - q[0]) < 1e-9 and abs(out[-1][1] - q[1]) < 1e-9:
            continue
        out.append(q)
    # 首尾相同则去掉尾点（前端画闭环时会自动连回去）
    if len(out) > 2 and out[0] == out[-1]:
        out.pop()
    return out


def collect_polygons(topology: dict, object_name: str, tolerance: float) -> list[list[list[float]]]:
    arcs = decode_arcs(topology)
    obj = topology["objects"][object_name]
    polygons: list[list[list[float]]] = []

    def add_polygon(rings: list[list[int]]) -> None:
        for i, ring in enumerate(rings):
            pts = ring_coords(ring, arcs)
            if len(pts) < 4:
                continue
            if i == 0:
                if abs(ring_signed_area(pts)) < MIN_POLYGON_AREA:
                    return  # 主环太小，整块丢掉
            simplified = rdp(pts, tolerance)
            q = quantize(simplified)
            if len(q) >= 3:
                polygons.append(q)

    if obj["type"] == "GeometryCollection":
        for geom in obj["geometries"]:
            if geom["type"] == "Polygon":
                add_polygon(geom["arcs"])
            elif geom["type"] == "MultiPolygon":
                for poly in geom["arcs"]:
                    add_polygon(poly)
    elif obj["type"] == "Polygon":
        add_polygon(obj["arcs"])
    elif obj["type"] == "MultiPolygon":
        for poly in obj["arcs"]:
            add_polygon(poly)
    return polygons


def collect_borders(topology: dict, tolerance: float) -> list[list[list[float]]]:
    """国界：用 countries 数据里所有 arc，去掉重复（共享边界只画一次）。"""
    arcs = decode_arcs(topology)
    seen: set[tuple] = set()
    lines: list[list[list[float]]] = []
    obj = topology["objects"]["countries"]
    geoms = obj["geometries"] if obj["type"] == "GeometryCollection" else [obj]

    def note(ring: list[int]) -> None:
        for idx in ring:
            key = min(idx, ~idx)
            if key in seen:
                continue
            seen.add(key)
            seg = arcs[idx] if idx >= 0 else list(reversed(arcs[~idx]))
            if len(seg) < 2:
                continue
            simplified = rdp(seg, tolerance * 1.2)
            q = quantize(simplified)
            if len(q) >= 2:
                lines.append(q)

    for geom in geoms:
        if geom["type"] == "Polygon":
            for ring in geom["arcs"]:
                note(ring)
        elif geom["type"] == "MultiPolygon":
            for poly in geom["arcs"]:
                for ring in poly:
                    note(ring)
    return lines


def totals(polys: list) -> tuple[int, int]:
    return len(polys), sum(len(p) for p in polys)


def write_module(land, borders) -> None:
    def fmt(polys: list[list[list[float]]]) -> str:
        rows = []
        for p in polys:
            coords = ",".join(f"[{x:g},{y:g}]" for x, y in p)
            rows.append(f"  [{coords}],")
        return "\n".join(rows)

    body = f"""// 自动生成，请勿手改 —— 由 tools/gen-globe-data.py 产出。
//
// 数据来源：Natural Earth 110m（经 world-atlas 的 TopoJSON 分发）
//   https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json
//   https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
// 处理：TopoJSON delta 解码 → Douglas-Peucker 简化 → 坐标量化到 0.1°
// 用途：3D 地球动画的陆地填充与国界线。坐标是 [经度, 纬度]，闭环保存在数组里。
//
// 陆地 {len(land)} 块 / {sum(len(p) for p in land)} 点
// 国界 {len(borders)} 段 / {sum(len(p) for p in borders)} 点

export const LAND = [
{fmt(land)}
];

export const BORDERS = [
{fmt(borders)}
];

export default {{ LAND, BORDERS }};
"""
    OUT.write_text(body, encoding="utf-8")


def check() -> int:
    if not OUT.exists():
        print(f"✗ 文件不存在：{OUT}")
        return 1
    text = OUT.read_text(encoding="utf-8")
    print(f"文件：{OUT.relative_to(ROOT)}  {len(text.encode('utf-8')) / 1024:.1f} KB")
    ns: dict = {}
    import re
    land = re.search(r"export const LAND = \[(.*?)\n\];", text, re.S)
    borders = re.search(r"export const BORDERS = \[(.*?)\n\];", text, re.S)
    for name, m in (("LAND", land), ("BORDERS", borders)):
        if not m:
            print(f"✗ 找不到 {name}")
            return 1
        rows = [r for r in m.group(1).split("\n") if r.strip()]
        pts = sum(r.count("[") - 1 for r in rows)
        print(f"  {name}: {len(rows)} 段 / {pts} 点")
    bad = [c for c in "锟閿鐗鍓閲鈥" if c in text]
    print(f"  编码自检：可疑字符 {len(bad)} 个（期望 0）")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.check:
        return check()

    print(f"容差 {args.tolerance}°（值越小越精细、文件越大）")
    land_topo = fetch("land")
    land = collect_polygons(land_topo, "land", args.tolerance)
    print(f"陆地：{totals(land)[0]} 块 / {totals(land)[1]} 点")

    countries_topo = fetch("countries")
    borders = collect_borders(countries_topo, args.tolerance)
    print(f"国界：{totals(borders)[0]} 段 / {totals(borders)[1]} 点")

    write_module(land, borders)
    size = OUT.stat().st_size / 1024
    print(f"\n已写入 {OUT.relative_to(ROOT)}：{size:.1f} KB")
    return check()


if __name__ == "__main__":
    sys.exit(main())
