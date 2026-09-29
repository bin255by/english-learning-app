/* ==========================================================================
 * filter-bar.js — 内容页顶部分类筛选条（需求 5 / 6 / 7 / 9 共用组件）
 * --------------------------------------------------------------------------
 * 一个组件同时承担三件事，四页（词根词缀 / 场景对话 / 主题单词 / 常用网站）复用：
 *
 *   1) 展开 / 收起（需求 6）
 *      - 顶部右侧一个 44x44 的小三角按钮（收起 ▸ / 展开 ▾）
 *      - 默认【收起】：所有分类标签在一行内横向平铺，可左右滑动
 *        （overflow-x:auto + scroll-snap，滚动条隐藏但保留滚动能力）
 *      - 展开：多行平铺显示全部标签；切换有高度过渡动画
 *      - 展开/收起【只影响显示】，不影响勾选状态
 *
 *   2) 一级分类 + 二级分类（需求 5，仅 roots 页传 subs）
 *      - 一级分类旁另有小三角：▸ 收起 / ▾ 展开二级列表（不改勾选）
 *      - 点一级分类文字本身 → 切换该一级下所有二级项的勾选（全选 / 全不选）
 *      - 点某个二级项     → 切换该二级项的勾选
 *
 *   3) 多选筛选 + 重置（需求 7 / 9）
 *      - multi 模式：默认全部勾选，点击即切换，未勾选的分类内容隐藏
 *      - single 模式（主题单词页）：保持原有 Tab 式，点谁只显示谁
 *      - showReset 页面额外提供「清空勾选」按钮，点击恢复"全选"默认状态
 *
 * 对外 API：
 *   const bar = createFilterBar({ items, mode, onChange, ... });
 *   bar.element            // 可直接 append 的 <div>
 *   bar.getSelected()      // Set<string>，被勾选的 key 集合
 *   bar.isSelected(key)
 *   bar.reset()            // 等价于「清空勾选」：全部恢复勾选
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
/** 「清空勾选」按钮文案（需求 9：两种方案里选"已全选时置灰"，见 renderSelection 注释） */
const RESET_LABEL = '清空勾选';

let uid = 0;

/**
 * 创建分类筛选条。
 * @param {{
 *   items: Array<{id:string, label:string, count?:number, countText?:string,
 *                 subs?:Array<{id:string, label:string, count?:number, countText?:string}>}>,
 *   ariaLabel?: string,
 *   mode?: 'multi'|'single',        // 默认 multi（分类筛选切换）
 *   showReset?: boolean,            // 是否显示「清空勾选」（需求 9）
 *   defaultCollapsed?: boolean,     // 默认收起（需求 6）
 *   activeId?: string,              // single 模式初始选中项
 *   onChange?: (payload: {selected: Set<string>, reason: string, id: string}) => void
 * }} options
 * @returns {{element: HTMLElement, getSelected: Function, isSelected: Function,
 *            reset: Function, setCollapsed: Function, syncActive: Function}}
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

  /* ---- 右侧工具区：「清空勾选」+ 展开/收起小三角（需求 9 + 需求 6） ---- */
  const tools = el('div', 'filterbar__tools');

  let resetBtn = null;
  if (showReset) {
    resetBtn = el('button', 'filterbar__reset');
    resetBtn.type = 'button';
    resetBtn.append(el('span', '', RESET_LABEL));
    tools.append(resetBtn);
  }

  const toggleBtn = el('button', 'filterbar__toggle');
  toggleBtn.type = 'button';
  toggleBtn.setAttribute('aria-label', '展开全部分类');
  toggleBtn.append(el('span', 'filterbar__toggle-icon', '▸'));
  tools.append(toggleBtn);

  row.append(list, tools);
  root.append(row);

  /* ---------------------------- 状态渲染 ---------------------------- */
  let collapsed = options.defaultCollapsed !== false;   // 需求 6：默认收起

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

    // 「清空勾选」按钮：已全选（或本来就全空）时置灰不可点。
    // 方案选择：置灰而非隐藏 —— 位置不会跳动，用户也更容易发现这个按钮的存在。
    if (resetBtn) {
      const all = allKeys();
      const allOn = all.length > 0 && all.every((key) => selected.has(key));
      const noneOn = all.every((key) => !selected.has(key));
      resetBtn.disabled = allOn || noneOn;
    }
  }

  function renderCollapsed() {
    root.classList.toggle('is-collapsed', collapsed);
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleBtn.setAttribute('aria-label', collapsed ? '展开全部分类' : '收起分类');
    const icon = toggleBtn.querySelector('.filterbar__toggle-icon');
    if (icon) icon.textContent = collapsed ? '▸' : '▾';
  }

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
        const open = nodes.subsBox.hidden;
        nodes.subsBox.hidden = !open;
        nodes.caret.setAttribute('aria-expanded', open ? 'true' : 'false');
        nodes.caret.setAttribute('aria-label', `${open ? '收起' : '展开'}「${labelOf(id)}」的二级分类`);
        const icon = nodes.caret.querySelector('.filterbar__caret-icon');
        if (icon) icon.textContent = open ? '▾' : '▸';
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

  // 工具区：清空勾选 / 展开收起
  tools.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (resetBtn && btn === resetBtn) { reset(); return; }
    if (btn === toggleBtn) { setCollapsed(!collapsed); }
  });

  /** 「清空勾选」：把所有一级、二级项恢复为勾选（即默认全显示） */
  function reset() {
    selected = new Set(allKeys());
    renderSelection();
    onChange({ selected: new Set(selected), reason: 'reset', id: '' });
  }

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

  return {
    element: root,
    getSelected: () => new Set(selected),
    isSelected: (id) => (subOwner.has(id) ? selected.has(id) : isItemSelected(id)),
    reset,
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

function labelOf(id) {
  const raw = String(id || '').split('::').pop();
  return raw || id;
}

/** 让当前选中的标签滚进可视区（横向滑动条里尤其需要） */
function scrollChipIntoView(chip) {
  if (!chip) return;
  try { chip.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  catch (err) { /* 老浏览器忽略 */ }
}
