#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""快速体检 WAV/MP3 音频资产：时长、峰值、响度、是否有静音。

用法：
    python tools/inspect-audio.py                          # 检查音乐文件
    python tools/inspect-audio.py assets/audio/zh/temp     # 检查某目录下全部片段
"""
from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent


def stats_wav(path: Path) -> dict:
    with wave.open(str(path), "rb") as f:
        ch = f.getnchannels()
        sr = f.getframerate()
        n = f.getnframes()
        raw = f.readframes(n)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float64)
    if ch > 1:
        data = data.reshape(-1, ch)
    peak = float(np.abs(data).max()) / 32768
    rms = float(np.sqrt((data.astype(np.float64) ** 2).mean())) / 32768
    mono = data if data.ndim == 1 else data.mean(axis=1)
    silent = float((np.abs(mono) < 0.005).mean())
    # 主频：确认真的有音高内容，而不是噪声或空文件
    spec = np.abs(np.fft.rfft(mono[: min(len(mono), sr * 4)] * np.hanning(min(len(mono), sr * 4))))
    freqs = np.fft.rfftfreq(min(len(mono), sr * 4), 1 / sr)
    dom = float(freqs[int(np.argmax(spec))]) if spec.size else 0.0
    return {"dur": n / sr, "sr": sr, "ch": ch, "peak": peak, "rms": rms,
            "silent": silent, "dominant": dom, "size": path.stat().st_size}


def main() -> int:
    targets = sys.argv[1:]
    paths: list[Path] = []
    if not targets:
        paths = sorted((ROOT / "assets" / "audio" / "music").glob("*.wav"))
    else:
        for t in targets:
            p = (ROOT / t) if not Path(t).is_absolute() else Path(t)
            paths += sorted(p.glob("*.wav")) if p.is_dir() else [p]

    if not paths:
        print("没有找到可检查的 wav 文件")
        return 1

    bad = 0
    for p in paths:
        try:
            s = stats_wav(p)
        except Exception as exc:  # noqa: BLE001
            print(f"✗ {p.name}: 读取失败 {exc}")
            bad += 1
            continue
        flag = "✓"
        if s["peak"] < 0.05 or s["silent"] > 0.35:
            flag, bad = "✗ 疑似静音/音量过低", bad + 1
        print(
            f"{flag} {p.name:<28} {s['dur']:6.2f}s {s['sr']}Hz {s['ch']}ch "
            f"peak={s['peak']:.3f} rms={s['rms']:.4f} 静音比={s['silent']:.1%} "
            f"主频={s['dominant']:.0f}Hz {s['size']/1024/1024:.2f}MB"
        )
        if len(paths) > 1:
            continue
        # 单个文件时打印频谱前几名，便于判断音色
        with wave.open(str(p), "rb") as f:
            n, sr = f.getnframes(), f.getframerate()
            d = np.frombuffer(f.readframes(n), dtype="<i2").astype(np.float64)
            if f.getnchannels() > 1:
                d = d.reshape(-1, f.getnchannels()).mean(axis=1)
        seg = d[: min(len(d), sr * 4)]
        spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        freqs = np.fft.rfftfreq(len(seg), 1 / sr)
        top = np.argsort(spec)[-10:][::-1]
        print("   主要频率成分：", ", ".join(f"{freqs[i]:.0f}Hz" for i in top))
    print(f"\n共检查 {len(paths)} 个文件，异常 {bad} 个")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
