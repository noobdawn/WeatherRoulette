// 音频清单：按需加载 + 并发限流 + 缓存，避免 1000 多个 mp3 同时发请求。
import { audioUrlFor, loadAudioManifest } from './manifest.js';

const MAX_CONCURRENT = 6;

export class ClipLoader {
  constructor() {
    /** @type {Map<string, HTMLAudioElement>} */
    this.clips = new Map();
    this.inflight = new Map();
    this.active = 0;
    this.queue = [];
    this.failed = new Set();
  }

  /** 已就绪的片段 */
  get readyCount() {
    return this.clips.size;
  }

  has(src) {
    return this.clips.has(src);
  }

  /** 预加载一个片段；重复调用共享同一个 Promise */
  load(src) {
    if (this.clips.has(src)) return Promise.resolve(this.clips.get(src));
    if (this.inflight.has(src)) return this.inflight.get(src);
    const p = new Promise((resolve, reject) => {
      this.queue.push({ src, resolve, reject });
      this.#pump();
    }).finally(() => this.inflight.delete(src));
    this.inflight.set(src, p);
    return p;
  }

  #pump() {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      const audio = new Audio();
      audio.preload = 'auto';
      audio.src = job.src;
      const done = (ok) => {
        this.active--;
        if (ok) {
          this.clips.set(job.src, audio);
          job.resolve(audio);
        } else {
          this.failed.add(job.src);
          job.reject(new Error(`音频加载失败：${job.src}`));
        }
        this.#pump();
      };
      audio.addEventListener('canplaythrough', () => done(true), { once: true });
      audio.addEventListener('error', () => done(false), { once: true });
      audio.load();
    }
  }

  /** 批量预加载，失败的片段被忽略（播放时会自动跳过） */
  async preloadAll(srcs) {
    const uniq = [...new Set(srcs)].filter((s) => !this.clips.has(s));
    const results = await Promise.allSettled(uniq.map((s) => this.load(s)));
    return {
      ok: results.filter((r) => r.status === 'fulfilled').length,
      failed: results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message),
    };
  }

  get(src) {
    return this.clips.get(src) ?? null;
  }
}

export { loadAudioManifest, audioUrlFor };
