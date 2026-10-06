#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 297 个待新增的地级行政区里挑出「最该先上的 100 个」，依据必须客观可查。

背景（老板的决定）：
  - 上「先加 100 个常见的」，不是一次铺满 297 个
  - 「不要搞什么一轮配额，直接全额随机」→ 抽样时不再分国内/国外

★ 关键原则：**不凭记忆编城市名单**（那样极易把地级市误当副省级、或漏掉省会）。
  判定依据全部来自行政区划代码，代码是唯一的、可核对的：
    省级代码        11 北京  12 天津  13 河北  14 山西  15 内蒙古
                    21 辽宁  22 吉林  23 黑龙江
                    31 上海  32 江苏  33 浙江  34 安徽  35 福建  36 江西  37 山东
                    41 河南  42 湖北  43 湖南  44 广东  45 广西  46 海南
                    50 重庆  51 四川  52 贵州  53 云南  54 西藏
                    61 陕西  62 甘肃  63 青海  64 宁夏  65 新疆
    ★ 地级代码以 **90** 结尾 = 省直辖县级行政区划（如河南济源），不是地级市
    ★ 副省级市 15 个（代码可查）：哈尔滨 230100、长春 220100、沈阳 210100、大连 210200、
      济南 370100、青岛 370200、南京 320100、杭州 330100、宁波 330200、厦门 350200、
      武汉 420100、广州 440100、深圳 440300、成都 510100、西安 610100

排序依据（从客观到主观，权重递减）：
  1. 省会/首府（每个省级单位一个，必有）
  2. 副省级市
  3. 名字短的优先（2~3 字，孩子好念好记；自治州/地区名通常很长）
  4. 纬度/人口等其它信息本数据集没有，不硬凑

用法：
    python tools/select-cn-cities.py                # 打印入选清单与统计
    python tools/select-cn-cities.py --count 120    # 换个数
    python tools/select-cn-cities.py --json out.json
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PREFS = ROOT / ".cache" / "cn-adm" / "prefectures.json"
PCAS_CACHE = ROOT / ".cache" / "cn-adm" / "pcas-code.json"
OUT_DEFAULT = ROOT / ".cache" / "cn-adm" / "selected.json"

PCAS_URL = "https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/pcas-code.json"

# ★ 必选省份：这些省份的地级行政区**全部入选**，优先于"按名字长短排序"的规则。
#   原因：老板是广西人，明确要求「广西省内的城市都添加一下」——
#   家乡城市对孩子有特别意义，不该被"名字短的优先"这种通用排序挤掉。
#   以后想加别的必选省份，往这里加一行即可（不要硬编码到别处）。
MUST_INCLUDE_PROVINCES = [
    "广西壮族自治区",
]

# 副省级市（中央编办口径）。⚠ pcas 里地级代码是 **4 位**（如哈尔滨 2301），
# 而通行写法是 6 位（230100），所以比对时统一取前 4 位 —— 早期版本直接拿 6 位比对 4 位，
# 结果「副省级市 0 个」，名单里全是按名字长短选的，把省会都漏了。
SUB_PROVINCIAL_CODES_6 = {
    "230100", "220100", "210100", "210200", "370100", "370200", "320100",
    "330100", "330200", "350200", "420100", "440100", "440300", "510100", "610100",
}
SUB_PROVINCIAL_CODES = {c[:4] for c in SUB_PROVINCIAL_CODES_6}


def load_pcas() -> list[dict]:
    if PCAS_CACHE.exists() and PCAS_CACHE.stat().st_size > 1000:
        return json.loads(PCAS_CACHE.read_text(encoding="utf-8"))
    req = urllib.request.Request(PCAS_URL, headers={"User-Agent": "WeatherRouletteBot/0.1"})
    raw = urllib.request.urlopen(req, timeout=120).read()
    PCAS_CACHE.write_bytes(raw)
    return json.loads(raw.decode("utf-8"))


def build_prefecture_meta(pcas: list[dict]) -> list[dict]:
    """从 pcas 取出地级条目：{code, name, province, code_province, is_capital, is_sub_provincial}"""
    out: list[dict] = []
    for prov in pcas:
        pcode = str(prov.get("code") or "")
        pname = (prov.get("name") or "").strip()
        children = prov.get("children") or []
        # 省会/首府：pcas 的第一条通常是省会（直辖市的 children 是「市辖区」）
        first_real = None
        for child in children:
            name = (child.get("name") or "").strip()
            if not name or name in ("市辖区", "县"):
                continue
            first_real = name
            break
        for child in children:
            code = str(child.get("code") or "")
            name = (child.get("name") or "").strip()
            if not name:
                continue
            # 跳过非地级：市辖区、省直辖县级行政区划、单字「县」
            if name in ("市辖区", "县", "省直辖县级行政区划", "自治区直辖县级行政区划"):
                continue
            # ★ 地级代码以 90 结尾 = 省直辖县级行政区划
            if code.endswith("90"):
                continue
            if len(code) != 4:
                continue
            out.append({
                "code": code,
                "name": name,
                "province": pname,
                "provinceCode": pcode,
                "isCapital": name == first_real,
                "isSubProvincial": code in SUB_PROVINCIAL_CODES,
            })
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--json", type=str, default=str(OUT_DEFAULT))
    args = ap.parse_args()

    data = json.loads(PREFS.read_text(encoding="utf-8"))
    prefs = data["prefectures"]
    new_zh = {p["zh"] for p in data["new"]}

    pcas = load_pcas()
    meta = build_prefecture_meta(pcas)
    print(f"pcas 地级条目：{len(meta)} 个（去掉市辖区/省直辖县级行政区划/代码 90 结尾的）")

    capitals = [m for m in meta if m["isCapital"]]
    subs = [m for m in meta if m["isSubProvincial"]]
    print(f"  省会/首府：{len(capitals)} 个")
    print(f"  副省级市：{len(subs)} 个 → {'、'.join(m['name'] for m in subs)}")

    # 归一化：pcas 的「市」后缀可能与上游「州/地区/盟」写法不同，用去后缀匹配
    def norm(n: str) -> str:
        for s in ("自治州", "地区", "盟", "市"):
            if n.endswith(s):
                return n[: -len(s)]
        return n

    meta_new = [m for m in meta if m["name"] in new_zh]
    print(f"\n待新增的 297 个里，能对上 pcas 元信息的：{len(meta_new)} 个")
    unmatched = sorted(new_zh - {m["name"] for m in meta})[:10]
    if unmatched:
        print(f"  对不上的（只在 city-geo 里有）：{'、'.join(unmatched)}")

    # 打分：必选省份最优先，其次省会，再副省级，最后其它；同级内名字短的优先（孩子好念）
    def rank_key(m: dict):
        if m["province"] in MUST_INCLUDE_PROVINCES:
            tier = 0
        elif m["isCapital"]:
            tier = 1
        elif m["isSubProvincial"]:
            tier = 2
        else:
            tier = 3
        return (tier, len(m["name"]), m["name"])

    ordered = sorted(meta_new, key=rank_key)
    picked = ordered[: args.count]
    rest = ordered[args.count:]

    # 必选省份可能因为名额不够被截断 —— 这里显式保证它们全进
    must = [m for m in meta_new if m["province"] in MUST_INCLUDE_PROVINCES]
    missing_must = [m for m in must if m not in picked]
    if missing_must:
        # 把排在末尾的非必选城市挤出去，给必选省份腾位
        picked = [m for m in picked if m["province"] not in MUST_INCLUDE_PROVINCES]
        picked = picked[: max(0, args.count - len(must))] + must
        picked = sorted(picked, key=rank_key)
        rest = [m for m in ordered if m not in picked]
        print(f"  ★ 必选省份 {MUST_INCLUDE_PROVINCES} 有 {len(missing_must)} 个被名额挤掉，"
              f"已腾位补回：{'、'.join(m['name'] for m in missing_must)}")

    print(f"\n入选 {len(picked)} 个（必选省份 → 省会 → 副省级 → 名字短）：")
    by_tier: dict[int, list[str]] = {0: [], 1: [], 2: [], 3: []}
    for m in picked:
        if m["province"] in MUST_INCLUDE_PROVINCES:
            tier = 0
        elif m["isCapital"]:
            tier = 1
        elif m["isSubProvincial"]:
            tier = 2
        else:
            tier = 3
        by_tier[tier].append(m["name"])
    labels = {0: "必选省份", 1: "省会/首府", 2: "副省级", 3: "其它"}
    for tier in (0, 1, 2, 3):
        if by_tier[tier]:
            preview = "、".join(by_tier[tier][:40])
            print(f"  {labels[tier]:<10} {len(by_tier[tier]):>3} 个：{preview}"
                  f"{'…' if len(by_tier[tier]) > 40 else ''}")

    print(f"\n未入选（留待以后）：{len(rest)} 个，前 20："
          f"{'、'.join(m['name'] for m in rest[:20])}")

    outp = Path(args.json)
    outp.write_text(json.dumps({
        "count": len(picked),
        "note": "必选省份（见 MUST_INCLUDE_PROVINCES）全部入选；其余按 省会/首府 → 副省级 → 名字短 排序；"
                "判定全部来自行政区划代码，不凭记忆",
        "mustIncludeProvinces": MUST_INCLUDE_PROVINCES,
        "selected": [{"zh": m["name"], "province": m["province"], "code": m["code"],
                      "isCapital": m["isCapital"], "isSubProvincial": m["isSubProvincial"],
                      "mustInclude": m["province"] in MUST_INCLUDE_PROVINCES}
                     for m in picked],
        "rest": [m["name"] for m in rest],
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n已写入 {outp.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
