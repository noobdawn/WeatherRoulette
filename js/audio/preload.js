// 音频预下载器：把语音片段全部灌进浏览器 cache，开播后就不再需要等网络。
//
// 为什么不是「把每个片段都做成 Audio 元素然后 preload」：
//   185 个 Audio 元素会各自占用一条连接并缓存解码后的 PCM，内存与连接都会被吃满；
//   而这里只需要让 HTTP 缓存/CDN 缓存有内容，之后 speech.js 里的 Audio 元素
//   指向同一 URL 时会直接命中缓存，几乎瞬间可播。
//
// 与 Service Worker 的关系：sw.js 对 assets/audio/ 走 cache-first，
// 所以这些 fetch 同时也会把片段写进 wr-audio-* 缓存，离线也能播。
import { audioUrlFor } from './manifest.js';

/** 并发上限：太高会拖慢单个请求，太低又浪费时间 */
const CONCURRENCY = 12;
/** 单个片段下载超时（毫秒）：超时算这次失败，交给下面的重试 */
const TIMEOUT = 20000;
/** 单个片段最多尝试几次（含首次）。不设整体上限，但偶发的网络抖动要靠重试兜住 */
const MAX_ATTEMPTS = 3;
/** 进度停滞多久后提示用户（毫秒）：只是提示，不会中断下载 */
const STALL_HINT_MS = 10000;

export class AudioPreloader {
  constructor() {
    this.total = 0;
    this.done = 0;
    this.failed = [];
    this.loadedBytes = 0;
    this.aborted = false;
    this.startedAt = 0;
  }

  get progress() {
    return this.total ? this.done / this.total : 0;
  }

  get elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /**
   * 下载全部语音片段。会一直等到下完（或每个片段都重试用尽），不设整体时限。
   * @param {Array<{kind:string,key:string}>} segments 任意卡片的片段（会去重）
   * @param {{onProgress?:Function, onStall?:Function, signal?:AbortSignal}} opts
   * @returns {Promise<{total:number, done:number, failed:number, bytes:number, ms:number}>}
   */
  async load(segments, { onProgress, onStall, signal } = {}) {
    const urls = [...new Set(segments.map((s) => audioUrlFor(s)))];
    this.total = urls.length;
    this.startedAt = Date.now();
    if (!urls.length) {
      onProgress?.({ done: 0, total: 0, ratio: 1, bytes: 0 });
      return { total: 0, done: 0, failed: 0, bytes: 0, ms: 0 };
    }

    // 进度停滞检测：只提示，不打断下载
    let lastChange = Date.now();
    const stallTimer = setInterval(() => {
      if (Date.now() - lastChange >= STALL_HINT_MS) {
        onStall?.({ stalledMs: Date.now() - lastChange, done: this.done, total: this.total });
        lastChange = Date.now(); // 避免反复触发同一个提示
      }
    }, 1000);

    let cursor = 0;
    const worker = async () => {
      while (!this.aborted && !signal?.aborted) {
        const i = cursor++;
        if (i >= urls.length) return;
        await this.#oneWithRetry(urls[i], signal);
        this.done++;
        lastChange = Date.now();
        onProgress?.({
          done: this.done,
          total: this.total,
          ratio: this.progress,
          bytes: this.loadedBytes,
          current: urls[i].split('/').pop(),
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()),
    );
    clearInterval(stallTimer);

    return {
      total: this.total,
      done: this.done,
      failed: this.failed.length,
      bytes: this.loadedBytes,
      ms: this.elapsedMs,
    };
  }

  abort() {
    this.aborted = true;
  }

  async #oneWithRetry(url, signal) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.aborted || signal?.aborted) return false;
      const ok = await this.#one(url, signal);
      if (ok) return true;
      lastErr = this.lastError;
      if (attempt < MAX_ATTEMPTS) {
        // 退避一下再试：网络抖动往往下一次就成
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
    this.failed.push({ url, reason: String(lastErr?.message ?? lastErr) });
    return false;
  }

  /** 下载单个片段。返回是否成功；失败原因记在 this.lastError 里供重试逻辑取用。 */
  async #one(url, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      // cache: 'default' —— 命中就秒回；没命中才走网络并写入缓存
      const res = await fetch(url, { signal: controller.signal, cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 必须把 body 读完才会真正进入缓存
      const buf = await res.arrayBuffer();
      this.loadedBytes += buf.byteLength;
      this.lastError = null;
      return true;
    } catch (err) {
      // 单个片段失败不在这里定论：交给 #oneWithRetry 决定是否重试
      this.lastError = err;
      return false;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export default AudioPreloader;
