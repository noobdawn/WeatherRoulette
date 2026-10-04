// 背景音乐：《渔舟唱晚》循环播放 + 淡入淡出。
// 浏览器自动播放策略会拒绝没有用户手势的 play()，这里一律「静默失败 + 记录状态」，绝不抛到界面。
import { AUDIO } from '../core/constants.js';

/** 默认渐变时长（毫秒） */
export const FADE_MS = 1500;
/** stop() 用的快速淡出，避免拖尾 */
export const STOP_FADE_MS = 250;
/** 音量渐变的步进间隔 */
const RAMP_STEP_MS = 30;

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

export class MusicPlayer {
  /**
   * @param {string} url 音乐文件地址（assets/audio/music/yuzhouchangwan.wav）
   * @param {{volume?: number, fadeMs?: number, loop?: boolean}} [options]
   */
  constructor(url, { volume = AUDIO.musicVolume, fadeMs = FADE_MS, loop = true } = {}) {
    this.url = url;
    this.targetVolume = clamp01(volume);
    this.fadeMs = Math.max(0, Number(fadeMs) || 0);
    this.loop = loop !== false;
    this.audio = null;
    /** 被浏览器自动播放策略拦下 */
    this.blocked = false;
    /** 音频文件加载/解码失败 */
    this.failed = false;
    this._playing = false;
    this._fadeToken = 0;
    this._fadeTimer = null;
  }

  /** 播放意图（淡出过程中仍为 true，pause()/stop() 立刻变 false） */
  get playing() {
    return this._playing;
  }

  get volume() {
    return this.audio ? Number(this.audio.volume) || 0 : 0;
  }

  #ensure() {
    if (this.audio) return this.audio;
    const Ctor = globalThis.Audio;
    if (typeof Ctor !== 'function' || !this.url) return null; // 非浏览器环境或没有音乐文件：静默降级
    const a = new Ctor();
    a.src = this.url;
    a.loop = this.loop;
    a.preload = 'auto';
    a.volume = 0; // 一律从 0 抬起来，避免爆音
    a.addEventListener?.('error', () => {
      this.failed = true;
      this._playing = false;
    });
    a.addEventListener?.('ended', () => {
      if (!this.loop) this._playing = false;
    });
    this.audio = a;
    return a;
  }

  /** 开始在 0 音量播放，然后淡入到目标音量 */
  async start() {
    return this.fadeIn(this.fadeMs);
  }

  /** 淡入；若尚未播放会先 play()（必须在用户手势里同步调用才能解锁声音） */
  fadeIn(ms = this.fadeMs) {
    const a = this.#ensure();
    if (!a) return Promise.resolve(false);
    this._playing = true;
    if (!a.paused && !this.blocked && !this.failed) {
      // 已经在播：直接抬音量
      this.#ramp(this.targetVolume, ms);
      return Promise.resolve(true);
    }
    return this.#begin(ms);
  }

  async #begin(ms) {
    const a = this.#ensure();
    if (!a) return false;
    this._fadeToken++; // 取消进行中的淡出
    a.volume = 0;
    let p;
    try {
      p = a.play(); // 同步调用，保住用户手势上下文
    } catch (err) {
      this.failed = true;
      this._playing = false;
      return false;
    }
    if (p && typeof p.then === 'function') {
      try {
        await p;
      } catch (err) {
        // 自动播放被拒绝：静默失败，记录状态，交给界面提示
        this.blocked = true;
        this._playing = false;
        return false;
      }
    }
    this.blocked = false;
    this._playing = true;
    this.#ramp(this.targetVolume, ms);
    return true;
  }

  /** 淡出后暂停 */
  pause() {
    if (!this.audio) {
      this._playing = false;
      return;
    }
    this._playing = false;
    if (this.audio.paused) return;
    this.#ramp(0, this.fadeMs, () => {
      try { this.audio?.pause(); } catch { /* 忽略 */ }
    });
  }

  /** 淡出；不暂停播放（供切歌/让位给人声使用） */
  fadeOut(ms = this.fadeMs) {
    const a = this.#ensure();
    if (!a) return Promise.resolve(false);
    this._playing = false;
    if (a.paused) {
      a.volume = 0;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.#ramp(0, ms, () => resolve(true));
    });
  }

  /** 恢复播放并淡入 */
  async resume() {
    return this.fadeIn(this.fadeMs);
  }

  /** 停止并复位到开头 */
  stop() {
    this._playing = false;
    const a = this.audio;
    if (!a) return;
    if (a.paused) {
      a.volume = 0;
      try { a.currentTime = 0; } catch { /* 忽略 */ }
      return;
    }
    this.#ramp(0, STOP_FADE_MS, () => {
      try { a.pause(); } catch { /* 忽略 */ }
      try { a.currentTime = 0; } catch { /* 忽略 */ }
    });
  }

  /** 设置目标音量；未在渐变中时立刻生效 */
  setVolume(v) {
    this.targetVolume = clamp01(v);
    if (this.audio && this._playing && !this._fadeTimer) {
      this.audio.volume = this.targetVolume;
    }
  }

  /** 释放资源（页面卸载 / 自测用） */
  destroy() {
    this._playing = false;
    clearInterval(this._fadeTimer);
    this._fadeTimer = null;
    this._fadeToken++;
    const a = this.audio;
    this.audio = null;
    if (!a) return;
    try { a.pause(); } catch { /* 忽略 */ }
    try { a.removeAttribute('src'); a.load?.(); } catch { /* 忽略 */ }
  }

  /** 音量渐变；token 变化 / 新的渐变会取消旧的 */
  #ramp(to, ms, onDone) {
    const a = this.#ensure();
    if (!a) {
      onDone?.();
      return;
    }
    clearInterval(this._fadeTimer);
    this._fadeTimer = null;
    const token = ++this._fadeToken;
    const from = clamp01(a.volume);
    const target = clamp01(to);
    const duration = Math.max(0, Math.round(Number(ms) || 0));
    if (duration === 0) {
      a.volume = target;
      onDone?.();
      return;
    }
    const started = Date.now();
    this._fadeTimer = setInterval(() => {
      if (token !== this._fadeToken) {
        clearInterval(this._fadeTimer);
        this._fadeTimer = null;
        return;
      }
      const k = Math.min(1, (Date.now() - started) / duration);
      try { a.volume = clamp01(from + (target - from) * k); } catch { /* 忽略 */ }
      if (k >= 1) {
        clearInterval(this._fadeTimer);
        this._fadeTimer = null;
        onDone?.();
      }
    }, RAMP_STEP_MS);
    // Node 自测时不要因为这个定时器挂住进程
    this._fadeTimer?.unref?.();
  }
}

export default MusicPlayer;
