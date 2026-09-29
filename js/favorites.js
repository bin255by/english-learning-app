/* ==========================================================================
 * favorites.js — 收藏 / 生词本（localStorage 持久化）
 * --------------------------------------------------------------------------
 * 能力：
 *   1. 给内容卡片右上角加一颗 44px 的 ☆ 收藏按钮（词根、单词、对话、网站）
 *   2. 首页「我的收藏」区块：按 Tab 分组展示，点击跳转、✕ 移除
 *   3. 单词类的收藏天然就是「生词本」，随学随存，刷新/关浏览器都不丢
 *
 * 存储：localStorage['elapp.favorites.v1'] = [{ key, tab, targetId, title, sub, type, addedAt }]
 * 依赖：goTo / notify 由 app.js 注入，避免循环引用。
 * ========================================================================== */

const STORAGE_KEY = 'elapp.favorites.v1';
const MAX_ITEMS = 300;          // 上限保护，避免 localStorage 无限增长

/** Tab → 分组标题 */
const TAB_LABEL = {
  roots: '词根词缀',
  vocabulary: '主题单词（生词本）',
  dialogues: '场景对话',
  websites: '常用网站'
};

/** 收藏条目主键：tab + targetId */
export function favKey(tab, targetId) {
  return `${tab || 'home'}:${targetId || ''}`;
}

/* ============================ 1. 存储层（纯逻辑，可单测） ============================ */
function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((i) => i && i.key) : [];
  } catch (err) {
    return [];                    // 隐私模式 / 数据损坏时按空处理
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
    return true;
  } catch (err) {
    return false;
  }
}

/** 全部收藏（按收藏时间倒序） */
export function getFavorites() {
  return readAll().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/** 收藏数量 */
export function countFavorites() {
  return readAll().length;
}

/** 是否已收藏 */
export function isFavorite(key) {
  return readAll().some((item) => item.key === key);
}

/** 加入收藏（已存在则忽略） */
export function addFavorite(item) {
  if (!item || !item.key) return false;
  const list = readAll();
  if (list.some((i) => i.key === item.key)) return false;
  list.push(Object.assign({ addedAt: Date.now() }, item));
  return writeAll(list);
}

/** 取消收藏 */
export function removeFavorite(key) {
  const list = readAll();
  const next = list.filter((i) => i.key !== key);
  if (next.length === list.length) return false;
  return writeAll(next);
}

/** 切换收藏状态 */
export function toggleFavorite(item) {
  if (!item || !item.key) return false;
  if (isFavorite(item.key)) { removeFavorite(item.key); return false; }
  addFavorite(item);
  return true;
}

/** 清空（设置里可用） */
export function clearFavorites() {
  return writeAll([]);
}

/* ============================ 2. 卡片收藏按钮 ============================ */
/** 各类卡片 → 收藏信息提取规则 */
const CARD_RULES = [
  {
    selector: '.affix-card', tab: 'roots',
    pick: (card) => ({
      targetId: card.dataset.id, type: '词根',
      title: text(card, '.affix-card__affix'),
      sub: text(card, '.affix-card__meaning')
    })
  },
  {
    selector: '.word-card', tab: 'vocabulary',
    pick: (card) => ({
      targetId: card.dataset.id, type: '单词',
      title: text(card, '.word-card__en'),
      sub: text(card, '.word-card__zh')
    })
  },
  {
    selector: '.dialogue-scene', tab: 'dialogues',
    pick: (card) => ({
      targetId: card.dataset.id, type: '对话',
      title: text(card, '.dialogue-scene__title-en'),
      sub: text(card, '.dialogue-scene__title-zh')
    })
  },
  {
    selector: '.website-card', tab: 'websites',
    pick: (card) => ({
      targetId: card.dataset.id, type: '网站',
      title: text(card, '.website-card__name-en'),
      sub: text(card, '.website-card__name-zh')
    })
  }
];

function text(root, sel) {
  const node = root.querySelector(sel);
  return node ? String(node.textContent || '').trim() : '';
}

/**
 * 给 root 下所有支持的卡片右上角插入收藏按钮（幂等，可重复调用）。
 * @param {HTMLElement} root
 * @returns {number} 实际插入的数量
 */
export function decorateFavorites(root) {
  if (!root || !root.querySelectorAll) return 0;
  let count = 0;
  CARD_RULES.forEach((rule) => {
    const cards = root.querySelectorAll(rule.selector);
    Array.prototype.forEach.call(cards, (card) => {
      if (card.querySelector('.fav-star')) return;        // 已插入过
      const info = rule.pick(card);
      if (!info.targetId) return;                         // 没有 data-id 的不收藏
      if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(buildStar(rule.tab, info));
      count += 1;
    });
  });
  return count;
}

function buildStar(tab, info) {
  const key = favKey(tab, info.targetId);
  const on = isFavorite(key);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fav-star' + (on ? ' is-on' : '');
  btn.dataset.favToggle = key;
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.setAttribute('aria-label', (on ? '取消收藏：' : '收藏：') + (info.title || key));
  btn.textContent = on ? '★' : '☆';
  return btn;
}

/** 同步所有收藏按钮的显示状态（切换后调用） */
function syncStars(root) {
  if (!root || !root.querySelectorAll) return;
  const buttons = root.querySelectorAll('[data-fav-toggle]');
  Array.prototype.forEach.call(buttons, (btn) => {
    const on = isFavorite(btn.dataset.favToggle);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? '★' : '☆';
  });
}

/* ============================ 3. 首页「我的收藏」列表 ============================ */
/**
 * 在容器里渲染收藏列表（按 Tab 分组）。
 * @param {HTMLElement} container
 * @param {{goTo?: Function, notify?: Function}} [options]
 * @returns {{render: Function}} 需要时可手动 render()
 */
export function mountFavoritesList(container, options = {}) {
  const goTo = options.goTo;
  const notify = options.notify || function () {};

  function render() {
    if (!container) return;
    container.innerHTML = '';

    const list = getFavorites();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'fav-empty';
      const t = document.createElement('p');
      t.className = 'fav-empty__title';
      t.textContent = '还没有收藏';
      const d = document.createElement('p');
      d.className = 'fav-empty__desc';
      d.textContent = '点内容卡片右上角的 ☆ 就能收进这里；收藏的单词就是你的生词本。';
      empty.appendChild(t);
      empty.appendChild(d);
      container.appendChild(empty);
      return;
    }

    const groups = new Map();
    list.forEach((item) => {
      const tab = item.tab || 'home';
      if (!groups.has(tab)) groups.set(tab, []);
      groups.get(tab).push(item);
    });

    Array.from(groups.keys()).forEach((tab) => {
      const items = groups.get(tab);
      const card = document.createElement('div');
      card.className = 'card fav-group';

      const head = document.createElement('div');
      head.className = 'fav-group__head';
      const title = document.createElement('h3');
      title.className = 'fav-group__title';
      title.textContent = TAB_LABEL[tab] || tab;
      const count = document.createElement('span');
      count.className = 'fav-group__count';
      count.textContent = items.length + ' 条';
      head.appendChild(title);
      head.appendChild(count);
      card.appendChild(head);

      items.forEach((item) => card.appendChild(buildFavRow(item, goTo, render, notify)));
      container.appendChild(card);
    });
  }

  render();
  return { render };
}

function buildFavRow(item, goTo, rerender, notify) {
  const row = document.createElement('div');
  row.className = 'fav-row';

  const title = item.title || item.targetId || '';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'fav-row__main';

  const badge = document.createElement('span');
  badge.className = 'fav-row__type';
  badge.textContent = item.type || '';

  const texts = document.createElement('span');
  texts.className = 'fav-row__texts';
  const name = document.createElement('span');
  name.className = 'fav-row__title';
  name.textContent = title;
  texts.appendChild(name);
  if (item.sub) {
    const sub = document.createElement('span');
    sub.className = 'fav-row__sub';
    sub.textContent = item.sub;
    texts.appendChild(sub);
  }
  main.appendChild(badge);
  main.appendChild(texts);
  main.addEventListener('click', () => {
    if (typeof goTo === 'function') goTo(item.tab, item.targetId);
  });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'fav-row__remove';
  del.setAttribute('aria-label', '移除收藏：' + title);
  del.textContent = '✕';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFavorite(item.key);
    syncStars(document);
    rerender();
    notify('已从收藏移除');
  });

  row.appendChild(main);
  row.appendChild(del);
  return row;
}

/* ============================ 4. 事件委托（只绑一次） ============================ */
let inited = false;

/**
 * 初始化收藏：document 级事件委托，任何页面渲染出的 ☆ 都能用。
 * 切换后派发 'favorites:change' 事件，首页列表可监听后重绘。
 * @param {{notify?: Function}} [options]
 */
export function initFavorites(options = {}) {
  if (inited) return;
  inited = true;
  const notify = options.notify || function () {};

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const btn = target.closest('[data-fav-toggle]');
    if (!btn) return;
    event.stopPropagation();                 // 避免同时触发卡片自己的点击

    const key = btn.dataset.favToggle;
    const parts = String(key).split(':');
    const added = toggleFavorite({
      key: key,
      tab: parts[0],
      targetId: parts.slice(1).join(':')
    });
    syncStars(document);
    document.dispatchEvent(new CustomEvent('favorites:change'));
    notify(added ? '已加入收藏 ⭐' : '已取消收藏');
  });
}


