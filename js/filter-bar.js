/* ==========================================================================
 * filter-bar.js — 内容页顶部分类筛选条（需求 5 / 6 / 7 / 9 共用组件）
 * --------------------------------------------------------------------------
 * 一个组件同时承担三件事，四页（词根词缀 / 场景对话 / 主题单词 / 常用网站）复用：
 *
 *   1) 展开 / 收起（需求 6 / 第 3 轮需求 3）
 *      - 顶部右侧一个 44x44 的小三角按钮（收起 ▸ / 展开 ▾）
 *      - 收起态：所有分类标签在一行内横向平铺，可左右滑动
 *        （overflow-x:auto + scroll-snap，滚动条隐藏但保留滚动能力）
 *      - 展开态：多行平铺显示全部标签；切换有高度过渡动画
 *      - 第 3 轮起组件【默认展开】；需要"默认收起"的页面传 defaultCollapsed: true
 *      - 展开/收起【只影响显示】，不影响勾选状态
 *
 *   2) 一级分类 + 二级分类（需求 5，仅 roots 页传 subs）
 *      - 一级分类旁另有小三角：▸ 收起 / ▾ 展开二级列表（不改勾选）
 *      - 点一级分类文字本身 → 切换该一级下所有二级项的勾选（全选 / 全不选）
 *      - 点某个二级项     → 切换该二级项的勾选
 *      - 第 4 轮需求 2：二级展开改为【手风琴】——同时只展开一个一级分类的二级；
 *        点另一个一级的 ▸ 会自动收起前一个，点已展开的 ▾ 则收起它
 *        （所以允许出现"一个二级都没展开"的状态）
 *
 *   3) 内部垂直滚动（第 4 轮需求 1，四页统一）
 *      - 标签多到撑破屏幕时，在筛选区【内部】上下滑动，不带动页面整体滚动
 *      - 展开态 max-height: 40vh + overflow-y:auto + overscroll-behavior:contain
 *      - 滚动条隐藏（scrollbar-width:none + ::-webkit-scrollbar{display:none}）
 *      - 收起态仍是一行横滑（本来就超不出 40vh，视觉不变）
 *      - 主题单词页是 Tab 式（data-mode="single"），max-height 始终生效
 *      - 内容确实超出时才在底部显示一条渐隐提示（::after + linear-gradient）
 *
 *   4) 多选筛选 +「全选 / 清空勾选」（需求 7 / 第 5 轮拆分为两个独立按钮）
 *      - multi 模式：默认全部勾选，点击即切换，未勾选的分类内容隐藏
 *      - single 模式（主题单词页）：保持原有 Tab 式，点谁只显示谁
 *      - showReset 页面右上角依次是 [全选][清空勾选][▸/▾] 三个按钮（同行垂直居中）：
 *        · 「全选」(主色实心)：所有一级、二级全部勾上并立即重绘内容区；已全选时置灰
 *        · 「清空勾选」(主色描边)：所有一级、二级全部取消并立即重绘；已全空时置灰
 *      - 一个分类都没勾时，筛选条内显示 .filterbar__empty 空状态引导文案
 *      - 展开/收起、手风琴切换只改显隐不改勾选，因此不影响两个按钮的置灰状态
 *
 * 对外 API：
 *   const bar = createFilterBar({ items, mode, onChange, ... });
 *   bar.element            // 可直接 append 的 <div>
 *   bar.getSelected()      // Set<string>，被勾选的 key 集合
 *   bar.isSelected(key)
 *   bar.selectAll()        // 全选（等价于点「全选」按钮）
 *   bar.clearAll()         // 清空勾选（等价于点「清空勾选」按钮）
 *   bar.reset()            // 兼容旧名：语义不变（全部恢复勾选），等价于 selectAll()
 *   bar.setCollapsed(bool) // 需求 6 的展开/收起
 *   bar.syncActive(id)     // single 模式下同步高亮（切分类后调用）
 *
 * 勾选状态的 key 规则（对外稳定，app.js 的 data-filter-key 与之保持一致）：
 *   - 没有二级分类的项：key = 项自身的 id（如 'shopping'）
 *   - 有二级分类的一级项：不直接存 key，其勾选状态由二级项推导（全选才算勾上）
 *   - 二级项：key = `${一级id}::${二级id}`（如 'prefixes::否定与相反'）
 * ========================================================================== */

/** 默认计数单位文案 */
const DEFAULT_COUNT_SUFFIX = ' 个';
/** 「全选」按钮文案（第 5 轮：拆分为「全选」+「清空勾选」两个独立工具按钮） */
const SELECT_ALL_LABEL = '全选';
/** 「清空勾选」按钮文案 */
const CLEAR_LABEL = '清空勾选';

let uid = 0;

/**
 * 创建分类筛选条。
 * @param {{
 *   items: Array<{id:string, label:string, count?:number, countText?:string,
 *                 subs?:Array<{id:string, label:string, count?:number, countText?:string}>}>,
 *   ariaLabel?: string,
 *   mode?: 'multi'|'single',        // 默认 multi（分类筛选切换）
 *   showReset?: boolean,            // 是否显示「全选」+「清空勾选」两个工具按钮（第 5 轮）
 *   defaultCollapsed?: boolean,     // 默认【展开】；传 true 则默认收起一行（主题单词页）
 *   activeId?: string,              // single 模式初始选中项
 *   onChange?: (payload: {selected: Set<string>, reason: string, id: string}) => void
 * }} options
 * @returns {{element: HTMLElement, getSelected: Function, isSelected: Function,
 *            selectAll: Function, clearAll: Function, reset: Function,
 *            setCollapsed: Function, syncActive: Function}}
 */
export function createFilterBar(options = {}) {
  const items = Array.isArray(options.items) ? options.items : [];
  const mode = options.mode === 'single' ? 'single' : 'multi';
  const showReset = !!options.showReset;
  const onChange = typeof options.onChange === 'function' ? options.onChange : function () {};
  const instanceId = `fb${++uid}`;

  /* ---------------- 勾选状态：selected 存 key 的集合 ---------------- */
  /** 二级项 key → 一级项 id */
  const subOwner = new Map();
  /** 一级项 id → 它下面所有二级项 key */
  const childrenOf = new Map();
  /** 一级项 id → 该项本身是否有二级项 */
  const hasSubs = new Map();

  items.forEach((item) => {
    const subs = Array.isArray(item.subs) && item.subs.length ? item.subs : null;
    hasSubs.set(item.id, !!subs);
    childrenOf.set(item.id, subs ? subs.map((s) => subKey(item.id, s.id)) : []);
    if (subs) subs.forEach((s) => subOwner.set(subKey(item.id, s.id), item.id));
  });

  /** 默认状态：所有一级、二级项全部勾选（= 显示全部内容） */
  let selected = new Set(allKeys());

  /** single 模式下当前"Tab 式"选中的项 */
  let activeId = options.activeId || (items[0] && items[0].id) || '';

  function subKey(parentId, subId) { return `${parentId}::${subId}`; }

  /** 全部可勾选的 key（无二级项的用自身 id，有二级项的用二级项 key） */
  function allKeys() {
    const keys = [];
    items.forEach((item) => {
      const subs = Array.isArray(item.subs) && item.subs.length ? item.subs : null;
      if (subs) subs.forEach((s) => keys.push(subKey(item.id, s.id)));
      else keys.push(item.id);
    });
    return keys;
  }

  /** 一个一级项是否「已勾选」：无二级项看自身；有二级项则必须全部勾上 */
  function isItemSelected(itemId) {
    if (!hasSubs.get(itemId)) return selected.has(itemId);
    const children = childrenOf.get(itemId) || [];
    if (!children.length) return selected.has(itemId);
    return children.every((key) => selected.has(key));
  }

  /* ---------------------------- DOM ---------------------------- */
  const root = el('div', 'filterbar');
  root.dataset.mode = mode;
  root.id = `${instanceId}-root`;

  const row = el('div', 'filterbar__row');

  const list = el('div', 'filterbar__list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', options.ariaLabel || '分类筛选');

  /* 第 4 轮：list 自身是滚动容器，外层 scroll 只是它的定位上下文，
     用来挂一条固定的底部渐隐提示（::after 不能挂在滚动容器上，否则会跟着内容滚走）。 */
  const scrollViewport = el('div', 'filterbar__scroll');
  scrollViewport.append(list);

  const groupNodes = new Map();   // item.id → {group, chip, caret, subsBox, subChips}

  items.forEach((item) => {
    const group = el('div', 'filterbar__group');
    group.dataset.filterGroup = item.id;

    const head = el('div', 'filterbar__head');

    const chip = el('button', 'filterbar__chip');
    chip.type = 'button';
    chip.dataset.filterId = item.id;
    chip.append(el('span', 'filterbar__label', item.label || item.id));
    chip.append(el('span', 'filterbar__count', countTextOf(item, true)));
    head.append(chip);

    // 二级列表容器（一级分类旁的小三角：▸ 收起 / ▾ 展开）
    let subsBox = null;
    let caret = null;
    const subChips = new Map();          // 无二级项时保持空 Map，渲染逻辑统一
    const subs = Array.isArray(item.subs) && item.subs.length ? item.subs : null;
    if (subs) {
      caret = el('button', 'filterbar__caret');
      caret.type = 'button';
      caret.dataset.filterCaret = item.id;
      caret.setAttribute('aria-expanded', 'false');
      caret.setAttribute('aria-label', `展开「${item.label || item.id}」的二级分类`);
      caret.append(el('span', 'filterbar__caret-icon', '▸'));
      head.append(caret);

      subsBox = el('div', 'filterbar__subs');
      subsBox.dataset.filterSubs = item.id;
      subsBox.hidden = true;

      subs.forEach((sub) => {
        const subChip = el('button', 'filterbar__sub');
        subChip.type = 'button';
        subChip.dataset.filterId = subKey(item.id, sub.id);
        subChip.append(el('span', 'filterbar__sub-tick', '✓'));
        subChip.append(el('span', 'filterbar__label', sub.label || sub.id));
        subChip.append(el('span', 'filterbar__count', countTextOf(sub, false)));
        subsBox.append(subChip);
        subChips.set(sub.id, subChip);
      });
      group.append(head, subsBox);
    } else {
      group.append(head);
    }

    list.append(group);
    groupNodes.set(item.id, { group, chip, caret, subsBox, subChips });
  });

  /* ---- 右侧工具区：「全选」+「清空勾选」+ 展开/收起小三角（第 5 轮拆分） ----
     三个按钮排在同一行（.filterbar__tools 为 flex + align-items:center 垂直居中）：
       [全选]（主色实心，视觉权重高） [清空勾选]（主色描边，权重低） [▸/▾]（保持原样） */
  const tools = el('div', 'filterbar__tools');

  let selectAllBtn = null;
  let clearBtn = null;
  if (showReset) {
    // 「全选」：主色填充（实心按钮）
    selectAllBtn = el('button', 'filterbar__tool filterbar__tool--primary');
    selectAllBtn.type = 'button';
    selectAllBtn.append(el('span', '', SELECT_ALL_LABEL));
    selectAllBtn.setAttribute('aria-label', '全选所有分类');

    // 「清空勾选」：主色描边（幽灵按钮，视觉权重低）
    clearBtn = el('button', 'filterbar__tool filterbar__tool--ghost');
    clearBtn.type = 'button';
    clearBtn.append(el('span', '', CLEAR_LABEL));
    clearBtn.setAttribute('aria-label', '清空所有分类的勾选');

    tools.append(selectAllBtn, clearBtn);
  }

  const toggleBtn = el('button', 'filterbar__toggle');
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-label', '展开全部分类');
  toggleBtn.append(el('span', 'filterbar__toggle-icon', '▸'));
  tools.append(toggleBtn);

  row.append(scrollViewport, tools);
  root.append(row);

  /* 第 5 轮：空状态引导 —— 一个分类都没勾（点「清空勾选」）时显示在筛选条内。
     仅 showReset 页面创建；文案居中 18px、--text-2，"[全选]" 做主色强调。
     纯普通流内元素，不遮挡返回顶部按钮和底部 Tab 栏。 */
  const emptyBox = showReset ? el('div', 'filterbar__empty') : null;
  if (emptyBox) {
    emptyBox.hidden = true;
    emptyBox.setAttribute('role', 'status');
    emptyBox.append(el('p', 'filterbar__empty-line', '还没有选择任何分类'));
    const hintLine = el('p', 'filterbar__empty-line');
    hintLine.append('点击上方 ');
    hintLine.append(el('span', 'filterbar__empty-hl', '[全选]'));
    hintLine.append(' 查看全部内容');
    emptyBox.append(hintLine);
    root.append(emptyBox);
  }

  /* ---------------------------- 状态渲染 ---------------------------- */
  // 第 3 轮起默认【展开】（多行平铺显示所有分类标签）；
  // 需要"默认收起一行横向滑动"的页面传 defaultCollapsed: true（如主题单词页）。
  let collapsed = options.defaultCollapsed === true;

  function renderSelection() {
    items.forEach((item) => {
      const nodes = groupNodes.get(item.id);
      if (!nodes) return;
      const on = mode === 'single' ? item.id === activeId : isItemSelected(item.id);
      nodes.chip.classList.toggle('is-on', on);
      nodes.chip.classList.toggle('is-off', !on);
      nodes.chip.setAttribute('aria-pressed', on ? 'true' : 'false');

      if (nodes.subsBox && nodes.subChips) {
        item.subs.forEach((sub) => {
          const subChip = nodes.subChips.get(sub.id);
          if (!subChip) return;
          const subOn = selected.has(subKey(item.id, sub.id));
          subChip.classList.toggle('is-on', subOn);
          subChip.classList.toggle('is-off', !subOn);
          subChip.setAttribute('aria-pressed', subOn ? 'true' : 'false');
        });
        // 一个都没勾 → 一级也置灰
        const anyOn = item.subs.some((sub) => selected.has(subKey(item.id, sub.id)));
        nodes.chip.classList.toggle('is-off', !anyOn);
      }
    });

    // 第 5 轮：勾选状态变化后统一同步两个工具按钮的置灰 + 空状态显隐。
    // 展开/收起（renderCollapsed）与手风琴（renderSubs）不经过这里 → 不影响置灰。
    syncToolButtons();
  }

  /* ---------------- 第 5 轮：全选 / 清空勾选 两个独立工具按钮 ---------------- */

  /** 所有一级 + 二级是否【已全部勾选】（只看可勾选 key，一级由二级推导） */
  function isAllSelected() {
    const all = allKeys();
    return all.length > 0 && all.every((key) => selected.has(key));
  }

  /** 所有一级 + 二级是否【全部未勾选】 */
  function isNoneSelected() {
    const all = allKeys();
    return all.length > 0 && all.every((key) => !selected.has(key));
  }

  /** 「全选」：所有一级、二级全部勾上 → 立即重新渲染内容区 */
  function selectAll() {
    selected = new Set(allKeys());
    renderSelection();
    onChange({ selected: new Set(selected), reason: 'select-all', id: '' });
  }

  /** 「清空勾选」：所有一级、二级全部取消 → 内容区进入空状态 */
  function clearAll() {
    selected = new Set();
    renderSelection();
    onChange({ selected: new Set(selected), reason: 'clear-all', id: '' });
  }

  /**
   * 同步两个工具按钮的 disabled + 空状态显隐（只在勾选状态变化后被调用）：
   *   「全选」    —— 已全部勾选时置灰
   *   「清空勾选」—— 已全部未勾选时置灰
   *   部分勾选   —— 两个都保持可点
   * single 模式（主题单词页）没有工具按钮，直接跳过。
   */
  function syncToolButtons() {
    if (!selectAllBtn || !clearBtn) return;
    const noneOn = isNoneSelected();
    selectAllBtn.disabled = isAllSelected();
    clearBtn.disabled = noneOn;
    if (emptyBox) emptyBox.hidden = !noneOn;
  }

  function renderCollapsed() {
    root.classList.toggle('is-collapsed', collapsed);
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', collapsed ? '展开全部分类' : '收起分类');
    const icon = toggleBtn.querySelector('.filterbar__toggle-icon');
    if (icon) icon.textContent = collapsed ? '▸' : '▾';
    syncScrollAffordance();
  }

  /* --------------------- 二级分类：手风琴（同时只展开一个） ---------------------
   * 第 4 轮需求 2：原先多个一级分类的二级可以同时展开，页面会被撑得很长。
   * 现在改为手风琴：展开 B 前自动收起 A；点已展开的 A 则收起它，
   * 于是允许出现"一个二级都没展开"的状态。
   * 只影响二级列表的显隐，完全不碰勾选状态，也不触发 onChange。
   * 组件级生效 —— 而四页里只有词根词缀页传了 subs，所以实际只有该页受影响。 */
  /** 当前展开二级列表的一级项 id；null = 一个都没展开 */
  let openSubId = null;

  function renderSubs() {
    items.forEach((item) => {
      const nodes = groupNodes.get(item.id);
      if (!nodes || !nodes.subsBox || !nodes.caret) return;
      const open = openSubId === item.id;
      nodes.subsBox.hidden = !open;
      nodes.caret.setAttribute('aria-expanded', open ? 'true' : 'false');
      nodes.caret.setAttribute('aria-label', `${open ? '收起' : '展开'}「${item.label || item.id}」的二级分类`);
      const icon = nodes.caret.querySelector('.filterbar__caret-icon');
      if (icon) icon.textContent = open ? '▾' : '▸';
    });
  }

  /* ------------------ 第 4 轮：区域内垂直滚动 + 底部渐隐提示 ------------------ */
  /**
   * 按真实尺寸决定要不要显示"还能往下滑"的渐隐条：
   *   .is-scrollable —— scrollHeight > clientHeight（内容确实超出）
   *   .is-scroll-end —— 已经滚到底，此时不再提示
   * 收起态只有一行，量出来不会超出，所以自然不会显示。
   */
  function syncScrollAffordance() {
    const over = list.scrollHeight - list.clientHeight;
    const scrollable = over > 1;
    root.classList.toggle('is-scrollable', scrollable);
    root.classList.toggle('is-scroll-end', scrollable && list.scrollTop >= over - 1);
  }

  /** 内容高度变了（展开二级 / 收起 / 换分类）后，下一帧再量一次尺寸 */
  function refreshScrollAffordance() {
    requestAnimationFrame(syncScrollAffordance);
  }

  list.addEventListener('scroll', syncScrollAffordance, { passive: true });
  // 40vh 跟着视口走：转屏、地址栏收起等会让可视高度变化 → 由 RO 兜底重算
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncScrollAffordance).observe(list);

  /* ---------------------------- 交互 ---------------------------- */
  // 点一级分类文字 → single 模式=切换 Tab；multi 模式=切换该一级下所有二级项的勾选
  //                   没有二级项的一级项 → 直接切换自身勾选
  // 点小三角      → 只展开/收起二级列表，不改勾选
  list.addEventListener('click', (event) => {
    const caret = event.target.closest('[data-filter-caret]');
    if (caret) {
      const id = caret.dataset.filterCaret;
      const nodes = groupNodes.get(id);
      if (nodes && nodes.subsBox) {
        // 第 4 轮需求 2（手风琴）：
        //   点已展开的 ▾ → 收起它（可以一个都没展开）
        //   点别的 ▸    → 先把当前展开的收起来，再展开这个
        // 只改二级列表的显隐，不碰勾选、不触发 onChange。
        openSubId = openSubId === id ? null : id;
        renderSubs();
        refreshScrollAffordance();   // 展开后内容变高，重算渐隐提示
      }
      return;
    }

    const chip = event.target.closest('[data-filter-id]');
    if (!chip) return;
    const id = chip.dataset.filterId;

    if (mode === 'single') {
      if (id === activeId) return;
      activeId = id;
      renderSelection();
      const nodes = groupNodes.get(id);
      scrollChipIntoView(nodes && nodes.chip);
      onChange({ selected: new Set([activeId]), reason: 'active', id: activeId });
      return;
    }

    // multi 模式：key 含 '::' 说明是二级项，否则是一级项
    const parentId = subOwner.get(id);
    if (parentId) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    } else {
      const children = childrenOf.get(id) || [];
      const allOn = children.length ? children.every((key) => selected.has(key)) : selected.has(id);
      const keys = children.length ? children : [id];
      keys.forEach((key) => {
        if (allOn) selected.delete(key);
        else selected.add(key);
      });
    }
    renderSelection();
    onChange({ selected: new Set(selected), reason: 'toggle', id });
  });

  // 工具区：全选 / 清空勾选 / 展开收起
  // （disabled 按钮原生不会派发 click，置灰时无需再判断）
  tools.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn === selectAllBtn) { selectAll(); return; }
    if (btn === clearBtn) { clearAll(); return; }
    if (btn === toggleBtn) { setCollapsed(!collapsed); }
  });

  /** 需求 6：展开 / 收起 */
  function setCollapsed(value) {
    collapsed = !!value;
    renderCollapsed();
  }

  /** single 模式：外部（如深链跳转）改变选中项时同步高亮 */
  function syncActive(id) {
    if (!id || mode !== 'single') return;
    activeId = id;
    renderSelection();
    const nodes = groupNodes.get(id);
    if (nodes) scrollChipIntoView(nodes.chip);
  }

  renderSelection();
  renderCollapsed();
  renderSubs();                    // 第 4 轮：二级列表默认一个都没展开
  refreshScrollAffordance();       // 入 DOM 前量不准，等挂载后（rAF/RO）再补一次

  return {
    element: root,
    getSelected: () => new Set(selected),
    isSelected: (id) => (subOwner.has(id) ? selected.has(id) : isItemSelected(id)),
    selectAll,
    clearAll,
    reset: selectAll,          // 兼容旧名：语义不变（全部恢复勾选）
    setCollapsed,
    syncActive
  };
}

/* ---------------------------- 小工具 ---------------------------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** 计数文案：没给 countText 时按 count 生成（'9 个' 或纯数字） */
function countTextOf(item, withUnit) {
  if (item.countText != null) return String(item.countText);
  if (item.count == null) return '';
  return withUnit ? `${item.count}${DEFAULT_COUNT_SUFFIX}` : String(item.count);
}

/**
 * 让当前选中的标签滚进可视区。
 * single 模式下切换分类时用：让被选中的那个标签在横向滑动条里自动居中。
 */
function scrollChipIntoView(chip) {
  if (!chip) return;
  try { chip.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  catch (err) { /* 老浏览器忽略 */ }
}
