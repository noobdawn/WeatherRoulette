#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
相机抛物线轨迹定标：把「相机沿抛物线飞出再落下」画出来，并算各距离下球的大小。

老板要求：
    相机运动的轨迹类似抛物线 —— 从起点城市"抛"向终点城市，
    中途升到最高点（球最小，能看到整颗地球与前后的城市），两端贴地（球最大、贴近城市）。
    抛物线高度随两城距离变化：几百公里只是轻轻一跳，几千公里则是明显的大抛。

为什么不是「缩放到某个距离再缩回来」：
    那是把缩放当成一个纯数值的来回，没有"相机在空间里走了一条弧线"的物理含义。
    抛物线轨迹里 **球的大小是相机距离的函数**（离得远就小），
    而相机距离由弹道曲线决定 —— 两者是同一件事的两种表现。

相机模型（世界坐标，地球半径取 1）：
    A = p(from) 起点城市单位向量
    B = p(to)   终点城市单位向量
    u(t)   = normalize( slerp(A, B, t) )     视线方向（始终指向两城之间的球面点）
    h(t)   = hMax · 4·t·(1-t)                弹道高度（标准抛物线，峰值在中点）
    C(t)   = u(t) · (1 + baseAlt + h(t))     相机位置
    dist(t) = |C(t)|                         相机到球心距离

球在屏幕上的半径 ∝ 1/dist（透视下小球近似）。于是：
    ratio(t) = ratioNear · (1 + baseAlt) / (1 + baseAlt + h(t))
两个端点自然满足：t=0/1 时 h=0 → ratio = ratioNear；t=0.5 时 h=hMax → 本趟最小。
★ 注意别把 ratio 绑在"相机距离的绝对值落在 [distNear, distFar] 里的百分比"上 ——
  那样短途（hMax≈0.001）会因为 baseAlt 的尺度差异而完全没有缩放。用 1/dist 才对。

★ 两个"成正比"分别落在两处（本文件最关键的结论）：
    1. **弹道高度** hMax 随两城距离增长 —— 决定"抛得多高"
    2. **最高点的球占比** 由 1/(1+hMax) 自动得出 —— 短途几乎不收，大跨洲才拉到 2/3
    实测：对跖时 0.86 · 1.04/1.34 = 0.6675，正好是「短边的三分之二」。
    早期版本把 ratioFar 永远钉在 2/3，于是珠海↔澳门 9 公里的转场也要求相机抛出
    约 0.6 个地球半径，与"距离成正比"完全相悖。

用法：
    python tools/calibrate-globe-arc.py
    python tools/calibrate-globe-arc.py --hmax 0.35 --alt-power 0.6
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
OUT = ROOT / "tools" / "globe-arc-preview.png"

R_EARTH_KM = 6371.0088
ARC_HALF_PI = math.pi  # 对跖夹角

# ── 待定标参数（对应 js/core/constants.js 的 GLOBE）──────────────────
H_MAX_FULL = 0.30       # 对跖（sep=π）时的弹道最高点，单位 = 地球半径
ALT_POWER = 0.75        # 高度随距离增长的幂次（<1 让中距离也有明显抛高）
BASE_ALT = 0.04         # 贴地时的基础高度（避免距离趋 0 时球无限大）
RATIO_NEAR = 0.86       # 贴地（两端）时球直径占视口短边


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def sep_rad(d_km: float) -> float:
    """两城夹角（弧度）"""
    return min(math.pi, d_km / R_EARTH_KM)


def span_of(d_km: float) -> float:
    """0 = 同一座城市，1 = 严格对跖"""
    return sep_rad(d_km) / ARC_HALF_PI


def h_max(d_km: float) -> float:
    return H_MAX_FULL * span_of(d_km) ** ALT_POWER


def ratio_peak(d_km: float) -> float:
    """本趟飞行最高点时的球占比 —— 由「半径 ∝ 1/相机距离」自动得出"""
    return RATIO_NEAR * (1.0 + BASE_ALT) / (1.0 + BASE_ALT + h_max(d_km))


def dist_profile(d_km: float, steps: int = 41):
    """返回 [(t, dist, ratio)]，其中 dist 是相机到球心的距离（地球半径 = 1）"""
    hm = h_max(d_km)
    out = []
    for i in range(steps):
        t = i / (steps - 1)
        h = hm * 4 * t * (1 - t)
        dist = 1.0 + BASE_ALT + h
        # 半径 ∝ 1/dist，两端归一化到 RATIO_NEAR
        ratio = RATIO_NEAR * (1.0 + BASE_ALT) / dist
        out.append((t, dist, ratio))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hmax", type=float, default=H_MAX_FULL)
    ap.add_argument("--alt-power", type=float, default=ALT_POWER)
    args = ap.parse_args()
    h_full, alt_pow = args.hmax, args.alt_power
    globals()["H_MAX_FULL"] = h_full
    globals()["ALT_POWER"] = alt_pow

    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    cities = raw["cities"] if isinstance(raw, dict) else raw

    print(f"抛物线参数：hMaxFull={h_full}（对跖时的最高点，单位=地球半径）  altPower={alt_pow}")
    print(f"贴地球占比 {RATIO_NEAR:.3f}；最高点占比由「半径 ∝ 1/相机距离」自动得出\n")

    cases = [
        # 距离由 cities.json 真实坐标算出（tools/city-distances.py），别手写估算值 ——
        # 曾把北京↔天津写成 113.0km，实测是 102.8km，标定表以实测为准。
        ("珠海↔澳门", 8.7), ("广州↔佛山", 18.8), ("北京↔天津", 102.8),
        ("上海↔东京", 1764.0), ("合肥↔东京", 2112.1), ("北京↔伦敦", 8141.1),
        ("奥克兰↔马德里", 19596.6), ("对跖（理论）", math.pi * R_EARTH_KM),
    ]
    print(f"{'城市对':<16}{'距离km':>10}{'夹角°':>8}{'hMax':>8}"
          f"{'最高点占比':>11}{'抛高':>8}{'落回占比':>10}")
    for name, d in cases:
        hm = h_max(d)
        peak = ratio_peak(d)
        print(f"{name:<16}{d:>10.1f}{math.degrees(sep_rad(d)):>8.1f}{hm:>8.4f}"
              f"{peak:>11.4f}{peak / RATIO_NEAR - 1:>8.1%}{RATIO_NEAR:>10.4f}")
    print("\n  『抛高』= 最高点的球比贴地时小多少。短途接近 0（只是轻轻一跳），")
    print("  大跨洲才到 22% 上下（明显退后）；对跖时最高点恰为短边的 2/3。")

    # ── 画图 ──────────────────────────────────────────────────────
    W, H = 1240, 800
    img = Image.new("RGB", (W, H), (14, 18, 28))
    dr = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15)
        font_s = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 13)
        font_b = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    except Exception:  # noqa: BLE001
        font = font_s = font_b = ImageFont.load_default()

    dr.text((20, 12), "相机抛物线轨迹：两端贴地、中途最高，抛高与两城距离成正比",
            font=font_b, fill=(230, 238, 250))

    # 左：轨迹侧视（横轴 = 角进度，纵轴 = 距球心高度）
    gx, gy, gw, gh = 60, 64, 540, 340
    dr.rectangle([gx, gy, gx + gw, gy + gh], outline=(70, 84, 108))
    base_y = gy + gh - 46
    dr.line([gx + 24, base_y, gx + gw - 24, base_y], fill=(90, 110, 140), width=2)
    dr.text((gx + 24, base_y + 8), "起点城市（贴地）", font=font_s, fill=(150, 165, 190))
    dr.text((gx + gw - 168, base_y + 8), "终点城市（贴地）", font=font_s, fill=(150, 165, 190))

    legend = [("珠海↔澳门 9km", 8.7, (120, 200, 255)),
              ("合肥↔东京 2112km", 2112.1, (255, 200, 120)),
              ("北京↔伦敦 8141km", 8141.1, (255, 130, 130)),
              ("奥克兰↔马德里 19597km", 19596.6, (150, 255, 180))]
    scale = (base_y - (gy + 30)) / max(h_full * 1.15, 1e-6)
    for i, (name, d, col) in enumerate(legend):
        hm = h_max(d)
        pts = []
        for k in range(0, 101):
            t = k / 100
            x = gx + 24 + (gw - 48) * t
            y = base_y - hm * 4 * t * (1 - t) * scale
            pts.append((x, y))
        dr.line(pts, fill=col, width=3)
        dr.text((gx + gw - 268, gy + 12 + i * 19), f"{name}  hMax={hm:.3f}", font=font_s, fill=col)

    # 右：球占比随时间
    bx, by, bw, bh = 640, 64, 580, 340
    dr.rectangle([bx, by, bx + bw, by + bh], outline=(70, 84, 108))
    lo, hi = ratio_peak(math.pi * R_EARTH_KM), RATIO_NEAR

    def y_of(ratio):
        return by + bh - 30 - int((ratio - lo) / (hi - lo) * (bh - 74))

    for frac in (ratio_peak(math.pi * R_EARTH_KM), 0.80, RATIO_NEAR):
        yy = y_of(frac)
        dr.line([bx + 56, yy, bx + bw - 16, yy], fill=(38, 48, 66))
        dr.text((bx + 6, yy - 8), f"{frac * 100:.0f}%", font=font_s, fill=(150, 165, 190))
    for name, d, col in legend:
        pts = [(bx + 56 + (bw - 72) * t, y_of(r)) for t, _dist, r in dist_profile(d)]
        dr.line(pts, fill=col, width=3)
    dr.text((bx + 56, by + bh - 20), "时间（0 = 起点城市，1 = 终点城市）", font=font_s, fill=(160, 175, 200))
    dr.text((bx + 8, by - 20), "球直径 ÷ 视口短边", font=font_s, fill=(200, 212, 232))

    notes = [
        "h(t) = hMax · 4t(1-t)    标准抛物线：峰值在 t=0.5，两端贴地",
        f"hMax = {h_full} × (夹角/π)^{alt_pow}    弹道高度随距离增长 —— 『抛得多高』与距离成正比",
        f"最高点占比 = 0.86 × 1.04/(1.04+hMax) → 短途 0.860、对跖 {ratio_peak(math.pi * R_EARTH_KM):.4f}（恰为 2/3）",
        "只看 hMax 不够：短途 hMax≈0.001（轻轻一跳），大跨洲 hMax≈0.30（明显大抛）",
    ]
    y = gy + gh + 36
    for n in notes:
        dr.text((20, y), n, font=font_s, fill=(168, 182, 205))
        y += 22

    img.save(OUT)
    print(f"\n已输出 {OUT.relative_to(ROOT)}  {img.size[0]}x{img.size[1]}")
    print("看图要点：左图四条抛物线是否两端贴地、距离越远抛得越高；")
    print("右图球占比曲线是否中间最小、短途几乎平（轻轻一跳）、大跨洲明显下探。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
