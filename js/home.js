/* ==========================================================================
 * home.js — 首页「随机知识点卡片」轮播
 * --------------------------------------------------------------------------
 * 职责：
 *   1. 接收 app.js 读到的 home-cards.json 数据，随机挑 5 张渲染成轮播
 *   2. 用 Swiper 11 实现：居中卡片 + 触摸滑动 + 自动轮播 + 圆点指示
 *   3. 点击卡片：先朗读卡片英文，读完后再跳转 targetTab / targetId
 *     （第二次点同一张卡片 = 立即跳转，不必等读完）
 *   4. Swiper 未加载（离线 / 被拦截）时自动降级为横向滚动，功能不丢
 *
 * 说明：卡片英文由「卡片」统一负责朗读（点哪里都读英文、然后跳转），
 *       所以卡片内部不再单独挂 .speakable，避免同一次点击被朗读两遍。
 * ========================================================================== */

import { speak, stopSpeaking } from './tts.js';

const MAX_CARDS = 5;              // 首页固定展示 5 张（数据再多也是随机 5 张）
const AUTOPLAY_DELAY = 5000;      // 自动轮播间隔（毫秒）
const NAV_FALLBACK_MS = 5000;     // 朗读回调迟迟不返回时的兜底跳转时间
const NAV_NO_TTS_MS = 400;        // 浏览器不支持朗读时，稍等一下再跳转

/** 卡片类型 → 中文标签 */
const TYPE_LABEL = {
  root: '词根词缀',
  dialogue: '场景对话',
  vocabulary: '主题单词',
  tip: '美国生活贴士',
  website: '常用网站'
};

let swiper = null;                // 当前 Swiper 实例
let pendingNav = null;            // 正在等待“读完再跳转”的卡片

/* ============================ 1. 对外 API ============================ */
/**
 * 创建首页卡片轮播区块。
 * @param {Array<object>} cards data/home-cards.json 的内容
 * @param {{goTo?: (tab:string, targetId?:string)=>void}} [options]
 * @returns {HTMLElement} 可直接插入页面的 <section>
 */
export function createHomeCards(cards, options = {}) {
  const goTo = typeof options.goTo === 'function' ? options.goTo : function () {};

  const section = el('section', 'section home-cards');
  const head = el('div', 'section__head');
  head.append(el('h2', 'section__title', '每日卡片'));
  head.append(elEn('span', 'section__title-en', 'Daily Card'));
  section.append(head);

  const list = shuffle(Array.isArray(cards) ? cards.slice() : []).slice(0, MAX_CARDS);
  const swiperEl = el('div', 'swiper home-swiper');
  const wrapper = el('div', 'swiper-wrapper');
  list.forEach((card) => wrapper.append(buildSlide(card, goTo)));
  swiperEl.append(wrapper);

  const pagination = el('div', 'swiper-pagination');
  pagination.setAttribute('aria-label', '卡片页码');
  section.append(swiperEl, pagination);
  section.append(el('p', 'home-cards__hint', '左右滑动可以看更多；点卡片会先读英文，再打开对应内容。'));

  if (typeof window.Swiper !== 'function') {
    // 降级：CDN 没加载成功时，用 CSS 横向滚动 + scroll-snap 顶上
    swiperEl.classList.add('swiper--fallback');
    pagination.hidden = true;
    console.warn('[home] Swiper 未加载，卡片降级为横向滚动');
    return section;
  }

  // Swiper 初始化要求元素已在文档中，所以延后一帧（app.js 会在本函数返回后立刻 append）
  requestAnimationFrame(() => initSwiper(swiperEl, pagination));
  return section;
}

/** 销毁 Swiper 实例并取消待跳转（切换 Tab 时调用，避免实例泄漏） */
export function destroyHomeCards() {
  cancelPendingNav();
  if (swiper) {
    try { swiper.destroy(true, true); } catch (err) { /* 忽略 */ }
    swiper = null;
  }
}

/* ============================ 2. Swiper 初始化 ============================ */
function initSwiper(swiperEl, pagination) {
  if (!swiperEl || !document.body.contains(swiperEl)) return;   // Tab 已经切走了
  if (swiper) destroyHomeCards();

  swiper = new window.Swiper(swiperEl, {
    slidesPerView: 1,
    centeredSlides: true,           // 卡片居中
    spaceBetween: 12,
    loop: true,                     // 循环轮播
    grabCursor: true,
    autoHeight: true,               // 卡片高度自适应，文字不会被裁切
    speed: 420,
    autoplay: {
      delay: AUTOPLAY_DELAY,
      disableOnInteraction: false,  // 手动滑过之后，过一会儿继续自动播
      pauseOnMouseEnter: true
    },
    pagination: {
      el: pagination,
      clickable: true                // 圆点可点
    },
    a11y: {
      prevSlideMessage: '上一张卡片',
      nextSlideMessage: '下一张卡片',
      paginationBulletMessage: '第 {{index}} 张卡片'
    }
  });
}

/* ============================ 3. 卡片渲染 ============================ */
function buildSlide(card, goTo) {
  const slide = el('div', 'swiper-slide');
  const btn = el('button', 'home-card');
  btn.type = 'button';
  btn.dataset.cardId = card.id || '';

  const top = el('div', 'home-card__top');
  top.append(el('span', 'home-card__emoji', card.emoji || '💡'));
  top.append(el('span', 'home-card__type', TYPE_LABEL[card.type] || '知识点'));
  btn.append(top);

  const en = el('p', 'home-card__en', card.titleEn || '');
  en.lang = 'en';
  btn.append(en);
  btn.append(el('p', 'home-card__zh', card.titleZh || ''));

  const descEn = el('p', 'home-card__desc-en', card.descEn || '');
  descEn.lang = 'en';
  btn.append(descEn);
  if (card.descZh) btn.append(el('p', 'home-card__desc-zh', card.descZh));

  btn.append(el('span', 'home-card__go', '点卡片：先朗读，再打开 ›'));

  btn.addEventListener('click', () => onCardClick(card, btn, goTo));
  slide.append(btn);
  return slide;
}

/* ============================ 4. 点击：先朗读再跳转 ============================ */
/**
 * 点击卡片：朗读英文 → 读完后跳转；再次点击同一张卡片则立即跳转。
 */
function onCardClick(card, cardEl, goTo) {
  if (pendingNav && pendingNav.cardEl === cardEl) {   // 第二次点击 → 不用等了
    navigate(card, goTo);
    return;
  }

  cancelPendingNav();
  const token = {};
  pendingNav = { token: token, cardEl: cardEl, timer: null };

  const go = () => {
    if (!pendingNav || pendingNav.token !== token) return;   // 已被其它卡片或“停止朗读”取代
    cancelPendingNav();
    navigate(card, goTo);
  };

  const started = speak(englishOf(card), {
    element: cardEl,                                   // 卡片整体高亮
    onDone: (result) => {
      // 只有“被停止/被打断”才不跳转；引擎报错时仍然要跳转，不能把用户卡在原地
      const reason = result && result.reason;
      const stopped = result && result.cancelled
        && (reason === 'interrupted' || reason === 'canceled' || reason === 'stopped');
      if (stopped) { stopPendingNav(token); return; }
      go();
    }
  });

  // 兜底：TTS 不可用或回调迟迟不回来，也要能跳转
  pendingNav.timer = setTimeout(go, started ? NAV_FALLBACK_MS : NAV_NO_TTS_MS);
}

/** 卡片英文：优先用 descEn（更完整的一句），否则退回 titleEn */
function englishOf(card) {
  const text = (card && (card.descEn || card.titleEn)) || '';
  return String(text).trim();
}

/** 执行跳转：清理定时器、停止朗读，再切 Tab */
function navigate(card, goTo) {
  cancelPendingNav();
  stopSpeaking();
  goTo(card.targetTab || 'home', card.targetId || undefined);
}

function cancelPendingNav() {
  if (!pendingNav) return;
  clearTimeout(pendingNav.timer);
  pendingNav = null;
}

function stopPendingNav(token) {
  if (pendingNav && pendingNav.token === token) cancelPendingNav();
}

/* ============================ 5. 小工具 ============================ */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function elEn(tag, className, text) {
  const node = el(tag, className, text);
  node.lang = 'en';
  return node;
}

/** Fisher–Yates 洗牌：每次打开首页的卡片顺序都不同 */
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}
