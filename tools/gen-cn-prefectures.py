#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「国内地级行政区」清单导出来，作为扩充 cities.json 的依据。

老板要求：添加所有国内的市级行政单位。
现有 data/cities.json 里国内只有 43 城，需要补齐地级行政区（地级市 + 地区 + 自治州 + 盟）。

数据来源（两个源交叉校验，互为补充）：
  1. 88250/city-geo 的 data.json —— 带 **经纬度**（刚需：天气查询与地球投影都要）
     结构：[{ province, city, area, lat, lng, country }]，
     `area` 为空表示这条就是「地级本身」；`area` 非空是下属区县。
  2. modood/Administrative-divisions-of-China 的 pcas-code.json —— 官方口径的层级，
     用来核对地级数量、发现遗漏。

用法：
    python tools/gen-cn-prefectures.py                 # 下载 + 生成清单
    python tools/gen-cn-prefectures.py --report        # 只打印统计，不写文件
    python tools/gen-cn-prefectures.py --json out.json # 写到指定路径
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "cn-adm"
OUT_DEFAULT = ROOT / ".cache" / "cn-adm" / "prefectures.json"

UA = "WeatherRouletteBot/0.1 (+https://github.com/noobdawn/WeatherRoulette)"
GEO_URL = "https://raw.githubusercontent.com/88250/city-geo/master/data.json"
PCAS_URL = "https://cdn.jsdelivr.net/gh/modood/Administrative-divisions-of-China@master/dist/pcas-code.json"

# 四个直辖市在 city-geo 里 city 字段是「市辖区」，要按 province 归一成城市名
MUNICIPALITIES = {"北京市", "天津市", "上海市", "重庆市"}


def fetch(url: str, name: str, tries: int = 4) -> bytes:
    """下载并缓存（GitHub raw 偶尔超时，必须重试）。"""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if path.exists() and path.stat().st_size > 1000:
        print(f"  用缓存 {name}（{path.stat().st_size / 1024:.0f} KB）")
        return path.read_bytes()
    last = None
    for i in range(tries):
        try:
            print(f"  下载 {name}（第 {i + 1} 次）")
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
            if len(raw) < 1000:
                raise ValueError(f"内容过短（{len(raw)} 字节）")
            path.write_bytes(raw)
            print(f"  成功 {len(raw) / 1024:.0f} KB")
            return raw
        except Exception as err:  # noqa: BLE001
            last = err
            print(f"    失败：{type(err).__name__}: {str(err)[:100]}")
            time.sleep(2 + i * 2)
    raise RuntimeError(f"{name} 下载失败：{last}")


def load_geo() -> list[dict]:
    raw = fetch(GEO_URL, "city-geo-data.json")
    return json.loads(raw.decode("utf-8"))


def load_pcas() -> list[dict]:
    raw = fetch(PCAS_URL, "pcas-code.json")
    return json.loads(raw.decode("utf-8"))


def build_prefectures(geo: list[dict]) -> list[dict]:
    """把 city-geo 里 `area` 为空的条目整理成地级清单。"""
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    dupes: list[str] = []
    for row in geo:
        if row.get("area"):
            continue
        province = (row.get("province") or "").strip()
        city = (row.get("city") or "").strip()
        if not province or not city:
            continue
        # 直辖市：city 是「市辖区」，用 province 的名字
        if city == "市辖区" and province in MUNICIPALITIES:
            city = province
        if city in ("省直辖县级行政区划", "自治区直辖县级行政区划"):
            # 这类不是地级市（如湖北的仙桃/潜江/天门），跳过
            continue
        # 上游混进的脏数据：省下面直接挂一个「县」「市辖区」之类，不是地级
        if city in ("县", "市", "区") or (city.endswith("县") and not city.endswith("自治县")):
            continue
        key = (province, city)
        if key in seen:
            dupes.append(f"{province} {city}")
            continue
        seen.add(key)
        try:
            lat = float(row["lat"])
            lon = float(row["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        out.append({
            "zh": city,
            "province": province,
            "lat": round(lat, 4),
            "lon": round(lon, 4),
        })
    if dupes:
        print(f"  去重：跳过 {len(dupes)} 条重复（{dupes[:3]}…）")
    out.sort(key=lambda x: (x["province"], x["zh"]))
    return out


def pcas_prefecture_names(pcas: list[dict]) -> list[str]:
    """从 pcas 里取地级名（省级的 children 再下一层）。"""
    names: list[str] = []
    for prov in pcas:
        for child in prov.get("children") or []:
            name = (child.get("name") or "").strip()
            if not name or name in ("市辖区", "省直辖县级行政区划", "自治区直辖县级行政区划", "县"):
                continue
            names.append(name)
    return names


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="只打印统计，不写文件")
    ap.add_argument("--json", type=str, default=str(OUT_DEFAULT), help="输出路径")
    args = ap.parse_args()

    print("一、取带经纬度的地级清单（88250/city-geo）")
    geo = load_geo()
    print(f"  原始记录 {len(geo)} 条（含区县）")
    prefs = build_prefectures(geo)
    print(f"  → 地级行政区 {len(prefs)} 个")

    print("\n二、与官方层级交叉校验（modood pcas-code）")
    try:
        pcas = load_pcas()
        pcas_names = set(pcas_prefecture_names(pcas))
        print(f"  pcas 里的省级单位 {len(pcas)} 个、地级名 {len(pcas_names)} 个")
        mine = {p["zh"] for p in prefs}
        only_pcas = sorted(pcas_names - mine)
        only_mine = sorted(mine - pcas_names)
        print(f"  只在 pcas 里（我漏了）：{len(only_pcas)} 个"
              f"{' → ' + '、'.join(only_pcas[:12]) if only_pcas else ''}")
        print(f"  只在我这里（pcas 没有）：{len(only_mine)} 个"
              f"{' → ' + '、'.join(only_mine[:12]) if only_mine else ''}")
    except Exception as err:  # noqa: BLE001
        print(f"  校验源不可用，跳过：{type(err).__name__}: {str(err)[:80]}")

    print("\n三、分类统计")
    provs = collections.Counter(p["province"] for p in prefs)
    print(f"  覆盖省级单位 {len(provs)} 个")
    suf = collections.Counter()
    for p in prefs:
        for s in ("自治州", "地区", "盟", "市"):
            if p["zh"].endswith(s):
                suf[s] += 1
                break
        else:
            suf["其它"] += 1
    print(f"  后缀分布：{dict(suf)}")
    print(f"  经纬度范围：lat {min(p['lat'] for p in prefs)}~{max(p['lat'] for p in prefs)}"
          f"  lon {min(p['lon'] for p in prefs)}~{max(p['lon'] for p in prefs)}")

    # 与现有 cities.json 比对，算出真正要新增的数量
    raw = json.loads((ROOT / "data" / "cities.json").read_text(encoding="utf-8"))
    existing = raw["cities"] if isinstance(raw, dict) else raw
    have = {c["zh"].rstrip("市") for c in existing if c.get("country") == "中国"}
    new = [p for p in prefs if p["zh"].rstrip("市") not in have]
    print(f"\n四、与现有 cities.json 比对")
    print(f"  现有国内 {len(have)} 城；地级清单里**需要新增** {len(new)} 个")
    print(f"  新增示例：{'、'.join(p['zh'] for p in new[:16])}…")

    print("\n五、代价估算（新增部分）")
    n = len(new)
    print(f"  语音片段：+{n} 个（约 {n * 4.7:.0f} KB）—— 由 tools/gen-audio.py 批量生成 + trim-audio.py 裁剪")
    print(f"  cities.json：+{n * 0.4:.0f} KB")
    print(f"  壁纸清单：+{n * 0.25:.0f} KB（若全部配图；也可先用首字插画兜底）")
    print(f"  亮度网格：+{n * 0.66:.0f} KB（需重跑 precompute-luminance.py）")
    print(f"  部署包合计约 +{(n * 4.7 + n * 1.3) / 1024:.1f} MB")

    if not args.report:
        outp = Path(args.json)
        outp.parent.mkdir(parents=True, exist_ok=True)
        outp.write_text(json.dumps({
            "source": GEO_URL,
            "count": len(prefs),
            "newCount": len(new),
            "prefectures": prefs,
            "new": new,
        }, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n已写入 {outp.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
