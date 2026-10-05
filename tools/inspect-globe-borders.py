#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
放大检查 albedo 里烘进去的国界是否清晰——取几块有代表性的区域 1:1 裁出来。

缩略图上看不出"国界是不是细而清晰"，必须按原始分辨率裁局部看。

用法：
    python tools/inspect-globe-borders.py            # 输出 tools/globe-border-crops.png
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "globe" / "albedo.jpg"
OUT = ROOT / "tools" / "globe-border-crops.png"

# (名称, 中心经度, 中心纬度, 裁剪宽)
CROPS = [
    ("Europe (dense borders)", 10.0, 48.0, 640),
    ("East Asia", 118.0, 33.0, 640),
    ("South America", -60.0, -15.0, 640),
    ("Himalaya (relief)", 85.0, 30.0, 512),
]


def main() -> int:
    if not SRC.exists():
        print(f"✗ 找不到 {SRC}")
        return 1
    img = Image.open(SRC).convert("RGB")
    w, h = img.size
    print(f"albedo {w}x{h}")

    tiles = []
    for name, lon, lat, cw in CROPS:
        cx = int((lon + 180.0) / 360.0 * w)
        cy = int((90.0 - lat) / 180.0 * h)
        ch = cw // 2
        box = (max(0, cx - cw // 2), max(0, cy - ch // 2),
               min(w, cx + cw // 2), min(h, cy + ch // 2))
        crop = img.crop(box)
        tile = Image.new("RGB", (crop.width, crop.height + 22), (16, 20, 30))
        tile.paste(crop, (0, 0))
        ImageDraw.Draw(tile).text((6, crop.height + 5), f"{name}  lon={lon} lat={lat}", fill=(220, 230, 245))
        tiles.append(tile)

    total_w = max(t.width for t in tiles)
    total_h = sum(t.height for t in tiles) + 8 * (len(tiles) - 1)
    canvas = Image.new("RGB", (total_w, total_h), (10, 12, 20))
    y = 0
    for t in tiles:
        canvas.paste(t, (0, y))
        y += t.height + 8
    canvas.save(OUT)
    print(f"已输出 {OUT.relative_to(ROOT)}  {canvas.size[0]}x{canvas.size[1]}")
    print("检查要点：国界是否为「细而连续」的深色线（不是断线、不是粗黑边、不是锯齿块）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
