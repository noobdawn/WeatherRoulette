// 毛玻璃加载界面：把语音包预下载完再开始播报，避免「进去等半天才出声」。
//
// 视觉：极简 —— 只有一根细长进度条 + 一个「强制进入」按钮，没有标题也没有百分比文字。
//   背景一开始就会渲染（第一张壁纸 + 大字已在毛玻璃后面），所以等待期间画面不是空白，
//   而是透过磨砂玻璃能看见城市的轮廓。
//
// 交互：点「强制进入」（或点屏幕上任意位置）可以跳过等待立刻开播；
//   未下完的片段在播放时按需加载，仍能播，只是首次可能略有延迟。
//
// 样式用 <style> 就地注入，不改 style.css（那是界面外壳的文件）。

const STYLE_ID = 'wr-loading-css';

const CSS = `
#wr-loading {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgba(8, 12, 24, 0.26);
  -webkit-backdrop-filter: blur(28px) saturate(1.2);
  backdrop-filter: blur(28px) saturate(1.2);
  transition: opacity 450ms ease, visibility 450ms ease;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif;
}
#wr-loading.is-gone {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

#wr-loading .wr-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: clamp(22px, 3.4vmin, 34px);
  width: min(66vw, 420px);
}

/* 细长进度条 */
#wr-loading .wr-bar {
  width: 100%;
  height: 3px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
  overflow: hidden;
}
#wr-loading .wr-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.55);
  transition: width 220ms ease;
}

/* 极简按钮：只有文字，一条细边框 */
#wr-loading .wr-skip {
  appearance: none;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.42);
  color: #fff;
  border-radius: 999px;
  padding: 0.62em 1.5em;
  font: inherit;
  font-size: clamp(15px, 2.1vmin, 18px);
  font-weight: 600;
  letter-spacing: 0.08em;
  cursor: pointer;
  opacity: 0.82;
  min-height: 48px;
  transition: opacity 200ms ease, border-color 200ms ease, background 200ms ease;
}
#wr-loading .wr-skip:hover,
#wr-loading .wr-skip:focus-visible {
  opacity: 1;
  border-color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.10);
  outline: none;
}
#wr-loading .wr-skip:active { transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  #wr-loading, #wr-loading .wr-fill, #wr-loading .wr-skip { transition: none; }
}
`;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.append(style);
}

export class LoadingScreen {
  /**
   * @param {Document} doc
   * @param {{onSkip?:Function}} opts onSkip：用户点「强制进入」时调用
   */
  constructor(doc = document, { onSkip = null } = {}) {
    this.doc = doc;
    this.onSkip = onSkip;
    this.el = null;
    this.fill = null;
    this.hidden = false;
    this.skipped = false;
  }

  /** 显示加载界面（幂等） */
  show() {
    if (this.el) return this;
    const doc = this.doc;
    ensureStyle(doc);

    const el = doc.createElement('div');
    el.id = 'wr-loading';
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-label', '正在缓存语音包');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('aria-valuenow', '0');

    const box = doc.createElement('div');
    box.className = 'wr-box';

    const bar = doc.createElement('div');
    bar.className = 'wr-bar';
    const fill = doc.createElement('div');
    fill.className = 'wr-fill';
    bar.append(fill);

    const skip = doc.createElement('button');
    skip.className = 'wr-skip';
    skip.type = 'button';
    skip.textContent = '强制进入';
    skip.setAttribute('aria-label', '不等缓存完成，直接开始播报');
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#skip();
    });

    box.append(bar, skip);
    el.append(box);
    // 点空白处也等同于点按钮，避免用户找不到
    el.addEventListener('click', () => this.#skip());

    (doc.getElementById('app') || doc.body).append(el);

    this.el = el;
    this.fill = fill;
    return this;
  }

  #skip() {
    if (this.skipped || this.hidden) return;
    this.skipped = true;
    console.info('[WeatherRoulette] 用户选择强制进入，跳过剩余的语音包下载');
    this.hide();
    try {
      this.onSkip?.();
    } catch (err) {
      console.warn('[WeatherRoulette] onSkip 抛错：', err);
    }
  }

  /** 更新进度（0~1） */
  setProgress({ done = 0, total = 0 } = {}) {
    if (!this.el) return this;
    const ratio = total ? Math.min(1, done / total) : 0;
    this.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.el.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    return this;
  }

  /** 兼容旧调用：极简版不显示任何文字，这里只做空实现 */
  setHint() {
    return this;
  }

  /** 淡出并移除 */
  hide() {
    if (!this.el || this.hidden) return this;
    this.hidden = true;
    const el = this.el;
    el.classList.add('is-gone');
    setTimeout(() => el.remove(), 500);
    return this;
  }

  get visible() {
    return Boolean(this.el) && !this.hidden;
  }
}

export default LoadingScreen;
