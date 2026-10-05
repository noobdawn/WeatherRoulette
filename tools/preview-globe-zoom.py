#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「地球拉远程度 vs 两城距离」的定标画成图，用于肉眼判断比例是否合理。

背景：老板要求拉远程度与城市间距离成正比（几百公里只拉远一点点，
几千公里拉到「地球恰好填满画面的三分之二」）。
但 tools/city-distances.py 实测发现：一轮随机播报里相邻两城距离的**中位数是 7177 km**，
所以纯线性映射会让绝大多数转场顶到最大拉远 —— 必须做非线性压缩。
这个工具把公式画出来 + 用真实城市对标注，供定调。

用法：
    python tools/preview-globe-zoom.py                 # 默认 1440x900
    python tools/preview-globe-zoom.py -W 390 -H 844   # 竖屏手机
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"
OUT = ROOT / "tools" / "globe-zoom-preview.png"

R_EARTH_KM = 6371.0088
MAXD = math.pi * R_EARTH_KM          # 理论对跖距离 ≈ 20015.1 km

# 与 js/core/constants.js 的 GLOBE 保持一致
ZOOM_POWER = 0.55
ZOOM_NEAR_MIN_SIDE_RATIO = 0.86
ZOOM_FAR_MIN_SIDE_RATIO = 2 / 3


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def r_base(w: float, h: float) -> float:
    """渲染器里地球的基准屏幕半径（js/ui/globe.js）"""
    return min(w * 0.44, h * 0.34)


def k_for_ratio(ratio: float, w: float, h: float) -> float:
    """要让「球直径 = 短边 × ratio」所需的半径倍率"""
    return (ratio * 0.5 * min(w, h)) / r_base(w, h)


def k_far(w: float, h: float) -> float:
    return k_for_ratio(ZOOM_FAR_MIN_SIDE_RATIO, w, h)


def k_near(w: float, h: float) -> float:
    return k_for_ratio(ZOOM_NEAR_MIN_SIDE_RATIO, w, h)


def k_for(d_km: float, w: float, h: float) -> float:
    t = min(1.0, max(0.0, d_km / MAXD)) ** ZOOM_POWER
    return k_near(w, h) + (k_far(w, h) - k_near(w, h)) * t


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-W", type=int, default=1440)
    ap.add_argument("-H", type=int, default=900)
    args = ap.parse_args()
    w, h = args.W, args.H

    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    cities = raw["cities"] if isinstance(raw, dict) else raw

    kb, kf = k_far(w, h), None
    print(f"视口 {w}x{h}")
    print(f"  基准半径 R_base = {r_base(w, h):.1f}px")
    print(f"  近景倍率 kNear = {k_near(w, h):.4f}"
          f"  → 半径 {r_base(w, h) * k_near(w, h):.1f}px"
          f"  直径/短边 = {ZOOM_NEAR_MIN_SIDE_RATIO:.4f}")
    print(f"  最远端倍率 kFar = {k_far(w, h):.4f}"
          f"  → 半径 {r_base(w, h) * k_far(w, h):.1f}px"
          f"  直径 {2 * r_base(w, h) * k_far(w, h):.1f}px"
          f" / 短边 {min(w, h)}px = {2 * r_base(w, h) * k_far(w, h) / min(w, h):.4f}")
    shrink = (1 - k_far(w, h) / k_near(w, h)) * 100
    print(f"  拉远幅度（近景半径 → 远景半径）= {shrink:.1f}%")

    # 真实城市对
    pairs = [
        ("珠海↔澳门", 8.7), ("广州↔佛山", 18.8), ("北京↔天津", 113.0),
        ("上海↔东京", 1764.0), ("合肥↔东京", 1900.0), ("北京↔伦敦", 8140.0),
        ("北京↔纽约", 11000.0), ("北京↔悉尼", 8900.0),
        ("奥克兰↔马德里", 19596.6),
    ]
    print("\n真实城对的实测值：")
    print(f"  {'城市对':<16}{'距离km':>10}{'k':>9}{'半径px':>9}{'直径/短边':>11}")
    for name, d in pairs:
        k = k_for(d, w, h)
        r = r_base(w, h) * k
        print(f"  {name:<16}{d:>10.1f}{k:>9.4f}{r:>9.1f}{2 * r / min(w, h):>11.4f}")

    # 分位数（来自 tools/city-distances.py 的实测）
    print("\n按实测分位数看（两两距离 / 一轮相邻距离）：")
    quantiles = [
        ("P5 两两", 559.0), ("P10 两两", 837.0), ("P25 两两", 1557.8),
        ("P50 两两", 7201.5), ("P90 两两", 10462.5), ("P95 两两", 11807.0),
        ("P50 相邻", 7176.7), ("P75 相邻", 9016.1), ("P95 相邻", 11754.1),
    ]
    for name, d in quantiles:
        k = k_for(d, w, h)
        r = r_base(w, h) * k
        print(f"  {name:<12}{d:>10.1f} km   k={k:.4f}   直径/短边={2 * r / min(w, h):.4f}")

    # ── 画图 ──────────────────────────────────────────────────
    W, H = 1200, 820
    img = Image.new("RGB", (W, H), (14, 18, 28))
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15)
        font_s = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 13)
        font_b = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    except Exception:  # noqa: BLE001
        font = font_s = font_b = ImageFont.load_default()

    d.text((20, 14), f"地球拉远定标：距离 → 屏幕直径占比（视口 {w}×{h}）", font=font_b, fill=(230, 238, 250))

    # 左图：曲线
    gx, gy, gw, gh = 60, 70, 560, 420
    d.rectangle([gx, gy, gx + gw, gy + gh], outline=(70, 84, 108))
    # 网格与刻度
    for frac in (0.0, 0.25, 0.5, 0.667, 0.75, 1.0):
        yy = gy + gh - int(frac * gh)
        d.line([gx, yy, gx + gw, yy], fill=(38, 48, 66))
        d.text((gx - 52, yy - 8), f"{frac * 100:>3.0f}%", font=font_s, fill=(150, 165, 190))
    for dk in (0, 5000, 10000, 15000, 20000):
        xx = gx + int(dk / MAXD * gw)
        d.line([xx, gy, xx, gy + gh], fill=(38, 48, 66))
        d.text((xx - 18, gy + gh + 6), f"{dk // 1000}k", font=font_s, fill=(150, 165, 190))
    d.text((gx + 160, gy + gh + 26), "两城大圆距离（km）", font=font_s, fill=(170, 185, 210))

    # 曲线：直径/短边
    pts = []
    for i in range(0, gw + 1):
        dk = i / gw * MAXD
        k = k_for(dk, w, h)
        ratio = 2 * r_base(w, h) * k / min(w, h)
        pts.append((gx + i, gy + gh - int(min(1.0, ratio) * gh)))
    d.line(pts, fill=(120, 200, 255), width=3)
    # 2/3 参考线
    ref = gy + gh - int(ZOOM_FAR_MIN_SIDE_RATIO * gh)
    d.line([gx, ref, gx + gw, ref], fill=(255, 150, 120), width=1)
    d.text((gx + gw - 150, ref - 18), "目标：短边 2/3", font=font_s, fill=(255, 170, 140))

    # 标注真实城市对
    marks = [("珠海↔澳门", 8.7), ("北京↔天津", 113.0), ("合肥↔东京", 1900.0),
             ("北京↔伦敦", 8140.0), ("奥克兰↔马德里", 19596.6)]
    for name, dk in marks:
        k = k_for(dk, w, h)
        ratio = 2 * r_base(w, h) * k / min(w, h)
        px = gx + int(dk / MAXD * gw)
        py = gy + gh - int(min(1.0, ratio) * gh)
        d.ellipse([px - 4, py - 4, px + 4, py + 4], fill=(255, 220, 120))
        label = f"{name} {dk:.0f}km"
        tx = px + 8 if px < gx + gw * 0.6 else px - 150
        d.text((tx, py - 20), label, font=font_s, fill=(255, 230, 160))

    # 右图：三个距离的球大小对比
    bx, by, bw, bh = 670, 70, 500, 420
    d.rectangle([bx, by, bx + bw, by + bh], outline=(70, 84, 108))
    d.text((bx + 10, by + 8), "同一视口下球的实际大小（按短边等比缩放示意）", font=font_s, fill=(200, 212, 232))
    cases = [("珠海↔澳门\n9km", 8.7), ("合肥↔东京\n1900km", 1900.0), ("奥克兰↔马德里\n19597km", 19596.6)]
    slot_w = bw / len(cases)
    for i, (name, dk) in enumerate(cases):
        k = k_for(dk, w, h)
        ratio = 2 * r_base(w, h) * k / min(w, h)
        cx = bx + slot_w * (i + 0.5)
        cy = by + bh * 0.52
        # 用「占短边的比例」画球，短边在示意图里按 min(w,h) 缩放到 bh*0.8
        box_side = bh * 0.78
        r = box_side * ratio / 2
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(46, 96, 158), outline=(140, 200, 255), width=2)
        d.rectangle([cx - box_side / 2, cy - box_side / 2, cx + box_side / 2, cy + box_side / 2],
                    outline=(96, 110, 134))
        d.text((cx - 46, cy + box_side / 2 + 8), name, font=font_s, fill=(220, 230, 245),
               align="center", spacing=4)
        d.text((cx - 30, cy + box_side / 2 + 46), f"{ratio * 100:.0f}%", font=font_s, fill=(255, 220, 120))

    # 底部说明
    lines = [
        f"t = clamp(d / {MAXD:.1f}, 0, 1) ** {ZOOM_POWER}；k = kNear + (kFar − kNear) × t；R = R_base × k",
        f"kNear = ({ZOOM_NEAR_MIN_SIDE_RATIO}/2 × 短边) / R_base = {k_near(w, h):.4f}（近景：球直径占短边 "
        f"{ZOOM_NEAR_MIN_SIDE_RATIO:.0%}）",
        f"kFar  = ((2/3)/2 × 短边) / R_base = {k_far(w, h):.4f}（最远端：球直径恰为短边的 2/3，老板要求）",
        f"拉远幅度 = {(1 - k_far(w, h) / k_near(w, h)) * 100:.1f}% —— 两位数的缩小才看得出来",
        "为什么不用线性：实测一轮播报里相邻两城距离的中位数是 7177 km，线性映射会让绝大多数转场顶到最远端。",
        "为什么近景要留余量：R_base 本身已占短边 68%，不给余量就只能缩 2%，等于没有拉远。",
    ]
    y = gy + gh + 60
    for line in lines:
        d.text((20, y), line, font=font_s, fill=(168, 182, 205))
        y += 22

    img.save(OUT)
    print(f"\n已输出 {OUT.relative_to(ROOT)}  {img.size[0]}x{img.size[1]}")
    print("看图要点：曲线是否单调平滑；最右端是否刚好落在「短边 2/3」参考线上；")
    print("三个球的对比是否体现「近处几乎不收、远处明显拉远」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
