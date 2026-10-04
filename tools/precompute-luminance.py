#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线预计算每张壁纸的「亮度网格」，供前端选择文字颜色（深字 / 白字）。

为什么必须离线算：
    前端原本用 canvas 读像素来判断壁纸亮暗，但 cdn.pixabay.com **不返回
    Access-Control-Allow-Origin**，带 crossOrigin 的 Image 直接 ERR_FAILED，
    canvas 读像素抛 SecurityError。结果 Pixabay 那张图（银川/福州/武汉/东京等）
    只能走兜底 → 白字压在亮壁纸上，实测对比度只有 1.46:1，几乎看不清。
    服务端取图没有跨域限制，所以把亮度预先算好写进 JSON，前端读 JSON 即可，
    既准确又零运行时开销，还能省掉一次图片解码。

网格设计：
    把每张图切成 GRID_W×GRID_H 的格子，每格记一个 8bit 平均相对亮度（0~255）。
    前端拿到文字包围盒后，换算成图片坐标，取覆盖到的格子求均值，
    再决定用深墨字还是白字。这样不管城市名多长、屏幕多宽都算得准。
    网格取 16×12：早先用 8×6 时每格约 180×150px，比一行字还大，
    会把相邻的亮区暗区抹平，导致个别城市判定不出最优配色（实测沈阳最差区域占 25%）。

输出：assets/images/luminance.json
用法：
    python tools/precompute-luminance.py                 # 增量（已有的图跳过）
    python tools/precompute-luminance.py --force         # 全部重算
    python tools/precompute-luminance.py -j 12           # 并发数
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import io
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "assets" / "images" / "manifest.json"
OUT = ROOT / "assets" / "images" / "luminance.json"
UA = "WeatherRouletteBot/0.1 (+https://github.com/noobdawn/WeatherRoulette)"

GRID_W, GRID_H = 16, 12


def srgb_to_linear(arr: np.ndarray) -> np.ndarray:
    """sRGB 0~1 → 线性光，WCAG 相对亮度要求线性空间。"""
    return np.where(arr <= 0.04045, arr / 12.92, ((arr + 0.055) / 1.055) ** 2.4)


def fetch(url: str, timeout: float = 30.0) -> bytes | None:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            return resp.read()
    except Exception:  # noqa: BLE001
        return None


def cell_luminance(raw: bytes) -> list[int] | None:
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:  # noqa: BLE001
        return None
    # 缩到网格分辨率再算，等价于对每格求平均（面积平均）
    small = np.asarray(img.resize((GRID_W, GRID_H), Image.BOX), dtype=np.float64) / 255.0
    lin = srgb_to_linear(small)
    lum = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    return [int(round(v * 255)) for v in lum.reshape(-1)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="已算过的也重算")
    ap.add_argument("-j", "--jobs", type=int, default=10)
    args = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    urls: list[str] = []
    for info in manifest["images"].values():
        if info.get("primary"):
            urls.append(info["primary"])
        urls.extend(info.get("fallbacks") or [])
    uniq = sorted(set(urls))
    print(f"清单里共 {len(uniq)} 条唯一图片 URL")

    existing: dict[str, list[int]] = {}
    if OUT.exists() and not args.force:
        try:
            data = json.loads(OUT.read_text(encoding="utf-8"))
            if data.get("grid") == [GRID_W, GRID_H]:
                existing = data.get("cells", {})
                print(f"已有 {len(existing)} 条预计算结果，将增量更新")
        except Exception:  # noqa: BLE001
            pass

    todo = [u for u in uniq if u not in existing]
    print(f"待计算 {len(todo)} 条（并发 {args.jobs}）\n")

    cells = dict(existing)
    failed: list[str] = []

    def work(url: str) -> tuple[str, list[int] | None]:
        raw = fetch(url)
        if raw is None:
            return url, None
        return url, cell_luminance(raw)

    if todo:
        done = 0
        with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for url, vals in pool.map(work, todo):
                done += 1
                if vals is None:
                    failed.append(url)
                    print(f"[{done:>3}/{len(todo)}] ✗ 取图或解码失败 {url[:90]}", flush=True)
                else:
                    cells[url] = vals
                    if done % 20 == 0 or done == len(todo):
                        print(f"[{done:>3}/{len(todo)}] ✓ 已完成", flush=True)

    payload = {
        "version": 1,
        "note": "每张壁纸的亮度网格（8x6，行优先，8bit 相对亮度）。由 tools/precompute-luminance.py 生成，"
                "供 js/ui/screen.js 选择文字配色，避免浏览器端 canvas 因跨域读不到像素而误判。",
        "grid": [GRID_W, GRID_H],
        "unit": "sRGB 线性相对亮度 × 255",
        "cells": cells,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    size_kb = OUT.stat().st_size / 1024
    print(f"\n已写入 {OUT.relative_to(ROOT)}：{len(cells)} 条，{size_kb:.1f} KB")
    if failed:
        print(f"失败 {len(failed)} 条（这些图前端会退回 canvas 采样 + 阴影兜底）：")
        for u in failed[:10]:
            print("  ✗", u[:110])
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
