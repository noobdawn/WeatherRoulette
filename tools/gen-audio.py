#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为 WeatherRoulette 生成离线播报音频片段。

思路（对应需求第五点）：
  央视《天气预报》的播报句式是高度模板化的：
      「<城市> <天气> <最低温>到<最高温>度」
  所有可变部分都是有限集合：
      城市名 81 个 · 天气词 13 个 · 温度数字 0~42 · 连接词 3 个
  于是离线把每个片段单独合成成一个小 mp3，网页播放时按顺序拼接，
  就能得到一套完整、稳定、可离线、无须联网 TTS 的女声播报。

用法：
    python tools/gen-audio.py                 # 生成缺失的片段（已存在则跳过）
    python tools/gen-audio.py --force         # 全部重新生成
    python tools/gen-audio.py --only cities   # 只生成城市片段
    python tools/gen-audio.py --concurrency 3
    python tools/gen-audio.py --verify        # 只检查清单与文件是否一致
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITIES_FILE = ROOT / "data" / "cities.json"
WMO_FILE = ROOT / "data" / "wmo-map.json"
AUDIO_ROOT = ROOT / "assets" / "audio"
MANIFEST_FILE = AUDIO_ROOT / "manifest.json"

# 与 js/core/constants.js 的 AUDIO 保持一致
VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "-8%"
TEMP_MIN, TEMP_MAX = 0, 42
DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"]

CONNECTORS = {
    "dao": "到",
    "du": "度",
    "sheshidu": "摄氏度",
}


def num_to_zh(n: int) -> str:
    if n < 10:
        return DIGITS[n]
    if n == 10:
        return "十"
    if n < 20:
        return "十" + DIGITS[n - 10]
    if n % 10 == 0:
        return DIGITS[n // 10] + "十"
    return DIGITS[n // 10] + "十" + DIGITS[n % 10]


def build_jobs(only: set[str] | None) -> list[dict]:
    cities = json.loads(CITIES_FILE.read_text(encoding="utf-8"))["cities"]
    wmo = json.loads(WMO_FILE.read_text(encoding="utf-8"))

    weather_words: dict[str, str] = {}
    for code, info in wmo["codes"].items():
        for key in info["audio"]:
            if key in weather_words and weather_words[key] != info["zh"]:
                raise SystemExit(f"天气键 {key} 对应多个中文词，请检查 wmo-map.json")
            weather_words[key] = info["zh"]

    jobs: list[dict] = []

    def add(kind: str, key: str, text: str, path: Path, note: str = "") -> None:
        if only and kind not in only:
            return
        jobs.append(
            {
                "kind": kind,
                "key": key,
                "text": text,
                "path": path,
                "rel": path.relative_to(AUDIO_ROOT).as_posix(),
                "note": note,
            }
        )

    for city in cities:
        add("city", city["id"], city["zh"], AUDIO_ROOT / "zh" / "city" / f"{city['id']}.mp3",
            f"{city['zh']} / {city['en']}")

    for key, word in sorted(weather_words.items()):
        add("weather", key, word, AUDIO_ROOT / "zh" / "weather" / f"{key}.mp3", word)

    for n in range(TEMP_MIN, TEMP_MAX + 1):
        add("temp", f"t{n}", f"{num_to_zh(n)}度", AUDIO_ROOT / "zh" / "temp" / f"t{n}.mp3",
            f"{n}°C")

    for key, text in CONNECTORS.items():
        add("word", key, text, AUDIO_ROOT / "zh" / "word" / f"{key}.mp3", text)

    return jobs


async def synth_one(job: dict, sem: asyncio.Semaphore, force: bool, retries: int = 3) -> dict:
    import edge_tts

    path: Path = job["path"]
    if path.exists() and path.stat().st_size > 0 and not force:
        return {**job, "status": "skipped", "size": path.stat().st_size}

    path.parent.mkdir(parents=True, exist_ok=True)
    last_err = None
    for attempt in range(retries):
        async with sem:
            try:
                comm = edge_tts.Communicate(job["text"], VOICE, rate=RATE)
                await comm.save(str(path))
                size = path.stat().st_size
                if size < 500:
                    raise RuntimeError(f"生成文件过小（{size} 字节），可能被服务端限流")
                return {**job, "status": "ok", "size": size, "attempt": attempt + 1}
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if path.exists() and path.stat().st_size < 500:
                    path.unlink(missing_ok=True)
        await asyncio.sleep(1.5 * (attempt + 1))
    return {**job, "status": "failed", "error": str(last_err)}


async def run(jobs: list[dict], concurrency: int, force: bool) -> int:
    sem = asyncio.Semaphore(concurrency)
    total = len(jobs)
    done = 0
    results = []
    lock = asyncio.Lock()

    async def worker(job: dict) -> None:
        nonlocal done
        res = await synth_one(job, sem, force)
        async with lock:
            done += 1
            results.append(res)
            mark = {"ok": "✓", "skipped": "·", "failed": "✗"}[res["status"]]
            print(f"[{done:>4}/{total}] {mark} {res['rel']:<44} {res['text']}", flush=True)

    await asyncio.gather(*(worker(j) for j in jobs))

    ok = [r for r in results if r["status"] == "ok"]
    skipped = [r for r in results if r["status"] == "skipped"]
    failed = [r for r in results if r["status"] == "failed"]
    print(f"\n生成 {len(ok)} 个，跳过 {len(skipped)} 个，失败 {len(failed)} 个")
    if failed:
        for r in failed[:20]:
            print(f"  失败：{r['rel']}  {r.get('error')}")
        print("提示：失败通常是对微软 TTS 服务请求过快，稍后重跑同一命令即可（已生成的会自动跳过）。")
    return 0 if not failed else 1


def write_manifest() -> None:
    """扫描磁盘上的实际文件生成清单（以文件为准，避免清单与文件不一致）。"""
    files: dict[str, dict] = {}
    for path in sorted(AUDIO_ROOT.rglob("*.mp3")):
        rel = path.relative_to(AUDIO_ROOT).as_posix()
        parts = rel.split("/")
        if len(parts) == 3 and parts[0] == "zh":
            kind, key = parts[1], parts[2][:-4]
        elif len(parts) == 2 and parts[0] == "music":
            kind, key = "music", parts[1]
        else:
            continue
        files[rel] = {"kind": kind, "key": key, "size": path.stat().st_size}

    music = sorted(
        [p for p in (AUDIO_ROOT / "music").glob("*") if p.suffix.lower() in {".mp3", ".wav", ".m4a", ".ogg"}]
    ) if (AUDIO_ROOT / "music").exists() else []
    manifest = {
        "version": 1,
        "voice": VOICE,
        "rate": RATE,
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "counts": {
            "city": sum(1 for f in files.values() if f["kind"] == "city"),
            "weather": sum(1 for f in files.values() if f["kind"] == "weather"),
            "temp": sum(1 for f in files.values() if f["kind"] == "temp"),
            "word": sum(1 for f in files.values() if f["kind"] == "word"),
        },
        "tempRange": [TEMP_MIN, TEMP_MAX],
        "music": [p.name for p in music],
        "files": files,
    }
    MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total_kb = sum(f["size"] for f in files.values()) / 1024
    print(
        f"清单已写入 {MANIFEST_FILE.relative_to(ROOT)}："
        f"{len(files)} 个片段，合计 {total_kb / 1024:.2f} MB"
    )


def verify() -> int:
    cities = json.loads(CITIES_FILE.read_text(encoding="utf-8"))["cities"]
    wmo = json.loads(WMO_FILE.read_text(encoding="utf-8"))
    expected: list[Path] = []
    expected += [AUDIO_ROOT / "zh" / "city" / f"{c['id']}.mp3" for c in cities]
    keys = {k for info in wmo["codes"].values() for k in info["audio"]}
    keys |= {k for k in wmo["fallback"]["audio"]}
    expected += [AUDIO_ROOT / "zh" / "weather" / f"{k}.mp3" for k in sorted(keys)]
    expected += [AUDIO_ROOT / "zh" / "temp" / f"t{n}.mp3" for n in range(TEMP_MIN, TEMP_MAX + 1)]
    expected += [AUDIO_ROOT / "zh" / "word" / f"{k}.mp3" for k in CONNECTORS]

    missing = [p for p in expected if not p.exists()]
    empty = [p for p in expected if p.exists() and p.stat().st_size < 500]
    music = sorted((AUDIO_ROOT / "music").glob("*"))
    print(f"应有片段 {len(expected)} 个；缺失 {len(missing)} 个；异常小 {len(empty)} 个")
    for p in (missing + empty)[:30]:
        print("  缺失：", p.relative_to(ROOT))
    print("音乐文件：", [p.name for p in music] or "（无）")
    if MANIFEST_FILE.exists():
        man = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
        print(f"清单记录 {len(man['files'])} 个片段")
    else:
        print("清单不存在，请先运行生成命令")
    return 1 if (missing or empty or not music) else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 WeatherRoulette 播报音频片段")
    ap.add_argument("--force", action="store_true", help="已存在的片段也重新生成")
    ap.add_argument("--only", default="", help="只生成某类片段，逗号分隔：city,weather,temp,word")
    ap.add_argument("--concurrency", type=int, default=4, help="并发请求数（默认 4，过大易被限流）")
    ap.add_argument("--verify", action="store_true", help="只校验，不生成")
    args = ap.parse_args()

    if args.verify:
        return verify()

    only = {s.strip() for s in args.only.split(",") if s.strip()} or None
    jobs = build_jobs(only)
    if not jobs:
        print("没有需要生成的片段。")
        return 0

    print(f"共 {len(jobs)} 个片段，语音 {VOICE}，语速 {RATE}，并发 {args.concurrency}")
    print(f"输出目录 {AUDIO_ROOT}")
    print("（首次运行约需 3~8 分钟，取决于网络；可中断后重跑，已生成的会跳过）\n")
    code = asyncio.run(run(jobs, args.concurrency, args.force))
    write_manifest()
    return code


if __name__ == "__main__":
    sys.exit(main())
