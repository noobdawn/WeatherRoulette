#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 globe-data.js 画成一张等距圆柱投影的 PNG，用来肉眼确认大陆形状没画错/没漏。

用途：3D 地球是给孩子认地理的，大陆轮廓必须能一眼认出来。
数据生成后跑一次这个脚本看图，比在浏览器里猜快得多。

用法：
    python tools/preview-globe-data.py            # 输出 tools/globe-preview.png
    python tools/preview-globe-data.py --size 1800x900
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "js" / "ui" / "globe-data.js"
OUT = ROOT / "tools" / "globe-preview.png"


def parse_array(text: str, name: str) -> list[list[tuple[float, float]]]:
    m = re.search(rf"export const {name} = \[(.*?)\n\];", text, re.S)
    if not m:
        raise SystemExit(f"找不到 {name}")
    body = m.group(1)
    rows = re.findall(r"\[((?:\[[-\d.]+,?[-\d.]*\],?)+)\]", body)
    out = []
    for row in rows:
        pts = [(float(a), float(b)) for a, b in re.findall(r"\[([-\d.]+),([-\d.]+)\]", row)]
        if len(pts) >= 2:
            out.append(pts)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="1600x800", help="输出尺寸，如 1600x800")
    args = ap.parse_args()
    w, h = (int(v) for v in args.size.lower().split("x"))

    text = DATA.read_text(encoding="utf-8")
    land = parse_array(text, "LAND")
    borders = parse_array(text, "BORDERS")
    print(f"陆地 {len(land)} 块 / {sum(len(p) for p in land)} 点")
    print(f"国界 {len(borders)} 段 / {sum(len(p) for p in borders)} 点")

    img = Image.new("RGB", (w, h), (18, 34, 62))       # 海洋
    draw = ImageDraw.Draw(img)

    def proj(lon: float, lat: float) -> tuple[float, float]:
        return ((lon + 180) / 360 * w, (90 - lat) / 180 * h)

    # 经纬网（每 30°），便于核对投影是否正确
    for lon in range(-180, 181, 30):
        draw.line([proj(lon, -90), proj(lon, 90)], fill=(30, 52, 88), width=1)
    for lat in range(-60, 61, 30):
        draw.line([proj(-180, lat), proj(180, lat)], fill=(30, 52, 88), width=1)
    draw.line([proj(-180, 0), proj(180, 0)], fill=(52, 88, 140), width=2)   # 赤道

    for poly in land:
        draw.polygon([proj(*p) for p in poly], fill=(78, 140, 92), outline=(196, 226, 200))
    for line in borders:
        draw.line([proj(*p) for p in line], fill=(150, 190, 160), width=1)

    # 标出 81 个城市的位置，确认坐标没写反（经度/纬度颠倒会立刻看出来）
    cities = (ROOT / "data" / "cities.json").read_text(encoding="utf-8")
    import json
    for c in json.loads(cities)["cities"]:
        x, y = proj(c["lon"], c["lat"])
        draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 214, 102), outline=(120, 70, 0))

    img.save(OUT)
    print(f"\n已输出 {OUT.relative_to(ROOT)}（{w}x{h}）")
    print("看图要点：大陆形状是否可辨认；81 个黄点是否落在陆地上；经度/纬度有没有颠倒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
