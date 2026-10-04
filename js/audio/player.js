// 播报总控：把卡片队列一句一句播出去，负责打断、暂停/恢复、进度回调与无限循环。
//
// 对外契约（main.js 严格按此调用，签名不可改）：
//   new Broadcaster({ cards, loader, music, hooks })
//   hooks = { onCardStart(index, card, total), onCardEnd(index, card),
//             onProgress({index,total,phase}), onFinish(), onError(err) }
//   await start() / pause() / await resume() / await next() / await prev()
//   await goto(i) / await reshuffle() / get state -> { playing, paused, index, total }
//
// 兼容扩展（对上面完全向后兼容）：
//   - cardsProvider: 一个返回「下一批卡片数组」的函数。给了它之后，一轮播完会先发
//     onPassEnd(最后一张下标, 总数)，再用 cardsProvider() 取新队列接着播，实现无限循环
//     （此时不再发 onFinish）。js/main.js 用的就是这个模式。
//   - onCardStart 的第三个参数是 total，js/main.js 需要它来算进度。
//   - get total / index / playing / paused / finished / cards / speech / loader / music
//   - setCards(cards) / stop() / start(index) / reshuffle(cards) 可选传参
import { AUDIO } from '../core/constants.js';
import { describeCard } from '../core/format.js';
import { shuffled } from '../core/utils.js';
import { audioUrlFor } from './manifest.js';
import { SpeechSequencer } from './speech.js';

/** 每城开始后预取下一城的前几个片段，减少网络往返带来的句内卡顿 */
const PREFETCH_SEGMENTS = 4;

export class Broadcaster {
  constructor({ cards = [], cardsProvider = null, loader, music = null, hooks = {} } = {}) {
    this.cards = Array.isArray(cards) ? cards : [];
    /** 返回下一批卡片的函数（可选）：给了它就一轮接一轮自动播下去 */
    this.cardsProvider = typeof cardsProvider === 'function' ? cardsProvider : null;
    this.loader = loader;
    this.music = music || null;
    this.hooks = hooks || {};
    this.speech = new SpeechSequencer(loader);

    this._playing = false;
    this._paused = false;
    this._started = false;
    this._index = 0;
    this._segment = 0;
    this._token = 0;
    this._runAbort = null;
    this._startResolvers = new Map();
    this._finished = Promise.resolve();
  }

  // ---------------------------------------------------------------- 状态

  get state() {
    return {
      playing: this._playing,
      paused: this._paused,
      index: this._index,
      total: this.cards.length,
    };
  }

  get total() { return this.cards.length; }
  get index() { return this._index; }
  get playing() { return this._playing; }
  get paused() { return this._paused; }
  /** 当前这一轮队列播完（或被切走）时 resolve；main.js 想用 await 代替 onFinish 时可用 */
  get finished() { return this._finished; }

  // ---------------------------------------------------------------- 对外操作

  /** 从 index 开始播；返回时「已经开始出声」而不是「播完了」（播完走 onFinish / onPassEnd） */
  async start(index = 0) {
    this._started = true;
    this._paused = false;
    this._segment = 0;
    if (!this.cards.length) this.#pullCards(); // main.js 模式：用 cardsProvider 取第一批
    const i = this.#clampIndex(index);
    this._index = i;
    this.#music('fadeIn'); // 必须同步调用，保住用户手势里的音频解锁
    this.#abortRun();
    this.#prefetch(i);
    // 开场留白：让《渔舟唱晚》先起拍，孩子也先看清城市名
    const run = this.#begin(i, 0, AUDIO.introDelay);
    await this.#awaitStart(run);
    return this.state;
  }

  /** 暂停播报与音乐，记住停到哪个片段（resume 从那里继续） */
  pause() {
    if (this._paused && !this._playing) return;
    this._paused = true;
    this._playing = false;
    // 保留 token，让被打断的那一句把「续播片段号」写回来
    this.#abortRun(true);
    this.#music('fadeOut');
    this.#emit('onProgress', { index: this._index, total: this.cards.length, phase: 'pause' });
  }

  /** 从暂停处继续 */
  async resume() {
    if (this._playing && !this._paused) return this.state;
    this._started = true;
    this._paused = false;
    this.#music('fadeIn');
    this.#abortRun();
    const run = this.#begin(this.#clampIndex(this._index), this._segment || 0);
    await this.#awaitStart(run);
    return this.state;
  }

  /** 立刻跳到下一城（打断当前句，不留重叠） */
  async next() {
    return this.#jump(this._index + 1, 'next');
  }

  async prev() {
    return this.#jump(this._index - 1, 'prev');
  }

  async goto(i) {
    return this.#jump(i, 'goto');
  }

  /** 重新洗牌（可传入新队列）后从头播 */
  async reshuffle(cards) {
    if (Array.isArray(cards) && cards.length) {
      this.cards = cards;
    } else if (this.cards.length > 1) {
      this.cards = shuffled(this.cards);
      if (this.#orderKey(this.cards) === this._lastOrder) {
        // 洗出来和原来一样时手动错一位，避免孩子看到「没变」
        this.cards = this.cards.slice(1).concat(this.cards.slice(0, 1));
      }
    }
    this._lastOrder = this.#orderKey(this.cards);
    this._started = true;
    this._paused = false;
    this._index = 0;
    this._segment = 0;
    this.#music('fadeIn');
    this.#abortRun();
    this.#prefetch(0);
    const run = this.#begin(0, 0);
    await this.#awaitStart(run);
    return this.state;
  }

  /** 直接替换队列（不自动开播） */
  setCards(cards) {
    if (Array.isArray(cards)) this.cards = cards;
    this._index = this.#clampIndex(this._index);
    return this.state;
  }

  /** 全部停下并复位（页面卸载/重新开始用） */
  stop() {
    this._started = false;
    this._playing = false;
    this._paused = false;
    this._index = 0;
    this._segment = 0;
    this.#abortRun();
    this.#music('stop');
    this.#emit('onProgress', { index: 0, total: this.cards.length, phase: 'stop' });
  }

  // ---------------------------------------------------------------- 内部

  #clampIndex(i) {
    const n = this.cards.length;
    if (!n) return 0;
    const v = Math.round(Number(i) || 0);
    return Math.max(0, Math.min(n - 1, v));
  }

  #orderKey(list) {
    return list.map((c) => c?.city?.id ?? c?.city?.zh ?? '?').join('|');
  }

  /** 中断当前一轮：token 失效 + signal 打断 + 立刻停声。
   *  keepToken=true（pause）时保留 token，让被中断的那句把续播片段号写回来。 */
  #abortRun(keepToken = false) {
    if (!keepToken) this._token++;
    const ctrl = this._runAbort;
    this._runAbort = null;
    try { ctrl?.abort(); } catch { /* 忽略 */ }
    this.speech.stop();
  }

  /** 起一轮播报；preRoll 是开场留白（毫秒）。返回 { token, started, done } */
  #begin(from, startSegment = 0, preRoll = 0) {
    const token = ++this._token;
    const controller = new AbortController();
    this._runAbort = controller;
    this._playing = true;
    this._paused = false;
    this._lastOrder = this.#orderKey(this.cards);

    let resolveStarted;
    const started = new Promise((r) => { resolveStarted = r; });
    this._startResolvers.set(token, resolveStarted);

    let resolveFinished;
    const finished = new Promise((r) => { resolveFinished = r; });
    this._finished = finished;

    const done = (async () => {
      const signal = controller.signal;
      const alive = () => token === this._token && !signal.aborted;
      try {
        if (preRoll > 0) {
          this.#prefetch(from);
          if (!(await this.#wait(preRoll, signal))) return;
        }
        let cursor = from;
        let segment = startSegment;
        // 一轮播完 → 有 cardsProvider 就换新队列接着播（无限循环），否则发 onFinish
        for (;;) {
          const completed = await this.#playFrom(cursor, segment, signal, token);
          if (!completed || !alive()) return;
          this._playing = false;
          this.#emit('onProgress', { index: this.cards.length, total: this.cards.length, phase: 'end' });
          if (!this.cardsProvider) {
            this.#emit('onFinish');
            return;
          }
          this.#emit('onPassEnd', Math.max(0, this.cards.length - 1), this.cards.length);
          if (!alive()) return;
          if (!this.#pullCards()) {
            this.#emit('onError', new Error('cardsProvider 没能给出新的卡片队列，播报停止'));
            return;
          }
          cursor = 0;
          segment = 0;
          this._index = 0;
          this._playing = true;
          this.#prefetch(0);
          if (!(await this.#wait(AUDIO.cardLeadIn, signal))) return;
        }
      } catch (err) {
        this._playing = false;
        this.#emit('onError', err);
      } finally {
        this._startResolvers.delete(token);
        resolveFinished(this.state);
      }
    })();

    return { token, started, done };
  }

  /** 依次播完 from..end；返回 true 表示这一轮播完了，false 表示被打断 */
  async #playFrom(from, startSegment, signal, token) {
    for (let i = from; i < this.cards.length; i++) {
      if (token !== this._token || signal.aborted) return false;
      this._index = i;
      await this.#playCard(i, this.cards[i], signal, token, i === from ? startSegment : 0);
      if (token !== this._token || signal.aborted) return false;
    }
    return true;
  }

  /** 从 cardsProvider 取下一批卡片；失败不抛，返回 false */
  #pullCards() {
    if (!this.cardsProvider) return false;
    try {
      const next = this.cardsProvider();
      if (Array.isArray(next) && next.length) {
        this.cards = next;
        this._lastOrder = this.#orderKey(next);
        return true;
      }
      return false;
    } catch (err) {
      this.#emit('onError', err);
      return false;
    }
  }

  async #awaitStart(run) {
    // 正常情况：第一张卡片开始播就返回；万一队列是空的，等这一轮结束
    await Promise.race([run.started, run.done]);
  }

  /** 一城：onCardStart → 等 cardLeadIn → speak → onCardEnd（speak 内部含句间停顿） */
  async #playCard(i, card, signal, token, startSegment) {
    const total = this.cards.length;
    this.#emit('onCardStart', i, card, total);
    const resolveStarted = this._startResolvers.get(token);
    if (resolveStarted) {
      this._startResolvers.delete(token);
      resolveStarted();
    }
    this.#emit('onProgress', { index: i, total, phase: 'lead-in' });

    if (startSegment === 0 && AUDIO.cardLeadIn > 0) {
      if (!(await this.#wait(AUDIO.cardLeadIn, signal))) return false;
    }
    if (signal.aborted || token !== this._token) return false;

    let segments = [];
    try {
      segments = describeCard(card)?.segments ?? [];
    } catch (err) {
      // 文案构造失败：报错但继续，下一城
      this.#emit('onError', err);
      this.#emit('onCardEnd', i, card);
      return true;
    }

    this.#emit('onProgress', { index: i, total, phase: 'speak' });
    let res = null;
    try {
      res = await this.speech.speak(segments, {
        signal,
        startAt: startSegment,
        // 注意展开顺序：片段级进度（speech 传上来的 index/total 是「第几个片段」）
        // 必须放在城市级 index/total 之前，否则会把「第几座城市」覆盖成「第几个片段」，
        // 进度条会瞬间变成 x/6 再回弹（大屏版实测复现过）。
        onProgress: (p) => this.#emit('onProgress', { ...p, index: i, total, phase: 'speak' }),
        // speak 内部的句间停顿期间预取下一城，减少下一句开头的网络卡顿
        onTrailingGap: () => this.#prefetch(i + 1),
      });
    } catch (err) {
      this.#emit('onError', err);
    }

    if (signal.aborted || token !== this._token || res?.aborted) {
      if (token === this._token) this._segment = res?.nextSegment ?? startSegment;
      return false;
    }

    this._segment = 0;
    this.#emit('onCardEnd', i, card);
    this.#emit('onProgress', {
      index: i,
      total,
      phase: 'card-end',
      played: res?.played?.length ?? 0,
      skipped: res?.skipped?.length ?? 0,
    });
    return true;
  }

  /** 跳到指定下标（越界时环形回绕，保证无限循环不断档） */
  async #jump(target, phase) {
    const total = this.cards.length;
    if (!total) {
      this.#emit('onFinish');
      return this.state;
    }
    let i = Math.round(Number(target) || 0);
    if (i >= total) i = 0;
    if (i < 0) i = total - 1;
    i = this.#clampIndex(i);

    this._index = i;
    this._segment = 0;
    this.#abortRun();
    this.#emit('onProgress', { index: i, total, phase });

    if (!this._started || this._paused) {
      // 还没点「开始」或正处于暂停：只换卡片不出声，等 resume/start 再读
      this.#emit('onCardStart', i, this.cards[i], total);
      return this.state;
    }

    this.#music('fadeIn');
    this.#prefetch(i);
    const run = this.#begin(i, 0);
    await this.#awaitStart(run);
    return this.state;
  }

  /** 可中断的等待：返回 false 表示被打断 */
  #wait(ms, signal) {
    return new Promise((resolve) => {
      let done = false;
      const onAbort = () => finish(false);
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolve(v);
      };
      const timer = setTimeout(() => finish(true), Math.max(0, Math.round(ms) || 0));
      if (signal) {
        if (signal.aborted) return finish(false);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** 预取某一城的前几个片段；失败静默（真正播到时再由 SpeechSequencer 跳过） */
  #prefetch(index, limit = PREFETCH_SEGMENTS) {
    const card = this.cards[index];
    if (!card || !this.loader?.load) return;
    let segments;
    try {
      segments = describeCard(card)?.segments ?? [];
    } catch {
      return;
    }
    for (const seg of segments.slice(0, limit)) {
      let url;
      try {
        url = audioUrlFor(seg);
      } catch {
        continue;
      }
      if (this.loader.has?.(url) || this.speech.failed.has(url)) continue;
      try {
        Promise.resolve(this.loader.load(url)).catch(() => {});
      } catch { /* 忽略 */ }
    }
  }

  #emit(name, ...args) {
    const fn = this.hooks?.[name];
    if (typeof fn !== 'function') return;
    try {
      fn(...args);
    } catch (err) {
      // 回调自己抛错不能拖垮播报；onError 再抛就吞掉
      if (name !== 'onError') this.#emit('onError', err);
      else console.error('[Broadcaster] onError 回调自身抛错：', err);
    }
  }

  /** 调用音乐播放器的方法：同步触发（保住用户手势），异常一律静默 */
  #music(method, ...args) {
    const fn = this.music?.[method];
    if (typeof fn !== 'function') return;
    try {
      const p = fn.apply(this.music, args);
      if (p && typeof p.then === 'function') p.catch(() => {});
    } catch (err) {
      console.warn(`[Broadcaster] music.${method}() 失败（已忽略）：`, err);
    }
  }
}

export default Broadcaster;
