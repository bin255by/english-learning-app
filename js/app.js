/* ==========================================================================
 * app.js — 应用唯一入口（原生 ES6 模块）
 * --------------------------------------------------------------------------
 * 阶段 1 职责：
 *   1. Hash 路由：#/home、#/roots/spect …（Tab + 目标 ID，支持深链与刷新保持）
 *   2. 底部 Tab 高亮与视图切换
 *   3. 视图渲染调度（各页面内容在后续阶段实现，本阶段为占位视图）
 *   4. data/*.json 统一加载（带内存缓存）
 *   5. Service Worker 注册（PWA）
 *
 * 全站约定（后续阶段严格遵守）：
 *   - 英文文本元素统一加 class="speakable"（阶段 2 接入 js/tts.js 后即可点击朗读）
 *   - 中文文本不加 speakable，且不会被朗读
 *   - 由 JSON 数据渲染的文本一律使用 textContent，避免 HTML 注入
 * ========================================================================== */

/* ============================ 0. 模块依赖 ============================ */
import { initTTS, bindSpeakable, speak, speakQueue, stopSpeaking, setRate, getRate, on, isSpeaking } from './tts.js';
import { initSpeechFeedback } from './speech-feedback.js';
import { createHomeCards, destroyHomeCards } from './home.js';
import { initSearch } from './search.js';
import { initFavorites, decorateFavorites, mountFavoritesList, getFavorites, countFavorites } from './favorites.js';

/* ============================ 1. Tab 配置 ============================ */
/** 底部 5 个 Tab；dataFile 为该页对应的数据文件，descZh 用于占位说明 */
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

/** 生成某个 Tab（可带目标 ID）的 hash，供后续阶段跳转使用 */
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
/** 各 Tab 对应的视图函数：返回 Element（或 Promise<Element>）；后续阶段逐个替换 */
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

  decorateFavorites(main);      // 给内容卡片加收藏按钮（阶段 9）

  if (targetId) focusTarget(targetId);
  else window.scrollTo({ top: 0 });

  main.focus({ preventScroll: true });   // 无障碍：切 Tab 后焦点进入内容区
}

/** 滚动到 data-id="xxx" 的元素并高亮 1.8s（搜索 / 首页卡片跳转用） */
function focusTarget(targetId) {
  const main = $('#appMain');
  const node = $$('[data-id]', main).find((n) => n.dataset.id === targetId);
  if (!node) {
    toast(`「${targetId}」的内容将在后续阶段上线`);
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

/* ---------------------------- 首页视图 ---------------------------- */
async function renderHomeView(tab) {
  const wrap = el('div');

  /* (1) 每日卡片轮播：随机 5 张，点卡片「先朗读英文，再跳转」 */
  try {
    const cards = await loadJSON(tab.dataFile);
    const list = Array.isArray(cards) ? cards : [];
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


/* （阶段 1 的「建设中」占位视图已移除：5 个 Tab 现在都有真实视图） */

/* ---------------------------- 词根词缀视图（阶段 4） ---------------------------- */
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

  section.append(buildCategoryNav(categories));
  categories.forEach((cat) => section.append(buildCategorySection(cat)));
  return section;
}

/** 顶部分类快速跳转（事件委托，一个监听搞定所有 chip） */
function buildCategoryNav(categories) {
  const nav = el('nav', 'roots-nav');
  nav.setAttribute('aria-label', '词根词缀分类');

  categories.forEach((cat) => {
    const chip = el('button', 'roots-nav__chip');
    chip.type = 'button';
    chip.dataset.goto = cat.id;
    chip.append(el('span', '', cat.nameZh || cat.id));
    chip.append(el('span', 'roots-nav__count',
      `${(cat.items || []).length} 个`));
    nav.append(chip);
  });

  nav.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-goto]');
    if (!chip) return;
    const target = document.getElementById(`roots-category-${chip.dataset.goto}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return nav;
}

/** 一个分类：标题 + 内部语义分组列表 */
function buildCategorySection(cat) {
  const block = el('section', 'roots-category');
  block.id = `roots-category-${cat.id}`;
  block.dataset.category = cat.id;

  const head = el('div', 'roots-category__head');
  head.append(el('h3', 'roots-category__title', cat.nameZh || cat.id));
  head.append(elEn('span', 'roots-category__title-en', CATEGORY_EN[cat.id] || ''));
  const count = (cat.items || []).length;
  head.append(el('span', 'roots-category__count', `${count} 个`));
  block.append(head);

  groupByMeaning(cat.items || []).forEach((group) => {
    block.append(buildGroup(group));
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

/** 一个语义分组：标题横线 + 若干词缀卡片 */
function buildGroup(group) {
  const wrap = el('div', 'roots-group');
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

/* ---------------------------- 场景对话视图（阶段 5） ---------------------------- */
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

  wrap.append(buildDialoguesToolbar(scenes));
  scenes.forEach((scene, index) => wrap.append(buildScene(scene, index + 1)));

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

/** 工具条：中文开关 + 场景快速跳转（事件委托） */
function buildDialoguesToolbar(scenes) {
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
    const root = bar.closest('.dialogues-view');
    if (!root) return;
    const hide = !root.classList.contains('is-zh-hidden');
    applyZhVisibility(root, hide);
    saveHideZhPref(hide);
  });

  const nav = el('nav', 'dialogues-nav');
  nav.setAttribute('aria-label', '对话场景');
  scenes.forEach((scene) => {
    const chip = el('button', 'dialogues-nav__chip');
    chip.type = 'button';
    chip.dataset.goto = scene.id || '';
    chip.append(document.createTextNode(scene.titleZh || scene.titleEn || scene.id || ''));
    nav.append(chip);
  });
  nav.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-goto]');
    if (!chip) return;
    const target = document.getElementById(`dialogue-scene-${chip.dataset.goto}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  bar.append(nav);
  return bar;
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

/* ---------------------------- 主题单词视图（阶段 6） ---------------------------- */
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

  const strip = buildVocabStrip(categories, activeId);
  const body = el('div', 'vocab-body');
  wrap.append(strip, body);

  const renderActive = () => {
    const cat = categories.find((c) => c.id === activeId) || categories[0];
    body.innerHTML = '';                       // 清空当前分类（未完成的维基请求会被丢弃）
    body.append(buildVocabCategory(cat));
    setActiveChip(strip, activeId);
  };

  // 事件委托：一个监听搞定 17 个分类标签
  strip.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-cat]');
    if (!chip || chip.dataset.cat === activeId) return;
    activeId = chip.dataset.cat;
    renderActive();
  });

  renderActive();
  return wrap;
}

/** 分类条：横向可滑动、不换行（17 个分类不会占满整屏） */
function buildVocabStrip(categories, activeId) {
  const strip = el('nav', 'vocab-strip');
  strip.setAttribute('aria-label', '单词分类');
  categories.forEach((cat) => {
    const chip = el('button', 'vocab-strip__chip');
    chip.type = 'button';
    chip.dataset.cat = cat.id;
    chip.setAttribute('aria-pressed', cat.id === activeId ? 'true' : 'false');
    if (cat.id === activeId) chip.classList.add('is-active');
    chip.append(document.createTextNode(cat.nameZh || cat.id));
    chip.append(el('span', 'vocab-strip__count', String((cat.items || []).length)));
    strip.append(chip);
  });
  return strip;
}

/** 切换分类时更新标签状态，并把当前标签滚进可视区 */
function setActiveChip(strip, activeId) {
  strip.querySelectorAll('.vocab-strip__chip').forEach((chip) => {
    const active = chip.dataset.cat === activeId;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (active) {
      try { chip.scrollIntoView({ inline: 'center', block: 'nearest' }); }
      catch (err) { /* 老浏览器忽略 */ }
    }
  });
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

/* ---------------------------- 常用网站视图（阶段 7） ---------------------------- */
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

  wrap.append(buildWebsitesNav(categories));
  categories.forEach((cat) => wrap.append(buildWebsiteCategory(cat)));
  return wrap;
}

/** 分类快速跳转（事件委托，一个监听搞定所有 chip） */
function buildWebsitesNav(categories) {
  const nav = el('nav', 'websites-nav');
  nav.setAttribute('aria-label', '网站分类');
  categories.forEach((cat) => {
    const chip = el('button', 'websites-nav__chip');
    chip.type = 'button';
    chip.dataset.goto = cat.id;
    chip.append(document.createTextNode(cat.nameZh || cat.id));
    chip.append(el('span', 'websites-nav__count', `${(cat.items || []).length} 个`));
    nav.append(chip);
  });
  nav.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-goto]');
    if (!chip) return;
    const target = document.getElementById(`website-category-${chip.dataset.goto}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return nav;
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
   已在阶段 8 移交 js/search.js；boot() 里用 initSearch({ loadJSON, goTo, notify }) 接入。
   这里不再保留任何阶段 1 的「搜索即将上线」占位逻辑。 */

/* ============================ 6. 说明：朗读交互的接管方式 ============================ */
/* 阶段 1 的临时提示已在阶段 2 删除。
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

  // 全站搜索：预热索引 + 实时下拉 + 点击跳转高亮（Fuse.js，缺库时自动降级）
  const searchApi = initSearch({ loadJSON, goTo, notify: toast });

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

  // 朗读引擎 + 界面反馈（阶段 2）
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
    favorites: { getFavorites, countFavorites }
  };
}

boot();


