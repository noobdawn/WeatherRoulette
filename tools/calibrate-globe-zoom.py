#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重新定标地球的「逼近/拉远」范围。

问题（由 tools/preview-globe-zoom.py 暴露）：
    老板要求「最远两城时地球恰好填满画面的三分之二」。
    但渲染器现在的基础半径是 R_base = min(w*0.44, h*0.34)，在 1440x900 下 = 306px，
    直径 612px 已经是**短边（900）的 68%** —— 比三分之二还大。
    于是"拉到三分之二"只需要缩小 2%（kFar = 0.9804），
    而"最近端"若定在 0.90 反而更小：**最远处比最近处还大，拉远效果为零**。

结论：**想要"明显的拉远"，就必须把近景的球做得明显更大、留出余量**，
让"拉远"体现为镜头退后而不是当前这种几乎不变。
这个脚本把候选范围列出来，供定调时直接看数字。

用法：
    python tools/calibrate-globe-zoom.py
    python tools/calibrate-globe-zoom.py --near-ratio 0.86 --far-ratio 0.667
"""
from __future__ import annotations

import argparse
import math
import sys

R_EARTH_KM = 6371.0088
MAXD = math.pi * R_EARTH_KM


def r_base(w: float, h: float) -> float:
    """渲染器里的基准半径（js/ui/globe.js）"""
    return min(w * 0.44, h * 0.34)


def k_for_ratio(ratio: float, w: float, h: float) -> float:
    """要让「球直径 = 短边 × ratio」所需的半径倍率"""
    target_r = ratio * 0.5 * min(w, h)
    return target_r / r_base(w, h)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--near-ratio", type=float, default=0.86,
                    help="最近两城时，球直径占视口短边的比例（近景要多大）")
    ap.add_argument("--far-ratio", type=float, default=2 / 3,
                    help="最远两城时，球直径占视口短边的比例（老板要求 2/3）")
    args = ap.parse_args()

    viewports = [("桌面 1440x900", 1440, 900), ("笔记本 1024x768", 1024, 768),
                 ("手机 375x812", 375, 812), ("大屏 1920x1080", 1920, 1080)]

    print("一、各视口下 R_base 与「直径占短边」的现状")
    print(f"  {'视口':<18}{'R_base':>9}{'直径':>9}{'短边':>7}{'占比':>9}{'kFar(2/3)':>11}")
    for name, w, h in viewports:
        rb, side = r_base(w, h), min(w, h)
        dia = 2 * rb
        print(f"  {name:<18}{rb:>9.1f}{dia:>9.1f}{side:>7}{dia / side:>9.4f}"
              f"{k_for_ratio(2 / 3, w, h):>11.4f}")
    print("\n  ↑ 现状：球本来就占短边 67~68%，「拉到三分之二」只需缩 2%，所以没有拉远效果。")

    print(f"\n二、按「近景 {args.near_ratio:.0%} / 远景 {args.far_ratio:.1%}」重新定标")
    print(f"  {'视口':<18}{'kNear':>9}{'kFar':>9}{'近景半径':>11}{'远景半径':>11}{'拉远幅度':>10}")
    for name, w, h in viewports:
        rb, side = r_base(w, h), min(w, h)
        kn = k_for_ratio(args.near_ratio, w, h)
        kf = k_for_ratio(args.far_ratio, w, h)
        rn, rf = rb * kn, rb * kf
        print(f"  {name:<18}{kn:>9.4f}{kf:>9.4f}{rn:>11.1f}{rf:>11.1f}"
              f"{(1 - rf / rn) * 100:>9.1f}%")
    print("\n  ↑ 拉远幅度 = 近景半径 → 远景半径缩小的百分比。两位数才算看得出来。")

    print("\n三、推荐写进 constants.js 的取值（各视口一致的那一组）")
    kn_list = [k_for_ratio(args.near_ratio, w, h) for _, w, h in viewports]
    kf_list = [k_for_ratio(args.far_ratio, w, h) for _, w, h in viewports]
    print(f"  kNear ∈ [{min(kn_list):.4f}, {max(kn_list):.4f}]"
          f"   跨度 {(max(kn_list) - min(kn_list)) * 100:.1f}%")
    print(f"  kFar  ∈ [{min(kf_list):.4f}, {max(kf_list):.4f}]"
          f"   跨度 {(max(kf_list) - min(kf_list)) * 100:.1f}%")
    print("  → 跨视口波动很小，所以 constants.js 里可以只用两个比例值：")
    print(f"      zoomNearMinSideRatio: {args.near_ratio}")
    print(f"      zoomFarMinSideRatio : {args.far_ratio}")
    print("    渲染器按每个视口实时反解 k，这样任何分辨率下两个比例都成立。")

    print("\n四、把比例换成「某距离下球多大」的实际观感（1440x900）")
    w, h = 1440, 900
    rb, side = r_base(w, h), min(w, h)
    kn = k_for_ratio(args.near_ratio, w, h)
    kf = k_for_ratio(args.far_ratio, w, h)
    power = 0.55
    rows = [("珠海↔澳门", 8.7), ("广州↔佛山", 18.8), ("北京↔天津", 113.0),
            ("合肥↔东京", 2112.1), ("北京↔伦敦", 8141.1), ("北京↔纽约", 11000.0),
            ("奥克兰↔马德里", 19596.6)]
    print(f"  {'城市对':<16}{'距离km':>10}{'k':>9}{'半径px':>9}{'直径/短边':>11}")
    for name, d in rows:
        t = min(1.0, d / MAXD) ** power
        k = kn + (kf - kn) * t
        r = rb * k
        print(f"  {name:<16}{d:>10.1f}{k:>9.4f}{r:>9.1f}{2 * r / side:>11.4f}")
    print(f"\n  注：严格的对跖距离是 {MAXD:.1f} km，本数据集最远只到 19596.6 km（t'=0.9884），")
    print("      所以最远城对的实测比例是 0.6689 而非精确的 2/3 —— 这是数据本身的上限，不是实现偏差。")
    print("      真正对跖的一对会精确落在 2/3。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
