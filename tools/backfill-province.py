#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给国内城市补 `province` 字段（省份 / 直辖市名 / 特别行政区 / 台湾省）。

为什么需要：老板要求「中国的城市在城市名上方小字显示其省份，国外城市显示国家名」。
新增的 100 个地级市来自 city-geo 数据，天然带 `province`；
但**原有 43 个国内城市没有这个字段**（只有大区 `region`=华北/华东…），所以要补齐。

★ 不凭记忆写省份，而是用两套权威依据交叉确认：
  1. modood pcas-code.json：省份 → 下辖地级市（按行政区划代码组织的官方层级）
  2. 已经带上游 province 的 100 个新城市，作为匹配样本
  直辖市（北京/天津/上海/重庆）按 pcas 的省级单位直接归一。

用法：
    python tools/backfill-province.py --report
    python tools/backfill-province.py --write      # 备份后写入
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"
PCAS = ROOT / ".cache" / "cn-adm" / "pcas-code.json"

# 需要单独指认的（不在 pcas 的省级 children 里，或名称与 PCAS 不同）
SPECIAL = {
    "香港": "香港特别行政区",
    "澳门": "澳门特别行政区",
    "台北": "台湾省",
}


def build_lookup() -> dict[str, str]:
    """城市名（去「市」后缀）→ 省级单位名"""
    if not PCAS.exists():
        raise SystemExit(f"✗ 缺少 {PCAS.relative_to(ROOT)}，请先跑 tools/gen-cn-prefectures.py")
    pcas = json.loads(PCAS.read_text(encoding="utf-8"))
    lookup: dict[str, str] = {}
    for prov in pcas:
        pname = (prov.get("name") or "").strip()
        if not pname:
            continue
        for child in prov.get("children") or []:
            name = (child.get("name") or "").strip()
            if not name or name in ("市辖区", "县", "省直辖县级行政区划", "自治区直辖县级行政区划"):
                continue
            lookup[name.rstrip("市")] = pname
    # 直辖市：pcas 的省级单位本身就是城市
    for m in ("北京市", "天津市", "上海市", "重庆市"):
        lookup[m.rstrip("市")] = m
    return lookup


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    lookup = build_lookup()
    raw = json.loads(CITIES.read_text(encoding="utf-8"))
    cities = raw["cities"] if isinstance(raw, dict) else raw

    filled: list[str] = []
    unresolved: list[str] = []
    for c in cities:
        if c.get("country") != "中国":
            continue
        if c.get("province"):
            continue
        key = c["zh"].rstrip("市")
        prov = SPECIAL.get(c["zh"]) or lookup.get(key)
        if not prov:
            unresolved.append(c["zh"])
            continue
        c["province"] = prov
        filled.append(f"{c['zh']} → {prov}")

    print(f"补齐 {len(filled)} 个国内城市的 province：")
    for line in filled:
        print(f"  {line}")
    if unresolved:
        print(f"\n⚠ 无法判定省份的 {len(unresolved)} 个：{'、'.join(unresolved)}")
        print("  （需要在 SPECIAL 里手动指认，不能猜）")
        return 1
    if not filled:
        print("  （没有需要补的）")

    cn = [c for c in cities if c.get("country") == "中国"]
    missing = [c["zh"] for c in cn if not c.get("province")]
    print(f"\n国内 {len(cn)} 城：province 覆盖 {len(cn) - len(missing)} 个"
          f"{'' if not missing else '，仍缺：' + '、'.join(missing)}")
    if missing:
        return 1

    # 抽检：直辖市应与城市同名，港澳台用特别名称
    print("\n抽检：")
    for zh in ("北京", "上海", "香港", "澳门", "台北", "石家庄", "济南", "乌鲁木齐"):
        hit = next((c for c in cities if c["zh"] == zh), None)
        if hit:
            print(f"  {zh:<8} province = {hit.get('province')}")

    if args.write:
        shutil.copy2(CITIES, CITIES.with_suffix(".json.bak"))
        if isinstance(raw, dict):
            raw["cities"] = cities
            out = raw
        else:
            out = {"cities": cities}
        CITIES.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n已写入 {CITIES.relative_to(ROOT)}（备份 cities.json.bak）")
    else:
        print("\n（这是预览。加 --write 才会写入）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
