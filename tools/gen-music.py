#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成《渔舟唱晚》主题的古筝风格背景音乐（纯程序合成，无第三方音频素材）。

版权说明：
    《渔舟唱晚》是娄树华 1930 年代据古曲《归去来》改编的古筝曲，
    曲调本身属于公有领域。这里不使用任何现成录音，而是用加法合成
    模拟古筝拨弦音色（谐波叠加 + 指数衰减 + 轻微失谐拍频 + 摇指颤音），
    因此产物完全自有，可自由用于静态网站。

输出：assets/audio/music/yuzhouchangwan.mp3（128kbps 立体声，约 1.7 MB / 63 秒）
     用 --wav 可另外导出一份无损 wav 用于试听校对。

依赖：numpy、av（pyav，提供 libmp3lame 编码）。安装：python -m pip install av

用法：
    python tools/gen-music.py                 # 默认 2 遍主题
    python tools/gen-music.py --rounds 3
    python tools/gen-music.py --preview       # 只生成 8 秒试听片段
"""
from __future__ import annotations

import argparse
import math
import struct
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MUSIC_DIR = ROOT / "assets" / "audio" / "music"
OUT = MUSIC_DIR / "yuzhouchangwan.mp3"

SR = 44100
BEAT = 0.62  # 一拍秒数：悠缓的行板
BEATS_PER_BAR = 4
BARS_PER_ROUND = 17

# D 宫五声音阶（古筝 D 调常用定弦）
NOTE_HZ = {
    "D3": 146.83, "E3": 164.81, "Fs3": 185.00, "A3": 220.00, "B3": 246.94,
    "D4": 293.66, "E4": 329.63, "Fs4": 369.99, "A4": 440.00, "B4": 493.88,
    "D5": 587.33, "E5": 659.26, "Fs5": 739.99, "A5": 880.00, "B5": 987.77,
    "D6": 1174.66,
}

# 主旋律：(拍, 音名, 时值拍)。这是《渔舟唱晚》最有辨识度的慢板主题轮廓。
MELODY: list[tuple[float, str, float]] = [
    # 第一乐句：起句悠远，逐级上行
    (0, "A3", 1), (1, "D4", 1), (2, "E4", 2),
    (4, "Fs4", 1), (5, "E4", 1), (6, "D4", 2),
    (8, "E4", 1), (9, "Fs4", 1), (10, "A4", 2),
    (12, "B4", 1), (13, "A4", 1), (14, "Fs4", 1), (15, "E4", 1),
    (16, "D4", 2), (18, "E4", 1), (19, "Fs4", 1),
    (20, "A4", 3), (23, "Fs4", 1),
    # 第二乐句：展开，音区抬升
    (24, "B4", 1), (25, "A4", 1), (26, "B4", 1), (27, "D5", 1),
    (28, "A4", 2), (30, "Fs4", 2),
    (32, "E4", 1), (33, "Fs4", 1), (34, "A4", 1), (35, "B4", 1),
    (36, "D5", 1), (37, "B4", 1), (38, "A4", 2),
    (40, "Fs4", 2), (42, "E4", 2),
    (44, "D4", 4),
    # 第三乐句：回到低音区，收束
    (48, "A3", 1), (49, "B3", 1), (50, "D4", 2),
    (52, "E4", 1), (53, "Fs4", 1), (54, "A4", 2),
    (56, "B4", 1), (57, "A4", 1), (58, "Fs4", 1), (59, "E4", 1),
    (60, "D4", 3), (63, "E4", 1),
    (64, "D4", 4),
]

# 左手低音（每两拍一次，宫—徵—商—羽的循环，古筝常用的托底）
BASS_CYCLE = ["D3", "A3", "E3", "A3"]

# 摇指颤音点缀（(拍, 音名)），模拟长音上的摇指
TREMOLO: list[tuple[float, str]] = [(20, "A4"), (44, "D4"), (64, "D4")]


def midi_pluck(freq: float, dur: float, sr: int, seed: int = 0) -> np.ndarray:
    """加法合成古筝拨弦音：泛音列 + 快速衰减 + 微小失谐拍频。"""
    rng = np.random.default_rng(seed)
    n = int(dur * sr)
    if n <= 0 or freq <= 0:
        return np.zeros(0, dtype=np.float64)
    t = np.arange(n) / sr

    # 古筝低音弦泛音丰富，高音弦偏纯净
    brightness = float(np.clip(1.35 - math.log2(freq / 146.83) * 0.14, 0.55, 1.35))
    partials = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13]
    wave = np.zeros(n, dtype=np.float64)
    for k in partials:
        amp = 1.0 / (k ** (1.45 - 0.18 * brightness))
        if k > 6:
            amp *= 0.5
        # 弦的轻微失谐，产生自然的"拍"
        detune = 1.0 + rng.normal(0, 0.0011)
        f = freq * k * detune
        if f > sr * 0.45:
            continue
        # 高次泛音衰减更快，这是拨弦"叮"的质感来源
        decay = (2.6 + dur * 0.85) / (1.0 + 0.55 * (k - 1) ** 1.05)
        phase = rng.uniform(0, 2 * math.pi)
        wave += amp * np.sin(2 * math.pi * f * t + phase) * np.exp(-t / decay)

    # 拨弦瞬间的噪声起振（指甲触弦）
    attack = int(0.006 * sr)
    if attack > 1:
        wave[:attack] *= np.linspace(0.2, 1.0, attack)
        wave[:attack] += rng.normal(0, 0.05, attack) * np.linspace(1.0, 0.0, attack)

    wave *= np.exp(-t / (1.15 + dur * 0.5))
    return wave * 0.32


def add(buf: np.ndarray, start: float, wave: np.ndarray, gain: float, pan: float = 0.0) -> None:
    """把一段波形叠加到立体声缓冲区的指定时间位置。pan: -1 左 ~ +1 右。"""
    if wave.size == 0:
        return
    i0 = int(start * SR)
    if i0 >= buf.shape[0]:
        return
    i1 = min(buf.shape[0], i0 + wave.size)
    seg = wave[: i1 - i0] * gain
    left = math.sqrt((1 - pan) / 2)
    right = math.sqrt((1 + pan) / 2)
    buf[i0:i1, 0] += seg * left
    buf[i0:i1, 1] += seg * right


def render_round(rounds: int) -> np.ndarray:
    total_beats = BARS_PER_ROUND * BEATS_PER_BAR * rounds
    total_sec = total_beats * BEAT + 6.0  # 末尾留出余韵
    buf = np.zeros((int(total_sec * SR), 2), dtype=np.float64)

    for r in range(rounds):
        offset = r * BARS_PER_ROUND * BEATS_PER_BAR
        # 第二遍力度稍强，做出"一遍轻、一遍亮"的层次
        dyn = 0.85 if r % 2 == 0 else 1.0
        for idx, (beat, name, dur) in enumerate(MELODY):
            if name not in NOTE_HZ:
                continue
            start = (offset + beat) * BEAT
            wave = midi_pluck(NOTE_HZ[name], dur * BEAT + 3.0, SR, seed=r * 1000 + idx)
            # 旋律略偏右，符合古筝演奏者视角
            add(buf, start, wave, 1.0 * dyn, pan=0.16)

        for beat in range(0, BARS_PER_ROUND * BEATS_PER_BAR, 2):
            name = BASS_CYCLE[(beat // 2) % len(BASS_CYCLE)]
            start = (offset + beat) * BEAT
            wave = midi_pluck(NOTE_HZ[name], 3.2, SR, seed=r * 5000 + beat)
            add(buf, start, wave, 0.42 * dyn, pan=-0.14)

        for idx, (beat, name) in enumerate(TREMOLO):
            start = (offset + beat) * BEAT
            for k in range(6):  # 摇指：同一个音快速反复
                wave = midi_pluck(NOTE_HZ[name], 0.55, SR, seed=r * 900 + idx * 10 + k)
                add(buf, start + k * 0.115, wave, 0.22 * dyn, pan=0.2)

    return buf


def normalize_and_fade(buf: np.ndarray, fade_in: float = 0.8, fade_out: float = 2.6) -> np.ndarray:
    peak = float(np.max(np.abs(buf))) or 1.0
    buf = buf / peak * 0.88
    n = buf.shape[0]
    fi = min(int(fade_in * SR), n)
    fo = min(int(fade_out * SR), n)
    if fi > 0:
        buf[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
    if fo > 0:
        buf[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
    return buf


def write_wav(path: Path, buf: np.ndarray, sr: int = SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clip = np.clip(buf, -1.0, 1.0)
    pcm = (clip * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


def write_mp3(path: Path, buf: np.ndarray, sr: int = SR, bitrate: int = 128_000) -> None:
    """用 pyav(libmp3lame) 编码 mp3：背景音乐不需要无损，128kbps 足够且体积只有 wav 的 1/10。"""
    import av

    path.parent.mkdir(parents=True, exist_ok=True)
    clip = np.clip(buf, -1.0, 1.0)
    # PyAV 的 packed 立体声格式要求 shape = (1, 采样数*2)，即交错存放的左右声道
    pcm = (clip * 32767.0).astype("<i2").reshape(1, -1)
    container = av.open(str(path), mode="w", format="mp3")
    stream = container.add_stream("libmp3lame", rate=sr)
    stream.bit_rate = bitrate
    # 分块送帧，避免一次性构造超长帧（每帧约 1 秒）
    chunk = sr * 2
    for start in range(0, pcm.shape[1], chunk):
        block = pcm[:, start : start + chunk]
        if block.shape[1] == 0:
            continue
        frame = av.AudioFrame.from_ndarray(block, format="s16", layout="stereo")
        frame.sample_rate = sr
        frame.pts = start // 2
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="合成《渔舟唱晚》古筝风格背景音乐")
    ap.add_argument("--rounds", type=int, default=2, help="主题重复遍数（默认 2，约 63 秒）")
    ap.add_argument("--preview", action="store_true", help="只生成 8 秒试听片段")
    ap.add_argument("--wav", action="store_true", help="另外导出无损 wav 用于试听校对")
    ap.add_argument("--bitrate", type=int, default=128, help="mp3 码率 kbps（默认 128）")
    args = ap.parse_args()

    if args.preview:
        full = render_round(1)
        segment = normalize_and_fade(full[: int(8 * SR)], fade_in=0.3, fade_out=1.0)
        out = MUSIC_DIR / "preview-8s.mp3"
        write_mp3(out, segment, bitrate=args.bitrate * 1000)
        print(f"试听片段：{out}（{segment.shape[0] / SR:.1f} 秒，{out.stat().st_size / 1024:.0f} KB）")
        return 0

    buf = normalize_and_fade(render_round(max(1, args.rounds)))
    write_mp3(OUT, buf, bitrate=args.bitrate * 1000)
    seconds = buf.shape[0] / SR
    print(f"已生成 {OUT}")
    print(f"  时长 {seconds:.1f} 秒（{seconds / 60:.2f} 分钟）")
    print(f"  大小 {OUT.stat().st_size / 1024 / 1024:.2f} MB，44.1kHz 立体声 {args.bitrate}kbps mp3")
    if args.wav:
        wav_path = OUT.with_suffix(".wav")
        write_wav(wav_path, buf)
        print(f"  无损副本 {wav_path}（{wav_path.stat().st_size / 1024 / 1024:.2f} MB，仅本地试听用，勿部署）")
    print("  提示：配合 AUDIO.musicVolume（默认 0.30）在网页里 loop 播放。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
