/* ==========================================================================
 * app.js — 应用唯一入口（原生 ES6 模块）
 * --------------------------------------------------------------------------
 * 职责：
 *   1. Hash 路由：#/home、#/roots/spect …（Tab + 目标 ID，支持深链与刷新保持）
 *   2. 底部 Tab 高亮与视图切换
 *   3. 视图渲染调度（5 个 Tab 各有独立视图函数）
 *   4. data/*.json 统一加载（带内存缓存）
 *   5. Service Worker 注册（PWA）
 *
 * 全站约定：
 *   - 英文文本元素统一加 class="speakable"，由 js/tts.js 的事件委托接管点击朗读
 *   - 中文文本不加 speakable，且不会被朗读
 *   - 由 JSON 数据渲染的文本一律使用 textContent，避免 HTML 注入
 * ========================================================================== */

/* ============================ 0. 模块依赖 ============================ */
import { initTTS, bindSpeakable, speak, speakQueue, stopSpeaking, setRate, getRate, on, isSpeaking } from './tts.js';
import { initSpeechFeedback } from './speech-feedback.js';
import { createHomeCards, destroyHomeCards } from './home.js';
import { initSearch } from './search.js';
import { initFavorites, decorateFavorites, mountFavoritesList, getFavorites, countFavorites } from './favorites.js';
import { initBackToTop } from './back-to-top.js';
import { createFilterBar } from './filter-bar.js';

/* ============================ 1. Tab 配置 ============================ */
/** 底部 5 个 Tab；dataFile 为该页对应的数据文件，descZh 为该页的一句话介绍（预留文案） */
export const TABS = [
  { id: 'home',       label: '首页',     emoji: '🏠', titleZh: '首页',     titleEn: 'Home',
    dataFile: 'data/home-cards.json', descZh: '随机知识点卡片，每天看一眼就好。' },
  { id: 'roots',      label: '词根词缀', emoji: '🧩', titleZh: '词根词缀', titleEn: 'Roots & Affixes',
    dataFile: 'data/roots.json',      descZh: '前缀 / 后缀 / 词根，按语义分组，配例词和例句。' },
  { id: 'dialogues',  label: '场景对话', emoji: '💬', titleZh: '场景对话', titleEn: 'Dialogues',
    dataFile: 'data/dialogues.json',  descZh: '寒暄、购物、求助、餐厅等真实场景，可逐句或整段播放。' },
  { id: 'vocabulary', label: '主题单词', emoji: '📚', titleZh: '主题单词', titleEn: 'Vocabulary',
    dataFile: 'data/vocabulary.json', descZh: '月份、动物、食物、节日等分类单词，都可点击朗读。' },
  { id: 'websites',   label: '常用网站', emoji: '🌐', titleZh: '常用网站', titleEn: 'Useful Websites',
    dataFile: 'data/websites.json',   descZh: '美国日常常用网站，附英文介绍与朗读。' }
];

const TAB_IDS = TABS.map((t) => t.id);
const DEFAULT_TAB = 'home';
const DATA_ROOT = 'data/';
/** 首页每次展示的卡片数量（需求 8：从卡片池里随机抽 5 张，互不重复） */
const HOME_CARDS_COUNT = 5;

/** 首页「我的收藏」列表句柄：收藏变化时用它重绘（页面切走后重绘无副作用） */
let favListApi = null;

/* ============================ 2. 小工具 ============================ */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素：el('p', 'muted', '文字') */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 创建英文元素（自动带 speakable + lang="en"） */
function elEn(tag, className, text) {
  const node = el(tag, `${className} speakable`, text);
  node.lang = 'en';
  return node;
}

/**
 * 生成“🔈 朗读”按钮。
 * data-speak 指定要读的英文；data-speak-for 指定高亮的元素 id（不填则高亮按钮自己）。
 */
function makeSpeakButton(text, targetId) {
  const btn = el('button', 'speak-btn');
  btn.type = 'button';
  btn.dataset.speak = text;
  if (targetId) btn.dataset.speakFor = targetId;
  const icon = el('span', 'speak-btn__icon', '🔈');
  icon.setAttribute('aria-hidden', 'true');
  btn.append(icon, document.createTextNode('朗读'));
  return btn;
}

/** 内存缓存：同一次会话内同一 JSON 只 fetch 一次 */
const jsonCache = new Map();

/**
 * 加载 data 目录下的 JSON。
 * @param {string} file 'home-cards.json' 或 'data/home-cards.json' 或完整 URL
 * @returns {Promise<any>}
 */
export async function loadJSON(file) {
  const url = /^(data\/|https?:)/.test(file) ? file : DATA_ROOT + file;
  if (jsonCache.has(url)) return jsonCache.get(url);

  const promise = fetch(url, { cache: 'no-cache' }).then((res) => {
    if (!res.ok) throw new Error(`${url} 加载失败（HTTP ${res.status}）`);
    return res.json();
  });
  jsonCache.set(url, promise);
  try {
    return await promise;
  } catch (err) {
    jsonCache.delete(url);   // 失败不缓存，方便重试
    throw err;
  }
}

/* ---------------------------- Toast 轻提示 ---------------------------- */
let toastTimer = null;
/** 底部轻提示，2 秒后自动消失 */
export function toast(message, duration = 2000) {
  const box = $('#toast');
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, duration);
}

/* ---------------------------- 空状态 / 报错 ---------------------------- */
function emptyState(emoji, title, desc, note) {
  const box = el('div', 'empty');
  box.append(el('div', 'empty__emoji', emoji));
  box.append(el('div', 'empty__title', title));
  if (desc) box.append(el('div', 'empty__desc', desc));
  if (note) box.append(el('div', 'empty__note', note));
  return box;
}

/* ============================ 3. 路由 ============================ */
/**
 * 解析 location.hash → { tab, targetId }
 * 例：#/roots/spect → { tab: 'roots', targetId: 'spect' }
 */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '').trim();   // 'roots/spect'
  const [tabPart, targetPart] = raw.split('/');
  const tab = TAB_IDS.includes(tabPart) ? tabPart : DEFAULT_TAB;
  return { tab, targetId: targetPart ? decodeURIComponent(targetPart) : null };
}

/** 生成某个 Tab（可带目标 ID）的 hash，供搜索、收藏、首页卡片跳转使用 */
export function tabHash(tabId, targetId) {
  const id = TAB_IDS.includes(tabId) ? tabId : DEFAULT_TAB;
  return `#/${id}${targetId ? '/' + encodeURIComponent(targetId) : ''}`;
}

/** 跳转到指定 Tab / 内容（搜索、首页卡片、收藏都会用） */
export function goTo(tabId, targetId) {
  const next = tabHash(tabId, targetId);
  if (location.hash === next) renderView(tabId, targetId);   // hash 相同不会触发 hashchange
  else location.hash = next;
}

/* ============================ 4. 视图渲染调度 ============================ */
/** 各 Tab 对应的视图函数：返回 Element（或 Promise<Element>） */
const views = {
  home: renderHomeView,
  roots: renderRootsView,
  dialogues: renderDialoguesView,
  vocabulary: renderVocabularyView,
  websites: renderWebsitesView
};

let renderToken = 0;   // 防止快速切换 Tab 时旧结果覆盖新内容

/** 渲染新视图前，先释放上一个视图的运行时资源（Swiper 实例、事件订阅等） */
function cleanupCurrentView() {
  destroyHomeCards();
  if (offDialogueHandlers) {              // 退出对话页时必须退订，否则切几次 Tab 会重复绑定
    offDialogueHandlers.forEach((off) => off());
    offDialogueHandlers = null;
  }
}

/** 渲染指定 Tab；targetId 存在时定位并高亮该内容 */
async function renderView(tabId, targetId) {
  const tab = TABS.find((t) => t.id === tabId) || TABS[0];
  const main = $('#appMain');
  const token = ++renderToken;

  cleanupCurrentView();
  setActiveTab(tab.id);
  document.title = `${tab.label} · 轻轻学英语`;

  // 加载中骨架屏
  main.setAttribute('aria-busy', 'true');
  main.innerHTML = '<div class="skeleton skeleton--card"></div><div class="skeleton skeleton--card"></div>';

  let view;
  try {
    view = await views[tab.id](tab, targetId);   // 传入 targetId，视图可据此预选分类
  } catch (err) {
    console.error('[view] 渲染失败：', err);
    view = emptyState('⚠️', '内容加载失败', String(err && err.message ? err.message : err),
      '请确认通过 http 服务打开页面：python -m http.server 8080');
  }
  if (token !== renderToken) return;   // 已有更新的渲染，丢弃本次结果

  main.innerHTML = '';
  main.append(view);
  main.removeAttribute('aria-busy');

  decorateFavorites(main);      // 给内容卡片加收藏按钮

  if (targetId) focusTarget(targetId);
  else window.scrollTo({ top: 0 });

  main.focus({ preventScroll: true });   // 无障碍：切 Tab 后焦点进入内容区
}

/** 滚动到 data-id="xxx" 的元素并高亮 1.8s（搜索 / 首页卡片跳转用） */
function focusTarget(targetId) {
  const main = $('#appMain');
  const node = $$('[data-id]', main).find((n) => n.dataset.id === targetId);
  if (!node) {
    toast('未找到该内容');
    return;
  }
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('is-target');
  setTimeout(() => node.classList.remove('is-target'), 1900);
}

/** 底部 Tab 高亮 */
function setActiveTab(tabId) {
  $$('#tabbar .tabbar__item').forEach((link) => {
    if (link.dataset.tab === tabId) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

/**
 * 把筛选条挂到页面根节点上（applyXxxFilter 通过 root.__filterBar 取勾选状态）。
 * 视图重建时旧的监听随 DOM 一起丢弃，不需要额外清理。
 * @param {{element: HTMLElement, getSelected: Function}} bar
 * @param {HTMLElement} root
 */
function bindFilterApply(bar, root) {
  root.__filterBar = bar;
}

/** 首页卡片池：内存缓存（需求 8）。首次进入首页时构建，之后只做 shuffle + slice(0,5) */
let homeCardPool = null;

/**
 * 构建首页随机推荐卡片池（需求 8）。
 * A. home-cards.json 的 5 条精品卡（原样保留）
 * B. 从 4 类数据自动生成：
 *    词根卡（每个词缀一条）/ 对话卡（每个场景一条）/ 单词卡（每个分类一条）/ 网站卡（每个站点一条）
 * 生成结构与 home-cards.json 完全一致（emoji/titleEn/titleZh/descEn/descZh/targetTab/targetId），
 * 所以卡片渲染、朗读、跳转逻辑一行都不用改。
 * @param {{homeCards:Array, roots:Object, dialogues:Object, vocabulary:Object, websites:Object}} data
 * @returns {Array<object>}
 */
export function buildHomeCardPool(data = {}) {
  const pool = [];

  /* ---- A. 精品卡 ---- */
  (Array.isArray(data.homeCards) ? data.homeCards : []).forEach((card) => pool.push(card));

  /* ---- B1. 词根卡：每个 roots.json 条目一张 ---- */
  const roots = data.roots || {};
  (Array.isArray(roots.categories) ? roots.categories : []).forEach((cat) => {
    (Array.isArray(cat.items) ? cat.items : []).forEach((item) => {
      if (!item || !item.affix) return;
      pool.push({
        id: `pool-root-${item.id}`,
        type: 'root',
        emoji: '🧩',
        titleEn: item.affix,
        titleZh: item.meaningZh || cat.nameZh || '',
        descEn: item.sentenceEn || (item.examples && item.examples[0] && item.examples[0].word) || '',
        descZh: item.meaningZh || '',
        targetTab: 'roots',
        targetId: item.id
      });
    });
  });

  /* ---- B2. 对话卡：每个 dialogues.json 场景一张 ---- */
  const dialogues = data.dialogues || {};
  (Array.isArray(dialogues.scenes) ? dialogues.scenes : []).forEach((scene) => {
    const first = Array.isArray(scene.lines) ? scene.lines[0] : null;
    pool.push({
      id: `pool-dialogue-${scene.id}`,
      type: 'dialogue',
      emoji: '💬',
      titleEn: scene.titleEn || scene.id || '',
      titleZh: scene.titleZh || '',
      descEn: (first && first.en) || '',
      descZh: (first && first.zh) || scene.descZh || '',
      targetTab: 'dialogues',
      targetId: scene.id
    });
  });

  /* ---- B3. 单词卡：每个 vocabulary.json 分类一张 ---- */
  const vocabulary = data.vocabulary || {};
  (Array.isArray(vocabulary.categories) ? vocabulary.categories : []).forEach((cat) => {
    const first = (Array.isArray(cat.items) ? cat.items : [])[0];
    if (!first) return;
    pool.push({
      id: `pool-vocab-${cat.id}`,
      type: 'vocabulary',
      emoji: '📚',
      titleEn: cat.nameEn || cat.nameZh || cat.id,
      titleZh: cat.nameZh || cat.id,
      descEn: first.en || '',
      descZh: first.zh || '',
      targetTab: 'vocabulary',
      targetId: cat.id
    });
  });

  /* ---- B4. 网站卡：每个 websites.json 站点一张 ---- */
  const websites = data.websites || {};
  (Array.isArray(websites.categories) ? websites.categories : []).forEach((cat) => {
    (Array.isArray(cat.items) ? cat.items : []).forEach((item) => {
      if (!item || !item.nameEn) return;
      pool.push({
        id: `pool-site-${slugId(item.nameEn)}`,
        type: 'website',
        emoji: '🌐',
        titleEn: item.nameEn,
        titleZh: item.nameZh || '',
        descEn: item.descEn || '',
        descZh: item.descZh || '',
        targetTab: 'websites',
        targetId: item.nameEn
      });
    });
  });

  return pool;
}

/**
 * 从卡片池里随机取 count 张（需求 8：每次进入首页都重抽，保证不重复）。
 * 洗牌后取前 count 个 → 结果天然互不相同。
 * @param {Array<object>} pool
 * @param {number} count
 * @returns {Array<object>}
 */
export function pickRandomCards(pool, count = 5) {
  const list = Array.isArray(pool) ? pool.slice() : [];
  if (list.length <= count) return list;
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list.slice(0, count);
}

/* ---------------------------- 首页视图 ---------------------------- */
async function renderHomeView(tab) {
  const wrap = el('div');

  /* (1) 每日卡片轮播（需求 8：卡片池 = 5 条精品卡 + 4 类数据自动生成的卡）
         每次进入首页都重新 shuffle 整个池子再取 5 条 */
  try {
    const [homeCards, roots, dialogues, vocabulary, websites] = await Promise.all([
      loadJSON(tab.dataFile),
      loadJSON('data/roots.json'),
      loadJSON('data/dialogues.json'),
      loadJSON('data/vocabulary.json'),
      loadJSON('data/websites.json')
    ]);

    if (!homeCardPool) {
      homeCardPool = buildHomeCardPool({ homeCards, roots, dialogues, vocabulary, websites });
      console.debug('[home] 卡片池已生成，共', homeCardPool.length, '张');
    }
    const list = pickRandomCards(homeCardPool, HOME_CARDS_COUNT);

    if (list.length) {
      wrap.append(createHomeCards(list, { goTo }));   // 轮播区块自带标题
    } else {
      const emptySection = el('section', 'section');
      const emptyHead = el('div', 'section__head');
      emptyHead.append(el('h2', 'section__title', '每日卡片'));
      emptyHead.append(elEn('span', 'section__title-en', 'Daily Card'));
      emptySection.append(emptyHead);
      emptySection.append(emptyState('🗂️', '暂无卡片', 'data/home-cards.json 里还没有内容。',
        '把卡片写进这个 JSON 文件，首页就会自动轮播。'));
      wrap.append(emptySection);
    }
  } catch (err) {
    console.error('[home] 卡片数据加载失败：', err);
    wrap.append(emptyState('⚠️', '数据加载失败', String(err && err.message ? err.message : err),
      '请确认已通过 http 服务打开：python -m http.server 8080'));
  }

  /* (2) 我的收藏 / 生词本（localStorage 持久化） */
  const favSection = el('section', 'section fav-section');
  const favHead = el('div', 'section__head');
  favHead.append(el('h2', 'section__title', '我的收藏'));
  favHead.append(elEn('span', 'section__title-en', 'Favorites'));
  favSection.append(favHead);
  favSection.append(el('p', 'section__desc',
    '点内容卡片右上角的 ☆ 就能收藏；收藏的单词就是你的生词本，保存在这台设备上。'));
  const favList = el('div', 'fav-list');
  favSection.append(favList);
  wrap.append(favSection);
  favListApi = mountFavoritesList(favList, { goTo, notify: toast });

  /* (3) 底部版本号 + 隐藏的「真机自测」入口（连点 5 次展开；临时功能，第 3 轮可整段删除） */
  appendSelfTestEntry(wrap);

  return wrap;
}


/**
 * 生成“▶ 整段播放”按钮：按顺序逐句朗读，并逐句高亮。
 * @param {Array<{en:string, id:string}>} items
 * @param {string} label
 */
function makePlayAllButton(items, label) {
  const btn = el('button', 'btn btn--soft btn--play');
  btn.type = 'button';
  const icon = el('span', '', '▶');
  icon.setAttribute('aria-hidden', 'true');
  btn.append(icon, document.createTextNode(label || '整段播放'));
  btn.addEventListener('click', () => {
    // 必须在点击（用户手势）里同步调用，iOS 才允许逐句连读
    speakQueue(items.map((it) => ({ text: it.en, element: document.getElementById(it.id) })));
  });
  return btn;
}


/* ---------------------------- 词根词缀视图 ---------------------------- */
/** 分类英文名：固定的 UI 标签（数据里只有 nameZh），也可点击朗读 */
const CATEGORY_EN = { prefixes: 'Prefixes', suffixes: 'Suffixes', roots: 'Roots' };

/**
 * 渲染词根词缀页：
 *   分类（前缀 / 后缀 / 词根）→ 语义分组（groupZh，保持 JSON 顺序）→ 词缀卡片
 * 每张卡片包含：词缀、含义、2~3 个例词、一个例句；所有英文均可点击朗读。
 */
async function renderRootsView(tab) {
  const section = el('section', 'section roots-view');

  const head = el('div', 'section__head');
  head.append(el('h2', 'section__title', '词根词缀'));
  head.append(elEn('span', 'section__title-en', 'Roots & Affixes'));
  section.append(head);
  section.append(el('p', 'section__desc',
    '按语义分组、不按字母顺序：先看含义，再看例词和例句，点虚线英文就能朗读。'));

  let data;
  try {
    data = await loadJSON(tab.dataFile);
  } catch (err) {
    console.error('[roots] 数据加载失败：', err);
    return emptyState('⚠️', '数据加载失败', String(err && err.message ? err.message : err),
      '请确认已通过 http 服务打开：python -m http.server 8080');
  }

  const categories = (data && Array.isArray(data.categories)) ? data.categories : [];
  if (!categories.length) {
    section.append(emptyState('🗂️', '暂无词根词缀', 'data/roots.json 里还没有内容。',
      '把数据写进这个 JSON 文件，本页会自动渲染。'));
    return section;
  }

  /* 顶部分类筛选条：需求 5（一级 + 二级多选）/ 6（展开收起）/ 7（筛选切换）/ 9（清空勾选） */
  const filterBar = createRootsFilterBar(categories, section);
  section.append(filterBar.element);
  categories.forEach((cat) => section.append(buildCategorySection(cat)));
  bindFilterApply(filterBar, section);
  return section;
}

/**
 * 词根词缀页的筛选条：
 *   一级 = 前缀 / 后缀 / 词根；二级 = 各分类下的语义分组（groupZh）
 * 点击一级文字 → 切换该一级下所有二级的勾选；点击 ▸/▾ → 展开收起二级列表。
 */
function createRootsFilterBar(categories, host) {
  const items = categories.map((cat) => {
    const groups = groupByMeaning(cat.items || []);
    return {
      id: cat.id,
      label: cat.nameZh || cat.id,
      count: (cat.items || []).length,
      subs: groups
        .filter((g) => g.title)          // 无标题的分组不单独做成二级项
        .map((g) => ({ id: g.title, label: g.title, count: g.items.length }))
    };
  });

  return createFilterBar({
    items,
    ariaLabel: '词根词缀分类筛选',
    mode: 'multi',                 // 需求 7：词根词缀 = 分类筛选切换（并集）
    showReset: true,               // 需求 9
    defaultCollapsed: true,        // 需求 6：默认收起一行
    onChange: () => applyRootsFilter(host)
  });
}

/**
 * 应用词根词缀页的勾选筛选。
 *
 * ⚠️ 语义取舍（需求 5）：用户原话是「AND」，但分类筛选中
 *    「既是前缀又是『否定与相反』」这种交集对同一批内容恒为空，
 *    勾两个分类后页面会永远空白。因此这里按【并集(OR)】实现：
 *    只要某个分类（二级）被勾选，它的内容就显示。
 *    一级分类被全不勾选时，它下面的内容全部隐藏。
 */
function applyRootsFilter(root) {
  if (!root) return;
  const bar = root.__filterBar;
  if (!bar) return;
  const selected = bar.getSelected();

  root.querySelectorAll('.roots-group').forEach((groupNode) => {
    const catId = groupNode.dataset.filterCategory;
    const groupZh = groupNode.dataset.filterGroup || '';
    const key = `${catId}::${groupZh}`;
    const on = selected.has(key) || selected.has(catId);
    groupNode.hidden = !on;
  });

  // 整个分类下一个二级都没勾 → 分类区块整体隐藏（并集语义下的自然结果）
  root.querySelectorAll('.roots-category').forEach((catNode) => {
    const anyVisible = Array.prototype.some.call(
      catNode.querySelectorAll('.roots-group'), (n) => !n.hidden);
    catNode.hidden = !anyVisible;
  });
}

/** 一个分类：标题 + 内部语义分组列表 */
function buildCategorySection(cat) {
  const block = el('section', 'roots-category');
  block.id = `roots-category-${cat.id}`;
  block.dataset.category = cat.id;
  block.dataset.id = cat.id;             // 深链 / 搜索定位目标（分类 id，如 #/roots/prefixes）

  const head = el('div', 'roots-category__head');
  head.append(el('h3', 'roots-category__title', cat.nameZh || cat.id));
  head.append(elEn('span', 'roots-category__title-en', CATEGORY_EN[cat.id] || ''));
  const count = (cat.items || []).length;
  head.append(el('span', 'roots-category__count', `${count} 个`));
  block.append(head);

  groupByMeaning(cat.items || []).forEach((group) => {
    block.append(buildGroup(group, cat.id));
  });
  return block;
}

/**
 * 按语义分组（保持 JSON 里出现的顺序，绝不按字母排序）。
 * 相同 groupZh 的条目会归到一组；没有 groupZh 的条目合并为一个无标题组。
 * @returns {Array<{title: string, items: Array}>}
 */
function groupByMeaning(items) {
  const order = [];
  const map = new Map();
  items.forEach((item) => {
    const key = item.groupZh || '';
    if (!map.has(key)) { map.set(key, []); order.push(key); }
    map.get(key).push(item);
  });
  return order.map((title) => ({ title, items: map.get(title) }));
}

/** 一个语义分组：标题横线 + 若干词缀卡片（带筛选用的 data-filter-* 标记） */
function buildGroup(group, categoryId) {
  const wrap = el('div', 'roots-group');
  wrap.dataset.filterCategory = categoryId;      // 供 applyRootsFilter 做并集筛选
  wrap.dataset.filterGroup = group.title || '';
  if (group.title) {
    const head = el('div', 'roots-group__head');
    head.append(el('span', 'roots-group__title', group.title));
    head.append(el('span', 'roots-group__line'));
    wrap.append(head);
  }
  group.items.forEach((item) => wrap.append(buildAffixCard(item)));
  return wrap;
}

/** 词缀卡片：词缀 + 含义 + 例词 + 例句（英文全部可朗读） */
function buildAffixCard(item) {
  const card = el('article', 'card affix-card');
  card.dataset.id = item.id || '';       // 深链 / 搜索跳转定位目标，例如 #/roots/spect

  const top = el('div', 'affix-card__top');
  top.append(elEn('p', 'affix-card__affix', item.affix || ''));
  top.append(el('p', 'affix-card__meaning', item.meaningZh || ''));
  card.append(top);

  const words = Array.isArray(item.examples) ? item.examples : [];
  if (words.length) {
    const list = el('div', 'affix-card__words');
    words.forEach((w) => {
      const chip = el('div', 'word-chip');
      const word = elEn('button', 'word-chip__en', w.word || '');
      word.type = 'button';
      chip.append(word, el('span', 'word-chip__zh', w.meaningZh || ''));
      list.append(chip);
    });
    card.append(list);
  }

  if (item.sentenceEn) {
    const sentence = el('div', 'affix-card__sentence');
    const enId = `affix-sent-${item.id}`;
    const en = elEn('p', 'affix-card__sentence-en', item.sentenceEn);
    en.id = enId;
    sentence.append(en, el('p', 'affix-card__sentence-zh', item.sentenceZh || ''));
    card.append(sentence);

    const foot = el('div', 'affix-card__foot');
    foot.append(makeSpeakButton(item.sentenceEn, enId));   // 点按钮高亮并朗读这句
    card.append(foot);
  }

  return card;
}

/* ---------------------------- 场景对话视图 ---------------------------- */
/** 中文显示偏好：'1' = 隐藏「英文的中文翻译」（文化小贴士属于讲解，不受影响） */
const ZH_PREF_KEY = 'elapp.dialogues.hideZh';
/** 视图级事件订阅；离开页面时必须退订，否则反复切换 Tab 会重复绑定 */
let offDialogueHandlers = null;

/**
 * 渲染场景对话页：
 *   工具条（中文开关 + 场景跳转）→ 6 个场景卡片
 *   每个场景：英文对话 + 中文翻译 + 关键表达 + 文化小贴士 +「整段播放」「停止」
 */
async function renderDialoguesView(tab) {
  const wrap = el('section', 'section dialogues-view');

  const head = el('div', 'section__head');
  head.append(el('h2', 'section__title', '场景对话'));
  head.append(elEn('span', 'section__title-en', 'Dialogues'));
  wrap.append(head);
  wrap.append(el('p', 'section__desc',
    '点英文句子可以单独朗读；「整段播放」会逐句读完，并高亮当前正在读的那句。'));

  let data;
  try {
    data = await loadJSON(tab.dataFile);
  } catch (err) {
    console.error('[dialogues] 数据加载失败：', err);
    return emptyState('⚠️', '数据加载失败', String(err && err.message ? err.message : err),
      '请确认已通过 http 服务打开：python -m http.server 8080');
  }

  const scenes = (data && Array.isArray(data.scenes)) ? data.scenes : [];
  if (!scenes.length) {
    wrap.append(emptyState('🗂️', '暂无对话场景', 'data/dialogues.json 里还没有内容。',
      '把数据写进这个 JSON 文件，本页会自动渲染。'));
    return wrap;
  }

  wrap.append(buildDialoguesToolbar(scenes, wrap));
  scenes.forEach((scene, index) => wrap.append(buildScene(scene, index + 1)));

  // 一个场景都没勾时给一句提示，避免出现纯空白页（配合 applyDialoguesFilter）
  wrap.append(el('div', 'dialogues-filter-empty muted',
    '所有场景都被取消了勾选，点右上角「清空勾选」即可恢复全部内容。'));
  wrap.lastChild.hidden = true;

  /* 中文显隐 + 播放状态联动 */
  applyZhVisibility(wrap, loadHideZhPref());
  let activeScene = null;                        // 记住正在播放的场景（句子间隙不闪烁）
  const syncPlaying = () => {
    if (!document.body.contains(wrap)) return;
    const speaking = wrap.querySelector('.dialogue-line__en.is-speaking');
    if (speaking) activeScene = speaking.closest('.dialogue-scene');
    else if (!isSpeaking()) activeScene = null;

    wrap.querySelectorAll('.dialogue-scene').forEach((s) => {
      s.classList.toggle('is-playing', s === activeScene);
    });
    wrap.querySelectorAll('.dialogue-actions .btn--play').forEach((btn) => {
      const owner = btn.closest('.dialogue-scene');
      btn.classList.toggle('is-playing', !!owner && owner.classList.contains('is-playing'));
    });
  };
  offDialogueHandlers = [on('start', syncPlaying), on('end', syncPlaying), on('queuechange', syncPlaying)];

  return wrap;
}

/** 工具条：中文开关 + 分类筛选条（需求 6 展开收起 / 7 筛选切换 / 9 清空勾选） */
function buildDialoguesToolbar(scenes, root) {
  const bar = el('div', 'dialogues-toolbar');

  const top = el('div', 'dialogues-toolbar__top');
  const toggle = el('button', 'zh-toggle');
  toggle.type = 'button';
  toggle.id = 'zhToggle';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', 'true');
  toggle.append(el('span', 'zh-toggle__label', '中文翻译'));
  toggle.append(el('span', 'zh-toggle__state', '开'));
  top.append(toggle);
  top.append(el('span', 'dialogues-count', `${scenes.length} 个场景`));
  bar.append(top);

  toggle.addEventListener('click', () => {
    const view = bar.closest('.dialogues-view');
    if (!view) return;
    const hide = !view.classList.contains('is-zh-hidden');
    applyZhVisibility(view, hide);
    saveHideZhPref(hide);
  });

  /* 需求 7：场景对话 = 分类筛选切换（默认全选，显示所有场景） */
  const filterBar = createFilterBar({
    items: scenes.map((scene) => ({
      id: scene.id || '',
      label: scene.titleZh || scene.titleEn || scene.id || '',
      count: (scene.lines || []).length
    })),
    ariaLabel: '对话场景筛选',
    mode: 'multi',
    showReset: true,
    defaultCollapsed: true,
    onChange: () => applyDialoguesFilter(root || bar.closest('.dialogues-view'))
  });
  bar.append(filterBar.element);
  bindFilterApply(filterBar, root);
  return bar;
}

/**
 * 应用场景对话页的勾选筛选（并集语义，理由同 applyRootsFilter 的注释）：
 * 未勾选的场景整块隐藏；一个都没勾时给出提示而不是空白页。
 */
function applyDialoguesFilter(root) {
  if (!root) return;
  const bar = root.__filterBar;
  if (!bar) return;
  const selected = bar.getSelected();

  let visible = 0;
  root.querySelectorAll('.dialogue-scene').forEach((scene) => {
    const on = selected.has(scene.dataset.id);
    scene.hidden = !on;
    if (on) visible += 1;
  });

  const tip = root.querySelector('.dialogues-filter-empty');
  if (tip) tip.hidden = visible > 0;
}

/** 应用“是否显示中文”：隐藏的是英文的中文翻译，文化小贴士（无英文对照）保留 */
function applyZhVisibility(root, hide) {
  if (!root) return;
  root.classList.toggle('is-zh-hidden', !!hide);
  const toggle = root.querySelector('#zhToggle');
  if (toggle) {
    toggle.setAttribute('aria-checked', hide ? 'false' : 'true');
    const state = toggle.querySelector('.zh-toggle__state');
    if (state) state.textContent = hide ? '关' : '开';
  }
}

function loadHideZhPref() {
  try { return localStorage.getItem(ZH_PREF_KEY) === '1'; } catch (err) { return false; }
}

function saveHideZhPref(hide) {
  try { localStorage.setItem(ZH_PREF_KEY, hide ? '1' : '0'); } catch (err) { /* 忽略 */ }
}

/** 一个场景卡片：标题 / 整段播放与停止 / 对话行 / 关键表达 / 文化小贴士 */
function buildScene(scene, index) {
  const block = el('section', 'dialogue-scene');
  block.id = `dialogue-scene-${scene.id}`;
  block.dataset.id = scene.id || '';          // 深链 / 搜索跳转目标：#/dialogues/small-talk

  /* 标题：序号 + 英文标题（可朗读）+ 中文标题 + 描述 */
  const head = el('div', 'dialogue-scene__head');
  const titleRow = el('div', 'dialogue-scene__title');
  titleRow.append(el('span', 'dialogue-scene__index', String(index)));
  titleRow.append(elEn('span', 'dialogue-scene__title-en', scene.titleEn || scene.id || ''));
  if (scene.titleZh) titleRow.append(el('span', 'dialogue-scene__title-zh zh-trans', scene.titleZh));
  head.append(titleRow);
  if (scene.descZh) head.append(el('p', 'dialogue-scene__desc', scene.descZh));
  block.append(head);

  const lines = Array.isArray(scene.lines) ? scene.lines : [];
  const playItems = [];
  lines.forEach((line, i) => {
    if (line.en) playItems.push({ en: line.en, id: `dlg-line-${scene.id}-${i}` });
  });

  /* 操作条：整段播放 + 停止（每个场景各一组） */
  const actions = el('div', 'dialogue-actions');
  actions.append(makePlayAllButton(playItems, '整段播放'));
  const stopBtn = el('button', 'btn btn--ghost');
  stopBtn.type = 'button';
  stopBtn.textContent = '⏹ 停止';
  stopBtn.addEventListener('click', () => stopSpeaking());
  actions.append(stopBtn);
  block.append(actions);

  /* 对话行：说话人 + 英文（可单独点击朗读）+ 中文翻译 */
  lines.forEach((line, i) => {
    const row = el('div', 'dialogue-line');
    row.append(el('span', 'dialogue-line__speaker', line.speaker || (i % 2 === 0 ? 'A' : 'B')));
    const text = el('div', 'dialogue-line__text');
    const en = elEn('p', 'dialogue-line__en', line.en || '');
    en.id = `dlg-line-${scene.id}-${i}`;       // 整段播放时的高亮目标
    text.append(en);
    if (line.zh) text.append(el('p', 'dialogue-line__zh zh-trans', line.zh));
    row.append(text);
    block.append(row);
  });

  /* 关键表达：汇总各行 keyExpressions，按英文去重、保持原顺序 */
  const keys = collectKeyExpressions(lines);
  if (keys.length) {
    const keyBox = el('div', 'dialogue-keys');
    keyBox.append(el('div', 'dialogue-keys__title', '关键表达'));
    const list = el('div', 'dialogue-keys__list');
    keys.forEach((item) => {
      const chip = el('div', 'key-chip');
      chip.append(elEn('span', 'key-chip__en', item.en));
      if (item.zh) chip.append(el('span', 'key-chip__zh zh-trans', item.zh));
      list.append(chip);
    });
    keyBox.append(list);
    block.append(keyBox);
  }

  /* 文化小贴士：只有中文，是讲解内容，不参与“隐藏中文” */
  const tips = Array.isArray(scene.tipsZh) ? scene.tipsZh : [];
  if (tips.length) {
    const tipBox = el('div', 'dialogue-tips');
    tipBox.append(el('div', 'dialogue-tips__title', '文化小贴士'));
    const ul = el('ul', '');
    tips.forEach((tip) => ul.append(el('li', '', tip)));
    tipBox.append(ul);
    block.append(tipBox);
  }

  return block;
}

/** 从各行汇总关键表达（保持顺序、按英文去重） */
function collectKeyExpressions(lines) {
  const seen = new Set();
  const list = [];
  lines.forEach((line) => {
    const items = Array.isArray(line.keyExpressions) ? line.keyExpressions : [];
    items.forEach((item) => {
      if (!item || !item.en || seen.has(item.en)) return;
      seen.add(item.en);
      list.push({ en: item.en, zh: item.zh || '' });
    });
  });
  return list;
}

/* ---------------------------- 主题单词视图 ---------------------------- */
/** 维基摘要缓存：title → Promise<{extract,url}>（失败结果也缓存，不重复请求） */
const wikiCache = new Map();

/**
 * 渲染主题单词页：
 *   顶部分类条（横向滑动）→ 只渲染当前选中的分类，点标签即切换
 *   深链 #/vocabulary/holidays 可直接选中分类；#/vocabulary/January 会选中所在分类
 */
async function renderVocabularyView(tab, targetId) {
  const wrap = el('section', 'section vocabulary-view');

  const head = el('div', 'section__head');
  head.append(el('h2', 'section__title', '主题单词'));
  head.append(elEn('span', 'section__title-en', 'Vocabulary'));
  wrap.append(head);
  wrap.append(el('p', 'section__desc',
    '点英文单词或例句都能朗读；左右滑动顶部标签切换分类，分类名后面的数字是词数。'));

  let data;
  try {
    data = await loadJSON(tab.dataFile);
  } catch (err) {
    console.error('[vocabulary] 数据加载失败：', err);
    return emptyState('⚠️', '数据加载失败', String(err && err.message ? err.message : err),
      '请确认已通过 http 服务打开：python -m http.server 8080');
  }

  const categories = (data && Array.isArray(data.categories)) ? data.categories : [];
  if (!categories.length) {
    wrap.append(emptyState('🗂️', '暂无单词', 'data/vocabulary.json 里还没有内容。',
      '把数据写进这个 JSON 文件，本页会自动渲染。'));
    return wrap;
  }

  /* 初始分类：深链给的是分类 id 就选它；给的是单词就选它所在的分类 */
  let activeId = categories[0].id;
  const categoryById = categories.find((c) => c.id === targetId);
  if (categoryById) {
    activeId = categoryById.id;
  } else if (targetId) {
    const hit = categories.find((c) => (c.items || []).some(
      (i) => i.en === targetId || i.zh === targetId));
    if (hit) activeId = hit.id;
  }

  /* 需求 6：顶部标签区默认收起一行可滑动；点 ▸ 展开为多行
     需求 7：主题单词保留原有 Tab 式逻辑（点谁只显示谁），所以 mode='single'、不显示「清空勾选」 */
  const strip = createFilterBar({
    items: categories.map((cat) => ({
      id: cat.id,
      label: cat.nameZh || cat.id,
      count: (cat.items || []).length
    })),
    ariaLabel: '单词分类',
    mode: 'single',
    showReset: false,
    defaultCollapsed: true,
    activeId
  });

  const body = el('div', 'vocab-body');
  wrap.append(strip.element, body);

  const renderActive = (id) => {
    const cat = categories.find((c) => c.id === id) || categories[0];
    body.innerHTML = '';                       // 清空当前分类（未完成的维基请求会被丢弃）
    body.append(buildVocabCategory(cat));
  };

  // 事件委托：一个监听搞定所有分类标签
  strip.element.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter-id]');
    if (!chip || chip.dataset.filterId === activeId) return;
    activeId = chip.dataset.filterId;
    renderActive(activeId);
  });

  renderActive(activeId);
  return wrap;
}

/** 当前分类：标题 + 单词卡片列表（带 wikiTitle 的会加载维基摘要） */
function buildVocabCategory(cat) {
  const section = el('section', 'vocab-category');
  section.id = `vocab-category-${cat.id}`;
  section.dataset.id = cat.id;             // 深链 / 搜索定位目标（分类 id）

  const head = el('div', 'vocab-category__head');
  head.append(el('h3', 'vocab-category__title', cat.nameZh || cat.id));
  head.append(elEn('span', 'vocab-category__title-en', cat.nameEn || ''));
  head.append(el('span', 'vocab-category__count', `${(cat.items || []).length} 个词`));
  section.append(head);

  const grid = el('div', 'vocab-grid');
  (cat.items || []).forEach((item) => grid.append(buildWordCard(item)));
  section.append(grid);
  return section;
}

/** 单词卡片：英文 + 缩写 + 中文 + 例句（英文都可点朗读） */
function buildWordCard(item) {
  const card = el('article', 'card word-card');
  if (item.en) card.dataset.id = item.en;   // 单词级定位：#/vocabulary/January

  const top = el('div', 'word-card__top');
  top.append(elEn('p', 'word-card__en', item.en || ''));
  if (item.abbr) top.append(el('span', 'word-card__abbr', item.abbr));   // 缩写是标签，不参与朗读
  top.append(el('p', 'word-card__zh', item.zh || ''));
  card.append(top);

  if (item.exampleEn) {
    const example = el('div', 'word-card__example');
    example.append(elEn('p', 'word-card__example-en', item.exampleEn));
    if (item.exampleZh) example.append(el('p', 'word-card__example-zh', item.exampleZh));
    card.append(example);
  }

  if (item.wikiTitle) card.append(buildWikiBox(item.wikiTitle));
  return card;
}

/* ============================ 维基百科摘要 ============================ */
/** 生成维基百科条目链接 */
function wikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).trim().replace(/\s+/g, '_'))}`;
}

/** 摘要太长就按句子边界截断，卡片里只显示前几行 */
function truncateExtract(text) {
  const s = String(text || '').trim();
  if (s.length <= 400) return s;
  const cut = s.slice(0, 400);
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (dot > 200) return cut.slice(0, dot + 1);
  return cut.replace(/\s+\S*$/, '') + '…';
}

/**
 * 获取维基百科摘要：
 *   1) 优先 REST 摘要接口（https://en.wikipedia.org/api/rest_v1/page/summary/{title}）
 *   2) 失败则回退 MediaWiki API（action=query&prop=extracts&exintro&origin=*）
 *   3) 仍失败 → 返回 { extract: null }，页面保留「阅读全文」链接（优雅降级）
 * 结果（含失败）写入缓存，切换分类回来不会重复请求。
 */
async function loadWikiSummary(title) {
  if (wikiCache.has(title)) return wikiCache.get(title);

  const request = (async () => {
    /* 1) REST 摘要接口 */
    try {
      const res = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const json = await res.json();
        if (json && json.extract) {
          const page = json.content_urls && json.content_urls.desktop
            ? json.content_urls.desktop.page : '';
          return { extract: truncateExtract(json.extract), url: page || wikiUrl(title) };
        }
      }
    } catch (err) {
      console.warn('[wiki] REST 接口失败，改用回退接口：', err && err.message);
    }

    /* 2) MediaWiki 回退接口（origin=* 放开 CORS） */
    try {
      const url = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts'
        + '&exintro=1&explaintext=1&format=json&origin=*'
        + `&titles=${encodeURIComponent(title)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const pages = (json && json.query && json.query.pages) || {};
      const key = Object.keys(pages)[0];
      const page = key ? pages[key] : null;
      if (page && page.extract) return { extract: truncateExtract(page.extract), url: wikiUrl(title) };
      if (page && page.missing) return { extract: null, url: wikiUrl(title) };
    } catch (err) {
      console.warn('[wiki] 回退接口也失败：', err && err.message);
    }

    /* 3) 两个接口都不可用：只要链接，保证仍能打开词条 */
    return { extract: null, url: wikiUrl(title) };
  })();

  wikiCache.set(title, request);
  return request;
}

/** 维基摘要卡片：骨架屏 → 摘要（英文可朗读）或降级提示；「阅读全文」链接始终存在 */
function buildWikiBox(title) {
  const box = el('div', 'wiki');
  box.append(el('div', 'wiki__title', '维基百科简介'));

  const skeleton = el('div', 'wiki__skeleton skeleton');
  box.append(skeleton);

  const foot = el('div', 'wiki__foot');
  const link = el('a', 'wiki__link');
  link.href = wikiUrl(title);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.append(document.createTextNode('阅读全文 →'));
  foot.append(link);
  box.append(foot);
  box.append(el('span', 'wiki__note', '摘要来自维基百科'));

  loadWikiSummary(title).then((result) => {
    if (!document.body.contains(box)) return;      // 用户已切走分类，丢弃这次结果
    skeleton.remove();

    if (result.extract) {
      const extract = el('p', 'wiki__extract');
      extract.lang = 'en';
      extract.textContent = result.extract;        // 文本用 textContent，绝不注入 HTML
      extract.classList.add('speakable');          // 摘要英文也能点读
      box.insertBefore(extract, foot);
      if (result.url) link.href = result.url;
    } else {
      const note = el('div', 'wiki__loading', '摘要暂时取不到，可点「阅读全文」打开词条。');
      box.insertBefore(note, foot);
    }
  }).catch((err) => {
    console.warn('[wiki] 摘要渲染失败：', err && err.message);
    if (document.body.contains(box)) {
      skeleton.remove();
      box.insertBefore(el('div', 'wiki__loading', '摘要暂时取不到，可点「阅读全文」打开词条。'), foot);
    }
  });

  return box;
}

/* ---------------------------- 常用网站视图 ---------------------------- */
/**
 * 渲染常用网站页：
 *   页头 → 分类快速跳转 → 分类区块 → 网站卡片
 * 卡片包含：英文名（可点读）、中文名、英文介绍（可点读）、中文说明、
 *          站点地址、打开链接（新窗口）与「🔈 朗读」按钮
 */
async function renderWebsitesView(tab) {
  const wrap = el('section', 'section websites-view');

  const head = el('div', 'section__head');
  head.append(el('h2', 'section__title', '常用网站'));
  head.append(elEn('span', 'section__title-en', 'Useful Websites'));
  wrap.append(head);
  wrap.append(el('p', 'section__desc',
    '点英文介绍就能朗读；「打开网站」会在新窗口打开，不会关掉学习页面。'));

  let data;
  try {
    data = await loadJSON(tab.dataFile);
  } catch (err) {
    console.error('[websites] 数据加载失败：', err);
    return emptyState('⚠️', '数据加载失败', String(err && err.message ? err.message : err),
      '请确认已通过 http 服务打开：python -m http.server 8080');
  }

  const categories = (data && Array.isArray(data.categories)) ? data.categories : [];
  if (!categories.length) {
    wrap.append(emptyState('🗂️', '暂无网站', 'data/websites.json 里还没有内容。',
      '把数据写进这个 JSON 文件，本页会自动渲染。'));
    return wrap;
  }

  /* 需求 7：常用网站 = 分类筛选切换（默认全选，显示所有分类） */
  const filterBar = createFilterBar({
    items: categories.map((cat) => ({
      id: cat.id,
      label: cat.nameZh || cat.id,
      count: (cat.items || []).length
    })),
    ariaLabel: '网站分类筛选',
    mode: 'multi',
    showReset: true,
    defaultCollapsed: true,
    onChange: () => applyWebsitesFilter(wrap)
  });
  wrap.append(filterBar.element);
  categories.forEach((cat) => wrap.append(buildWebsiteCategory(cat)));

  // 所有分类都被取消勾选时的提示（配合 applyWebsitesFilter）
  wrap.append(el('div', 'websites-filter-empty muted',
    '所有分类都被取消了勾选，点右上角「清空勾选」即可恢复全部内容。'));
  wrap.lastChild.hidden = true;

  bindFilterApply(filterBar, wrap);
  return wrap;
}

/**
 * 应用常用网站页的勾选筛选（并集语义，理由同 applyRootsFilter 的注释）：
 * 未勾选的分类整块隐藏；一个都没勾时显示提示而不是空白页。
 */
function applyWebsitesFilter(root) {
  if (!root) return;
  const bar = root.__filterBar;
  if (!bar) return;
  const selected = bar.getSelected();

  let visible = 0;
  root.querySelectorAll('.website-category').forEach((catNode) => {
    const on = selected.has(catNode.dataset.id);
    catNode.hidden = !on;
    if (on) visible += 1;
  });

  const tip = root.querySelector('.websites-filter-empty');
  if (tip) tip.hidden = visible > 0;
}

/** 一个分类区块：标题 + 计数 + 网站卡片列表 */
function buildWebsiteCategory(cat) {
  const section = el('section', 'website-category');
  section.id = `website-category-${cat.id}`;
  section.dataset.id = cat.id;              // 深链 / 搜索定位：#/websites/search

  const head = el('div', 'website-category__head');
  head.append(el('h3', 'website-category__title', cat.nameZh || cat.id));
  head.append(el('span', 'website-category__count', `${(cat.items || []).length} 个`));
  section.append(head);

  const grid = el('div', 'website-grid');
  (cat.items || []).forEach((item) => grid.append(buildWebsiteCard(item)));
  section.append(grid);
  return section;
}

/** 网站卡片 */
function buildWebsiteCard(item) {
  const card = el('article', 'card website-card');
  if (item.nameEn) card.dataset.id = item.nameEn;   // 搜索可精确定位到这一张卡

  /* 头部：字母徽标（纯视觉）+ 英文名（可读）+ 中文名 */
  const head = el('div', 'website-card__head');
  const badge = el('span', 'website-card__badge', websiteInitial(item.nameEn));
  badge.setAttribute('aria-hidden', 'true');      // 字母是装饰，不重复读一遍
  head.append(badge);
  const names = el('div', 'website-card__names');
  names.append(elEn('p', 'website-card__name-en', item.nameEn || ''));
  names.append(el('p', 'website-card__name-zh', item.nameZh || ''));
  head.append(names);
  card.append(head);

  /* 英文介绍（可点读）+ 中文说明 */
  const descId = `site-desc-${slugId(item.nameEn)}`;
  if (item.descEn) {
    const descEn = elEn('p', 'website-card__desc-en', item.descEn);
    descEn.id = descId;
    card.append(descEn);
  }
  if (item.descZh) card.append(el('p', 'website-card__desc-zh', item.descZh));

  /* 站点地址（去掉 www 前缀，方便辨认） */
  if (item.url) card.append(el('span', 'website-card__url', hostOf(item.url)));

  /* 操作：打开网站（新窗口）+ 朗读介绍 */
  const foot = el('div', 'website-card__foot');
  if (item.url) {
    const link = el('a', 'website-card__open');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append(document.createTextNode('打开网站 →'));
    foot.append(link);
  }
  if (item.descEn) foot.append(makeSpeakButton(item.descEn, descId));
  card.append(foot);
  return card;
}

/** 取站点主机名，去掉 www. 前缀（用于展示，便于辨认链接） */
function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); }
  catch (err) { return String(url || ''); }
}

/** 网站英文名首字母（徽标用，非数据） */
function websiteInitial(name) {
  const s = String(name || '').trim();
  return s ? s.charAt(0).toUpperCase() : '★';
}

/** 生成 URL 安全的 id：Google Translate → google-translate */
function slugId(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'site';
}




/* ============================ 5. 顶部搜索框 ============================ */
/* 搜索框的全部交互（预热索引、实时结果、清空、回车跳第一条、点外部收起）
   已由 js/search.js 负责；boot() 里用 initSearch({ loadJSON, goTo, notify }) 接入。 */

/* ============================ 6. 说明：朗读交互的接管方式 ============================ */
/* 旧版本的临时朗读提示已移除。
   现在全站的英文朗读由 js/tts.js 的 bindSpeakable(document) 用事件委托统一接管，
   界面状态（停止按钮、语速档位、朗读中徽标）由 js/speech-feedback.js 负责。 */

/* ============================ 7. Service Worker（PWA） ============================ */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;   // file:// 下不注册

  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('新版本已就绪，刷新后生效 🔄', 2600);
        }
      });
    });
  } catch (err) {
    console.warn('[sw] 注册失败：', err);
  }
}

/* ============================ 8. 启动 ============================ */
function boot() {
  // 没有 hash 时补上默认 Tab（replaceState 不产生多余历史记录）
  if (!/^#\//.test(location.hash)) history.replaceState(null, '', tabHash(DEFAULT_TAB));

  window.addEventListener('hashchange', () => {
    const { tab, targetId } = parseHash();
    renderView(tab, targetId);
  });

  // 全站搜索：预热索引 + 放大镜展开/收起 + 实时下拉 + 点击跳转高亮（Fuse.js，缺库时自动降级）
  const searchApi = initSearch({ loadJSON, goTo, notify: toast });

  // 返回顶部按钮：全站挂载一次，5 个 Tab 页面共用（需求 1）
  initBackToTop();

  // 收藏 / 生词本：document 级事件委托，任意页面渲染出的 ☆ 都能用
  initFavorites({ notify: toast });
  document.addEventListener('favorites:change', () => {
    if (favListApi) favListApi.render();     // 首页收藏列表实时刷新
  });

  // 添加到主屏幕：Android/桌面 Chrome 触发 beforeinstallprompt 后才显示提示条
  // （iOS Safari 不支持该事件，用系统 分享 → 添加到主屏幕 即可）
  let installPrompt = null;
  const installBanner = document.getElementById('installBanner');
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    if (installBanner) installBanner.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    if (installBanner) installBanner.hidden = true;
    toast('已添加到主屏幕 🎉');
  });
  const installBtn = document.getElementById('installBtn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      installPrompt = null;
      if (installBanner) installBanner.hidden = true;
      toast(choice && choice.outcome === 'accepted' ? '已添加到主屏幕 🎉' : '已取消添加');
    });
  }
  const installLater = document.getElementById('installLater');
  if (installLater) {
    installLater.addEventListener('click', () => {
      if (installBanner) installBanner.hidden = true;
    });
  }

  // 朗读引擎 + 界面反馈
  const ttsReady = initTTS();
  if (ttsReady) bindSpeakable(document);   // document 级事件委托：绑一次，全站生效
  initSpeechFeedback({ notify: toast });

  const { tab, targetId } = parseHash();
  renderView(tab, targetId);

  registerServiceWorker();

  // 调试入口：控制台可执行 __app.goTo('roots','spect')、__app.speak('Hello')、__app.search('spect')
  window.__app = {
    TABS, loadJSON, toast, goTo, renderView,
    speak, speakQueue, stopSpeaking, setRate, getRate,
    search: searchApi,
    homeCards: { buildHomeCardPool, pickRandomCards, getPool: () => homeCardPool },
    favorites: { getFavorites, countFavorites }
  };
}

/* ============================ 9. 真机自测面板（临时） ============================ */
/*
 * 【临时功能 · 第 3 轮可整段删除】
 * 用途：真机走查时，在首页底部「连点版本号 5 次」展开，一键截图上报环境信息
 *       （浏览器 UA / 当前缓存版本 / SW 注册状态 / 系统语音列表）。
 * 依据：docs/真机验收.md 的附录 A。
 *
 * 删除方法（共 3 处，删完不影响任何功能）：
 *   1) 本节全部代码
 *   2) renderHomeView() 里的 appendSelfTestEntry(wrap);
 *   3) css/components.css 末尾的「真机自测面板」样式块
 */

/** 页面版本常量：应与 sw.js 的 CACHE_VERSION 保持一致（面板会与 caches 实际名对照显示） */
const APP_VERSION = 'v0.9.0';
const SELFTEST_TAPS = 5;        // 需要连点的次数
const SELFTEST_TAP_GAP = 2500;  // 相邻两次点击的最大间隔(ms)，超时则重新计数
const SELFTEST_VOICE_MAX = 12;  // 语音列表最多展示几条（截图友好）

let selftestTaps = 0;        // 已连点次数
let selftestLastTap = 0;     // 上一次点击的时间戳
let selftestPanel = null;    // 面板节点（跨 Tab 切换保留，切回来仍是展开状态）
let selftestFields = null;   // 面板里各个 <dd> 的引用

/**
 * 首页底部：灰色版本号（同时是隐藏入口）。
 * @param {HTMLElement} host
 * @returns {HTMLElement} 版本号按钮
 */
function appendSelfTestEntry(host) {
  const btn = el('button', 'app-version', `版本 ${APP_VERSION}`);
  btn.type = 'button';
  btn.setAttribute('aria-label', `版本 ${APP_VERSION}，连点 5 次打开真机自测面板`);
  btn.addEventListener('click', () => {
    const now = Date.now();
    // 超过间隔就重新计数，避免很久之后随手点几下就误触
    selftestTaps = (now - selftestLastTap > SELFTEST_TAP_GAP) ? 1 : selftestTaps + 1;
    selftestLastTap = now;
    if (selftestTaps >= SELFTEST_TAPS) {
      selftestTaps = 0;
      showSelfTestPanel(btn);
    }
  });

  host.append(btn);
  if (selftestPanel) host.append(selftestPanel);   // 切走再回来时保持已展开
  return btn;
}

/** 展开（或刷新）自测面板；幂等 */
function showSelfTestPanel(anchor) {
  if (!selftestPanel) {
    selftestPanel = buildSelfTestPanel();
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(selftestPanel, anchor.nextSibling);
  }
  selftestPanel.hidden = false;
  collectSelfTestInfo();
  selftestPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return selftestPanel;
}

/** 搭面板骨架：标题 + 关闭按钮 + 若干「标签/取值」行 */
function buildSelfTestPanel() {
  const box = el('section', 'selftest');
  box.id = 'selfTestPanel';

  const head = el('div', 'selftest__head');
  head.append(el('strong', 'selftest__title', '真机自测（临时）'));
  const close = el('button', 'selftest__close', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭真机自测面板');
  close.addEventListener('click', () => { box.hidden = true; });
  head.append(close);
  box.append(head);

  const list = el('dl', 'selftest__list');
  const addRow = (label, extraClass) => {
    list.append(el('dt', '', label));
    const dd = el('dd', extraClass || '', '读取中…');
    list.append(dd);
    return dd;
  };

  selftestFields = {
    ua:     addRow('浏览器 UA'),
    page:   addRow('页面版本'),
    cache:  addRow('当前缓存版本'),
    sw:     addRow('SW 注册状态'),
    voices: addRow('语音列表', 'selftest__voices'),
    env:    addRow('环境')
  };

  box.append(list);
  return box;
}

/** 采集一次环境信息并填进面板（同步项直接写，异步项给 Promise） */
function collectSelfTestInfo() {
  const f = selftestFields;
  if (!f) return;

  f.ua.textContent = navigator.userAgent;
  f.page.textContent = `${APP_VERSION}（页面常量，应与缓存名一致）`;

  /* 缓存版本：caches.keys() 是运行时真相，比去解析 sw.js 可靠 */
  if ('caches' in window && window.isSecureContext) {
    caches.keys()
      .then((keys) => {
        f.cache.textContent = keys.length
          ? keys.join('、')
          : '（空：Service Worker 尚未装上，PWA 与离线项会失败）';
      })
      .catch((err) => { f.cache.textContent = `读取失败：${errText(err)}`; });
  } else {
    f.cache.textContent = '不可用（需 https 或 127.0.0.1）';
  }

  /* SW 注册状态 */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration()
      .then((reg) => {
        if (!reg) { f.sw.textContent = '未注册（首次访问未完成？刷新一次再看）'; return; }
        const state = reg.installing ? 'installing'
          : reg.waiting ? 'waiting'
            : reg.active ? 'activated' : '未知';
        const ctrl = navigator.serviceWorker.controller
          ? '本页已被接管' : '本页未被接管（首次访问属正常）';
        f.sw.textContent = `${state} · scope=${reg.scope} · ${ctrl}`;
      })
      .catch((err) => { f.sw.textContent = `读取失败：${errText(err)}`; });
  } else {
    f.sw.textContent = '该浏览器不支持 Service Worker';
  }

  /* 语音列表：首屏常常是空的，监听 voiceschanged 再补两次重试 */
  if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoiceList);
    setTimeout(refreshVoiceList, 800);
    setTimeout(refreshVoiceList, 2500);
  }
  refreshVoiceList();

  f.env.textContent = [
    location.protocol,
    `安全上下文=${window.isSecureContext}`,
    `屏宽=${window.innerWidth}`,
    `dpr=${window.devicePixelRatio}`,
    `语速=${getRate()}`
  ].join(' · ');
}

/** 刷新语音列表：空列表或没有英语语音时，面板本身就是问题定位依据 */
function refreshVoiceList() {
  const f = selftestFields;
  if (!f) return;
  if (!('speechSynthesis' in window)) {
    f.voices.textContent = '该浏览器不支持语音合成（朗读会整体不可用）';
    return;
  }
  const list = window.speechSynthesis.getVoices() || [];
  if (!list.length) {
    f.voices.textContent = '（空：系统里没有可用语音，需在系统设置中下载英语语音包）';
    return;
  }
  const enCount = list.filter((v) => /^en([-_]|$)/i.test(v.lang || '')).length;
  const shown = list.slice(0, SELFTEST_VOICE_MAX)
    .map((v) => `${v.name} [${v.lang}]${v.localService ? ' 本地' : ''}${v.default ? ' 默认' : ''}`);
  f.voices.textContent =
    `共 ${list.length} 个，其中英语 ${enCount} 个${enCount ? '' : '（⚠️ 无英语语音，朗读必然失败）'}\n`
    + shown.join('\n')
    + (list.length > SELFTEST_VOICE_MAX ? `\n… 其余 ${list.length - SELFTEST_VOICE_MAX} 个省略` : '');
}

/** 统一取错误信息 */
function errText(err) {
  return String((err && err.message) || err || '未知错误');
}

boot();


