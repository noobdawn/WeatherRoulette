# 独立校验城市壁纸清单：覆盖度 + URL 真实可用性（不依赖队友的自述结论）
#
#   python tools/check-images.py            # 覆盖度 + 抽样验证
#   python tools/check-images.py --all      # 逐条验证全部 URL（81 城 × primary+fallbacks，约 2-4 分钟）
#   python tools/check-images.py --all -j 8 # 指定并发
import argparse
import concurrent.futures as cf
import json
import random
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"
MANIFEST = ROOT / "assets" / "images" / "manifest.json"
UA = "WeatherRouletteBot/0.1 (+https://github.com/noobdawn/WeatherRoulette)"


def head_ok(url: str, timeout: float = 25.0) -> tuple[bool, str]:
    """用 GET 取一小段即可判定（有些 CDN 不支持 HEAD）。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type") or "").lower()
            chunk = resp.read(2048)
            if resp.status != 200:
                return False, f"HTTP {resp.status}"
            if not ctype.startswith("image/"):
                return False, f"Content-Type={ctype or '空'}"
            if len(chunk) < 512:
                return False, f"内容过短（{len(chunk)} 字节）"
            return True, f"{ctype} {len(chunk)}B+"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="验证全部 URL，而非抽样")
    ap.add_argument("--sample", type=int, default=24, help="抽样条数（默认 24）")
    ap.add_argument("-j", "--jobs", type=int, default=8)
    args = ap.parse_args()

    if not MANIFEST.exists():
        print(f"✗ 清单不存在：{MANIFEST}")
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    images = manifest.get("images", {}) or {}
    cities = json.loads(CITIES.read_text(encoding="utf-8"))["cities"]
    city_ids = [c["id"] for c in cities]

    print(f"清单：{MANIFEST.relative_to(ROOT)}")
    print(f"  版本 {manifest.get('version')}，生成于 {manifest.get('generatedAt')}")
    print(f"  记录城市 {len(images)} 个 / 实际城市 {len(city_ids)} 个\n")

    missing = [cid for cid in city_ids if cid not in images]
    extra = [cid for cid in images if cid not in set(city_ids)]
    no_primary = [cid for cid in image_ids_present(images) if not (images[cid].get("primary"))]
    print(f"[覆盖度] 缺失 {len(missing)} 个；多余 {len(extra)} 个；无 primary {len(no_primary)} 个")
    if missing:
        print("  缺失：", ", ".join(missing[:20]), "..." if len(missing) > 20 else "")
    if extra:
        print("  多余：", ", ".join(extra[:10]))
    if no_primary:
        print("  无主图：", ", ".join(no_primary[:10]))

    all_urls: list[tuple[str, str]] = []  # (city_id, url)
    for cid, info in images.items():
        if info.get("primary"):
            all_urls.append((cid, info["primary"]))
        for u in info.get("fallbacks") or []:
            all_urls.append((cid, u))
    uniq_urls = sorted({u for _, u in all_urls})
    print(f"[URL 总数] {len(all_urls)} 条（{len(uniq_urls)} 条去重）")

    if args.all:
        targets = uniq_urls
        print("逐个验证全部 URL（--all）……")
    else:
        rnd = random.Random(20261004)
        targets = rnd.sample(uniq_urls, min(args.sample, len(uniq_urls)))
        print(f"抽样验证 {len(targets)} 条（用 --all 可全量验证）……")

    ok = 0
    bad: list[tuple[str, str]] = []
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(head_ok, u): u for u in targets}
        for i, fut in enumerate(cf.as_completed(futures), 1):
            url = futures[fut]
            good, detail = fut.result()
            if good:
                ok += 1
            else:
                bad.append((url, detail))
            if args.all and i % 20 == 0:
                print(f"  …{i}/{len(targets)}（已通过 {ok}，失败 {len(bad)}）")

    print(f"\n[验证结果] 通过 {ok} / {len(targets)}，失败 {len(bad)}")
    for url, detail in bad[:15]:
        print(f"  ✗ {detail}  {url[:110]}")

    # 每城至少要有一个可用候选（抽样模式下无法全量断言，只做提示）
    if bad and not args.all:
        print("\n注意：抽样中发现坏链，建议跑 --all 全量确认后再部署。")

    verdict = not missing and not no_primary and ok == len(targets)
    print("\n结论：" + ("通过 ✓" if verdict else "存在问题 ✗"))
    return 0 if verdict else 1


def image_ids_present(images: dict) -> list[str]:
    return list(images.keys())


if __name__ == "__main__":
    sys.exit(main())
