// 离线音频拼接引擎：把预生成的片段按顺序播成一句「央视腔」播报。
//
// 设计要点（三条硬要求）：
// 1) 所有时间参数都从 core/constants.js 的 AUDIO 取，这里不写死业务数字；
// 2) 任何单个片段「清单缺失 / 加载失败 / 播放失败 / 超时」都只跳过它，整句继续，绝不卡死；
// 3) 支持 AbortSignal 立刻打断：pause() + currentTime 归零，切换城市时不会有声音重叠。
//
// 音乐不在这里播放，由 music.js 负责。
import { AUDIO } from '../core/constants.js';
import { audioUrlFor, loadAudioManifest, manifestHas } from './manifest.js';

/** 单个片段加载超时（毫秒）：超时按失败跳过，避免一个卡住的请求拖死整句 */
export const CLIP_LOAD_TIMEOUT = 8000;
/** 音频清单读取超时（毫秒）：读不到就退化成「乐观加载」，能播的照播 */
export const MANIFEST_TIMEOUT = 6000;
/** 片段播放兜底超时（毫秒）：ended 事件没来时的保险丝 */
const PLAY_FALLBACK_MS = 15000;
/** 兜底超时 = 片段时长 + 这段余量 */
const PLAY_TAIL_MS = 3000;

/** 相邻片段之间的停顿：city → weather 用 gapCityToWeather，其余相邻关系用 gapWeatherToTemp */
export function gapBetween(prev, next) {
  if (!prev || !next) return 0;
  if (prev.kind === 'city' && next.kind === 'weather') return AUDIO.gapCityToWeather;
  return AUDIO.gapWeatherToTemp;
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** 可中断的等待：被 abort 时立刻返回 false */
function sleep(ms, latch) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(true), Math.max(0, Math.round(ms) || 0));
    latch?.promise.then(() => finish(false));
  });
}

/** 把 promise 与「超时」「打断」赛跑；打断/超时统一以 reject 表示失败 */
function raceWith(promise, latch, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => done(reject, new Error('timeout')), Math.max(1, Math.round(timeoutMs) || 1));
    Promise.resolve(promise).then(
      (v) => done(resolve, v),
      (e) => done(reject, e),
    );
    latch?.promise.then(() => done(reject, new Error('aborted')));
  });
}

/** AbortSignal 的一次性封装：方便清理监听器，也方便不传 signal 时也能工作 */
class AbortLatch {
  constructor(signal) {
    this.signal = signal || null;
    this.fired = false;
    this._resolve = null;
    this._onAbort = null;
    this.promise = new Promise((resolve) => { this._resolve = resolve; });
    if (this.signal) {
      this._onAbort = () => this.fire();
      if (this.signal.aborted) this.fire();
      else this.signal.addEventListener('abort', this._onAbort, { once: true });
    }
  }

  get aborted() {
    return this.fired || Boolean(this.signal?.aborted);
  }

  fire() {
    if (this.fired) return;
    this.fired = true;
    this._resolve('abort');
  }

  dispose() {
    if (this._onAbort && this.signal) this.signal.removeEventListener('abort', this._onAbort);
    this._onAbort = null;
  }
}

function playTimeoutFor(audio) {
  const d = Number(audio?.duration);
  if (Number.isFinite(d) && d > 0) return d * 1000 + PLAY_TAIL_MS;
  return PLAY_FALLBACK_MS;
}

export class SpeechSequencer {
  /**
   * @param {import('./loader.js').ClipLoader} loader 并发限流加载器（可直接用 loader.js 的 ClipLoader）
   * @param {{manifest?: object, loadTimeout?: number}} [options] manifest 可注入（自测用）；不传则自动读取
   */
  constructor(loader, { manifest = null, loadTimeout = CLIP_LOAD_TIMEOUT } = {}) {
    if (!loader || typeof loader.load !== 'function') {
      throw new Error('SpeechSequencer 需要一个带 load(url) 的加载器（ClipLoader）');
    }
    this.loader = loader;
    this.manifest = manifest || null;
    this.loadTimeout = loadTimeout;
    /** 已经确认拿不到的片段，后续直接跳过，不再重试 */
    this.failed = new Set();
    /** 正在播放的 audio 元素 */
    this._pending = null;
    this._speaking = false;
    this._manifestPromise = null;
    this._manifestFailedAt = 0;
  }

  get speaking() {
    return this._speaking;
  }

  /** 立刻让当前片段静音停住（打断用），不抛异常 */
  stop() {
    const pending = this._pending;
    this._pending = null;
    if (pending?.audio) this.#silence(pending.audio);
    if (pending?.finish) pending.finish('aborted');
  }

  /**
   * 顺序播放一句话。
   * @param {Array<{kind:string,key:string}>} segments 来自 describeCard(card).segments
   * @param {{signal?: AbortSignal, onProgress?: Function, onTrailingGap?: Function, startAt?: number, trailingGap?: boolean}} [options]
   * @returns {Promise<{played:Array, skipped:Array, aborted:boolean, nextSegment:number}>}
   */
  async speak(segments, { signal, onProgress, onTrailingGap, startAt = 0, trailingGap = true } = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const from = Math.max(0, Math.min(list.length, Math.round(Number(startAt) || 0)));
    const result = { played: [], skipped: [], aborted: false, nextSegment: from };
    const latch = new AbortLatch(signal);

    if (!list.length) {
      latch.dispose();
      return result;
    }
    if (latch.aborted) {
      result.aborted = true;
      latch.dispose();
      return result;
    }

    this._speaking = true;
    try {
      // 清单读不到（离线 / file:// 打开）时不拦路，退化为乐观加载：能加载的照播。
      const manifest = await this.#manifest(latch);
      if (latch.aborted) {
        result.aborted = true;
        result.nextSegment = from;
        return result;
      }

      for (let i = from; i < list.length; i++) {
        if (latch.aborted) {
          result.aborted = true;
          result.nextSegment = i;
          break;
        }
        const seg = list[i];
        result.nextSegment = i;

        // 1) 片段前的停顿：由「上一个片段 → 当前片段」的 kind 推断
        if (i > from) {
          const gapMs = gapBetween(list[i - 1], seg);
          if (gapMs > 0 && !(await sleep(gapMs, latch))) {
            result.aborted = true;
            result.nextSegment = i;
            break;
          }
        }
        if (latch.aborted) {
          result.aborted = true;
          result.nextSegment = i;
          break;
        }

        // 2) 解析 URL；未知类型直接跳过（不卡死）
        let url;
        try {
          url = audioUrlFor(seg);
        } catch (err) {
          result.skipped.push({ ...seg, url: null, reason: 'unknown-kind', message: err?.message });
          continue;
        }

        // 3) 清单里没有 → 跳过（不发无谓请求）
        if (manifest && !manifestHas(manifest, seg)) {
          result.skipped.push({ ...seg, url, reason: 'missing-in-manifest' });
          continue;
        }
        if (this.failed.has(url)) {
          result.skipped.push({ ...seg, url, reason: 'known-failed' });
          continue;
        }

        // 4) 加载片段（超时 / 打断都算失败，跳过继续）
        let audio;
        try {
          audio = await raceWith(this.loader.load(url), latch, this.loadTimeout);
        } catch (err) {
          this.failed.add(url);
          if (latch.aborted) {
            result.aborted = true;
            result.nextSegment = i;
            break;
          }
          result.skipped.push({ ...seg, url, reason: err?.message === 'timeout' ? 'load-timeout' : 'load-failed', message: err?.message });
          continue;
        }
        if (latch.aborted) {
          result.aborted = true;
          result.nextSegment = i;
          break;
        }
        if (!audio || typeof audio.play !== 'function') {
          this.failed.add(url);
          result.skipped.push({ ...seg, url, reason: 'not-audio' });
          continue;
        }

        // 5) 播放并等 ended
        const outcome = await this.#playOne(audio, latch);
        if (outcome === 'aborted') {
          result.aborted = true;
          result.nextSegment = i;
          break;
        }
        if (outcome !== 'ended') {
          this.failed.add(url);
          result.skipped.push({ ...seg, url, reason: outcome === 'timeout' ? 'play-timeout' : 'play-failed' });
          continue;
        }

        result.played.push({ ...seg, url });
        try {
          onProgress?.({ done: result.played.length, total: list.length, index: i, kind: seg.kind, key: seg.key });
        } catch { /* 回调异常不影响播报 */ }
      }

      // 6) 句间停顿（整句结束 → 下一城），同样可被打断；
      //    停顿期间通过 onTrailingGap 通知调用方（用来预取下一城）
      if (!result.aborted && trailingGap && AUDIO.gapBetweenCities > 0) {
        try {
          onTrailingGap?.(result);
        } catch { /* 回调异常不影响播报 */ }
        if (!(await sleep(AUDIO.gapBetweenCities, latch))) {
          result.aborted = true;
          // 停在句间停顿里：本句其实已经播完，续播时直接进入下一城
          result.nextSegment = list.length;
        }
      }
      return result;
    } finally {
      this._speaking = false;
      latch.dispose();
      const pending = this._pending;
      this._pending = null;
      if (pending?.audio) this.#silence(pending.audio);
      if (pending?.finish) pending.finish('aborted');
    }
  }

  /** 播放单个片段，返回 'ended' | 'error' | 'timeout' | 'aborted' */
  async #playOne(audio, latch) {
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const onEnded = () => finish('ended');
      const onError = () => finish('error');
      const cleanup = () => {
        clearTimeout(timer);
        audio.removeEventListener?.('ended', onEnded);
        audio.removeEventListener?.('error', onError);
        if (this._pending?.finish === finish) this._pending = null;
      };
      const finish = (why) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(why);
      };
      const timer = setTimeout(() => finish('timeout'), playTimeoutFor(audio));

      try { audio.currentTime = 0; } catch { /* 只读实现忽略 */ }
      try { audio.volume = clamp01(AUDIO.voiceVolume); } catch { /* 忽略 */ }
      audio.addEventListener?.('ended', onEnded, { once: true });
      audio.addEventListener?.('error', onError, { once: true });
      this._pending = { audio, finish };

      // 打断：立刻静音并唤醒等待者，保证和下一个片段不重叠
      latch.promise.then(() => {
        this.#silence(audio);
        finish('aborted');
      });

      let p;
      try {
        p = audio.play();
      } catch {
        finish('error');
        return;
      }
      if (p && typeof p.then === 'function') {
        // 浏览器自动播放策略拒绝 / 解码失败
        p.then(undefined, () => finish('error'));
      }
    });

    if (outcome !== 'aborted') this.#silence(audio);
    if (this._pending?.audio === audio) this._pending = null;
    return outcome;
  }

  /** 停声并复位：pause + currentTime=0，绝不 removeAttribute('src')，缓存元素还要复用 */
  #silence(audio) {
    if (!audio) return;
    try { audio.pause(); } catch { /* 忽略 */ }
    try { audio.currentTime = 0; } catch { /* 忽略 */ }
  }

  /** 清单只读一次；读取失败退化为「乐观加载」，30 秒后允许再试一次 */
  async #manifest(latch) {
    if (this.manifest) return this.manifest;
    if (!this._manifestPromise) {
      this._manifestPromise = loadAudioManifest()
        .then((m) => {
          this.manifest = m;
          return m;
        })
        .catch((err) => {
          console.warn('[speech] 音频清单读取失败，改为乐观加载：', err?.message);
          this._manifestFailedAt = Date.now();
          return null;
        });
    }
    try {
      return await raceWith(this._manifestPromise, latch, MANIFEST_TIMEOUT);
    } catch {
      // 被打断或超时：本次不拦路；清单失败的情况 30 秒后允许重试
      if (!this.manifest && this._manifestFailedAt && Date.now() - this._manifestFailedAt > 30000) {
        this._manifestPromise = null;
        this._manifestFailedAt = 0;
      }
      return null;
    }
  }
}

export default SpeechSequencer;
