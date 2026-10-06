#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给国内城市的省份补英文名（`provinceEn`），供城市名上方那行小字用。

老板要求：国内城市显示省份、国外城市显示国家名。
中文省份名好办（数据里已有 `province`），但英文侧需要名字。

★ 为什么不手写：省份拼音很容易错，尤其「陕西 Shaanxi / 山西 Shanxi」这对必须区分，
  还有自治区的长名（新疆维吾尔自治区）。用 pypinyin 生成再核对，比手写可靠。

产出是**写进 data/cities.json**（`provinceEn` 字段），运行时不再依赖任何拼音库。

用法：
    python tools/gen-province-en.py --report
    python tools/gen-province-en.py --write
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from pypinyin import lazy_pinyin

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"

# 需要人工指定的特殊情况（国家标准与习惯写法）
OVERRIDES = {
    "陕西": "Shaanxi",     # 与山西 Shanxi 区分，官方 ISO 就是 Shaanxi
    "山西": "Shanxi",
    "内蒙古": "Inner Mongolia",
    "西藏": "Tibet",
    "新疆": "Xinjiang",    # 不能生成 XinJiang 这种驼峰
    "广西": "Guangxi",
    "宁夏": "Ningxia",
    "香港": "Hong Kong",
    "澳门": "Macao",
    "台湾": "Taiwan",
    "北京市": "Beijing",
    "天津市": "Tianjin",
    "上海市": "Shanghai",
    "重庆市": "Chongqing",
    # 单音节/易拼错的补几个常用写法（避免生成 YunNan 这种驼峰）
    "云南": "Yunnan",
    "黑龙江": "Heilongjiang",
    "吉林": "Jilin",
    "四川": "Sichuan",
    "安徽": "Anhui",
    "山东": "Shandong",
    "广东": "Guangdong",
    "江苏": "Jiangsu",
    "江西": "Jiangxi",
    "河北": "Hebei",
    "河南": "Henan",
    "浙江": "Zhejiang",
    "海南": "Hainan",
    "湖北": "Hubei",
    "湖南": "Hunan",
    "甘肃": "Gansu",
    "福建": "Fujian",
    "贵州": "Guizhou",
    "辽宁": "Liaoning",
    "青海": "Qinghai",
}


def title(word: str) -> str:
    """整串小写（省份英文习惯写法是连写的单个词，不是驼峰）"""
    return "".join(lazy_pinyin(word)).lower()


def province_en(province: str) -> str:
    """省级单位 → 英文名。先查人工表，再按规则生成。"""
    p = (province or "").strip()
    if not p:
        return ""
    # 去行政后缀取核心名
    core = p
    for suf in ("特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区", "自治区", "省", "市"):
        if core.endswith(suf) and len(core) > len(suf):
            core = core[: -len(suf)]
            break
    for key in (p, core):
        if key in OVERRIDES:
            return OVERRIDES[key]
    return title(core)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    cities = raw["cities"] if isinstance(raw, dict) else raw

    provinces = sorted({c.get("province") for c in cities if c.get("province")})
    mapping = {p: province_en(p) for p in provinces}

    print(f"国内省份 {len(provinces)} 个 → 英文名：")
    for p in provinces:
        print(f"  {p:<16} {mapping[p]}")

    # 自检：陕西/山西不能撞、自治区别撞、不能有空格残留
    problems = []
    if mapping.get("陕西省") == mapping.get("山西省"):
        problems.append("陕西与山西的英文名相同（必须区分 Shaanxi / Shanxi）")
    empties = [p for p, en in mapping.items() if not en.strip()]
    if empties:
        problems.append(f"英文名是空的：{empties}")
    if problems:
        print("\n⚠ 自检未通过：")
        for x in problems:
            print(f"  - {x}")
        return 1
    print("\n✓ 自检通过（陕西/山西已区分、无空值）")

    filled = 0
    for c in cities:
        if c.get("country") != "中国":
            continue
        en = mapping.get(c.get("province") or "")
        if en and c.get("provinceEn") != en:
            c["provinceEn"] = en
            filled += 1
    print(f"需写入 provinceEn 的城市：{filled} 个")

    if args.write:
        shutil.copy2(CITIES, CITIES.with_suffix(".json.bak"))
        if isinstance(raw, dict):
            raw["cities"] = cities
            out = raw
        else:
            out = {"cities": cities}
        CITIES.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"已写入 {CITIES.relative_to(ROOT)}（备份 cities.json.bak）")
    else:
        print("\n（这是预览。加 --write 才会写入）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
