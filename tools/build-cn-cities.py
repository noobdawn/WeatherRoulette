#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「国内地级行政区」清单转成 data/cities.json 的城市记录，供扩充国内城市用。

老板要求：添加所有国内的市级行政单位。
上游清单由 tools/gen-cn-prefectures.py 生成（带经纬度，与官方层级交叉校验过）。

产出每条记录的字段与现有 43 个国内城市保持一致：
    id        拼音短横线（唯一，且必须与 assets/audio/zh/city/<id>.mp3 文件名一致）
    zh / en   中英文名（en 用拼音标题化；地区/自治州给缩写形式）
    country / countryEn / region
    lat / lon / timezone    经纬度来自上游；时区统一 Asia/Shanghai
                            （国内地级行政区全部落在东八区，含新疆西藏的法定时区）
    keywords  壁纸搜索词：先放 city 名与 province 名，具体地标由壁纸工具或人工补

用法：
    python tools/build-cn-cities.py --report          # 只打印将要新增的清单与统计
    python tools/build-cn-cities.py --write           # 写入 data/cities.json（会备份原文件）
    python tools/build-cn-cities.py --write --dry-run # 写到一个临时文件供检查
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
PREFS = ROOT / ".cache" / "cn-adm" / "prefectures.json"

TIMEZONE = "Asia/Shanghai"

# 省级 → 大区（沿用现有 43 城的分区习惯，界面与关键词都用得上）
REGION_OF_PROVINCE = {
    "北京市": "华北", "天津市": "华北", "河北省": "华北", "山西省": "华北",
    "内蒙古自治区": "华北",
    "辽宁省": "东北", "吉林省": "东北", "黑龙江省": "东北",
    "上海市": "华东", "江苏省": "华东", "浙江省": "华东", "安徽省": "华东",
    "福建省": "华东", "江西省": "华东", "山东省": "华东", "台湾省": "华东",
    "河南省": "华中", "湖北省": "华中", "湖南省": "华中",
    "广东省": "华南", "广西壮族自治区": "华南", "海南省": "华南",
    "香港特别行政区": "华南", "澳门特别行政区": "华南",
    "重庆市": "西南", "四川省": "西南", "贵州省": "西南", "云南省": "西南",
    "西藏自治区": "西南",
    "陕西省": "西北", "甘肃省": "西北", "青海省": "西北",
    "宁夏回族自治区": "西北", "新疆维吾尔自治区": "西北",
}

# 自治州/地区/盟 的英文用「主体名 + 类型」，避免整串拼音过长
SUFFIX_EN = {
    "自治州": "Prefecture",
    "地区": "Prefecture",
    "盟": "League",
    "市": "City",
    "特别行政区": "SAR",
}


def title_pinyin(text: str) -> str:
    """中文 → 拼音 id（小写短横线）"""
    parts = lazy_pinyin(text)
    clean: list[str] = []
    for p in parts:
        p = "".join(ch for ch in p.lower() if ch.isalnum())
        if p:
            clean.append(p)
    return "-".join(clean)


def english_name(zh: str) -> str:
    """英文名：主体名的拼音标题化 + 行政区类型。"""
    for suf, en in SUFFIX_EN.items():
        if zh.endswith(suf) and len(zh) > len(suf):
            core = zh[: -len(suf)]
            return f"{''.join(w.capitalize() for w in lazy_pinyin(core))} {en}"
    return "".join(w.capitalize() for w in lazy_pinyin(zh))


def province_initials(province: str) -> str:
    """省份拼音首字母（取每个音节首字母），用于 id 去重后缀。
    用首字母而不是全拼：`tai-zhou-shi-zj` 比 `tai-zhou-shi-zhe-jiang-sheng` 短得多，
    音频文件名也更好看。"""
    return "".join(p[0] for p in lazy_pinyin(province) if p)


def make_record(p: dict) -> dict:
    raw_zh = p["zh"]
    # 与现有城市统一格式：地级市去掉「市」后缀（现有是「南宁」不是「南宁市」）；
    # 自治州/地区/盟保留全名（它们不以「市」结尾，本来就没有后缀可去）。
    zh = raw_zh[:-1] if raw_zh.endswith("市") and len(raw_zh) > 1 else raw_zh
    province = p["province"]
    return {
        "id": title_pinyin(zh),
        "zh": zh,
        "en": english_name(raw_zh),
        "country": "中国",
        "countryEn": "China",
        "region": REGION_OF_PROVINCE.get(province, "其它"),
        "province": province,
        "lat": p["lat"],
        "lon": p["lon"],
        "timezone": TIMEZONE,
        # 具体地标关键词需要人工或壁纸工具补；先用城市名与省名保证搜索有词可用
        "keywords": [zh, province],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="只打印，不写")
    ap.add_argument("--write", action="store_true", help="写入 data/cities.json")
    ap.add_argument("--dry-run", action="store_true", help="配合 --write：写到临时文件")
    args = ap.parse_args()

    if not PREFS.exists():
        print(f"✗ 找不到 {PREFS.relative_to(ROOT)}，请先跑 python tools/gen-cn-prefectures.py")
        return 1

    data = json.loads(PREFS.read_text(encoding="utf-8"))
    prefs = data["prefectures"]

    # 只上选定的那批（老板决定「先加 100 个常见的」；选法见 tools/select-cn-cities.py）
    selected_path = ROOT / ".cache" / "cn-adm" / "selected.json"
    if selected_path.exists():
        sel = json.loads(selected_path.read_text(encoding="utf-8"))
        keep = {m["zh"] for m in sel["selected"]}
        prefs = [p for p in prefs if p["zh"] in keep]
        print(f"按 selected.json 限定为 {len(prefs)} 个（共 {data['count']} 个地级行政区）")

    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    existing = raw["cities"] if isinstance(raw, dict) else raw
    have_ids = {c["id"] for c in existing}
    have_zh = {c["zh"].rstrip("市") for c in existing if c.get("country") == "中国"}

    records = [make_record(p) for p in prefs]

    # 与现有城市去重：同名（忽略「市」后缀）视为已有
    to_add: list[dict] = []
    skipped: list[str] = []
    for r in records:
        if r["zh"].rstrip("市") in have_zh:
            skipped.append(r["zh"])
            continue
        to_add.append(r)

    # id 唯一性检查（含与现有 id 冲突）。
    # ⚠ 拼音会撞车：台州/泰州 → tai-zhou-shi、榆林/玉林 → yu-lin-shi、
    #   伊春/宜春 → yi-chun-shi。撞了就补上省份拼音做区分（如 tai-zhou-shi-zhe-jiang）。
    seen: dict[str, str] = {}
    disambiguated: list[str] = []
    for r in to_add:
        if r["id"] in have_ids or r["id"] in seen:
            suffix = province_initials(r["province"])
            new_id = f"{r['id']}-{suffix}"
            # 万一连省名也撞（同省同名不可能，但防御一下）
            n = 2
            while new_id in have_ids or new_id in seen:
                new_id = f"{r['id']}-{suffix}-{n}"
                n += 1
            disambiguated.append(f"{r['zh']}（{r['province']}）→ {new_id}")
            r["id"] = new_id
        seen[r["id"]] = r["zh"]

    print(f"上游地级行政区：{len(prefs)} 个")
    print(f"已在 cities.json 里（按名称匹配）：{len(skipped)} 个")
    print(f"需要新增：{len(to_add)} 个")
    if disambiguated:
        print(f"\n拼音撞车的 {len(disambiguated)} 个已用省份后缀区分：")
        for c in disambiguated:
            print(f"    {c}")
    print("✓ id 全部唯一（含与现有城市比对）")

    print(f"\n新增清单（前 30，共 {len(to_add)}）：")
    for r in to_add[:30]:
        print(f"    {r['zh']:<12} {r['en']:<34} {r['region']:<4} "
              f"{r['lat']:>7.2f},{r['lon']:>8.2f}  id={r['id']}")

    by_region: dict[str, int] = {}
    for r in to_add:
        by_region[r["region"]] = by_region.get(r["region"], 0) + 1
    print(f"\n按大区分布：{by_region}")

    if not (args.write or args.dry_run):
        print("\n（这是预览。加 --write 才会写入 data/cities.json）")
        return 0

    merged = existing + to_add
    out = dict(raw) if isinstance(raw, dict) else {"cities": merged}
    out["cities"] = merged
    if isinstance(raw, dict):
        out["note"] = raw.get("note", "")
        out["version"] = raw.get("version", 1)

    target = CITIES
    if args.dry_run:
        target = ROOT / ".cache" / "cn-adm" / "cities.dryrun.json"
    else:
        shutil.copy2(CITIES, CITIES.with_suffix(".json.bak"))
        print(f"\n已备份原文件到 {CITIES.with_suffix('.json.bak').name}")

    target.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已写入 {target.relative_to(ROOT)}（城市总数 {len(merged)}）")

    print("\n下一步：")
    print("  1) python tools/gen-audio.py --only city    # 生成新增城市名的语音片段")
    print("  2) python tools/trim-audio.py               # 裁掉首尾静音（必须）")
    print("  3) 补 assets/images/manifest.json 的壁纸（缺图的城市会走首字插画兜底）")
    print("  4) python tools/precompute-luminance.py     # 重算亮度网格")
    print("  5) 把 sw.js 的 CACHE_VERSION 加一")
    return 0


if __name__ == "__main__":
    sys.exit(main())
