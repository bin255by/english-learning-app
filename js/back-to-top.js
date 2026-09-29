/* ==========================================================================
 * back-to-top.js — 全站「快速返回顶部」浮动按钮
 * --------------------------------------------------------------------------
 * 职责：
 *   1. 在 app.js 启动时挂载一次（5 个 Tab 页面共用，不随视图切换重复创建）
 *   2. 页面滚动超过 400px 后淡入显示，滚回 400px 以内自动隐藏
 *   3. 页面本身不可滚动（内容不足一屏）时始终隐藏
 *   4. 点击平滑滚动到顶部
 *
 * 位置：屏幕右下角，底部 Tab 栏上方 16px（已考虑 iPhone 安全区）
 * 尺寸：直径 48px（≥44px 触控标准）
 * ========================================================================== */

/** 滚动多少像素后才显示 */
const SHOW_THRESHOLD = 400;
/** 判定「页面不可滚动」的容差：内容高度比视口高出不到这个数就认为滚不动 */
const NO_SCROLL_TOLERANCE = 8;

/** 单例句柄：重复调用 initBackToTop() 不会重复挂载 */
let instance = null;

/**
 * 挂载返回顶部按钮（幂等）。
 * @param {{threshold?: number}} [options] threshold = 触发显示的滚动距离，默认 400
 * @returns {{element: HTMLElement, destroy: Function}|null}
 */
export function initBackToTop(options = {}) {
  if (instance) return instance;
  if (typeof document === 'undefined' || !document.body) return null;

  const threshold = Number(options.threshold) > 0 ? Number(options.threshold) : SHOW_THRESHOLD;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'back-to-top';
  btn.id = 'backToTop';
  btn.setAttribute('aria-label', '返回顶部');
  btn.setAttribute('aria-hidden', 'true');        // 隐藏时对读屏软件也不朗读
  btn.tabIndex = -1;                             // 隐藏时不可聚焦
  btn.hidden = true;

  const icon = document.createElement('span');
  icon.className = 'back-to-top__icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '↑';
  btn.append(icon);

  /* 点击：平滑回到顶部；兼容个别浏览器不支持 smooth 的情况 */
  btn.addEventListener('click', () => {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      window.scrollTo(0, 0);
    }
    // 回到顶部后立刻隐藏，避免按钮还挂在屏幕上
    if (window.scrollY <= 0) setVisible(false);
  });

  document.body.append(btn);

  /* ---- 滚动监听：rAF 节流，避免高频 scroll 事件把主线程打满 ---- */
  let ticking = false;

  const update = () => {
    ticking = false;
    const y = window.pageYOffset || document.documentElement.scrollTop || 0;
    const doc = document.documentElement;
    const scrollable = (doc.scrollHeight - window.innerHeight) > NO_SCROLL_TOLERANCE;
    setVisible(scrollable && y > threshold);
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };

  function setVisible(visible) {
    if (!visible) {
      btn.classList.remove('is-visible');
      btn.setAttribute('aria-hidden', 'true');
      btn.tabIndex = -1;
      // 等淡出动画结束再真正隐藏，保证过渡可见
      window.clearTimeout(setVisible.timer);
      setVisible.timer = window.setTimeout(() => {
        if (!btn.classList.contains('is-visible')) btn.hidden = true;
      }, 220);
      return;
    }
    window.clearTimeout(setVisible.timer);
    btn.hidden = false;
    btn.classList.add('is-visible');
    btn.setAttribute('aria-hidden', 'false');
    btn.tabIndex = 0;
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();   // 首屏内容不足一屏时保证按钮是隐藏的

  instance = {
    element: btn,
    destroy() {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.clearTimeout(setVisible.timer);
      if (btn.parentNode) btn.parentNode.removeChild(btn);
      instance = null;
    }
  };
  return instance;
}

/** 当前是否已挂载（调试用：__app.backToTop） */
export function getBackToTop() {
  return instance;
}
