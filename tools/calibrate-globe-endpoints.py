#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
定标弹道两端（起飞/落地）的相机距离：老板要求「比现在近 80% 以上」。

歧义与取舍（写下来免得后人再猜）：
    老板原话「调整动画开始和末端的距离，要比现在近80%以上！」
    "距离"在弹道模型里是**相机到球心的距离**（camera distance），不是屏幕上的球径。
    两种解读的数值差 5 倍：
      A. 相机距离 → 现在的 20%（近 80%）→ 球变大 5 倍 → 球直径占满屏幕 430%，**显然不可行**
      B. 相机高度（贴地余量 h）→ 现在的 20%          → 球**变小** 5 倍
    采用 B：与"距离变近=相机贴得更近"在观感上一致，且不会让球超出画面。
    实现上就是 nearMinSideRatio 按同比例缩小（球径 ∝ 1/相机距离）。

用法：
    python tools/calibrate-globe-endpoints.py
    python tools/calibrate-globe-endpoints.py --ratio 0.17
"""
from __future__ import annotations

import argparse
import math
import sys

R_EARTH_KM = 6371.0088
BASE_ALT = 0.04          # cameraBaseAlt
ARC_FULL = 0.30          # arcHeightFull
ARC_POW = 0.75           # arcHeightPower


def ratio_at(d_km: float, near: float) -> float:
    """本趟飞行最高点时的球占比（半径 ∝ 1/相机距离）"""
    span = min(1.0, (d_km / R_EARTH_KM) / math.pi)
    hmax = ARC_FULL * span ** ARC_POW
    return near * (1 + BASE_ALT) / (1 + BASE_ALT + hmax)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ratio", type=float, default=0.172,
                    help="新的 nearMinSideRatio（贴地时的球直径 / 视口短边）")
    ap.add_argument("--old", type=float, default=0.86, help="旧的 nearMinSideRatio")
    args = ap.parse_args()
    near, old = args.ratio, args.old

    print(f"nearMinSideRatio: {old} → {near}")
    for label, viewports in (("按视口", [("1440x900", 1440, 900), ("1024x768", 1024, 768),
                                        ("375x812", 375, 812)]),):
        print(f"\n{label}（贴地 = 两端 / 最高点 = 中途）：")
        print(f"  {'视口':<12}{'短边':>7}{'旧贴地直径':>12}{'新贴地直径':>12}"
              f"{'近了多少':>10}{'新最高点直径':>14}")
        for name, w, h in viewports:
            side = min(w, h)
            old_d = old * side
            new_d = near * side
            print(f"  {name:<12}{side:>7}{old_d:>12.0f}{new_d:>12.0f}"
                  f"{(1 - new_d / old_d) * 100:>9.0f}%{ratio_at(19596.6, near) * side:>14.0f}")

    print("\n相机距离（地球半径=1）：")
    d_old = (1 + BASE_ALT) / old
    d_new = (1 + BASE_ALT) / near
    print(f"  旧贴地距离 / 半径 = (1+{BASE_ALT})/{old} = {d_old:.3f}")
    print(f"  新贴地距离 / 半径 = (1+{BASE_ALT})/{near} = {d_new:.3f}")
    print(f"  → 相机贴近了 {(1 - d_new / d_old) * 100:.0f}%")

    print("\n各距离下球占短边的比例：")
    print(f"  {'城市对':<16}{'距离km':>10}{'最高点(中途)':>14}{'贴地(两端)':>12}{'动态范围':>10}")
    for name, d in (("珠海↔澳门", 8.7), ("北京↔天津", 102.8), ("合肥↔东京", 2112.1),
                    ("北京↔伦敦", 8141.1), ("奥克兰↔马德里", 19596.6)):
        peak = ratio_at(d, near)
        print(f"  {name:<16}{d:>10.1f}{peak:>14.4f}{near:>12.4f}{peak / near:>9.2f}x")
    peak_max = ratio_at(math.pi * R_EARTH_KM, near)
    print(f"  {'对跖（理论）':<16}{math.pi * R_EARTH_KM:>10.1f}{peak_max:>14.4f}{near:>12.4f}"
          f"{peak_max / near:>9.2f}x")
    print(f"\n  最远城对中途仍是短边的 {peak_max * 100:.1f}%（老板要求的 2/3 ≈ 66.7%，"
          f"偏差 {(peak_max / (2 / 3) - 1) * 100:+.2f}%）")
    print(f"  中途/两端的动态范围最大 {peak_max / near:.2f}x —— 这就是「抛出去再落回来」的观感强度")
    return 0


if __name__ == "__main__":
    sys.exit(main())
