#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
评估「添加所有国内市级行政单位」的可行性与代价。

老板要求：添加所有国内的市级行政单位。
现有 data/cities.json 里国内只有 43 城，要做的是把**地级行政区**补齐。

这个脚本不写任何数据文件，只回答三个问题：
  1. 到底有多少个？（地级市 / 地区 / 自治州 / 盟 分别是多少）
  2. 每个城市要付多少代价？（语音片段数量与体积、壁纸数量）
  3. 现有的语音方案能不能扛住？（片段命名、TTS 可用性）

数据源：GitHub 上的开源中国行政区划数据（含经纬度）。
用法：
    python tools/plan-cn-prefectures.py
    python tools/plan-cn-prefectures.py --source ./data/adm.json   # 用本地文件
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"
CACHE = ROOT / ".cache" / "cn-adm"

UA = "WeatherRouletteBot/0.1 (+https://github.com/noobdawn/WeatherRoulette)"

# 候选数据源（都带经纬度），按优先级尝试
SOURCES = [
    ("modood/Administrative-divisions-of-China pcas-code.json",
     "https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/pcas-code.json"),
    ("modood pcas.json",
     "https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/pcas.json"),
    ("中国行政区划（含经纬度）",
     "https://cdn.jsdelivr.net/gh/wecatch/china_regions@master/json/ok_data_level3.json"),
]


def fetch(url: str, name: str) -> object | None:
    CACHE.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in name)[:60]
    path = CACHE / f"{safe}.json"
    if path.exists() and path.stat().st_size > 1000:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
        path.write_bytes(raw)
        print(f"  下载成功：{name}（{len(raw) / 1024:.0f} KB）")
        return json.loads(raw.decode("utf-8"))
    except Exception as err:  # noqa: BLE001
        print(f"  失败：{name} → {type(err).__name__}: {err}")
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=str, default=None)
    args = ap.parse_args()

    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    existing = raw["cities"] if isinstance(raw, dict) else raw
    cn_existing = [c for c in existing if c.get("country") == "中国"]
    print(f"现有城市：{len(existing)} 座（其中中国 {len(cn_existing)} 座）")
    print(f"现有国内城市：{'、'.join(c['zh'] for c in cn_existing)}\n")

    print("一、探测数据源（需要「地级行政区 + 经纬度」）")
    data = None
    if args.source:
        data = json.loads(Path(args.source).read_text(encoding="utf-8"))
        print(f"  用本地文件：{args.source}")
    else:
        for name, url in SOURCES:
            print(f"  尝试 {name}")
            data = fetch(url, name)
            if data:
                break
    if not data:
        print("\n✗ 所有数据源都拿不到。需要换源（例如自己从民政部区划地名公共服务平台导出）。")
        return 1

    # 结构探测：列出顶层形状，便于判断怎么取「地级」
    print(f"\n  顶层类型：{type(data).__name__}")
    if isinstance(data, list):
        print(f"  顶层长度：{len(data)}")
        if data:
            print(f"  首项键：{list(data[0].keys()) if isinstance(data[0], dict) else type(data[0]).__name__}")
            print(f"  首项示例：{json.dumps(data[0], ensure_ascii=False)[:300]}")
    elif isinstance(data, dict):
        keys = list(data.keys())[:6]
        print(f"  顶层键（前 6）：{keys}")
        first = data[keys[0]]
        print(f"  首键的值类型：{type(first).__name__}"
              f"{f' 长度 {len(first)}' if hasattr(first, '__len__') else ''}")
        if isinstance(first, dict):
            print(f"  二级键示例：{list(first.keys())[:8]}")

    print(f"\n  缓存目录：{CACHE.relative_to(ROOT)}（已 gitignore，可删）")
    print("\n二、代价估算（等拿到地级清单后才能给准确数，先按规模量级算）")
    print("  每个城市需要：")
    print("    1) data/cities.json 一行（id/中英名/经纬度/时区/关键词）")
    print("    2) 1 个语音片段 assets/audio/zh/city/<id>.mp3（约 4.7KB/片段）")
    print("    3) 1 条壁纸 URL（可由工具从 Pexels/Pixabay 搜）")
    print("    4) 亮度网格重算（precompute-luminance.py）")
    print("\n  按约 300 个地级行政区估：")
    for n in (293, 333):
        audio_kb = n * 4.7
        print(f"    {n} 个：语音 +{audio_kb:.0f} KB、cities.json +{n * 0.4:.0f} KB、"
              f"wallpaper manifest +{n * 0.25:.0f} KB、亮度网格 +{n * 0.66:.0f} KB"
              f" → 部署包约 +{(audio_kb + n * 1.3) / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
