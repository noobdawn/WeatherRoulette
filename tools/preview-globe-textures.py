#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 assets/globe/ 里的贴图缩成一张预览图，用来肉眼检查地球素材质量。

为什么要看图而不是看数字：
    albedo 里国界是否清晰、normal 是否真有起伏、countries 的国家色块是否串色，
    这些只能看出来。文件大小正常不代表画面对。

用法：
    python tools/preview-globe-textures.py            # 输出 tools/globe-textures-preview.png
    python tools/preview-globe-textures.py --width 1800
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "globe"
OUT = ROOT / "tools" / "globe-textures-preview.png"


def tile(path: Path, label: str, box_w: int) -> Image.Image | None:
    if not path.exists():
        return None
    img = Image.open(path).convert("RGB")
    h = int(box_w / 2)  # 等距圆柱 2:1
    img = img.resize((box_w, h), Image.LANCZOS)
    out = Image.new("RGB", (box_w, h + 26), (16, 20, 30))
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    d.text((6, h + 6), f"{label}  {path.stat().st_size / 1024:.0f} KB", fill=(220, 230, 245))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=1400)
    args = ap.parse_args()

    if not SRC.exists():
        print(f"✗ 找不到 {SRC}")
        return 1

    items = [
        tile(SRC / "albedo.jpg", "albedo.jpg (satellite + borders)", args.width),
        tile(SRC / "normal.jpg", "normal.jpg (relief for realtime lighting)", args.width),
        tile(SRC / "countries.png", "countries.png (country id map)", args.width),
    ]
    items = [i for i in items if i is not None]
    if not items:
        print("✗ 没有可预览的贴图")
        return 1

    total_h = sum(i.height for i in items) + 10 * (len(items) - 1)
    canvas = Image.new("RGB", (args.width, total_h), (10, 12, 20))
    y = 0
    for i in items:
        canvas.paste(i, (0, y))
        y += i.height + 10
    canvas.save(OUT)
    print(f"已输出 {OUT.relative_to(ROOT)}  {canvas.size[0]}x{canvas.size[1]}")
    print("检查要点：")
    print("  1. albedo 上能否看清大陆/山脉纹理，国界是否是清晰细线")
    print("  2. normal 是否以中灰为主、山脊处有明显彩色起伏（全灰=没有法线信息）")
    print("  3. countries 上各国家是否为不同的纯色块、海洋为纯黑、版图是否越界串色")
    return 0


if __name__ == "__main__":
    sys.exit(main())
