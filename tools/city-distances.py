#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统计 81 座城市两两之间的大圆距离，用来给「地球缩放」定标。

需求背景（老板）：
    过场动画里地球离得太远。要做逼近与拉远，**拉远程度与城市间距离成正比**：
    相隔几百公里的，只拉远一点点；相隔几千公里的，拉到「地球恰好填满画面的三分之二」。

这个脚本只做一件事：把真实距离分布算出来，回答
  - 最近的城对有多近、最远的城对有多远
  - 分位数是多少（这样比例映射才有依据，而不是拍脑袋取常数）
  - 一轮播报里典型的「相邻两城」距离分布如何

用法：
    python tools/city-distances.py              # 打印统计
    python tools/city-distances.py --matrix     # 附带 20 个城市的距离矩阵样例
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"

R_EARTH_KM = 6371.0088


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def percentile(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return float("nan")
    k = (len(sorted_vals) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return sorted_vals[int(k)]
    return sorted_vals[lo] * (hi - k) + sorted_vals[hi] * (k - lo)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", action="store_true", help="额外打印一个距离矩阵样例")
    args = ap.parse_args()

    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    # cities.json 是 { version, note, cities: [...] }，不是裸数组
    cities = raw["cities"] if isinstance(raw, dict) else raw
    print(f"城市数：{len(cities)}")

    pairs: list[tuple[float, str, str]] = []
    for a, b in combinations(cities, 2):
        d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
        pairs.append((d, a["zh"], b["zh"]))
    pairs.sort()
    dists = [p[0] for p in pairs]

    print(f"\n两两距离样本数：{len(pairs)}（{len(cities)} 城全部组合）")
    print("\n分位数（km）：")
    for p in (0.0, 0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99, 1.0):
        print(f"  P{p * 100:>5.1f}  {percentile(dists, p):>9.1f}")

    print("\n最近的 8 对：")
    for d, a, b in pairs[:8]:
        print(f"  {d:>8.1f} km  {a} ↔ {b}")
    print("\n最远的 8 对：")
    for d, a, b in pairs[-8:]:
        print(f"  {d:>8.1f} km  {a} ↔ {b}")

    print(f"\n地球对跖点理论最大距离：{math.pi * R_EARTH_KM:.1f} km")
    print(f"本数据集最大距离占比：{dists[-1] / (math.pi * R_EARTH_KM) * 100:.1f}%")

    # 一轮播报是 20 城（国内 12 + 国际 8），相邻两城的距离才有意义。
    # 这里用「随机抽 20 城、按抽样顺序看相邻间隔」近似，给缩放的典型区间一个感觉。
    import random
    random.seed(20261005)
    adj: list[float] = []
    for _ in range(4000):
        sample = random.sample(cities, min(20, len(cities)))
        for i in range(len(sample) - 1):
            adj.append(haversine(sample[i]["lat"], sample[i]["lon"],
                                 sample[i + 1]["lat"], sample[i + 1]["lon"]))
    adj.sort()
    print(f"\n模拟「一轮 20 城」里相邻两城的距离（{len(adj)} 个样本）：")
    for p in (0.05, 0.25, 0.50, 0.75, 0.95):
        print(f"  P{p * 100:>5.1f}  {percentile(adj, p):>9.1f} km")

    if args.matrix:
        sample = cities[:14]
        print("\n距离矩阵样例（km，行=起点 列=终点）：")
        header = "        " + "".join(f"{c['zh'][:4]:>9}" for c in sample)
        print(header)
        for a in sample:
            row = f"{a['zh'][:6]:>6}  "
            for b in sample:
                row += f"{haversine(a['lat'], a['lon'], b['lat'], b['lon']):>9.0f}"
            print(row)

    return 0


if __name__ == "__main__":
    sys.exit(main())
