// 资源路径拼装：所有音频／图片路径只在这里生成，避免大小写与目录漂移。
import { AUDIO_DIR, IMAGES_DIR } from './constants.js';

/** assets/audio/zh/city/jinan.mp3 */
export function cityAudioPath(id) {
  return `${AUDIO_DIR}/zh/city/${id}.mp3`;
}

/** assets/audio/zh/weather/qing.mp3 */
export function weatherAudioPath(key) {
  return `${AUDIO_DIR}/zh/weather/${key}.mp3`;
}

/** assets/audio/zh/word/zhuan.mp3 */
export function wordAudioPath(key) {
  return `${AUDIO_DIR}/zh/word/${key}.mp3`;
}

/**
 * assets/audio/zh/temp/t18.mp3（十八度，自带「度」）
 * 入参可以是 18、'18' 或片段键 't18' —— 两种写法都容错，
 * 避免调用方多带一层 t 前缀时解析出不存在的 tt18.mp3。
 */
export function tempAudioPath(n) {
  const num = String(n).replace(/^t/, '');
  return `${AUDIO_DIR}/zh/temp/t${num}.mp3`;
}

/**
 * assets/audio/zh/num/n18.mp3（只读「十八」，不带「度」）
 * 用于「十八到二十四度」这样的温度区间：前半段的数字后面不能带「度」。
 */
export function numAudioPath(n) {
  const num = String(n).replace(/^n/, '');
  return `${AUDIO_DIR}/zh/num/n${num}.mp3`;
}

/** assets/audio/music/yuzhouchangwan.mp3（也可放自备的 music.mp3 覆盖） */
export function musicPath(file = 'yuzhouchangwan.mp3') {
  return `${AUDIO_DIR}/music/${file}`;
}

/** assets/images/city/jinan.jpg */
export function cityImagePath(id, ext = 'jpg') {
  return `${IMAGES_DIR}/city/${id}.${ext}`;
}
