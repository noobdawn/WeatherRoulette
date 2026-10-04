// 毛玻璃加载界面：把语音包全部预下载完再开始播报，避免「进去等半天才出声」。
//
// 设计取舍：
//   1) 背景一开始就会渲染（第一张壁纸 + 大字随即出现在毛玻璃后面），所以等待期间
//      画面不是空白，而是透过磨砂玻璃能看见城市的轮廓；
//   2) 进度条只反映「语音片段下载进度」，这是决定能否立刻开播的唯一瓶颈；
//   3) 全部就绪后淡出（450ms），并广播 wr:preload-done，让 main.js 接着开播。
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
  background: rgba(8, 12, 24, 0.28);
  -webkit-backdrop-filter: blur(26px) saturate(1.25);
  backdrop-filter: blur(26px) saturate(1.25);
  transition: opacity 450ms ease, visibility 450ms ease;
  cursor: pointer;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', system-ui, sans-serif;
}
#wr-loading.is-gone {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

#wr-loading .wr-panel {
  min-width: min(78vw, 520px);
  padding: clamp(26px, 4.4vmin, 46px) clamp(30px, 5vw, 58px);
  border-radius: clamp(22px, 3vmin, 34px);
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.30);
  box-shadow:
    0 24px 70px rgba(2, 6, 18, 0.42),
    inset 0 1px 0 rgba(255, 255, 255, 0.38);
  color: #fff;
  text-align: center;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
}

#wr-loading .wr-title {
  font-size: clamp(26px, 4.6vmin, 46px);
  font-weight: 800;
  letter-spacing: 0.06em;
  line-height: 1.2;
}
#wr-loading .wr-sub {
  margin-top: 0.5em;
  font-size: clamp(13px, 1.9vmin, 18px);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.82;
}

#wr-loading .wr-bar {
  margin-top: clamp(20px, 3.2vmin, 32px);
  height: clamp(8px, 1.1vmin, 12px);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.24);
  overflow: hidden;
}
#wr-loading .wr-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: linear-gradient(90deg, #ffffff, #ffd97d);
  box-shadow: 0 0 18px rgba(255, 217, 125, 0.65);
  transition: width 220ms ease;
}

#wr-loading .wr-meta {
  margin-top: clamp(14px, 2.2vmin, 20px);
  display: flex;
  justify-content: space-between;
  gap: 1.2em;
  font-size: clamp(14px, 2.1vmin, 19px);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
#wr-loading .wr-hint {
  margin-top: 0.9em;
  font-size: clamp(12px, 1.7vmin, 15px);
  font-weight: 600;
  opacity: 0.75;
  min-height: 1.2em;
}

@media (prefers-reduced-motion: reduce) {
  #wr-loading, #wr-loading .wr-fill { transition: none; }
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
  constructor(doc = document) {
    this.doc = doc;
    this.el = null;
    this.fill = null;
    this.percent = null;
    this.count = null;
    this.hint = null;
    this.hidden = false;
  }

  /** 显示加载界面（幂等） */
  show({ title = '天气播报', sub = 'Weather Roulette', hint = '' } = {}) {
    if (this.el) return this;
    const doc = this.doc;
    ensureStyle(doc);

    const el = doc.createElement('div');
    el.id = 'wr-loading';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    const panel = doc.createElement('div');
    panel.className = 'wr-panel';

    const t = doc.createElement('div');
    t.className = 'wr-title';
    t.textContent = title;

    const s = doc.createElement('div');
    s.className = 'wr-sub';
    s.textContent = sub;

    const bar = doc.createElement('div');
    bar.className = 'wr-bar';
    const fill = doc.createElement('div');
    fill.className = 'wr-fill';
    bar.append(fill);

    const meta = doc.createElement('div');
    meta.className = 'wr-meta';
    const count = doc.createElement('span');
    const percent = doc.createElement('span');
    meta.append(count, percent);

    const h = doc.createElement('div');
    h.className = 'wr-hint';
    h.textContent = hint;

    panel.append(t, s, bar, meta, h);
    el.append(panel);
    (doc.getElementById('app') || doc.body).append(el);

    this.el = el;
    this.fill = fill;
    this.percent = percent;
    this.count = count;
    this.hint = h;
    return this;
  }

  /** 更新进度；done/total 为片段数，bytes 为已下载字节 */
  setProgress({ done = 0, total = 0, bytes = 0 } = {}) {
    if (!this.el) return this;
    const ratio = total ? Math.min(1, done / total) : 0;
    this.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    this.percent.textContent = `${Math.round(ratio * 100)}%`;
    this.count.textContent = `语音包 ${done} / ${total}`;
    if (bytes) {
      const mb = bytes / 1024 / 1024;
      this.hint.textContent = mb >= 0.1
        ? `已缓存 ${mb.toFixed(1)} MB · 全部准备好后自动开始`
        : '全部准备好后自动开始';
    }
    return this;
  }

  setHint(text) {
    if (this.hint) this.hint.textContent = text;
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
