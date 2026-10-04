// 读取 assets/audio/manifest.json（由 tools/gen-audio.py 生成），校验片段是否齐全。
import { AUDIO } from '../core/constants.js';
import { cityAudioPath, weatherAudioPath, wordAudioPath, tempAudioPath } from '../core/paths.js';

let cached = null;

export async function loadAudioManifest() {
  if (cached) return cached;
  const res = await fetch('assets/audio/manifest.json');
  if (!res.ok) throw new Error(`音频清单缺失：HTTP ${res.status}（请先运行 tools/gen-audio.py）`);
  cached = await res.json();
  return cached;
}

/** 片段描述 → 实际 URL */
export function audioUrlFor(seg) {
  switch (seg.kind) {
    case 'city':
      return cityAudioPath(seg.key);
    case 'weather':
      return weatherAudioPath(seg.key);
    case 'word':
      return wordAudioPath(seg.key);
    case 'temp':
      return tempAudioPath(seg.key);
    default:
      throw new Error(`未知音频片段类型：${seg.kind}`);
  }
}

/** 检查清单里是否存在某个片段；缺失时播放器会跳过而不是卡住 */
export function manifestHas(manifest, seg) {
  const url = audioUrlFor(seg);
  const rel = url.replace(/^assets\/audio\//, '');
  return Boolean(manifest.files?.[rel]);
}

export const audioSettings = AUDIO;
