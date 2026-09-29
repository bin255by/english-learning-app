/* ==========================================================================
 * search.js — 全站模糊搜索（Fuse.js 7）
 * --------------------------------------------------------------------------
 * 分两层，方便测试与维护：
 *   纯逻辑（不碰 DOM，可单测）：
 *     buildSearchRecords(dataByName) → 把 5 份 JSON 拍平成搜索记录
 *     createSearcher(records, opts)  → { engine, search(keyword, limit) }
 *   DOM 层：
 *     initSearch({ loadJSON, goTo, notify }) → 建索引 + 放大镜展开/收起 + 实时下拉 + 点击跳转高亮
 *
 * 搜索框形态（第 2 轮需求 3a / 4）：
 *   - 默认收起，顶部只显示一个 44x44 的 🔍 图标按钮
 *   - 点图标 → 从图标位置宽度过渡展开成完整输入框并自动聚焦（软键盘弹出）
 *   - 点「取消」/ 点框外空白 / 按 Esc → 收起并 blur（软键盘收起），但【保留关键词】
 *   - 点某条搜索结果跳转 → 结果框收起 + blur 收起键盘，搜索框保持展开、关键词保留
 *
 * 依赖（loadJSON / goTo / toast）由 app.js 注入，避免与 app.js 循环引用。
 * 匹配策略是「先子串分级，再 Fuse 容错」：
 *   1) 精确 → 前缀 → 包含（标题中英）→ 包含（正文）逐级打分，结果稳定可预期
 *   2) 子串完全没命中时才交给 Fuse 模糊匹配（拼写容错）
 *   3) Fuse 没加载（离线/被拦截）→ 自动降级为子串匹配，搜索照常可用
 * ========================================================================== */

/** 数据源：索引顺序 = 同分时的排序（卡片 → 词根 → 对话 → 单词 → 网站） */
const SOURCES = [
  { key: 'home-cards',  file: 'data/home-cards.json' },
  { key: 'roots',       file: 'data/roots.json' },
  { key: 'dialogues',   file: 'data/dialogues.json' },
  { key: 'vocabulary',  file: 'data/vocabulary.json' },
  { key: 'websites',    file: 'data/websites.json' }
];

/** 导出数据源清单，供 app.js 预热索引时复用 */
export function getSearchSources() {
  return SOURCES.map((s) => ({ key: s.key, file: s.file }));
}

/**
 * 把全站数据拍平成搜索记录。
 * 记录结构：{ id, tab, targetId, type, title, titleZh, sub, haystack }
 *  - targetId 是深链目标：会交给对应视图预选/定位，并由 focusTarget 加高亮
 *  - haystack 是给 Fuse 看的全文（中英都放进去）
 * @param {Object} dataByName 已解析的 JSON，键为 SOURCES[].key
 * @returns {Array<Object>}
 */
export function buildSearchRecords(dataByName) {
  const records = [];
  const data = dataByName || {};

  const push = (record) => {
    if (record && (record.title || record.titleZh)) records.push(record);
  };
  const join = (parts) => parts.filter(Boolean).join(' ');

  /* ---------- 1) 首页卡片：数据里自带 targetTab / targetId ---------- */
  const cards = data['home-cards'];
  (Array.isArray(cards) ? cards : []).forEach((card) => {
    push({
      id: `card:${card.id || card.titleEn}`,
      tab: card.targetTab || 'home',
      targetId: card.targetId || undefined,
      type: '每日卡片',
      title: card.titleEn || '',
      titleZh: card.titleZh || '',
      sub: card.descZh || '',
      haystack: join([card.titleEn, card.titleZh, card.descEn, card.descZh, card.type])
    });
  });

  /* ---------- 2) 词根词缀：targetId = 词缀 id（卡片 data-id） ---------- */
  const roots = data['roots'];
  ((roots && roots.categories) || []).forEach((cat) => {
    const typeLabel = cat.id === 'prefixes' ? '前缀' : (cat.id === 'suffixes' ? '后缀' : '词根');
    (cat.items || []).forEach((item) => {
      const wordList = (item.examples || []).map((w) => w.word).filter(Boolean).join(' ');
      const wordZhList = (item.examples || []).map((w) => w.meaningZh).filter(Boolean).join(' ');
      push({
        id: `root:${item.id}`,
        tab: 'roots',
        targetId: item.id,
        type: typeLabel,
        title: item.affix || '',
        titleZh: item.meaningZh || '',
        sub: wordList,
        haystack: join([item.affix, item.meaningZh, item.groupZh, wordList, wordZhList,
          item.sentenceEn, item.sentenceZh, cat.nameZh])
      });
    });
  });

  /* ---------- 3) 场景对话：targetId = 场景 id（整段高亮） ---------- */
  const dialogues = data['dialogues'];
  ((dialogues && dialogues.scenes) || []).forEach((scene) => {
    const lineEn = (scene.lines || []).map((l) => l.en).filter(Boolean).join(' ');
    const lineZh = (scene.lines || []).map((l) => l.zh).filter(Boolean).join(' ');
    const keys = (scene.lines || []).reduce((acc, l) => {
      (l.keyExpressions || []).forEach((k) => acc.push(k.en, k.zh));
      return acc;
    }, []).join(' ');
    push({
      id: `scene:${scene.id}`,
      tab: 'dialogues',
      targetId: scene.id,
      type: '对话',
      title: scene.titleEn || '',
      titleZh: scene.titleZh || '',
      sub: scene.descZh || '',
      haystack: join([scene.titleEn, scene.titleZh, scene.descZh, lineEn, lineZh, keys,
        (scene.tipsZh || []).join(' ')])
    });
  });

  /* ---------- 4) 主题单词：分类记录 + 单词记录 ---------- */
  const vocabulary = data['vocabulary'];
  ((vocabulary && vocabulary.categories) || []).forEach((cat) => {
    /* 分类本身：搜「月份」「购物」这类词时直接跳分类 */
    push({
      id: `vocab-cat:${cat.id}`,
      tab: 'vocabulary',
      targetId: cat.id,
      type: '单词分类',
      title: cat.nameEn || '',
      titleZh: cat.nameZh || '',
      sub: `${(cat.items || []).length} 个词`,
      haystack: join([cat.nameEn, cat.nameZh,
        (cat.items || []).map((i) => i.en).join(' '),
        (cat.items || []).map((i) => i.zh).join(' ')])
    });

    (cat.items || []).forEach((item) => {
      /* 单词级：targetId = 英文单词（视图会预选所在分类，卡片 data-id 精确高亮） */
      push({
        id: `vocab:${cat.id}:${item.en}`,
        tab: 'vocabulary',
        targetId: item.en,
        type: '单词',
        title: item.en || '',
        titleZh: item.zh || '',
        sub: item.exampleZh || '',
        haystack: join([item.en, item.zh, item.abbr, item.exampleEn, item.exampleZh,
          cat.nameEn, cat.nameZh])
      });
    });
  });

  /* ---------- 5) 常用网站：分类记录 + 网站记录 ---------- */
  const websites = data['websites'];
  ((websites && websites.categories) || []).forEach((cat) => {
    push({
      id: `site-cat:${cat.id}`,
      tab: 'websites',
      targetId: cat.id,
      type: '网站分类',
      title: cat.nameZh || '',
      titleZh: '',
      sub: `${(cat.items || []).length} 个网站`,
      haystack: join([cat.nameZh, (cat.items || []).map((i) => i.nameEn).join(' '),
        (cat.items || []).map((i) => i.nameZh).join(' ')])
    });

    (cat.items || []).forEach((item) => {
      /* 网站卡片 data-id = 英文名，可精确定位到那一张卡 */
      push({
        id: `site:${item.nameEn}`,
        tab: 'websites',
        targetId: item.nameEn,
        type: '网站',
        title: item.nameEn || '',
        titleZh: item.nameZh || '',
        sub: item.descZh || '',
        haystack: join([item.nameEn, item.nameZh, item.descEn, item.descZh, item.url, cat.nameZh])
      });
    });
  });

  return records;
}

/* ============================ 搜索器（纯逻辑，可单测） ============================ */
/** 归一化：转小写并去掉首尾空白 */
function normalize(text) {
  return String(text == null ? '' : text).toLowerCase().trim();
}

/**
 * 创建搜索器。
 * 匹配策略：先做「子串分级」保证结果稳定可控；完全没命中时才交给 Fuse 做模糊容错。
 * @param {Array<Object>} records buildSearchRecords() 的结果
 * @param {{engine?: 'auto'|'fuse'|'substring'}} [options] engine='substring' 可强制降级（便于测试）
 * @returns {{engine: string, search: (keyword: string, limit?: number) => Array<Object>}}
 */
export function createSearcher(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const mode = options.engine || 'auto';

  let fuse = null;
  const canUseFuse = (mode !== 'substring')
    && typeof window !== 'undefined'
    && typeof window.Fuse === 'function';

  if (canUseFuse) {
    fuse = new window.Fuse(list, {
      includeScore: true,
      threshold: 0.4,            // 容错强度：允许一定拼写错误
      ignoreLocation: true,      // 关键词出现在长文本任意位置都能命中
      minMatchCharLength: 2,     // 少于 2 个字符不出模糊结果，避免刷屏
      keys: [
        { name: 'title', weight: 0.5 },
        { name: 'titleZh', weight: 0.3 },
        { name: 'haystack', weight: 0.2 }
      ]
    });
  }

  /**
   * 子串分级打分：0 精确 → 0.15 前缀 → 0.3 标题包含 → 0.6 正文包含；-1 未命中
   * 中文与英文同一套规则，天然支持双语搜索。
   */
  function scoreBySubstring(kw, record) {
    const title = normalize(record.title);
    const titleZh = normalize(record.titleZh);
    if ((title && title === kw) || (titleZh && titleZh === kw)) return 0;
    if ((title && title.indexOf(kw) === 0) || (titleZh && titleZh.indexOf(kw) === 0)) return 0.15;
    if ((title && title.indexOf(kw) > -1) || (titleZh && titleZh.indexOf(kw) > -1)) return 0.3;
    if (normalize(record.haystack).indexOf(kw) > -1) return 0.6;
    return -1;
  }

  function search(keyword, limit) {
    const max = limit || 8;
    const kw = normalize(keyword);
    if (kw.length < MIN_QUERY_LENGTH) return [];

    const hits = [];
    list.forEach((record) => {
      const score = scoreBySubstring(kw, record);
      if (score >= 0) hits.push({ record, score });
    });
    hits.sort((a, b) => a.score - b.score);   // 稳定排序：同分保持索引顺序

    if (hits.length) {
      return hits.slice(0, max).map((hit) => Object.assign({}, hit.record, { score: hit.score }));
    }

    // 子串完全没命中 → 交给 Fuse 做拼写容错（Fuse 不可用则无结果）
    if (fuse) {
      return fuse.search(kw, { limit: max }).map((hit) =>
        Object.assign({}, hit.item, { score: hit.score }));
    }
    return [];
  }

  return { engine: fuse ? 'fuse' : 'substring', search };
}

/** 允许的最小关键词长度 */
const MIN_QUERY_LENGTH = 1;

/* ============================ DOM 层（顶部搜索框交互） ============================ */
const DEBOUNCE_MS = 120;      // 输入防抖
const MAX_RESULTS = 8;        // 最多显示 8 条

/** 本模块内的建元素工具 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 初始化顶部搜索框（在 app.js 启动时调用一次）。
 *   - 后台预热索引（5 份数据只请求一次，与页面渲染共用 loadJSON 的内存缓存）
 *   - 输入实时显示下拉结果（中英双语 + 拼写容错）
 *   - 点击结果 → goTo(tab, targetId) 切 Tab 并由 focusTarget 滚动高亮
 * @param {{loadJSON: Function, goTo: Function, notify?: Function}} options 由 app.js 注入
 * @returns {{search: Function, hide: Function}|null}
 */
export function initSearch(options) {
  const loadJSON = options.loadJSON;
  const goTo = options.goTo;
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  const panel = document.getElementById('searchResults');
  const box = document.getElementById('searchBox');
  const toggleBtn = document.getElementById('searchToggle');
  const cancelBtn = document.getElementById('searchCancel');
  if (!input || !panel || typeof loadJSON !== 'function') return null;

  let searcher = null;
  let results = [];
  let debounceTimer = null;

  /* 1) 预热索引：启动即后台加载数据，用户开始输入时索引多半已就绪 */
  const ready = (async () => {
    const dataByName = {};
    await Promise.all(getSearchSources().map(async (source) => {
      try {
        dataByName[source.key] = await loadJSON(source.file);
      } catch (err) {
        console.warn('[search] 数据加载失败：', source.file, err && err.message);
        dataByName[source.key] = null;
      }
    }));
    searcher = createSearcher(buildSearchRecords(dataByName));
    console.debug('[search] 索引就绪，引擎 =', searcher.engine);
    return searcher;
  })();
  ready.catch((err) => console.warn('[search] 索引构建失败：', err));

  /* 2) 输入 → 防抖 → 查询 → 渲染 */
  const runSearch = async (keyword) => {
    try {
      await ready;
    } catch (err) {
      renderResults([], keyword);
      return;
    }
    results = searcher.search(keyword, MAX_RESULTS);
    renderResults(results, keyword);
  };

  const onInput = () => {
    const keyword = input.value.trim();
    if (clearBtn) clearBtn.hidden = input.value.length === 0;
    clearTimeout(debounceTimer);
    if (!keyword) { hideResults(); return; }
    debounceTimer = setTimeout(() => { runSearch(keyword); }, DEBOUNCE_MS);
  };

  input.addEventListener('input', onInput);
  input.addEventListener('focus', () => {
    const keyword = input.value.trim();
    if (keyword) runSearch(keyword);            // 再次点进来时恢复上次结果
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (results.length) jumpTo(results[0]);   // 回车直达第一条
      else input.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();                  // 避免冒泡到 document 再收一次
      closeSearch();                            // 需求 3a：Esc 收起（保留关键词）
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.hidden = true;
      hideResults();
      input.focus();
    });
  }

  /* 点搜索区域外 → 收起结果 */
  document.addEventListener('click', (event) => {
    if (panel.hidden) return;
    if (!event.target.closest('.search')) hideResults();
  });

  /* ===================== 2.5 放大镜 ⇄ 搜索框 展开/收起（需求 3a） ===================== */
  /**
   * 展开搜索框：从放大镜图标位置展开成完整输入框，自动聚焦唤起软键盘。
   * 已有关键词时直接复用，不必重新输入。
   */
  function openSearch() {
    if (!box) return;
    box.classList.add('is-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
    if (cancelBtn) cancelBtn.hidden = false;
    input.focus();
    // 再次点开时恢复上次的搜索结果
    const keyword = input.value.trim();
    if (keyword) runSearch(keyword);
  }

  /**
   * 收起搜索框：清空结果列表 + 让输入框失焦（收起移动端软键盘），
   * 但【保留输入框里的关键词】，用户下次点开还能看到自己搜了什么（需求 3a / 4）。
   * @param {{keepOpen?: boolean, keepResults?: boolean}} [opts]
   */
  function closeSearch(opts = {}) {
    if (!opts.keepResults) hideResults();
    if (opts.keepOpen) return;
    if (box) box.classList.remove('is-open');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
    if (cancelBtn) cancelBtn.hidden = true;
    blurInput();
  }

  /** 让输入框失焦：移动端据此收起软键盘（iOS 需要真实 blur 才生效） */
  function blurInput() {
    try {
      if (typeof input.blur === 'function') input.blur();
    } catch (err) { /* 忽略 */ }
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => { openSearch(); });
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => { closeSearch(); });
  }

  // 点输入框外的空白区域 → 收起（需求 3a）
  document.addEventListener('click', (event) => {
    if (!box || !box.classList.contains('is-open')) return;
    if (!event.target.closest('.search')) closeSearch();
  });

  // Escape → 收起（需求 3a；输入框内已有一份，见下面的 keydown）
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!box || !box.classList.contains('is-open')) return;
    if (panel && !panel.hidden) return;    // 结果还开着时交给输入框处理，避免两次收起
    closeSearch();
  });

  /* 3) 渲染与跳转 */
  function renderResults(list, keyword) {
    panel.innerHTML = '';
    setExpanded(true);
    if (!list.length) {
      panel.append(el('div', 'search-result search-result--empty',
        `没有找到「${keyword}」，换个词试试`));
      panel.hidden = false;
      return;
    }
    list.forEach((item) => panel.append(buildResultRow(item)));
    panel.append(el('div', 'search-result__count', `共 ${list.length} 条 · 点击打开并定位高亮`));
    panel.hidden = false;
  }

  function hideResults() {
    panel.hidden = true;
    panel.innerHTML = '';
    results = [];
    setExpanded(false);
  }

  function setExpanded(value) {
    input.setAttribute('aria-expanded', value ? 'true' : 'false');
  }

  /**
   * 需求 4：点击搜索结果跳转后
   *   1) 立即隐藏下拉结果框
   *   2) 让 searchInput 失焦 → 收起移动端软键盘
   *   3) 触发 goTo（沿用现有跳转 + focusTarget 高亮）
   *   搜索框本身【保持展开】，输入框里的关键词也【保留】，让用户看到自己搜了什么。
   */
  function jumpTo(item) {
    hideResults();
    blurInput();
    if (typeof goTo === 'function') goTo(item.tab, item.targetId);
  }

  function buildResultRow(item) {
    const btn = el('button', 'search-result');
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.append(el('span', 'search-result__type', item.type || '内容'));

    const body = el('div', 'search-result__body');
    const titleText = item.title || item.titleZh || '';
    const title = el('span', 'search-result__title', titleText);
    if (titleText && !/[一-鿿]/.test(titleText)) title.lang = 'en';
    body.append(title);

    const subs = [];
    if (item.title && item.titleZh && item.titleZh !== item.title) subs.push(item.titleZh);
    if (item.sub) subs.push(item.sub);
    if (subs.length) body.append(el('span', 'search-result__sub', subs.join(' · ')));
    btn.append(body);

    btn.append(el('span', 'search-result__arrow', '›'));
    // 必须 stopPropagation：hideResults() 会清空 panel，事件冒泡到 document 时
    // event.target 已脱离 DOM，closest('.search') 返回 null，会被误判成"点了框外"而收起整个搜索框。
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      jumpTo(item);
    });
    return btn;
  }

  setExpanded(false);
  if (clearBtn) clearBtn.hidden = input.value.length === 0;
  // 默认收起：只显示放大镜图标
  if (box) box.classList.remove('is-open');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
  if (cancelBtn) cancelBtn.hidden = true;

  return {
    search: (keyword) => (searcher ? searcher.search(keyword, MAX_RESULTS) : []),
    hide: hideResults,
    open: openSearch,
    close: closeSearch,
    isOpen: () => !!(box && box.classList.contains('is-open'))
  };
}



