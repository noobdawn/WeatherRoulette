#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
裁剪播报语音片段首尾的空白（静音），让拼接后的句子更连贯。

为什么需要：edge-tts 生成的每个片段头尾都带有静音（有时长达 200~300ms）。
播放器按片段顺序拼接时，这些静音会叠加成不自然的停顿——
「五 <长停> 到 <长停> 十五度」听起来一顿一顿的。

做法：
    解码 → 求每 10ms 的 RMS → 从两端向中间找第一个超过阈值的帧 → 两端各留 PAD_MS →
    重新编码回 mp3。保留一点点 padding 是为了不削掉声母的起振（"到" d 的爆破音）。

用法：
    python tools/trim-audio.py                    # 裁剪全部片段（已有备份则跳过）
    python tools/trim-audio.py --force            # 重新裁剪
    python tools/trim-audio.py --dry-run          # 只看会裁掉多少，不写文件
    python tools/trim-audio.py --only num,word    # 只处理某几类
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import av
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AUDIO_ROOT = ROOT / "assets" / "audio"
MANIFEST = AUDIO_ROOT / "manifest.json"
BACKUP = AUDIO_ROOT / ".orig"

FRAME_MS = 10
THRESHOLD_DB = -45.0     # 低于这个响度视为静音
PAD_MS = 25              # 两端保留的余量，避免削掉起振
MIN_KEEP_MS = 80         # 裁剪后至少保留这么长，防误裁
BITRATE_KBPS = 48        # 语音是单声道，48kbps 足够且比原来的体积更小


def decode(path: Path) -> tuple[np.ndarray, int]:
    """解码成单声道 float32。"""
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        sr = stream.rate
        chunks = []
        resampler = av.audio.resampler.AudioResampler(format="fltp", layout="mono", rate=sr)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32), sr
    return np.concatenate(chunks).astype(np.float32), sr


def encode(path: Path, data: np.ndarray, sr: int) -> None:
    container = av.open(str(path), mode="w", format="mp3")
    stream = container.add_stream("libmp3lame", rate=sr)
    stream.bit_rate = BITRATE_KBPS * 1000
    pcm = np.clip(data, -1.0, 1.0)
    pcm16 = (pcm * 32767.0).astype("<i2").reshape(1, -1)
    chunk = sr * 2
    for start in range(0, pcm16.shape[1], chunk):
        block = pcm16[:, start : start + chunk]
        if block.shape[1] == 0:
            continue
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(block), format="s16", layout="mono")
        frame.sample_rate = sr
        frame.pts = start
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()


def trim_bounds(data: np.ndarray, sr: int) -> tuple[int, int]:
    """返回应该保留的 [start, end) 采样下标。"""
    if data.size == 0:
        return 0, 0
    hop = max(1, int(sr * FRAME_MS / 1000))
    n_frames = data.size // hop
    if n_frames < 2:
        return 0, data.size
    frames = data[: n_frames * hop].reshape(n_frames, hop)
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    loud = np.flatnonzero(db > THRESHOLD_DB)
    if loud.size == 0:
        return 0, data.size  # 整段都轻，别裁
    pad = int(sr * PAD_MS / 1000)
    start = max(0, loud[0] * hop - pad)
    end = min(data.size, (loud[-1] + 1) * hop + pad)
    if end - start < int(sr * MIN_KEEP_MS / 1000):
        # 裁完太短，说明判定不可靠，回退到原样
        return 0, data.size
    return start, end


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="已裁剪过的也重新处理")
    ap.add_argument("--dry-run", action="store_true", help="只统计不写文件")
    ap.add_argument("--only", default="", help="只处理这些类别：num,temp,word,city,weather")
    args = ap.parse_args()

    only = {s.strip() for s in args.only.split(",") if s.strip()} or None
    clips = sorted(AUDIO_ROOT.glob("zh/*/*.mp3"))
    if only:
        clips = [p for p in clips if p.parent.name in only]
    if not clips:
        print("没有找到片段")
        return 1

    BACKUP.mkdir(parents=True, exist_ok=True)
    total_before = sum(p.stat().st_size for p in clips)
    trimmed = 0
    skipped = 0
    rows = []

    for path in clips:
        rel = path.relative_to(AUDIO_ROOT)
        backup = BACKUP / rel
        if backup.exists() and not args.force:
            skipped += 1
            continue
        try:
            data, sr = decode(path)
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ 解码失败 {rel}: {exc}")
            continue
        a, b = trim_bounds(data, sr)
        orig_ms = data.size / sr * 1000
        kept = data[a:b]
        kept_ms = kept.size / sr * 1000
        rows.append((str(rel), orig_ms, kept_ms))
        if not args.dry_run:
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, backup)
            encode(path, kept, sr)
        trimmed += 1
        if trimmed % 40 == 0:
            print(f"  …已处理 {trimmed}/{len(clips)}", flush=True)

    total_after = sum(p.stat().st_size for p in clips)
    print(f"\n处理 {trimmed} 个，跳过 {skipped} 个（已有备份）")
    if rows:
        cut = [(r[0], r[1] - r[2]) for r in rows]
        cut.sort(key=lambda x: -x[1])
        avg_cut = sum(c for _, c in cut) / len(cut)
        print(f"平均每个片段裁掉 {avg_cut:.0f}ms")
        print("裁得最多的 5 个：")
        for name, ms in cut[:5]:
            print(f"  {name:<34} -{ms:.0f}ms")
    print(f"体积：{total_before/1024:.0f} KB → {total_after/1024:.0f} KB")
    if args.dry_run:
        print("（--dry-run，未写入任何文件）")
    else:
        # 清单里的体积需要同步刷新
        if MANIFEST.exists():
            man = json.loads(MANIFEST.read_text(encoding="utf-8"))
            for rel, info in man.get("files", {}).items():
                p = AUDIO_ROOT / rel
                if p.exists():
                    info["size"] = p.stat().st_size
            MANIFEST.write_text(json.dumps(man, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"已同步 {MANIFEST.relative_to(ROOT)} 的片段体积")
        print(f"原始片段已备份到 {BACKUP.relative_to(ROOT)}（可据此回滚）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
